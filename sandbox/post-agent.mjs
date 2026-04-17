/**
 * AgentCafe — sandbox post-writing agent.
 *
 * Runs inside a Vercel Sandbox microVM (headless Chromium).
 * Composes a computer-related post and publishes it to the given Daum cafe.
 *
 * Environment (injected by the calling Next.js route):
 *   SESSION_BLOB_URL  public (secret-by-URL) Blob URL to storageState.json
 *   CAFE_URL          target cafe URL, e.g. https://cafe.daum.net/your-cafe
 *   TOPIC_HINT        optional topic seed
 *   LENGTH            "short" | "medium" | "long"
 *   TONE              optional tone hint
 *   MODEL_ID          e.g. "anthropic/claude-sonnet-4.6"
 */
import { writeFile } from "node:fs/promises";
import process from "node:process";
import { ToolLoopAgent, stepCountIs } from "ai";
import { createMCPClient } from "@ai-sdk/mcp";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { anthropic } from "@ai-sdk/anthropic";

function emit(kind, payload) {
  process.stdout.write(
    JSON.stringify({ t: Date.now(), kind, ...payload }) + "\n",
  );
}

async function main() {
  const {
    SESSION_BLOB_URL,
    CAFE_URL,
    TOPIC_HINT = "",
    LENGTH = "medium",
    TONE = "",
    MODEL_ID = "anthropic/claude-sonnet-4.6",
  } = process.env;

  if (!SESSION_BLOB_URL) throw new Error("SESSION_BLOB_URL is required");
  if (!CAFE_URL) throw new Error("CAFE_URL is required");

  // Resolve model: direct Anthropic provider if API key available, otherwise AI Gateway
  function resolveModel(id) {
    if (process.env.ANTHROPIC_API_KEY) {
      const raw = (id ?? "anthropic/claude-sonnet-4.6").replace(/^anthropic\//, "");
      return anthropic(raw.replace(/\./g, "-"));
    }
    return id ?? "anthropic/claude-sonnet-4.6";
  }

  emit("phase", { message: "downloading storageState" });
  const res = await fetch(SESSION_BLOB_URL);
  if (!res.ok) {
    throw new Error(
      `failed to fetch storageState: ${res.status} ${res.statusText}`,
    );
  }
  const storageStatePath = "/tmp/daum-storage-state.json";
  await writeFile(storageStatePath, await res.text(), "utf8");
  emit("phase", { message: "storageState ready" });

  emit("phase", { message: "starting playwright-mcp (headless)" });
  const mcpClient = await createMCPClient({
    transport: new StdioClientTransport({
      command: "npx",
      args: [
        "-y",
        "@playwright/mcp@latest",
        "--headless",
        "--browser",
        "chromium",
        "--storage-state",
        storageStatePath,
        "--viewport-size",
        "1280,900",
        "--isolated",
      ],
      stderr: "inherit",
      env: Object.fromEntries(
        Object.entries(process.env).filter(([, v]) => v !== undefined),
      ),
    }),
  });

  const tools = await mcpClient.tools();
  emit("phase", {
    message: "mcp tools discovered",
    tools: Object.keys(tools),
  });

  const lengthGuide =
    LENGTH === "short"
      ? "150~250 characters"
      : LENGTH === "long"
        ? "600~900 characters"
        : "350~550 characters";

  const toneGuide = TONE
    ? `Lean into this tone: ${TONE}.`
    : "Casual, friendly, relatable — the voice of someone sharing something interesting with cafe members.";

  const topicGuide = TOPIC_HINT
    ? `Topic seed (use this as a jumping-off point — you may refine): ${JSON.stringify(TOPIC_HINT)}`
    : "Pick your own computer-related angle: a recent tech trend, a productivity tip, software you'd recommend, a hardware unboxing/review, a coding lesson, AI news, keyboard/mouse setup, home lab, linux tip — anything tech-y and genuinely interesting.";

  const instructions = `
You are AgentCafe-Writer. Compose and publish ONE computer-related post to
the Daum Cafe at ${CAFE_URL}. The browser has storageState loaded so
you are already logged in.

STEP 1 — Invent the content (do this in your reasoning, BEFORE calling tools).
  ${topicGuide}
  Produce FRESH, SPECIFIC computer-info content — pick something concrete and
  current, not abstract. Think: recent GPU launches, specific useful VS Code
  extensions, a Claude/ChatGPT workflow trick, a specific Linux command, a
  Raspberry Pi project idea, a keyboard review with actual model numbers,
  a tip for cleaning up Windows 11, a comparison between M3 and M4 Macs, etc.
  Grounded and actionable beats generic.

  Produce:
    - title   : one catchy Korean line, 15–30 characters. Natural cafe-style —
                can use ㅎㅎ, ㅠㅠ, ~, !, ?, [정보], [꿀팁], [질문] tags if
                fitting. Not clickbait, not formal.
    - body    : ${lengthGuide} of natural Korean, casual cafe tone. Real people
                writing patterns:
                  · 안녕하세요 or bare intro — no need for both
                  · "저는", "제가" first-person framing
                  · Short paragraphs (2-4 lines each), blank line between
                  · "~요", "~에요", "~더라구요", "~네요" endings — NOT "~다"
                  · 1–3 emojis total, sprinkled, not clustered
                  · Specific numbers/models/commands where relevant
                  · Close with a light CTA: "써보신 분 있나요?", "댓글로 알려주세요!",
                    "저만 이런 건지 ㅠㅠ", "의견 부탁드려요!" — pick ONE
                  · NO headings like "## 1. 서론". Just prose.
                  · NO markdown. Plain text only.
  ${toneGuide}

STEP 2 — Navigate the cafe.
  - browser_navigate to ${CAFE_URL}
  - browser_snapshot to orient yourself.
  - Look for the 글쓰기 (write) button. On Daum cafes this might be:
      · A "글쓰기" link in the left sidebar board list
      · A "+" / 글쓰기 button at the top of the board page
      · Need to click into a specific board first (e.g., "자유게시판") and
        then the write button appears
  - If presented with a board picker, choose a board that looks appropriate
    for computer/tech content — e.g. a free-talk board, a tech board, or the
    most recently-active board. Prefer 자유게시판 / 잡담 if multiple options.

STEP 3 — Fill the editor.
  - Title field: fill with your invented title.
  - Body editor: this is usually a WYSIWYG contenteditable. Click into it
    first, then type the body. If browser_type doesn't land in the iframe,
    try a few focus strategies (click inside the editor area, press Tab into
    it, etc.).

STEP 4 — Submit.
  - Click the final 등록 / 올리기 / 작성완료 button.
  - browser_snapshot again. Confirm the post appears on the page.
  - Capture the post URL if visible.

STEP 5 — Report.
  - One concise paragraph summary: what you wrote, where you posted it.
  - Include the post URL on its own final line as:  URL: https://...

GUARDRAILS
  - Stay on daum.net / cafe.daum.net.
  - No promotional, political, hateful, or spam content.
  - If you hit a login screen, captcha, or "의심스러운 접속" — stop, report.
  - If no board allows writing (permission error), stop and report which.
  - Prefer browser_snapshot over browser_screenshot.
`.trim();

  const agent = new ToolLoopAgent({
    model: resolveModel(MODEL_ID),
    instructions,
    tools,
    stopWhen: stepCountIs(50),
    onStepFinish: async ({ stepNumber, finishReason, toolCalls, usage }) => {
      emit("step", {
        stepNumber,
        finishReason,
        toolsUsed: toolCalls?.map((tc) => tc.toolName) ?? [],
        inputTokens: usage?.inputTokens,
        outputTokens: usage?.outputTokens,
      });
    },
  });

  emit("phase", { message: "agent starting (headless)" });

  try {
    const result = await agent.stream({
      prompt: `Write and publish the post now.`,
    });

    let final = "";
    for await (const chunk of result.textStream) {
      final += chunk;
      emit("chunk", { text: chunk });
    }

    const urlMatch = final.match(/URL:\s*(https?:\S+)/i);
    emit("done", {
      summary: final,
      postUrl: urlMatch ? urlMatch[1] : null,
    });
  } finally {
    await mcpClient.close();
  }
}

main().catch((err) => {
  emit("error", { message: String(err?.message ?? err), stack: err?.stack });
  process.exit(1);
});
