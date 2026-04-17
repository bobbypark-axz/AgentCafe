/**
 * Demo driver: opens AgentCafe in a headed Chromium, fills the post-writing
 * form with a sample request, and submits. A SECOND Chromium window will
 * appear (spawned by @playwright/mcp) — that's Claude composing the post and
 * posting it to cafe.daum.net in real time.
 */
import { chromium } from "playwright";

const APP_URL = process.env.APP_URL ?? "http://localhost:3000";
const CAFE_URL = process.env.CAFE_URL ?? "https://cafe.daum.net/1232123124";
const TOPIC_HINT = process.env.TOPIC_HINT ?? "";

async function main() {
  console.log(`→ opening ${APP_URL}`);
  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext({
    locale: "ko-KR",
    viewport: { width: 1280, height: 900 },
  });
  const page = await context.newPage();

  await page.goto(APP_URL, { waitUntil: "domcontentloaded" });

  const cafeInput = page.getByPlaceholder("https://cafe.daum.net/your-cafe");
  await cafeInput.click();
  await cafeInput.fill("");
  await cafeInput.pressSequentially(CAFE_URL, { delay: 8 });

  if (TOPIC_HINT) {
    const topicInput = page.getByPlaceholder(
      /^예: 요즘 쓰는/,
    );
    await topicInput.click();
    await topicInput.pressSequentially(TOPIC_HINT, { delay: 10 });
  }

  console.log("→ waiting for submit button to be enabled");
  await page.waitForFunction(
    () => {
      const btn = Array.from(
        document.querySelectorAll("button[type=submit]"),
      ).find((b) => b.textContent?.trim().startsWith("글 쓰고 발행"));
      return btn ? !btn.hasAttribute("disabled") : false;
    },
    null,
    { timeout: 10_000 },
  );

  console.log("→ clicking 글 쓰고 발행");
  await page.getByRole("button", { name: "글 쓰고 발행" }).click();

  console.log(
    "→ submit sent. A second Chromium window should open shortly —",
  );
  console.log(
    "  that's @playwright/mcp, with Claude writing + posting to the cafe.",
  );

  // Keep process + browser alive while the agent runs.
  await new Promise(() => {});
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
