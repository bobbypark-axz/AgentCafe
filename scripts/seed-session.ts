/**
 * Seeds a Daum Cafe authenticated session into Vercel Blob.
 *
 * Runs a headed Chromium locally, opens the Daum login page, and polls the
 * cookie jar until a Daum/Kakao auth cookie appears — at which point we
 * capture `storageState` and upload it to a Blob. No stdin prompt needed,
 * so this can be driven from a non-interactive launcher.
 */
import { chromium } from "playwright";
import { put } from "@vercel/blob";

const DAUM_LOGIN_URL =
  "https://logins.daum.net/accounts/loginform.do?url=https%3A%2F%2Fwww.daum.net%2F";
const DAUM_HOME_URL = "https://www.daum.net";
const DEFAULT_BLOB_KEY = "sessions/daum-storage-state.json";

async function main() {
  const blobToken = process.env.BLOB_READ_WRITE_TOKEN;
  if (!blobToken) {
    throw new Error(
      "BLOB_READ_WRITE_TOKEN is not set. Run `vercel env pull .env.local` after creating a Blob store.",
    );
  }
  const blobKey = process.env.DAUM_SESSION_BLOB_KEY ?? DEFAULT_BLOB_KEY;

  console.log("→ launching Chromium (headed) — a browser window will open");
  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext({
    locale: "ko-KR",
    timezoneId: "Asia/Seoul",
    viewport: { width: 1280, height: 860 },
  });
  const page = await context.newPage();

  console.log("→ navigating to Daum login");
  await page.goto(DAUM_LOGIN_URL, { waitUntil: "domcontentloaded" });

  console.log(
    "\n────────────────────────────────────────────────────────────────",
  );
  console.log("  Sign in to Daum in the opened browser window");
  console.log("  (Kakao OAuth / ID+PW / 2FA — whatever works).");
  console.log(
    "  This script will auto-detect login and save the session itself.",
  );
  console.log(
    "────────────────────────────────────────────────────────────────\n",
  );

  // Only cookies that are set AFTER a successful Kakao/Daum login — not the
  // anonymous tracking cookies (`_T_ANO`, `DAUM_APPAS_RET`, etc.) that appear
  // on the login page itself.
  const LOGIN_COOKIE_PREFIXES = ["_kawlt", "_karmt"] as const;
  const LOGIN_COOKIE_NAMES = new Set(["_KHAID"]);
  const TIMEOUT_MS = 5 * 60 * 1000; // 5 min
  const POLL_MS = 2000;

  const isLoginCookie = (name: string) =>
    LOGIN_COOKIE_NAMES.has(name) ||
    LOGIN_COOKIE_PREFIXES.some((p) => name.startsWith(p));

  console.log("→ waiting for Kakao/Daum login cookies (up to 5 min)…");
  const deadline = Date.now() + TIMEOUT_MS;
  let matched: string[] = [];
  let cancelled = false;
  page.on("close", () => {
    cancelled = true;
  });
  context.on("close", () => {
    cancelled = true;
  });

  while (Date.now() < deadline) {
    if (cancelled) {
      throw new Error(
        "Browser was closed before login completed. Run `npm run seed` again.",
      );
    }
    let cookies;
    try {
      cookies = await context.cookies();
    } catch {
      // Context torn down — surface a clear error.
      throw new Error(
        "Lost access to browser before login completed. Run `npm run seed` again.",
      );
    }
    matched = cookies.map((c) => c.name).filter(isLoginCookie);
    if (matched.length >= 2) break; // need at least _kawlt + _karmt (or similar)
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
  if (matched.length < 2) {
    throw new Error(
      "Timed out waiting for Kakao/Daum login cookies (_kawlt/_karmt/_KHAID). " +
        "Did you actually finish logging in?",
    );
  }
  console.log(`✓ detected login cookies: ${matched.join(", ")}`);

  // Capture storageState from the *current* page before doing anything that
  // could tear the context down. No navigation needed — all auth cookies are
  // already in this context.

  const storageState = await context.storageState();
  const serialised = JSON.stringify(storageState);
  console.log(
    `→ captured ${storageState.cookies.length} cookies, ${storageState.origins.length} origins`,
  );

  console.log(`→ uploading to Vercel Blob at ${blobKey}`);
  const blob = await put(blobKey, serialised, {
    access: "public", // stored at a random URL; see note below
    addRandomSuffix: false,
    allowOverwrite: true,
    contentType: "application/json",
    token: blobToken,
  });

  console.log("\n✓ Session saved");
  console.log(`  blob.url      = ${blob.url}`);
  console.log(`  blob.pathname = ${blob.pathname}`);
  console.log(
    "\nNote: @vercel/blob's `access: 'public'` means anyone with the URL can read it.\n" +
      "The URL itself is the secret — do not share it. For stricter isolation use\n" +
      "`access: 'private'` (beta) and read via `get()` from the agent.\n",
  );

  await browser.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
