/**
 * AgentCafe — Electron entry point.
 *
 * Boots a Next.js server as a child process (dev: `next dev`, prod:
 * the bundled `.next/standalone/server.js`), waits for it to answer on
 * 127.0.0.1:<port>, then loads it into a single BrowserWindow.
 *
 * The renderer is just the existing Next app — every API route, the
 * login modal, and the local Playwright/MCP agent in src/lib/local-agent.ts
 * keep working exactly as in `npm run dev`. Electron's job is only to
 * give it a desktop shell.
 */
"use strict";

const { app, BrowserWindow, shell } = require("electron");
const path = require("node:path");
const fs = require("node:fs");
const http = require("node:http");
const { spawn } = require("node:child_process");

const isDev = !app.isPackaged;
const PORT = process.env.AGENTCAFE_PORT || (isDev ? "3000" : "39391");
const HOST = "127.0.0.1";
const APP_URL = `http://${HOST}:${PORT}`;

// In a packaged build, extraResources puts files under
// <Contents>/Resources/app/. In dev we resolve from the repo root.
const APP_ROOT = isDev
  ? path.resolve(__dirname, "..")
  : path.join(process.resourcesPath, "app");

let nextServer = null;
let mainWindow = null;

/**
 * Minimal `.env` parser. Avoids dragging the `dotenv` dep into the asar
 * archive. Handles `KEY=value`, quoted values, comments, blank lines.
 */
function loadEnvFile(file) {
  let txt;
  try {
    txt = fs.readFileSync(file, "utf8");
  } catch {
    return {};
  }
  const out = {};
  for (const rawLine of txt.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    if (key) out[key] = val;
  }
  return out;
}

function resolveBundledMcpCli() {
  // The CLI ends up at <APP_ROOT>/node_modules/@playwright/mcp/cli.js in
  // both dev and packaged trees, since electron-builder mirrors node_modules
  // under app/ via extraResources (see package.json build config).
  const cli = path.join(
    APP_ROOT,
    "node_modules",
    "@playwright",
    "mcp",
    "cli.js",
  );
  return fs.existsSync(cli) ? cli : null;
}

function startNextServer() {
  // Env that flows into the spawned Next server. We layer:
  //   1. baseline process.env (Electron-injected)
  //   2. .env.local (bundled in extraResources for packaged builds, repo
  //      root in dev) — gives the user's API keys to the agent
  //   3. AGENTCAFE_MCP_CLI / Electron-as-Node hint so local-agent.ts knows
  //      it can spawn @playwright/mcp without `npx`
  const envFile = path.join(APP_ROOT, ".env.local");
  const fileEnv = loadEnvFile(envFile);
  const mcpCli = resolveBundledMcpCli();
  const childEnv = {
    ...process.env,
    ...fileEnv,
    PORT: String(PORT),
    HOSTNAME: HOST,
    ...(mcpCli ? { AGENTCAFE_MCP_CLI: mcpCli } : {}),
  };

  if (isDev) {
    // Dev: spawn `next dev` ourselves so the user only runs one command.
    // Turbopack + HMR work via the BrowserWindow loading APP_URL.
    const nextBin = path.join(
      APP_ROOT,
      "node_modules",
      "next",
      "dist",
      "bin",
      "next",
    );
    nextServer = spawn(process.execPath, [nextBin, "dev", "-p", String(PORT)], {
      cwd: APP_ROOT,
      env: childEnv,
      stdio: "inherit",
    });
    return;
  }

  // Packaged: run the standalone server bundled at app/.next/standalone/.
  // It's a plain `node server.js`. We use Electron's binary as the Node
  // interpreter via ELECTRON_RUN_AS_NODE so we don't have to ship a
  // separate Node binary.
  const standaloneDir = path.join(APP_ROOT, ".next", "standalone");
  const serverFile = path.join(standaloneDir, "server.js");
  nextServer = spawn(process.execPath, [serverFile], {
    cwd: standaloneDir,
    env: {
      ...childEnv,
      NODE_ENV: "production",
      ELECTRON_RUN_AS_NODE: "1",
    },
    stdio: "inherit",
  });
}

async function waitForServer(url, timeoutMs = 60_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const ok = await new Promise((resolve) => {
      const req = http.get(url, (res) => {
        res.resume();
        resolve(typeof res.statusCode === "number" && res.statusCode < 500);
      });
      req.on("error", () => resolve(false));
      req.setTimeout(2000, () => {
        req.destroy();
        resolve(false);
      });
    });
    if (ok) return;
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`Next server at ${url} did not become ready in ${timeoutMs}ms`);
}

async function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 960,
    minHeight: 640,
    title: "AgentCafe",
    backgroundColor: "#0b0b0c",
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  // Outbound links (post URLs etc.) open in the system browser, not a
  // second Electron window — the renderer only ever shows our own app.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url) && !url.startsWith(APP_URL)) {
      shell.openExternal(url);
      return { action: "deny" };
    }
    return { action: "allow" };
  });

  await waitForServer(APP_URL);
  await mainWindow.loadURL(APP_URL);

  if (isDev) {
    // Surfacing renderer errors here saves a debugging round-trip — without
    // DevTools, console errors stay invisible inside the BrowserWindow.
    mainWindow.webContents.openDevTools({ mode: "detach" });
  }

  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

app.whenReady().then(async () => {
  startNextServer();
  try {
    await createWindow();
  } catch (err) {
    console.error("[electron] failed to create window:", err);
    app.quit();
  }

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) void createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

function killNext() {
  if (nextServer && !nextServer.killed) {
    try {
      nextServer.kill();
    } catch {
      /* ignore */
    }
  }
}

app.on("before-quit", killNext);
process.on("exit", killNext);
process.on("SIGINT", () => {
  killNext();
  process.exit(0);
});
process.on("SIGTERM", () => {
  killNext();
  process.exit(0);
});
