/**
 * Pre-builds a Vercel Sandbox snapshot with all Chromium system deps,
 * the agent's node_modules, and the Playwright Chromium binary ready to go.
 *
 * Without a snapshot, each cafe-creation run installs ~300MB of packages —
 * which takes 30-60s of cold-start. With a snapshot, startup is sub-second.
 *
 * Usage:
 *   npm run snapshot
 *
 * Then set the printed ID as AGENT_BROWSER_SNAPSHOT_ID in your Vercel env.
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { Sandbox } from "@vercel/sandbox";
import ms from "ms";
import { getSandboxCredentials } from "../src/lib/sandbox";

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

async function main() {
  const credentials = getSandboxCredentials();
  console.log("→ creating base sandbox (node24)");
  const sandbox = await Sandbox.create({
    ...credentials,
    runtime: "node24",
    timeout: ms("10m"),
  });

  try {
    console.log("→ installing chromium system libs via dnf");
    await sandbox.runCommand("sh", [
      "-c",
      `sudo dnf clean all 2>&1 && sudo dnf install -y --skip-broken ${CHROMIUM_SYSTEM_DEPS.join(" ")} 2>&1 && sudo ldconfig 2>&1`,
    ]);

    console.log("→ uploading agent source + package.json");
    const root = process.cwd();
    const agentSrc = await readFile(
      path.join(root, "sandbox/agent.mjs"),
      "utf8",
    );
    const agentPkg = await readFile(
      path.join(root, "sandbox/package.json"),
      "utf8",
    );
    const workdir = "/vercel/sandbox/agent";
    await sandbox.writeFiles([
      { path: `${workdir}/agent.mjs`, content: agentSrc },
      { path: `${workdir}/package.json`, content: agentPkg },
    ]);

    console.log("→ npm install (this is the slow part)");
    const npmRes = await sandbox.runCommand({
      cmd: "npm",
      args: ["install", "--no-audit", "--no-fund"],
      cwd: workdir,
    });
    if (npmRes.exitCode !== 0) {
      throw new Error(`npm install failed (${npmRes.exitCode})`);
    }

    console.log("→ playwright install chromium");
    const pwRes = await sandbox.runCommand({
      cmd: "npx",
      args: ["playwright", "install", "chromium"],
      cwd: workdir,
    });
    if (pwRes.exitCode !== 0) {
      throw new Error(`playwright install failed (${pwRes.exitCode})`);
    }

    console.log("→ snapshotting");
    const snapshot = await sandbox.snapshot();
    console.log(`\n✓ Snapshot created: ${snapshot.snapshotId}\n`);
    console.log("Now set it in your Vercel project environment:");
    console.log(
      `  vercel env add AGENT_BROWSER_SNAPSHOT_ID production preview development <<< '${snapshot.snapshotId}'`,
    );
    console.log(
      "  vercel env pull .env.local --yes   # refresh local env",
    );
  } catch (err) {
    await sandbox.stop().catch(() => {});
    throw err;
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
