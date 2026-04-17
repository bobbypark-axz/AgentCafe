import { Sandbox } from "@vercel/sandbox";
import { Readable, Writable } from "node:stream";
import { readFile } from "node:fs/promises";
import path from "node:path";
import ms from "ms";

// System libraries Chromium needs on Amazon Linux 2023 (the sandbox OS).
// Sourced from Vercel's official vercel-sandbox skill recipe.
const CHROMIUM_SYSTEM_DEPS = [
  "nss",
  "nspr",
  "libxkbcommon",
  "atk",
  "at-spi2-atk",
  "at-spi2-core",
  "libXcomposite",
  "libXdamage",
  "libXrandr",
  "libXfixes",
  "libXcursor",
  "libXi",
  "libXtst",
  "libXScrnSaver",
  "libXext",
  "mesa-libgbm",
  "libdrm",
  "mesa-libGL",
  "mesa-libEGL",
  "cups-libs",
  "alsa-lib",
  "pango",
  "cairo",
  "gtk3",
  "dbus-libs",
];

const SANDBOX_WORKDIR = "/vercel/sandbox/agent";

/**
 * On Vercel, OIDC auth is automatic. Locally we need explicit credentials
 * from `vercel env pull .env.local`.
 */
export function getSandboxCredentials() {
  if (
    process.env.VERCEL_TOKEN &&
    process.env.VERCEL_TEAM_ID &&
    process.env.VERCEL_PROJECT_ID
  ) {
    return {
      token: process.env.VERCEL_TOKEN,
      teamId: process.env.VERCEL_TEAM_ID,
      projectId: process.env.VERCEL_PROJECT_ID,
    };
  }
  return {};
}

export type RunCafeAgentParams = {
  cafeName: string;
  cafeDescription?: string;
  visibility: "public" | "private";
  category?: string;
  sessionBlobUrl: string;
  modelId?: string;
};

export type RunSandboxPostParams = {
  cafeUrl: string;
  topicHint?: string;
  length?: "short" | "medium" | "long";
  tone?: string;
  sessionBlobUrl: string;
  modelId?: string;
};

/**
 * Spins up a Vercel Sandbox, uploads the agent code, and runs it against the
 * given cafe creation params. Returns a Web ReadableStream of NDJSON events
 * suitable for a Response body.
 */
