import { Sandbox } from "@vercel/sandbox";
import { Writable } from "node:stream";
import { readFile } from "node:fs/promises";
import path from "node:path";
import ms from "ms";
import { put, list } from "@vercel/blob";

export const runtime = "nodejs";
export const maxDuration = 300;

const activeSessions = new Map<
  string,
  { sandbox: Sandbox; createdAt: number }
>();

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

/** Capture stdout of a sandbox command into a string. */
function captureStdout(): { stream: Writable; getOutput: () => string } {
  let buf = "";
  const stream = new Writable({
    write(chunk: Buffer, _enc, cb) { buf += chunk.toString("utf8"); cb(); },
  });
  return { stream, getOutput: () => buf };
}

/** Read a file from the sandbox via cat. */
async function readSandboxFile(sandbox: Sandbox, filePath: string): Promise<string> {
  const { stream, getOutput } = captureStdout();
  await sandbox.runCommand({
    cmd: "sh",
    args: ["-c", `cat ${filePath} 2>/dev/null || echo ""`],
    cwd: "/",
    stdout: stream,
  });
  return getOutput().trim();
}

async function getScreenshot(sandbox: Sandbox, sessionId?: string) {
  const b64 = await readSandboxFile(sandbox, "/tmp/screenshot.b64");
  const statusRaw = await readSandboxFile(sandbox, "/tmp/status.json");
  let status = { url: "", title: "" };
  try { status = JSON.parse(statusRaw || "{}"); } catch { /* ignore */ }

  return Response.json({
    ...(sessionId ? { sessionId } : {}),
    screenshot: b64,
    status,
  });
}

export async function POST(req: Request) {
  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const action = (body.action as string) ?? "start";
  const sessionId = body.sessionId as string | undefined;

  // ─── send command ───
  if (action === "command" && sessionId) {
    const session = activeSessions.get(sessionId);
    if (!session) return Response.json({ error: "session not found" }, { status: 404 });

    await session.sandbox.writeFiles([
      { path: "/tmp/command.json", content: JSON.stringify(body.command) },
    ]);
    await new Promise((r) => setTimeout(r, 2000));
    return getScreenshot(session.sandbox);
  }

  // ─── get screenshot ───
  if (action === "screenshot" && sessionId) {
    const session = activeSessions.get(sessionId);
    if (!session) return Response.json({ error: "session not found" }, { status: 404 });
    return getScreenshot(session.sandbox);
  }

  // ─── save session ───
  if (action === "save" && sessionId) {
    const session = activeSessions.get(sessionId);
    if (!session) return Response.json({ error: "session not found" }, { status: 404 });

    await session.sandbox.writeFiles([{ path: "/tmp/done", content: "please" }]);
    await new Promise((r) => setTimeout(r, 4000));

    const stateJson = await readSandboxFile(session.sandbox, "/tmp/storageState.json");
    if (!stateJson || stateJson === '""') {
      await session.sandbox.stop().catch(() => {});
      activeSessions.delete(sessionId);
      return Response.json({ error: "Failed to read storageState" }, { status: 500 });
    }

    const blobKey = process.env.DAUM_SESSION_BLOB_KEY ?? "sessions/daum-storage-state.json";
    const token = process.env.BLOB_READ_WRITE_TOKEN;
    if (!token) return Response.json({ error: "BLOB_READ_WRITE_TOKEN not set" }, { status: 500 });

    const blob = await put(blobKey, stateJson, {
      access: "public",
      addRandomSuffix: false,
      allowOverwrite: true,
      contentType: "application/json",
      token,
    });

    await session.sandbox.stop().catch(() => {});
    activeSessions.delete(sessionId);
    return Response.json({ ok: true, blobUrl: blob.url });
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

  // ─── start new login ───
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
  const helperSrc = await readFile(path.join(root, "sandbox/login-helper.mjs"), "utf8");
  const pkgSrc = await readFile(path.join(root, "sandbox/package.json"), "utf8");
  await sandbox.writeFiles([
    { path: `${SANDBOX_WORKDIR}/login-helper.mjs`, content: helperSrc },
    { path: `${SANDBOX_WORKDIR}/package.json`, content: pkgSrc },
  ]);

  if (!snapshotId) {
    await sandbox.runCommand({ cmd: "npm", args: ["install", "--no-audit", "--no-fund", "--loglevel=error"], cwd: SANDBOX_WORKDIR });
    await sandbox.runCommand({ cmd: "npx", args: ["playwright", "install", "chromium"], cwd: SANDBOX_WORKDIR });
  }

  // Load existing storageState if available
  try {
    const prefix = process.env.DAUM_SESSION_BLOB_KEY ?? "sessions/daum-storage-state.json";
    const token = process.env.BLOB_READ_WRITE_TOKEN!;
    const { blobs } = await list({ prefix, limit: 1, token });
    if (blobs.length > 0) {
      const res = await fetch(blobs[0].url);
      if (res.ok) {
        await sandbox.writeFiles([{ path: "/tmp/existing-storage-state.json", content: await res.text() }]);
      }
    }
  } catch { /* fine */ }

  // Start login helper in background (don't await)
  sandbox.runCommand({
    cmd: "node",
    args: ["login-helper.mjs"],
    cwd: SANDBOX_WORKDIR,
    env: {
      DAUM_EMAIL: process.env.DAUM_EMAIL ?? "",
      DAUM_PASSWORD: process.env.DAUM_PASSWORD ?? "",
      STORAGE_STATE_PATH: "/tmp/existing-storage-state.json",
    },
  }).catch(() => {});

  // Poll until ready
  for (let i = 0; i < 60; i++) {
    const check = await readSandboxFile(sandbox, "/tmp/ready");
    if (check === "ok") break;
    await new Promise((r) => setTimeout(r, 2000));
  }

  activeSessions.set(id, { sandbox, createdAt: Date.now() });
  return getScreenshot(sandbox, id);
}
