/**
 * Attaches to a running sandbox by ID and probes why Xvnc/websockify
 * aren't binding their ports. Pass the sandboxId as the first argument.
 *
 *   npx tsx scripts/debug-vnc.ts sbx_xxxxx
 */
import { Sandbox } from "@vercel/sandbox";

async function main() {
  const sandboxId = process.argv[2];
  if (!sandboxId) {
    console.error("usage: tsx scripts/debug-vnc.ts <sandboxId>");
    process.exit(1);
  }

  const sandbox = await Sandbox.get({ sandboxId });
  console.log(`→ attached to ${sandbox.sandboxId} (status=${sandbox.status})`);

  const probes: Array<[string, string]> = [
    ["which Xvnc; which websockify; which python3",
     "binary locations"],
    ["ps -ef | grep -E 'Xvnc|websockify' | grep -v grep || echo NONE",
     "running VNC processes"],
    ["ss -tln 2>&1 | head -20",
     "all listening ports"],
    ["Xvnc :99 -geometry 1280x800 -depth 24 -SecurityTypes None -localhost no -AlwaysShared 2>&1 & sleep 2; ps -ef | grep -v grep | grep Xvnc; ss -tln | grep 5999; pkill -f 'Xvnc :99' 2>/dev/null; echo DONE",
     "foreground Xvnc test"],
    ["Xvnc :99 -rfbport 5999 -geometry 1280x800 -depth 24 -SecurityTypes None 2>&1 & sleep 2; ss -tln | grep 5999; pkill -f 'Xvnc :99' 2>/dev/null; echo DONE",
     "Xvnc with explicit -rfbport"],
    ["echo '=stderr first 30 lines='; (Xvnc :99 -geometry 1280x800 -depth 24 -SecurityTypes None 2>&1 || true) | head -30",
     "Xvnc actual stderr"],
  ];

  for (const [cmd, label] of probes) {
    console.log(`\n--- ${label} ---`);
    const r = await sandbox.runCommand("sh", ["-c", cmd]);
    const out = (await r.stdout()).trim();
    const err = (await r.stderr()).trim();
    if (out) console.log(out);
    if (err) console.log("[stderr]", err);
    console.log(`(exit ${r.exitCode})`);
  }
}

main().catch((err) => {
  console.error("✗", err?.message ?? err);
  process.exit(1);
});
