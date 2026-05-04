/**
 * Standalone VNC pipeline smoke test.
 *
 * Spins up a Vercel Sandbox, installs Xvnc + websockify + noVNC, launches
 * a headed Chromium pointing at example.com, and prints a public noVNC URL
 * for you to open in a browser (or embed in an iframe).
 *
 * No Daum session, no LLM, no AgentCafe agent — just verifies the
 * Sandbox port-exposure + iframe-able stream actually works.
 *
 * Usage:
 *   npx tsx scripts/test-vnc.ts
 */
import { Sandbox } from "@vercel/sandbox";
import ms from "ms";
import { getSandboxCredentials } from "../src/lib/sandbox";

const CHROMIUM_SYSTEM_DEPS = [
  "nss", "nspr", "libxkbcommon", "atk", "at-spi2-atk", "at-spi2-core",
  "libXcomposite", "libXdamage", "libXrandr", "libXfixes", "libXcursor",
  "libXi", "libXtst", "libXScrnSaver", "libXext", "mesa-libgbm", "libdrm",
  "mesa-libGL", "mesa-libEGL", "cups-libs", "alsa-lib", "pango", "cairo",
  "gtk3", "dbus-libs",
];
const VNC_DEPS = ["tigervnc-server", "python3", "python3-pip", "git"];

const KEEPALIVE_MS = ms("8m");

const browserScript = `
import { chromium } from "playwright";

const browser = await chromium.launch({
  headless: false,
  args: ["--no-sandbox", "--disable-dev-shm-usage", "--start-maximized"],
});
const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
const page = await ctx.newPage();
await page.goto("https://example.com");
console.log("chromium ready, holding open for 8min");
await new Promise((r) => setTimeout(r, ${KEEPALIVE_MS}));
await browser.close();
`;

async function main() {
  const credentials = getSandboxCredentials();
  console.log("→ creating sandbox with port 6080 exposed");
  const sandbox = await Sandbox.create({
    ...credentials,
    runtime: "node24",
    ports: [6080],
    timeout: ms("12m"),
  });
  console.log(`  sandbox: ${sandbox.sandboxId}`);

  try {
    console.log("→ dnf install: chromium libs (~30s)");
    const r1 = await sandbox.runCommand("sh", [
      "-c",
      `sudo dnf clean all 2>&1 && sudo dnf install -y --skip-broken ${CHROMIUM_SYSTEM_DEPS.join(" ")} 2>&1 && sudo ldconfig 2>&1`,
    ]);
    if (r1.exitCode !== 0) throw new Error(`chromium libs install failed: ${r1.exitCode}`);

    console.log("→ dnf install: tigervnc-server + python3 + git");
    const r2 = await sandbox.runCommand("sh", [
      "-c",
      `sudo dnf install -y --skip-broken ${VNC_DEPS.join(" ")} 2>&1`,
    ]);
    if (r2.exitCode !== 0) throw new Error(`vnc deps install failed: ${r2.exitCode}`);

    console.log("→ verifying Xvnc + websockify availability");
    const r2b = await sandbox.runCommand("sh", [
      "-c",
      `which Xvnc || which Xtigervnc || ls /usr/bin/Xvnc* /usr/sbin/Xvnc* 2>&1; rpm -ql tigervnc-server | head -20`,
    ]);
    console.log("   ", (await r2b.stdout()).trim().split("\n").join("\n    "));

    console.log("→ pip install websockify + clone noVNC");
    const r3 = await sandbox.runCommand("sh", [
      "-c",
      `sudo pip3 install --quiet websockify && git clone --depth 1 https://github.com/novnc/noVNC.git /tmp/novnc 2>&1 | tail -5`,
    ]);
    if (r3.exitCode !== 0) throw new Error(`websockify/novnc install failed: ${r3.exitCode}`);

    console.log("→ npm install playwright + chromium browser");
    await sandbox.runCommand("sh", ["-c", "mkdir -p /tmp/test"]);
    await sandbox.writeFiles([
      {
        path: "/tmp/test/package.json",
        content: Buffer.from(
          JSON.stringify({ type: "module", dependencies: { playwright: "1.59.1" } }),
        ),
      },
      {
        path: "/tmp/test/test.mjs",
        content: Buffer.from(browserScript),
      },
    ]);
    const r4 = await sandbox.runCommand({
      cmd: "npm",
      args: ["install", "--no-audit", "--no-fund", "--loglevel=error"],
      cwd: "/tmp/test",
    });
    if (r4.exitCode !== 0) throw new Error(`npm install failed: ${r4.exitCode}`);

    const r5 = await sandbox.runCommand({
      cmd: "npx",
      args: ["playwright", "install", "chromium"],
      cwd: "/tmp/test",
    });
    if (r5.exitCode !== 0) throw new Error(`playwright install failed: ${r5.exitCode}`);

    console.log("→ start Xvnc :99 (detached)");
    await sandbox.runCommand({
      cmd: "Xvnc",
      args: [
        ":99",
        "-geometry", "1280x800",
        "-depth", "24",
        "-SecurityTypes", "None",
        "-localhost", "no",
        "-AlwaysShared",
      ],
      detached: true,
    });

    await sandbox.runCommand("sh", ["-c", "sleep 1"]);

    // Sanity: confirm Xvnc is actually running (AL2023 lacks `ss` so grep
    // /proc instead — process visibility means port 5999 is bound).
    const xvncCheck = await sandbox.runCommand("sh", [
      "-c",
      "pgrep -fa 'Xvnc :99' || echo NONE",
    ]);
    console.log("   xvnc process:", (await xvncCheck.stdout()).trim());

    console.log("→ start websockify :6080 (detached)");
    await sandbox.runCommand({
      cmd: "websockify",
      args: ["--web=/tmp/novnc", "6080", "localhost:5999"],
      detached: true,
    });

    await sandbox.runCommand("sh", ["-c", "sleep 1"]);
    const wsCheck = await sandbox.runCommand("sh", [
      "-c",
      "pgrep -fa websockify || echo NONE",
    ]);
    console.log("   websockify process:", (await wsCheck.stdout()).trim());

    const host = sandbox.domain(6080);
    const url = host.startsWith("http") ? host : `https://${host}`;

    console.log("\n┌──────────────────────────────────────────────────────────");
    console.log("│ 🎬  Open in your browser:");
    console.log(`│   ${url}/vnc_lite.html?autoconnect=1&resize=scale`);
    console.log("│");
    console.log("│ Or embed as iframe:");
    console.log(`│   <iframe src="${url}/vnc_lite.html?autoconnect=1&resize=scale">`);
    console.log("└──────────────────────────────────────────────────────────\n");

    console.log("→ launch headed Chromium → example.com (DISPLAY=:99)");
    await sandbox.runCommand({
      cmd: "node",
      args: ["test.mjs"],
      cwd: "/tmp/test",
      env: { DISPLAY: ":99" },
      detached: true,
    });

    console.log(`→ holding sandbox open for ${KEEPALIVE_MS / 1000}s. Ctrl+C to stop early.`);
    await new Promise((r) => setTimeout(r, KEEPALIVE_MS));
  } finally {
    console.log("→ stopping sandbox");
    await sandbox.stop().catch(() => {});
  }
}

main().catch(async (err) => {
  console.error("\n✗ failed:", err?.message ?? err);
  process.exit(1);
});
