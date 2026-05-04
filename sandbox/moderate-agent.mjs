/**
 * AgentCafe — sandbox moderation agent.
 *
 * Runs inside a Vercel Sandbox microVM (headless Chromium).
 * Scans recent posts/comments on a Daum cafe the logged-in user runs,
 * detects violations against a keyword list or general abusive behavior,
 * and — if not in dry-run — executes 차단/정지 via the cafe's moderation UI.
 *
 * The operator MUST be a cafe manager/운영자 for actions to be available.
 *
 * Environment (injected by the calling Next.js route):
 *   SESSION_BLOB_URL  Blob URL to storageState.json
 *   CAFE_URL          target cafe URL, e.g. https://cafe.daum.net/your-cafe
 *   BOARD_HINT        optional board name (picks most active if empty)
 *   KEYWORDS          comma-separated keyword list
 *   ACTION            "3일 정지" | "7일 정지" | "영구 차단"
 *   DRY_RUN           "1" | "0"
 *   MAX_POSTS         how many recent posts to scan (default 10)
 *   MAX_ACTIONS       cap for actual ban/suspend clicks (default 5)
 *   MODEL_ID          e.g. "anthropic/claude-sonnet-4.6"
 */
import { writeFile } from "node:fs/promises";
import process from "node:process";
import { ToolLoopAgent, stepCountIs } from "ai";
import { createMCPClient } from "@ai-sdk/mcp";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { anthropic } from "@ai-sdk/anthropic";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";

function emit(kind, payload) {
  process.stdout.write(
    JSON.stringify({ t: Date.now(), kind, ...payload }) + "\n",
  );
}

