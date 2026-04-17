/**
 * AgentCafe — sandbox agent entrypoint.
 *
 * Runs inside a Vercel Sandbox microVM. Orchestrates:
 *   1. Pulls the Daum authenticated storageState JSON from Vercel Blob.
 *   2. Starts @playwright/mcp over stdio with that storageState loaded.
 *   3. Connects the AI SDK MCP client to it and hands the resulting tools to
 *      a ToolLoopAgent backed by Claude via the Vercel AI Gateway.
 *   4. Streams structured progress lines to stdout for the parent process to
 *      forward to the browser UI.
 *
 * Environment (injected by the calling Next.js route):
 *   SESSION_BLOB_URL    public (secret-by-URL) Blob URL to storageState.json
 *   CAFE_NAME           name of the cafe to create
 *   CAFE_DESCRIPTION    description/intro text for the cafe
 *   CAFE_VISIBILITY     'public' | 'private'  (Daum: 공개 vs 비공개)
 *   CAFE_CATEGORY       optional category hint
 *   MODEL_ID            e.g. "anthropic/claude-sonnet-4.6"
 *
 * Auth: @ai-sdk/gateway reads VERCEL_OIDC_TOKEN automatically (preferred path
 * via `vercel env pull .env.local` / auto-injected on Vercel — no manual key
 * rotation needed).
 */
import { writeFile } from "node:fs/promises";
import process from "node:process";
import { ToolLoopAgent, stepCountIs } from "ai";
import { createMCPClient } from "@ai-sdk/mcp";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

// ─── structured logging ──────────────────────────────────────────────────────
function emit(kind, payload) {
  process.stdout.write(
    JSON.stringify({ t: Date.now(), kind, ...payload }) + "\n",
  );
}

// ─── main ────────────────────────────────────────────────────────────────────
async function main() {
  const {
    SESSION_BLOB_URL,
    CAFE_NAME,
    CAFE_DESCRIPTION = "",
    CAFE_VISIBILITY = "public",
    CAFE_CATEGORY = "",
    MODEL_ID = "anthropic/claude-sonnet-4.6",
  } = process.env;

  if (!SESSION_BLOB_URL) throw new Error("SESSION_BLOB_URL is required");
  if (!CAFE_NAME) throw new Error("CAFE_NAME is required");

  emit("status", { message: "downloading storageState" });
  const res = await fetch(SESSION_BLOB_URL);
  if (!res.ok) {
    throw new Error(
      `failed to fetch storageState: ${res.status} ${res.statusText}`,
    );
  }
  const storageStatePath = "/tmp/daum-storage-state.json";
  await writeFile(storageStatePath, await res.text(), "utf8");
  emit("status", { message: "storageState ready" });

  // ─── MCP stdio client → spawns @playwright/mcp internally ────────────────
  emit("status", { message: "starting playwright-mcp" });
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
        "1280,860",
        "--isolated", // fresh context per session
      ],
      // MCP server's stderr → this process's stderr → sandbox stderr → UI logs
      stderr: "inherit",
      env: Object.fromEntries(
        Object.entries(process.env).filter(([, v]) => v !== undefined),
      ),
    }),
  });

  const tools = await mcpClient.tools();
  emit("status", {
    message: "mcp tools discovered",
    tools: Object.keys(tools),
  });

  // ─── agent instructions ──────────────────────────────────────────────────
  const instructions = `
You are AgentCafe, an autonomous browser agent that creates a new cafe on
Daum Cafe (https://cafe.daum.net) on behalf of an already-authenticated user.

The browser has been pre-loaded with the user's storageState, so you are
already signed in. Do NOT attempt to log in. If you land on a login page it
means the session has expired — stop immediately and report the failure.

Plan:
  1. browser_navigate to https://top.cafe.daum.net/_c21_/_cafe_create
     (the cafe creation flow). If that URL is stale, fall back to
     https://cafe.daum.net and follow the "새 카페 만들기" (Make new cafe) link.
  2. browser_snapshot to read the accessibility tree.
  3. Fill in the form fields precisely:
       - 카페 이름 (cafe name):        ${JSON.stringify(CAFE_NAME)}
       - 카페 소개 (description):      ${JSON.stringify(CAFE_DESCRIPTION)}
       - 공개 설정 (visibility):       ${CAFE_VISIBILITY === "private" ? "비공개" : "공개"}
       ${CAFE_CATEGORY ? `- 카테고리: ${JSON.stringify(CAFE_CATEGORY)}` : ""}
  4. Agree to any required terms-of-service checkboxes.
  5. Submit the form.
  6. browser_snapshot again to confirm the cafe was created; capture the new
     cafe URL from the page if present.
  7. Reply with a concise one-paragraph summary of what happened. Include the
     cafe URL on a separate final line in the form: URL: https://...

Guardrails:
  - Work strictly within daum.net / cafe.daum.net domains.
  - Never guess at values — if a required field is unclear, ask by responding
    with text instead of calling more tools.
  - Prefer browser_snapshot over browser_screenshot for efficiency.
  - Use browser_wait_for to let pages settle after form interactions.
  - If you hit a captcha or "의심스러운 접속" page, stop and report that the
    session needs to be reseeded.
`.trim();

  const agent = new ToolLoopAgent({
    model: MODEL_ID,
    instructions,
    tools,
    stopWhen: stepCountIs(40),
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

  emit("status", { message: "agent starting" });

  try {
    const result = await agent.stream({
      prompt: `Create the cafe now.`,
    });

    let final = "";
    for await (const chunk of result.textStream) {
      final += chunk;
      emit("chunk", { text: chunk });
    }

    const urlMatch = final.match(/URL:\s*(https?:\S+)/i);
    emit("done", {
      summary: final,
      cafeUrl: urlMatch ? urlMatch[1] : null,
    });
  } finally {
    await mcpClient.close();
  }
}

main().catch((err) => {
  emit("error", { message: String(err?.message ?? err), stack: err?.stack });
  process.exit(1);
});
