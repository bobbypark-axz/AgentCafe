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

// Stack needed to mirror a headed Chromium over noVNC inside the sandbox.
// `tigervnc-server` provides Xvnc (a virtual X server with a built-in VNC
// listener — no separate xvfb + x11vnc combo). `websockify` proxies the
// VNC TCP port to a public HTTPS port so the browser can connect over WSS.
// noVNC is a tiny static HTML5 client that we serve from /tmp/novnc.
const VNC_SYSTEM_DEPS = [
  "tigervnc-server",
  "python3",
  "python3-pip",
  "git",
];

// Display + ports used by the live viewer pipeline.
const VIEWER_DISPLAY = ":99";
const VIEWER_VNC_PORT = 5999; // 5900 + display number
const VIEWER_HTTP_PORT = 6080;

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
  /** Optional Daum/Kakao login fallback. When the cached storageState is
   *  expired, the agent will type these into the login form. 2FA still
   *  requires the user to interact with the live iframe. */
  daumEmail?: string;
  daumPassword?: string;
};

export type ModerationAction = "3일 정지" | "7일 정지" | "영구 차단";

export type RunSandboxModerateParams = {
  cafeUrl: string;
  boardHint?: string;
  keywords: string[];
  action: ModerationAction;
  dryRun: boolean;
  maxPosts?: number;
  maxActions?: number;
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
    // TEMP: mirror to server console for iframe-pipeline debugging.
    try {
      const k = String(event.kind ?? "?");
      const m = String(event.message ?? event.line ?? event.text ?? event.url ?? "");
      console.log(`[agent] ${k}: ${m.slice(0, 200)}`);
    } catch {
      /* ignore */
    }
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
      // ports:[6080] declares the noVNC websockify port so it can be
      // resolved later via sandbox.domain(6080) → public HTTPS URL.
      sandbox = snapshotId
        ? await Sandbox.create({
            ...credentials,
            source: { type: "snapshot", snapshotId },
            ports: [VIEWER_HTTP_PORT],
            timeout: ms("10m"),
          })
        : await Sandbox.create({
            ...credentials,
            runtime: "node24",
            ports: [VIEWER_HTTP_PORT],
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

        emit({
          kind: "phase",
          message: "installing VNC stack (Xvnc + websockify + noVNC)",
        });
        const vncDeps = await sandbox.runCommand({
          cmd: "sh",
          args: [
            "-c",
            // Tigervnc → Xvnc binary. websockify via pip (avoids a separate
            // dnf package). noVNC is a static HTML/JS client served by
            // websockify itself via --web=DIR.
            [
              `sudo dnf install -y --skip-broken ${VNC_SYSTEM_DEPS.join(" ")}`,
              `sudo pip3 install --quiet websockify`,
              `git clone --depth 1 https://github.com/novnc/noVNC.git /tmp/novnc`,
            ].join(" && "),
          ],
          stdout: makeLineSink("setup-stdout"),
          stderr: makeLineSink("setup-stderr"),
        });
        if (vncDeps.exitCode !== 0) {
          throw new Error(
            `VNC stack install failed with exit code ${vncDeps.exitCode}`,
          );
        }
      }

      // Boot the live viewer pipeline EARLY — right after VNC packages are
      // installed, BEFORE the slow npm install / playwright install steps.
      // This way the iframe in the UI mounts ~35s into the run instead of
      // ~75s, and the user sees an empty Xvnc canvas while the rest of
      // setup completes (then Chromium fills it in).
      //   Xvnc :99  →  TCP :5999  →  websockify (HTTP+WS :6080)  →  iframe
      emit({
        kind: "phase",
        message: `starting Xvnc on ${VIEWER_DISPLAY} (${VIEWER_VNC_PORT})`,
      });
      await sandbox.runCommand({
        cmd: "Xvnc",
        args: [
          VIEWER_DISPLAY,
          "-geometry", "1280x800",
          "-depth", "24",
          "-SecurityTypes", "None",
          "-localhost", "no",
          "-AlwaysShared",
        ],
        detached: true,
        stdout: makeLineSink("xvnc-stdout"),
        stderr: makeLineSink("xvnc-stderr"),
      });

      await sandbox.runCommand({ cmd: "sh", args: ["-c", "sleep 1"] });

      emit({
        kind: "phase",
        message: `starting websockify on :${VIEWER_HTTP_PORT}`,
      });
      await sandbox.runCommand({
        cmd: "websockify",
        args: [
          "--web=/tmp/novnc",
          String(VIEWER_HTTP_PORT),
          `localhost:${VIEWER_VNC_PORT}`,
        ],
        detached: true,
        stdout: makeLineSink("websockify-stdout"),
        stderr: makeLineSink("websockify-stderr"),
      });

      try {
        const viewerHost = sandbox.domain(VIEWER_HTTP_PORT);
        // vnc.html (full UI) supports `resize=scale` which scales the
        // 1280×800 framebuffer to the iframe viewport. vnc_lite.html
        // ignores that param and shows native 1280×800 — looks tiny when
        // the iframe is smaller. show_dot & bell suppressed for clean UX.
        const viewerUrl =
          `${viewerHost}/vnc.html` +
          `?autoconnect=1&resize=scale&reconnect=1` +
          `&show_dot=false&bell=off`;
        emit({ kind: "viewer", url: viewerUrl });
      } catch (err) {
        emit({
          kind: "error",
          message: `failed to resolve viewer domain: ${err instanceof Error ? err.message : String(err)}`,
        });
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

        // @playwright/mcp ≥ 0.0.70 looks for `chrome-for-testing` (a distinct
        // build from the plain `chromium` that `playwright install` brings).
        // Without this step the MCP browser_* tools fail with
        // "Browser 'chrome-for-testing' is not installed".
        emit({
          kind: "phase",
          message: "installing chrome-for-testing (playwright/mcp)",
        });
        const mcpRes = await sandbox.runCommand({
          cmd: "npx",
          args: [
            "@playwright/mcp@latest",
            "install-browser",
            "chrome-for-testing",
          ],
          cwd: SANDBOX_WORKDIR,
          stdout: makeLineSink("setup-stdout"),
          stderr: makeLineSink("setup-stderr"),
        });
        if (mcpRes.exitCode !== 0) {
          throw new Error(
            `@playwright/mcp install-browser failed with exit code ${mcpRes.exitCode}`,
          );
        }
      }

      emit({ kind: "phase", message: "running post-writing agent (headed)" });
      const agentRes = await sandbox.runCommand({
        cmd: "node",
        args: ["post-agent.mjs"],
        cwd: SANDBOX_WORKDIR,
        env: {
          // DISPLAY presence flips post-agent.mjs to headed Chromium so the
          // VNC server has something to mirror.
          DISPLAY: VIEWER_DISPLAY,
          SESSION_BLOB_URL: params.sessionBlobUrl,
          CAFE_URL: params.cafeUrl,
          TOPIC_HINT: params.topicHint ?? "",
          LENGTH: params.length ?? "medium",
          TONE: params.tone ?? "",
          MODEL_ID: params.modelId ?? "anthropic/claude-sonnet-4.6",
          ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY ?? "",
          BIZROUTER_API_KEY: process.env.BIZROUTER_API_KEY ?? "",
          BIZROUTER_BASE_URL: process.env.BIZROUTER_BASE_URL ?? "",
          BIZROUTER_MODEL_ID: process.env.BIZROUTER_MODEL_ID ?? "",
          // Login fallback creds — request body wins over server env defaults.
          DAUM_EMAIL: params.daumEmail || process.env.DAUM_EMAIL || "",
          DAUM_PASSWORD: params.daumPassword || process.env.DAUM_PASSWORD || "",
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

/**
 * Sandbox-based cafe moderation agent. Scans recent posts/comments on the
 * target cafe and (when dryRun is false) executes ban/suspend actions via the
 * Daum Cafe moderation UI. The logged-in session MUST belong to a manager.
 */
export function runSandboxModerateAgent(
  params: RunSandboxModerateParams,
  signal?: AbortSignal,
): ReadableStream<Uint8Array> {
  const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
  const writer = writable.getWriter();
  const encoder = new TextEncoder();
  let writerClosed = false;

  const emit = (event: Record<string, unknown>) => {
    if (writerClosed) return;
    // TEMP: mirror to server console for iframe-pipeline debugging.
    try {
      const k = String(event.kind ?? "?");
      const m = String(event.message ?? event.line ?? event.text ?? event.url ?? "");
      console.log(`[agent] ${k}: ${m.slice(0, 200)}`);
    } catch {
      /* ignore */
    }
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

      emit({ kind: "phase", message: "uploading moderate-agent code" });
      const root = process.cwd();
      const agentSrc = await readFile(
        path.join(root, "sandbox/moderate-agent.mjs"),
        "utf8",
      );
      const agentPkg = await readFile(
        path.join(root, "sandbox/package.json"),
        "utf8",
      );
      await sandbox.writeFiles([
        { path: `${SANDBOX_WORKDIR}/moderate-agent.mjs`, content: agentSrc },
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

      emit({
        kind: "phase",
        message: `running moderation agent (${params.dryRun ? "DRY-RUN" : "LIVE"})`,
      });
      const agentRes = await sandbox.runCommand({
        cmd: "node",
        args: ["moderate-agent.mjs"],
        cwd: SANDBOX_WORKDIR,
        env: {
          SESSION_BLOB_URL: params.sessionBlobUrl,
          CAFE_URL: params.cafeUrl,
          BOARD_HINT: params.boardHint ?? "",
          KEYWORDS: params.keywords.join(","),
          ACTION: params.action,
          DRY_RUN: params.dryRun ? "1" : "0",
          MAX_POSTS: String(params.maxPosts ?? 10),
          MAX_ACTIONS: String(params.maxActions ?? 5),
          MODEL_ID: params.modelId ?? "anthropic/claude-sonnet-4.6",
          ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY ?? "",
          BIZROUTER_API_KEY: process.env.BIZROUTER_API_KEY ?? "",
          BIZROUTER_BASE_URL: process.env.BIZROUTER_BASE_URL ?? "",
          BIZROUTER_MODEL_ID: process.env.BIZROUTER_MODEL_ID ?? "",
          DAUM_EMAIL: process.env.DAUM_EMAIL ?? "",
          DAUM_PASSWORD: process.env.DAUM_PASSWORD ?? "",
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