// Priority: BizRouter (OpenAI-compatible) → direct Anthropic → AI Gateway.
function resolveModel(id) {
  if (process.env.BIZROUTER_API_KEY) {
    // `||` (truthy) — env passes empty strings for unset values which `??`
    // would accept as real, sending model:'' and getting 404.
    const baseURL =
      process.env.BIZROUTER_BASE_URL || "https://bizrouter.ai/api/v1";
    const bizrouter = createOpenAICompatible({
      name: "bizrouter",
      apiKey: process.env.BIZROUTER_API_KEY,
      baseURL,
    });
    // BizRouter catalog uses vendor-prefixed slugs verbatim
    // (e.g. "anthropic/claude-sonnet-4.6"). Don't strip the prefix.
    const modelId =
      process.env.BIZROUTER_MODEL_ID || id || "anthropic/claude-sonnet-4.6";
    emit("phase", { message: `using BizRouter: ${baseURL} · ${modelId}` });
    return bizrouter(modelId);
  }
  if (process.env.ANTHROPIC_API_KEY) {
    const raw = (id ?? "anthropic/claude-sonnet-4.6").replace(/^anthropic\//, "");
    return anthropic(raw.replace(/\./g, "-"));
  }
  return id ?? "anthropic/claude-sonnet-4.6";
}

async function main() {
  const {
    SESSION_BLOB_URL,
    CAFE_URL,
    BOARD_HINT = "",
    KEYWORDS = "",
    ACTION = "3일 정지",
    DRY_RUN = "1",
    MAX_POSTS = "10",
    MAX_ACTIONS = "5",
    MODEL_ID = "anthropic/claude-sonnet-4.6",
    DAUM_EMAIL = "",
    DAUM_PASSWORD = "",
  } = process.env;

  if (!SESSION_BLOB_URL) throw new Error("SESSION_BLOB_URL is required");
  if (!CAFE_URL) throw new Error("CAFE_URL is required");

  const dryRun = DRY_RUN === "1";
  const maxPosts = Math.max(1, parseInt(MAX_POSTS, 10) || 10);
  const maxActions = Math.max(0, parseInt(MAX_ACTIONS, 10) || 5);
  const keywordList = KEYWORDS.split(",")
    .map((k) => k.trim())
    .filter(Boolean);

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

  const boardGuide = BOARD_HINT
    ? `Target board (navigate into this one first): ${JSON.stringify(BOARD_HINT)}.`
    : "No specific board specified — pick the most recently active free-talk / 자유게시판.";

  const keywordGuide = keywordList.length
    ? `Flag any post or comment whose text contains any of these substrings (case-insensitive): ${JSON.stringify(keywordList)}.`
    : "No explicit keywords — flag only clear abusive/spam/insulting/promotional content.";

  const modeGuide = dryRun
    ? "DRY-RUN MODE: you MUST NOT click any ban/suspend button. Only detect and report."
    : `LIVE MODE: after detecting, you MAY execute moderation. Cap actual moderation actions at ${maxActions}. Skip any case you are unsure about.`;

  const instructions = `
You are AgentCafe-Moderator. You are operating on behalf of the cafe manager
(운영자) of ${CAFE_URL}. The browser has storageState loaded so you are
already logged in as that manager.

${modeGuide}

STEP 1 — Navigate.
  - browser_navigate to ${CAFE_URL}.
  - browser_snapshot to orient yourself.
  - Confirm you are logged in. If a "로그인" button shows, STOP and emit
    an error saying "session expired".
  - Confirm you appear to have manager privileges. A quick cue: the cafe
    management entry (관리 / 카페관리 / 스태프메뉴) is visible. If nothing
    manager-ish is visible after 2 snapshots, STOP and report "not a manager".

STEP 2 — Enter a board.
  ${boardGuide}
  - Click into the board list in the left sidebar, pick the target board.
  - You only need the latest ${maxPosts} posts. Don't paginate further.

STEP 3 — Scan each post.
  For each of the latest ${maxPosts} posts (newest first):
    a) Open the post (new tab not needed — just navigate).
    b) browser_snapshot. Capture: postUrl, author nickname, title,
       first ~500 chars of body.
    c) If comments exist, expand/scroll and capture commenter nickname +
       comment text for each comment (cap at ~30 comments per post).
    d) ${keywordGuide}
    e) For each match, emit a single line to stdout in this exact JSON form:
         {"kind":"violation","postUrl":"...","author":"...","where":"body|comment",
          "matched":["keyword1",...],"snippet":"...", "reason":"short reason"}
       (A tool you have access to is to just write to stdout via your reasoning —
        emit these as regular reasoning chunks prefixed with VIOLATION_JSON: )
    f) Go back to the board list for the next post.

STEP 4 — Execute actions (LIVE MODE only).
  ${dryRun ? "  — skipped, dry-run." : `
  Pick up to ${maxActions} most severe detections and execute:
    a) Open the offending post.
    b) Click the author's nickname (or the ⋯/더보기 menu beside their name).
    c) A menu should offer "회원 차단", "회원 제재", or similar.
    d) Choose: "${ACTION}". If exact option missing, pick the closest.
    e) Provide a brief reason if a reason field appears
       (e.g. "카페 규칙 위반 — [matched keyword]").
    f) Confirm. browser_snapshot to verify the success toast or notice.
    g) Emit: ACTION_JSON: {"kind":"action","postUrl":"...","author":"...",
             "action":"${ACTION}","success":true|false,"error":"if any"}
    h) If any step raises a permission error or the menu item is missing,
       emit an action with success=false and move on.
  Never attempt the same author twice in one run.
  `}

STEP 5 — Final report.
  One concise paragraph summary including:
    - board scanned, how many posts read
    - how many violations detected
    - how many actions executed (dry-run: 0)
    - any notes / skipped cases

GUARDRAILS
  - Stay on daum.net / cafe.daum.net.
  - Read-only outside the banning click sequence.
  - If DRY_RUN, NEVER click a ban/suspend/정지/차단 button.
  - If anything looks like a captcha / "의심스러운 접속" / unexpected popup,
    stop and report.
  - Prefer browser_snapshot over browser_screenshot.
  - If you cannot find the specified action option "${ACTION}", report, don't
    guess a more severe alternative.
  - If the session is actually logged out despite storageState, you may
    retry login ONCE with: DAUM_EMAIL=${JSON.stringify(DAUM_EMAIL)}
    DAUM_PASSWORD=${JSON.stringify(DAUM_PASSWORD)}. If 2FA blocks, stop.
`.trim();

  const agent = new ToolLoopAgent({
    model: resolveModel(MODEL_ID),
    instructions,
    tools,
    stopWhen: stepCountIs(60),
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

  emit("phase", {
    message: `moderator starting (${dryRun ? "DRY-RUN" : "LIVE"}, action="${ACTION}", posts<=${maxPosts}, actions<=${maxActions})`,
  });

  try {
    const result = await agent.stream({
      prompt: `Scan and (if live) moderate now.`,
    });

    let final = "";
    for await (const chunk of result.textStream) {
      final += chunk;
      emit("chunk", { text: chunk });

      // Re-emit structured rows the agent wrote into its reasoning.
      const vMatches = chunk.matchAll(/VIOLATION_JSON:\s*(\{[^\n]+\})/g);
      for (const m of vMatches) {
        try { emit("violation", JSON.parse(m[1])); } catch { /* ignore */ }
      }
      const aMatches = chunk.matchAll(/ACTION_JSON:\s*(\{[^\n]+\})/g);
      for (const m of aMatches) {
        try { emit("action", JSON.parse(m[1])); } catch { /* ignore */ }
      }
    }

    emit("done", { summary: final, dryRun });
  } finally {
    await mcpClient.close();
  }
}

main().catch((err) => {
  emit("error", { message: String(err?.message ?? err), stack: err?.stack });
  process.exit(1);
});