export function runCafeAgent(
  params: RunCafeAgentParams,
  signal?: AbortSignal,
): ReadableStream<Uint8Array> {
  const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
  const writer = writable.getWriter();
  const encoder = new TextEncoder();
  let writerClosed = false;

  const emit = (event: Record<string, unknown>) => {
    if (writerClosed) return;
    // fire-and-forget; TransformStream backpressure is fine for our volume
    void writer.write(encoder.encode(JSON.stringify(event) + "\n"));
  };

  const closeWriter = async () => {
    if (writerClosed) return;
    writerClosed = true;
    try {
      await writer.close();
    } catch {
      /* already closed */
    }
  };

  // Node Writable that splits incoming bytes into lines and forwards them to
  // `emit()` under a caller-specified `kind`. Agent stdout is pre-formatted
  // JSON; we try to reparse it so structured events pass through unwrapped.
  const makeLineSink = (kind: string) => {
    let buf = "";
    return new Writable({
      write(chunk: Buffer, _enc, cb) {
        buf += chunk.toString("utf8");
        let i: number;
        while ((i = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, i).trim();
          buf = buf.slice(i + 1);
          if (!line) continue;
          if (kind === "agent") {
            try {
              const parsed = JSON.parse(line) as Record<string, unknown>;
              emit(parsed);
              continue;
            } catch {
              /* fall through to log line */
            }
          }
          emit({ kind, line });
        }
        cb();
      },
      final(cb) {
        if (buf.trim()) emit({ kind, line: buf });
        cb();
      },
    });
  };

  void (async () => {
    let sandbox: Sandbox | null = null;
    try {
      const snapshotId = process.env.AGENT_BROWSER_SNAPSHOT_ID;
      emit({
        kind: "phase",
        message: snapshotId
          ? `provisioning sandbox from snapshot ${snapshotId}`
          : "provisioning sandbox (cold start)",
      });

      const credentials = getSandboxCredentials();
      sandbox = snapshotId
        ? await Sandbox.create({
            ...credentials,
            source: { type: "snapshot", snapshotId },
            timeout: ms("10m"),
          })
        : await Sandbox.create({
            ...credentials,
            runtime: "node24",
            timeout: ms("10m"),
          });

      if (!snapshotId) {
        emit({ kind: "phase", message: "installing chromium system libs" });
        const depsInstall = await sandbox.runCommand({
          cmd: "sh",
          args: [
            "-c",
            `sudo dnf clean all && sudo dnf install -y --skip-broken ${CHROMIUM_SYSTEM_DEPS.join(" ")} && sudo ldconfig`,
          ],
          stdout: makeLineSink("setup-stdout"),
          stderr: makeLineSink("setup-stderr"),
        });
        if (depsInstall.exitCode !== 0) {
          throw new Error(
            `dnf install failed with exit code ${depsInstall.exitCode}`,
          );
        }
      }

      emit({ kind: "phase", message: "uploading agent code" });
      const root = process.cwd();
      const agentSrc = await readFile(
        path.join(root, "sandbox/agent.mjs"),
        "utf8",
      );
      const agentPkg = await readFile(
        path.join(root, "sandbox/package.json"),
        "utf8",
      );
      await sandbox.writeFiles([
        { path: `${SANDBOX_WORKDIR}/agent.mjs`, content: agentSrc },
        { path: `${SANDBOX_WORKDIR}/package.json`, content: agentPkg },
      ]);

      if (!snapshotId) {
        emit({ kind: "phase", message: "npm install (agent deps)" });
        const npmRes = await sandbox.runCommand({
          cmd: "npm",
          args: ["install", "--no-audit", "--no-fund", "--loglevel=error"],
          cwd: SANDBOX_WORKDIR,
          stdout: makeLineSink("setup-stdout"),
          stderr: makeLineSink("setup-stderr"),
        });
        if (npmRes.exitCode !== 0) {
          throw new Error(`npm install failed with exit code ${npmRes.exitCode}`);
        }

        emit({ kind: "phase", message: "installing chromium browser" });
        const pwRes = await sandbox.runCommand({
          cmd: "npx",
          args: ["playwright", "install", "chromium"],
          cwd: SANDBOX_WORKDIR,
          stdout: makeLineSink("setup-stdout"),
          stderr: makeLineSink("setup-stderr"),
        });
        if (pwRes.exitCode !== 0) {
          throw new Error(
            `playwright install failed with exit code ${pwRes.exitCode}`,
          );
        }
      }

      emit({ kind: "phase", message: "running agent" });
      const agentRes = await sandbox.runCommand({
        cmd: "node",
        args: ["agent.mjs"],
        cwd: SANDBOX_WORKDIR,
        env: {
          SESSION_BLOB_URL: params.sessionBlobUrl,
          CAFE_NAME: params.cafeName,
          CAFE_DESCRIPTION: params.cafeDescription ?? "",
          CAFE_VISIBILITY: params.visibility,
          CAFE_CATEGORY: params.category ?? "",
          MODEL_ID: params.modelId ?? "anthropic/claude-sonnet-4.6",
          // Gateway resolves auth from VERCEL_OIDC_TOKEN automatically —
          // forwarded so the sandbox Node process can see it.
          VERCEL_OIDC_TOKEN: process.env.VERCEL_OIDC_TOKEN ?? "",
        },
        stdout: makeLineSink("agent"),
        stderr: makeLineSink("agent-stderr"),
        signal,
      });

      emit({
        kind: "phase",
        message: `agent finished (exit ${agentRes.exitCode})`,
      });
    } catch (err) {
      const message =
        err instanceof Error ? err.message : String(err);
      emit({ kind: "error", message });
    } finally {
      if (sandbox) {
        try {
          await sandbox.stop();
        } catch (err) {
          emit({
            kind: "error",
            message: `sandbox stop failed: ${err instanceof Error ? err.message : String(err)}`,
          });
        }
      }
      await closeWriter();
    }
  })();

  // Hush an unused import — Readable reserved for future streaming variants.
  void Readable;

  return readable;
}

/**
 * Sandbox-based post-writing agent. Uploads post-agent.mjs into a Vercel
 * Sandbox microVM and runs it headless against the target Daum cafe.
 */
