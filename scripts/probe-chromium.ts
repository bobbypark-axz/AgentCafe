/**
 * Lists running sandboxes and probes the most recent one for chromium
 * process status — DISPLAY env, listening on Xvnc, headless flag, etc.
 *
 *   npx tsx scripts/probe-chromium.ts
 */
import { Sandbox } from "@vercel/sandbox";

async function main() {
  const { json } = await Sandbox.list({ limit: 5 });
  const running = json.sandboxes.filter((s) => s.status === "running");
  if (running.length === 0) {
    console.log("no running sandboxes");
    return;
  }
  const target = running[0];
  console.log(`→ probing ${target.id} (created ${target.createdAt})`);

  const sandbox = await Sandbox.get({ sandboxId: target.id });

  const probes: Array<[string, string]> = [
    [
      "all chromium / chrome processes (with DISPLAY env)",
      "for pid in $(pgrep -f 'chrom|chrome'); do echo '--- PID '$pid' ---'; cat /proc/$pid/cmdline | tr '\\0' ' '; echo; cat /proc/$pid/environ | tr '\\0' '\\n' | grep -E 'DISPLAY|HEADLESS|XAUTH'; done | head -80",
    ],
    [
      "Xvnc + websockify status",
      "pgrep -fa 'Xvnc|websockify'",
    ],
    [
      "active VNC connections",
      "lsof -i :5999 2>/dev/null | head -10 || echo 'lsof unavailable'",
    ],
    [
      "Xvnc framebuffer activity (xdpyinfo / xwd)",
      "DISPLAY=:99 xdpyinfo 2>&1 | head -10 || echo 'xdpyinfo not available'",
    ],
    [
      "what window manager / clients are connected to :99",
      "DISPLAY=:99 xlsclients 2>&1 || echo 'xlsclients not available'",
    ],
  ];

  for (const [label, cmd] of probes) {
    console.log(`\n--- ${label} ---`);
    const r = await sandbox.runCommand("sh", ["-c", cmd]);
    const out = (await r.stdout()).trim();
    const err = (await r.stderr()).trim();
    if (out) console.log(out);
    if (err) console.log("[stderr]", err);
  }
}

main().catch((err) => {
  console.error("✗", err?.message ?? err);
  process.exit(1);
});
