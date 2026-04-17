/**
 * Login helper — runs inside Vercel Sandbox.
 *
 * 1. Opens Chromium, navigates to Kakao login
 * 2. Fills email/password automatically
 * 3. Detects 2FA screen → writes "2fa" to /tmp/status
 * 4. Waits for /tmp/code file (user's 2FA code)
 * 5. Types the code, completes login
 * 6. Saves storageState to /tmp/storageState.json
 *
 * File-based IPC:
 *   /tmp/status   — "filling" | "2fa" | "done" | "error:message"
 *   /tmp/code     — 2FA code written by the API when user submits
 *   /tmp/storageState.json — captured session
 *   /tmp/ready    — signals the helper is running
 */
import { chromium } from "playwright-core";
import { writeFile, readFile, access } from "node:fs/promises";

const DAUM_EMAIL = process.env.DAUM_EMAIL || "";
const DAUM_PASSWORD = process.env.DAUM_PASSWORD || "";

async function fileExists(p) {
  try { await access(p); return true; } catch { return false; }
}

async function setStatus(s) {
  await writeFile("/tmp/status", s);
  console.log(`[status] ${s}`);
}

async function main() {
  const browser = await chromium.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  });
  const context = await browser.newContext({
    viewport: { width: 1280, height: 900 },
    locale: "ko-KR",
    timezoneId: "Asia/Seoul",
  });
  const page = await context.newPage();

  await writeFile("/tmp/ready", "ok");
  await setStatus("filling");

  // Navigate to Kakao login
  const loginUrl = "https://accounts.kakao.com/login/?continue=https%3A%2F%2Flogins.daum.net%2Faccounts%2Fksso.do%3Frescue%3Dtrue%26url%3Dhttps%253A%252F%252Fwww.daum.net%252F";
  await page.goto(loginUrl, { waitUntil: "domcontentloaded", timeout: 30000 });
  await page.waitForTimeout(2000);

  // Fill credentials
  if (DAUM_EMAIL) {
    try {
      const emailInput = page.locator('input[name="loginId"], input[id="loginId--1"], input[type="email"], input[placeholder*="이메일"], input[placeholder*="카카오"]');
      if (await emailInput.count() > 0) {
        await emailInput.first().click();
        await emailInput.first().fill(DAUM_EMAIL);
        await page.waitForTimeout(300);
      }

      const pwInput = page.locator('input[name="password"], input[id="password--2"], input[type="password"]');
      if (await pwInput.count() > 0) {
        await pwInput.first().click();
        await pwInput.first().fill(DAUM_PASSWORD);
        await page.waitForTimeout(300);
      }

      const loginBtn = page.locator('button[type="submit"], button:has-text("로그인")');
      if (await loginBtn.count() > 0) {
        await loginBtn.first().click();
        console.log("[login-helper] clicked login button, waiting for response...");
        await page.waitForTimeout(5000);
      }
    } catch (e) {
      console.log("[login-helper] credential fill error:", e.message);
    }
  }

  // Check current state: did we land on 2FA or are we logged in?
  const currentUrl = page.url();
  console.log("[login-helper] current URL:", currentUrl);

  // Check if we're on daum.net (login success) or still on kakao (2FA needed)
  if (currentUrl.includes("daum.net") && !currentUrl.includes("accounts.kakao")) {
    // Already logged in
    await saveAndExit(context, browser);
    return;
  }

  // Likely 2FA screen — signal and wait for code
  await setStatus("2fa");
  console.log("[login-helper] 2FA detected, waiting for /tmp/code...");

  // Wait up to 5 minutes for the code
  for (let i = 0; i < 300; i++) {
    if (await fileExists("/tmp/code")) {
      const code = (await readFile("/tmp/code", "utf8")).trim();
      console.log("[login-helper] received code, typing...");
      await setStatus("submitting");

      // Type the code into the current page
      // Kakao 2FA usually has an input for the verification code
      try {
        const codeInput = page.locator('input[type="tel"], input[type="number"], input[type="text"][maxlength], input[placeholder*="인증"], input[name="code"]');
        if (await codeInput.count() > 0) {
          await codeInput.first().click();
          await codeInput.first().fill(code);
          await page.waitForTimeout(500);

          // Click confirm/submit button
          const confirmBtn = page.locator('button[type="submit"], button:has-text("확인"), button:has-text("인증")');
          if (await confirmBtn.count() > 0) {
            await confirmBtn.first().click();
          }
        } else {
          // Fallback: just type the code and press Enter
          await page.keyboard.type(code, { delay: 50 });
          await page.keyboard.press("Enter");
        }

        await page.waitForTimeout(5000);

        // Check if login succeeded
        const afterUrl = page.url();
        if (afterUrl.includes("daum.net") && !afterUrl.includes("accounts.kakao")) {
          await saveAndExit(context, browser);
          return;
        }

        // Maybe there's another step — wait a bit more
        await page.waitForTimeout(3000);
        await saveAndExit(context, browser);
        return;
      } catch (e) {
        await setStatus(`error:${e.message}`);
        break;
      }
    }
    await new Promise((r) => setTimeout(r, 1000));
  }

  await setStatus("error:timeout waiting for 2FA code");
  await browser.close();
}

async function saveAndExit(context, browser) {
  const state = await context.storageState();
  await writeFile("/tmp/storageState.json", JSON.stringify(state));
  await setStatus("done");
  console.log(`[login-helper] saved ${state.cookies.length} cookies`);
  await browser.close();
}

main().catch(async (err) => {
  console.error("[login-helper] fatal:", err);
  await setStatus(`error:${err.message}`).catch(() => {});
  process.exit(1);
});