export function runSandboxPostAgent(
  params: RunSandboxPostParams,
  signal?: AbortSignal,
): ReadableStream<Uint8Array> {
  const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
  const writer = writable.getWriter();
  const encoder = new TextEncoder();
  let writerClosed = false;

  const emit = (event: Record<string, unknown>) => {
    if (writerClosed) return;
    void writer.write(encoder.encode(JSON.stringify(event) + "\n"));
  };

  const closeWriter = async () => {
    if (writerClosed) return;
    writerClosed = true;
    try {
      await writer.close();
    } catch {
      /* already closed */
    }
  };

  const makeLineSink = (kind: string) => {
    let buf = "";
    return new Writable({
      write(chunk: Buffer, _enc, cb) {
        buf += chunk.toString("utf8");
        let i: number;
        while ((i = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, i).trim();
          buf = buf.slice(i + 1);
          if (!line) continue;
          if (kind === "agent") {
            try {
              const parsed = JSON.parse(line) as Record<string, unknown>;
              emit(parsed);
              continue;
            } catch {
              /* fall through */
            }
          }
          emit({ kind, line });
        }
        cb();
      },
      final(cb) {
        if (buf.trim()) emit({ kind, line: buf });
        cb();
      },
    });
  };

  void (async () => {
    let sandbox: Sandbox | null = null;
    try {
      const snapshotId = process.env.AGENT_BROWSER_SNAPSHOT_ID;
      emit({
        kind: "phase",
        message: snapshotId
          ? `provisioning sandbox from snapshot ${snapshotId}`
          : "provisioning sandbox (cold start)",
      });

      const credentials = getSandboxCredentials();
      sandbox = snapshotId
        ? await Sandbox.create({
            ...credentials,
            source: { type: "snapshot", snapshotId },
            timeout: ms("10m"),
          })
        : await Sandbox.create({
            ...credentials,
            runtime: "node24",
            timeout: ms("10m"),
          });

      if (!snapshotId) {
        emit({ kind: "phase", message: "installing chromium system libs" });
        const depsInstall = await sandbox.runCommand({
          cmd: "sh",
          args: [
            "-c",
            `sudo dnf clean all && sudo dnf install -y --skip-broken ${CHROMIUM_SYSTEM_DEPS.join(" ")} && sudo ldconfig`,
          ],
          stdout: makeLineSink("setup-stdout"),
          stderr: makeLineSink("setup-stderr"),
        });
        if (depsInstall.exitCode !== 0) {
          throw new Error(
            `dnf install failed with exit code ${depsInstall.exitCode}`,
          );
        }
      }

      emit({ kind: "phase", message: "uploading post-agent code" });
      const root = process.cwd();
      const agentSrc = await readFile(
        path.join(root, "sandbox/post-agent.mjs"),
        "utf8",
      );
      const agentPkg = await readFile(
        path.join(root, "sandbox/package.json"),
        "utf8",
      );
      await sandbox.writeFiles([
        { path: `${SANDBOX_WORKDIR}/post-agent.mjs`, content: agentSrc },
        { path: `${SANDBOX_WORKDIR}/package.json`, content: agentPkg },
      ]);

      if (!snapshotId) {
        emit({ kind: "phase", message: "npm install (agent deps)" });
        const npmRes = await sandbox.runCommand({
          cmd: "npm",
          args: ["install", "--no-audit", "--no-fund", "--loglevel=error"],
          cwd: SANDBOX_WORKDIR,
          stdout: makeLineSink("setup-stdout"),
          stderr: makeLineSink("setup-stderr"),
        });
        if (npmRes.exitCode !== 0) {
          throw new Error(`npm install failed with exit code ${npmRes.exitCode}`);
        }

        emit({ kind: "phase", message: "installing chromium browser" });
        const pwRes = await sandbox.runCommand({
          cmd: "npx",
          args: ["playwright", "install", "chromium"],
          cwd: SANDBOX_WORKDIR,
          stdout: makeLineSink("setup-stdout"),
          stderr: makeLineSink("setup-stderr"),
        });
        if (pwRes.exitCode !== 0) {
          throw new Error(
            `playwright install failed with exit code ${pwRes.exitCode}`,
          );
        }
      }

      emit({ kind: "phase", message: "running post-writing agent" });
      const agentRes = await sandbox.runCommand({
        cmd: "node",
        args: ["post-agent.mjs"],
        cwd: SANDBOX_WORKDIR,
        env: {
          SESSION_BLOB_URL: params.sessionBlobUrl,
          CAFE_URL: params.cafeUrl,
          TOPIC_HINT: params.topicHint ?? "",
          LENGTH: params.length ?? "medium",
          TONE: params.tone ?? "",
          MODEL_ID: params.modelId ?? "anthropic/claude-sonnet-4.6",
          VERCEL_OIDC_TOKEN: process.env.VERCEL_OIDC_TOKEN ?? "",
        },
        stdout: makeLineSink("agent"),
        stderr: makeLineSink("agent-stderr"),
        signal,
      });

      emit({
        kind: "phase",
        message: `agent finished (exit ${agentRes.exitCode})`,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      emit({ kind: "error", message });
    } finally {
      if (sandbox) {
        try {
          await sandbox.stop();
        } catch (err) {
          emit({
            kind: "error",
            message: `sandbox stop failed: ${err instanceof Error ? err.message : String(err)}`,
          });
        }
      }
      await closeWriter();
    }
  })();

  return readable;
}
