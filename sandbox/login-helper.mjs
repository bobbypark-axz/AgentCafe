/**
 * Login helper — runs inside Vercel Sandbox.
 *
 * Opens Chromium, navigates to Kakao login, fills credentials,
 * then enters a loop: takes screenshots, watches for user commands
 * (type, click, press) via /tmp/command.json, and waits for a
 * /tmp/done signal to capture storageState.
 *
 * Communication is file-based:
 *   /tmp/screenshot.b64   — latest screenshot (base64 PNG)
 *   /tmp/command.json      — next command to execute (deleted after read)
 *   /tmp/done              — signal to save session and exit
 *   /tmp/storageState.json — captured session (written on done)
 *   /tmp/ready             — signals the helper is ready
 *   /tmp/status.json       — current page URL + title
 */
import { chromium } from "playwright";
import { writeFile, readFile, unlink, access } from "node:fs/promises";

const SCREENSHOT_PATH = "/tmp/screenshot.b64";
const COMMAND_PATH = "/tmp/command.json";
const DONE_PATH = "/tmp/done";
const STATE_PATH = "/tmp/storageState.json";
const READY_PATH = "/tmp/ready";
const STATUS_PATH = "/tmp/status.json";

const DAUM_EMAIL = process.env.DAUM_EMAIL || "";
const DAUM_PASSWORD = process.env.DAUM_PASSWORD || "";
const STORAGE_STATE_PATH = process.env.STORAGE_STATE_PATH || "";

async function fileExists(p) {
  try { await access(p); return true; } catch { return false; }
}

async function main() {
  console.log("[login-helper] launching browser");
  const browser = await chromium.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  });

  const contextOptions = {
    viewport: { width: 1280, height: 900 },
    locale: "ko-KR",
    timezoneId: "Asia/Seoul",
  };

  // Load existing storageState if available
  if (STORAGE_STATE_PATH && await fileExists(STORAGE_STATE_PATH)) {
    try {
      const raw = await readFile(STORAGE_STATE_PATH, "utf8");
      contextOptions.storageState = JSON.parse(raw);
      console.log("[login-helper] loaded existing storageState");
    } catch (e) {
      console.log("[login-helper] failed to load storageState:", e.message);
    }
  }

  const context = await browser.newContext(contextOptions);
  const page = await context.newPage();

  // Navigate to Kakao login
  console.log("[login-helper] navigating to Kakao login");
  const loginUrl = "https://accounts.kakao.com/login/?continue=https%3A%2F%2Flogins.daum.net%2Faccounts%2Fksso.do%3Frescue%3Dtrue%26url%3Dhttps%253A%252F%252Fwww.daum.net%252F";
  await page.goto(loginUrl, { waitUntil: "domcontentloaded", timeout: 30000 });
  await page.waitForTimeout(2000);

  // Fill credentials if available
  if (DAUM_EMAIL) {
    console.log("[login-helper] filling credentials");
    try {
      // Try to find and fill the email field
      const emailInput = page.locator('input[name="loginId"], input[id="loginId--1"], input[type="email"], input[placeholder*="이메일"], input[placeholder*="카카오메일"]');
      if (await emailInput.count() > 0) {
        await emailInput.first().fill(DAUM_EMAIL);
        await page.waitForTimeout(500);
      }

      // Fill password
      const pwInput = page.locator('input[name="password"], input[id="password--2"], input[type="password"]');
      if (await pwInput.count() > 0) {
        await pwInput.first().fill(DAUM_PASSWORD);
        await page.waitForTimeout(500);
      }

      // Click login button
      const loginBtn = page.locator('button[type="submit"], button:has-text("로그인")');
      if (await loginBtn.count() > 0) {
        await loginBtn.first().click();
        console.log("[login-helper] clicked login button");
        await page.waitForTimeout(3000);
      }
    } catch (e) {
      console.log("[login-helper] credential fill error:", e.message);
    }
  }

  // Take initial screenshot and signal ready
  await takeScreenshot(page);
  await writeStatus(page);
  await writeFile(READY_PATH, "ok");
  console.log("[login-helper] ready, entering main loop");

  // Main loop
  let loopCount = 0;
  const MAX_LOOPS = 300; // 5 min at 1s interval
  while (loopCount < MAX_LOOPS) {
    loopCount++;

    // Take screenshot
    await takeScreenshot(page);
    await writeStatus(page);

    // Check for command
    if (await fileExists(COMMAND_PATH)) {
      try {
        const raw = await readFile(COMMAND_PATH, "utf8");
        await unlink(COMMAND_PATH);
        const cmd = JSON.parse(raw);
        console.log("[login-helper] executing command:", cmd.action);

        if (cmd.action === "type") {
          await page.keyboard.type(cmd.text || "", { delay: 50 });
        } else if (cmd.action === "click") {
          await page.mouse.click(cmd.x, cmd.y);
        } else if (cmd.action === "press") {
          await page.keyboard.press(cmd.key || "Enter");
        } else if (cmd.action === "navigate") {
          await page.goto(cmd.url, { waitUntil: "domcontentloaded", timeout: 15000 });
        } else if (cmd.action === "fill") {
          const el = page.locator(cmd.selector);
          if (await el.count() > 0) {
            await el.first().fill(cmd.text || "");
          }
        }

        await page.waitForTimeout(1000);
        await takeScreenshot(page);
        await writeStatus(page);
      } catch (e) {
        console.log("[login-helper] command error:", e.message);
      }
    }

    // Check for done signal
    if (await fileExists(DONE_PATH)) {
      console.log("[login-helper] done signal received, saving storageState");
      const state = await context.storageState();
      await writeFile(STATE_PATH, JSON.stringify(state));
      await writeFile(DONE_PATH, "saved");
      break;
    }

    await new Promise((r) => setTimeout(r, 1000));
  }

  console.log("[login-helper] shutting down");
  await browser.close();
}

async function takeScreenshot(page) {
  try {
    const buf = await page.screenshot({ type: "png" });
    await writeFile(SCREENSHOT_PATH, buf.toString("base64"));
  } catch (e) {
    console.log("[login-helper] screenshot error:", e.message);
  }
}

async function writeStatus(page) {
  try {
    await writeFile(STATUS_PATH, JSON.stringify({
      url: page.url(),
      title: await page.title(),
    }));
  } catch { /* ignore */ }
}

main().catch((err) => {
  console.error("[login-helper] fatal:", err);
  process.exit(1);
});
