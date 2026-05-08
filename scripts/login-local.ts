/**
 * Opens a persistent-profile Chromium for the user to log into Daum once.
 *
 * Writes to a real Chromium profile directory on disk. After a successful
 * login, every local-agent run reuses the same profile — no re-seeding ritual,
 * no Kakao re-verification (same device fingerprint).
 *
 * Default profile dir: ~/.agent-cafe-profile (override with DAUM_PROFILE_DIR).
 *
 * IMPORTANT: stop any running dev server first — Chromium can't open the same
 * profile dir from two processes.
 */
import { chromium } from "playwright";
import path from "node:path";
import os from "node:os";
import { mkdir, writeFile } from "node:fs/promises";

const TARGET_URL = process.env.DAUM_LOGIN_TARGET ?? "https://www.daum.net/";

async function main() {
  const profileDir =
    process.env.DAUM_PROFILE_DIR ??
    path.join(os.homedir(), ".agent-cafe-profile");
  await mkdir(profileDir, { recursive: true });
  const storageStatePath = path.join(profileDir, "storage-state.json");

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
  console.log("  When fully logged in, close the browser window.");
  console.log(
    "────────────────────────────────────────────────────────────────\n",
  );

  // Capture storageState BEFORE the context closes — it's the bridge that
  // @playwright/mcp consumes via --storage-state. Profile dir alone does not
  // work cross-binary (login uses playwright's chromium, MCP uses
  // chrome-for-testing — different versions, different profile schemas).
  let captured = false;
  context.on("page", () => {
    /* keep alive until close */
  });

  // Poll: when the user navigates to a logged-in page, capture cookies.
  const captureLoop = async () => {
    while (!captured) {
      await new Promise((r) => setTimeout(r, 2000));
      try {
        const cookies = await context.cookies();
        const hasKakaoAuth = cookies.some(
          (c) =>
            c.name === "_kawlt" ||
            c.name === "_karmt" ||
            c.name === "_KHAID" ||
            c.name.startsWith("_kawlt"),
        );
        if (hasKakaoAuth) {
          const state = await context.storageState();
          await writeFile(
            storageStatePath,
            JSON.stringify(state),
            "utf8",
          );
          console.log(
            `✓ captured ${state.cookies.length} cookies → ${storageStatePath}`,
          );
          captured = true;
        }
      } catch {
        /* context might be closing */
      }
    }
  };
  void captureLoop();

  await new Promise<void>((resolve) => {
    context.on("close", () => resolve());
  });

  if (!captured) {
    console.log(
      "⚠ no Daum/Kakao auth cookies detected before close — try again.",
    );
    process.exit(1);
  }
  console.log("✓ profile + storageState saved. Local agents will reuse it.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
