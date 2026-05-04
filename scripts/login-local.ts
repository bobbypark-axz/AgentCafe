/**
 * Opens a persistent-profile Chromium for the user to log into Daum once.
 *
 * Unlike `npm run seed` (which captures storageState into a one-shot Blob),
 * this writes to a real Chromium profile directory on disk. After a successful
 * login, every local-agent run reuses the same profile — no re-seeding ritual,
 * no Kakao re-verification (same device fingerprint).
 *
 * Default profile dir: ~/.agent-cafe-profile (override with DAUM_PROFILE_DIR).
 *
 * For Sandbox/Vercel deploys, keep using `npm run seed` — those microVMs are
 * fresh on every run and need a portable storageState snapshot from Blob.
 */
import { chromium } from "playwright";
import path from "node:path";
import os from "node:os";
import { mkdir } from "node:fs/promises";

const TARGET_URL = process.env.DAUM_LOGIN_TARGET ?? "https://www.daum.net/";

async function main() {
  const profileDir =
    process.env.DAUM_PROFILE_DIR ??
    path.join(os.homedir(), ".agent-cafe-profile");
  await mkdir(profileDir, { recursive: true });

  console.log(`→ profile dir: ${profileDir}`);
  console.log("→ launching persistent Chromium…");
  const context = await chromium.launchPersistentContext(profileDir, {
    headless: false,
    locale: "ko-KR",
    timezoneId: "Asia/Seoul",
    viewport: { width: 1280, height: 860 },
  });
  const page = context.pages()[0] ?? (await context.newPage());
  await page.goto(TARGET_URL, { waitUntil: "domcontentloaded" });

  console.log(
    "\n────────────────────────────────────────────────────────────────",
  );
  console.log("  Sign in to Daum in the opened window (Kakao / ID+PW / 2FA).");
  console.log("  When you're fully logged in, just close the browser window.");
  console.log("  The profile is saved automatically.");
  console.log(
    "────────────────────────────────────────────────────────────────\n",
  );

  await new Promise<void>((resolve) => {
    context.on("close", () => resolve());
  });
  console.log("✓ profile saved. Local agents will now reuse this login.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
