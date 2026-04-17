import { Sandbox } from "@vercel/sandbox";
import { Writable } from "node:stream";
import { readFile } from "node:fs/promises";
import path from "node:path";
import ms from "ms";
import { put, list } from "@vercel/blob";

export const runtime = "nodejs";
export const maxDuration = 300;

const activeSessions = new Map<string, { sandbox: Sandbox; createdAt: number }>();

const SANDBOX_WORKDIR = "/vercel/sandbox/agent";
const CHROMIUM_SYSTEM_DEPS = [
  "nss", "nspr", "libxkbcommon", "atk", "at-spi2-atk", "at-spi2-core",
  "libXcomposite", "libXdamage", "libXrandr", "libXfixes", "libXcursor",
  "libXi", "libXtst", "libXScrnSaver", "libXext", "mesa-libgbm", "libdrm",
  "mesa-libGL", "mesa-libEGL", "cups-libs", "alsa-lib", "pango", "cairo",
  "gtk3", "dbus-libs",
];

function getSandboxCredentials() {
  if (process.env.VERCEL_TOKEN && process.env.VERCEL_TEAM_ID && process.env.VERCEL_PROJECT_ID) {
    return { token: process.env.VERCEL_TOKEN, teamId: process.env.VERCEL_TEAM_ID, projectId: process.env.VERCEL_PROJECT_ID };
  }
  return {};
}

async function readSandboxFile(sandbox: Sandbox, filePath: string): Promise<string> {
  let buf = "";
  const stream = new Writable({
    write(chunk: Buffer, _enc, cb) { buf += chunk.toString("utf8"); cb(); },
  });
  await sandbox.runCommand({
    cmd: "sh",
    args: ["-c", `cat ${filePath} 2>/dev/null || echo ""`],
    cwd: "/",
    stdout: stream,
  });
  return buf.trim();
}

export async function POST(req: Request) {
  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const action = (body.action as string) ?? "start";
  const sessionId = body.sessionId as string | undefined;

  // ─── submit 2FA code ───
  if (action === "code" && sessionId) {
    const session = activeSessions.get(sessionId);
    if (!session) return Response.json({ error: "session not found" }, { status: 404 });

    const code = String(body.code ?? "");
    await session.sandbox.writeFiles([{ path: "/tmp/code", content: code }]);

    // Wait for the helper to process it
    for (let i = 0; i < 15; i++) {
      await new Promise((r) => setTimeout(r, 2000));
      const status = await readSandboxFile(session.sandbox, "/tmp/status");
      if (status === "done") {
        // Read and save storageState
        const stateJson = await readSandboxFile(session.sandbox, "/tmp/storageState.json");
        if (stateJson && stateJson !== '""') {
          const blobKey = process.env.DAUM_SESSION_BLOB_KEY ?? "sessions/daum-storage-state.json";
          const token = process.env.BLOB_READ_WRITE_TOKEN;
          if (token) {
            await put(blobKey, stateJson, {
              access: "public", addRandomSuffix: false, allowOverwrite: true,
              contentType: "application/json", token,
            });
          }
        }
        await session.sandbox.stop().catch(() => {});
        activeSessions.delete(sessionId);
        return Response.json({ status: "done" });
      }
      if (status.startsWith("error:")) {
        await session.sandbox.stop().catch(() => {});
        activeSessions.delete(sessionId);
        return Response.json({ status: "error", message: status.slice(6) });
      }
    }
    return Response.json({ status: "timeout" });
  }

  // ─── poll status ───
  if (action === "status" && sessionId) {
    const session = activeSessions.get(sessionId);
    if (!session) return Response.json({ error: "session not found" }, { status: 404 });
    const status = await readSandboxFile(session.sandbox, "/tmp/status");
    return Response.json({ status });
  }

  // ─── stop ───
  if (action === "stop" && sessionId) {
    const session = activeSessions.get(sessionId);
    if (session) {
      await session.sandbox.stop().catch(() => {});
      activeSessions.delete(sessionId);
    }
    return Response.json({ ok: true });
  }

  // ─── start login ───
  const id = crypto.randomUUID().slice(0, 8);
  const credentials = getSandboxCredentials();
  const snapshotId = process.env.AGENT_BROWSER_SNAPSHOT_ID;

  const sandbox = snapshotId
    ? await Sandbox.create({ ...credentials, source: { type: "snapshot", snapshotId }, timeout: ms("10m") })
    : await Sandbox.create({ ...credentials, runtime: "node24", timeout: ms("10m") });

  if (!snapshotId) {
    await sandbox.runCommand({
      cmd: "sh",
      args: ["-c", `sudo dnf clean all && sudo dnf install -y --skip-broken ${CHROMIUM_SYSTEM_DEPS.join(" ")} && sudo ldconfig`],
    });
  }

  const root = process.cwd();
  await sandbox.writeFiles([
    { path: `${SANDBOX_WORKDIR}/login-helper.mjs`, content: await readFile(path.join(root, "sandbox/login-helper.mjs"), "utf8") },
    { path: `${SANDBOX_WORKDIR}/package.json`, content: await readFile(path.join(root, "sandbox/package.json"), "utf8") },
  ]);

  if (!snapshotId) {
    await sandbox.runCommand({ cmd: "npm", args: ["install", "--no-audit", "--no-fund", "--loglevel=error"], cwd: SANDBOX_WORKDIR });
    await sandbox.runCommand({ cmd: "npx", args: ["playwright", "install", "chromium"], cwd: SANDBOX_WORKDIR });
  }

  // Start login helper (don't await — it runs in background)
  sandbox.runCommand({
    cmd: "node", args: ["login-helper.mjs"], cwd: SANDBOX_WORKDIR,
    env: { DAUM_EMAIL: process.env.DAUM_EMAIL ?? "", DAUM_PASSWORD: process.env.DAUM_PASSWORD ?? "" },
  }).catch(() => {});

  // Wait for ready
  for (let i = 0; i < 60; i++) {
    const check = await readSandboxFile(sandbox, "/tmp/ready");
    if (check === "ok") break;
    await new Promise((r) => setTimeout(r, 2000));
  }

  // Wait for status to settle (filling → 2fa or done)
  let status = "filling";
  for (let i = 0; i < 30; i++) {
    await new Promise((r) => setTimeout(r, 2000));
    status = await readSandboxFile(sandbox, "/tmp/status");
    if (status !== "filling") break;
  }

  // If already done (no 2FA needed), save and return
  if (status === "done") {
    const stateJson = await readSandboxFile(sandbox, "/tmp/storageState.json");
    if (stateJson && stateJson !== '""') {
      const token = process.env.BLOB_READ_WRITE_TOKEN;
      if (token) {
        await put(
          process.env.DAUM_SESSION_BLOB_KEY ?? "sessions/daum-storage-state.json",
          stateJson,
          { access: "public", addRandomSuffix: false, allowOverwrite: true, contentType: "application/json", token },
        );
      }
    }
    await sandbox.stop().catch(() => {});
    return Response.json({ sessionId: id, status: "done" });
  }

  activeSessions.set(id, { sandbox, createdAt: Date.now() });
  return Response.json({ sessionId: id, status });
}
