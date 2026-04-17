/**
 * Local headed-browser post-writer agent.
 *
 * Claude composes a computer-related post in casual Korean cafe style
 * (title + body), then drives a visible Chromium window via @playwright/mcp
 * to actually publish it to the given Daum cafe.
 *
 * Enable with LOCAL_AGENT=1 in .env.local. Not for production — serverless
 * functions can't pop visible browser windows.
 */
import { writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { ToolLoopAgent, stepCountIs, type LanguageModel } from "ai";
import { createMCPClient } from "@ai-sdk/mcp";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { anthropic } from "@ai-sdk/anthropic";

/**
 * Resolve the language model.
 *
 * Default path is AI Gateway (OIDC auth, failover, cost tracking), by passing
 * a plain "anthropic/claude-sonnet-4.6" slug. The gateway does require a card
 * on file for free-tier credits though, so we intentionally fall back to a
 * direct Anthropic key when ANTHROPIC_API_KEY is set — used for quick local
 * demos where a user hasn't onboarded a Vercel payment method yet. Remove
 * that env var in production so gateway is the canonical path.
 */
function resolveModel(requested?: string): LanguageModel {
  if (process.env.ANTHROPIC_API_KEY) {
    // Direct provider fallback (not recommended for prod — see docstring).
    const raw = (requested ?? "anthropic/claude-sonnet-4.6").replace(
      /^anthropic\//,
      "",
    );
    return anthropic(raw.replace(/\./g, "-"));
  }
  return requested ?? "anthropic/claude-sonnet-4.6";
}

export type LocalPostParams = {
  /** Target cafe URL, e.g., https://cafe.daum.net/your-cafe-name */
  cafeUrl: string;
  /** Optional topic seed, e.g., "요즘 쓰는 노트북 추천". Claude picks freely if empty. */
  topicHint?: string;
  /** Rough size budget for the body. */
  length?: "short" | "medium" | "long";
  /** Tone hint, e.g., "정보전달", "후기", "잡담". */
  tone?: string;
  /** Pre-seeded session URL (Blob). */
  sessionBlobUrl: string;
  /** Override model slug. */
  modelId?: string;
};

export function runLocalPostAgent(
  params: LocalPostParams,
  signal?: AbortSignal,
): ReadableStream<Uint8Array> {
  const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
  const writer = writable.getWriter();
  const encoder = new TextEncoder();
  let writerClosed = false;

  const emit = (event: Record<string, unknown>) => {
    if (writerClosed) return;
    void writer.write(encoder.encode(JSON.stringify(event) + "\n"));
  };

  const closeWriter = async () => {
    if (writerClosed) return;
    writerClosed = true;
    try {
      await writer.close();
    } catch {
      /* already closed */
    }
  };

  void (async () => {
    let mcpClient: Awaited<ReturnType<typeof createMCPClient>> | null = null;
    try {
      emit({ kind: "phase", message: "downloading session from Blob" });
      const res = await fetch(params.sessionBlobUrl);
      if (!res.ok) {
        throw new Error(
          `failed to fetch storageState: ${res.status} ${res.statusText}`,
        );
      }
      const tmpDir = path.join(os.tmpdir(), "agent-cafe");
      await mkdir(tmpDir, { recursive: true });
      const storageStatePath = path.join(tmpDir, "daum-storage-state.json");
      await writeFile(storageStatePath, await res.text(), "utf8");

      emit({
        kind: "phase",
        message: "launching headed Chromium via @playwright/mcp",
      });

      mcpClient = await createMCPClient({
        transport: new StdioClientTransport({
          command: "npx",
          args: [
            "-y",
            "@playwright/mcp@latest",
            // no --headless: user watches this window
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
          ) as Record<string, string>,
        }),
      });

      const tools = await mcpClient.tools();
      emit({
        kind: "phase",
        message: "mcp tools discovered",
        tools: Object.keys(tools),
      });

      const lengthGuide =
        params.length === "short"
          ? "150~250 characters"
          : params.length === "long"
            ? "600~900 characters"
            : "350~550 characters";

      const toneGuide = params.tone
        ? `Lean into this tone: ${params.tone}.`
        : "Casual, friendly, relatable — the voice of someone sharing something interesting with cafe members.";

      const topicGuide = params.topicHint
        ? `Topic seed (use this as a jumping-off point — you may refine): ${JSON.stringify(params.topicHint)}`
        : "Pick your own computer-related angle: a recent tech trend, a productivity tip, software you'd recommend, a hardware unboxing/review, a coding lesson, AI news, keyboard/mouse setup, home lab, linux tip — anything tech-y and genuinely interesting.";

      const instructions = `
You are AgentCafe-Writer. Compose and publish ONE computer-related post to
the Daum Cafe at ${params.cafeUrl}. The browser has storageState loaded so
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
                  · 1–3 emojis total, sprinkled, not clustered (😊 💻 👍 etc.)
                  · Specific numbers/models/commands where relevant
                  · Close with a light CTA: "써보신 분 있나요?", "댓글로 알려주세요!",
                    "저만 이런 건지 ㅠㅠ", "의견 부탁드려요!" — pick ONE
                  · NO headings like "## 1. 서론". Just prose.
                  · NO markdown. Plain text only.
  ${toneGuide}

STEP 2 — Navigate the cafe.
  - browser_navigate to ${params.cafeUrl}
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
        model: resolveModel(params.modelId),
        instructions,
        tools,
        stopWhen: stepCountIs(50),
        onStepFinish: async ({
          stepNumber,
          finishReason,
          toolCalls,
          usage,
        }) => {
          emit({
            kind: "step",
            stepNumber,
            finishReason,
            toolsUsed: toolCalls?.map((tc) => tc.toolName) ?? [],
            inputTokens: usage?.inputTokens,
            outputTokens: usage?.outputTokens,
          });
        },
      });

      emit({
        kind: "phase",
        message: "agent starting — watch the Chromium window",
      });

      const result = await agent.stream({
        prompt: `Write and publish the post now.`,
        abortSignal: signal,
      });

      let final = "";
      for await (const chunk of result.textStream) {
        final += chunk;
        emit({ kind: "chunk", text: chunk });
      }

      const urlMatch = final.match(/URL:\s*(https?:\S+)/i);
      emit({
        kind: "done",
        summary: final,
        postUrl: urlMatch ? urlMatch[1] : null,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      emit({ kind: "error", message });
    } finally {
      try {
        await mcpClient?.close();
      } catch {
        /* ignore */
      }
      await closeWriter();
    }
  })();

  return readable;
}
