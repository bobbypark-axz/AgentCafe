/**
 * Local headed-browser post-writer agent.
 *
 * Claude composes a computer-related post in casual Korean cafe style
 * (title + body), then drives a visible Chromium window via @playwright/mcp
 * to actually publish it to the given Daum cafe.
 *
 * Runs on the user's machine (`npm run dev`). Not for serverless deploy —
 * cloud functions can't pop a visible browser window. Persistent profile
 * at `~/.agent-cafe-profile` keeps the Daum/Kakao session alive across runs.
 */
import { mkdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { ToolLoopAgent, stepCountIs, type LanguageModel } from "ai";
import { createMCPClient } from "@ai-sdk/mcp";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { anthropic } from "@ai-sdk/anthropic";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";

/**
 * First-run login helper — pops a real Chromium with the user's persistent
 * profile, waits for them to sign into Daum/Kakao, then captures cookies
 * into storage-state.json. Subsequent runs skip this and use the JSON.
 *
 * Called inline at the start of any agent run so the user gets a single-
 * click experience: if creds are missing, browser opens, they log in,
 * browser closes, agent proceeds.
 */
const KAKAO_AUTH_COOKIES = ["_kawlt", "_karmt", "_KHAID"] as const;

async function hasValidStorageState(storageStatePath: string): Promise<boolean> {
  try {
    const exists = await stat(storageStatePath);
    if (!exists.isFile()) return false;
    const buf = await readFile(storageStatePath, "utf8");
    const state = JSON.parse(buf) as { cookies?: Array<{ name?: string }> };
    const cookies = state.cookies ?? [];
    return cookies.some(
      (c) =>
        typeof c.name === "string" &&
        (KAKAO_AUTH_COOKIES as readonly string[]).includes(c.name),
    );
  } catch {
    return false;
  }
}

async function ensureStorageState(
  _profileDir: string,
  storageStatePath: string,
  _emit: (event: Record<string, unknown>) => void,
  _signal?: AbortSignal,
): Promise<void> {
  if (await hasValidStorageState(storageStatePath)) return;
  // Login is now an explicit step driven by the chat UI: it calls
  // /api/login with credentials, which writes storage-state.json.
  // Throw a recognizable error so the UI can prompt the user.
  throw new Error(
    "AWAITING_LOGIN: Daum 로그인이 필요합니다. 사이드바의 'Daum 로그인' 버튼을 눌러 ID/PW를 입력해주세요.",
  );
}

/**
 * Resolve the language model. Priority order:
 *   1. BizRouter (BIZROUTER_API_KEY) — Korean enterprise LLM router, OpenAI-
 *      compatible. Uses provider/model slugs like "anthropic/claude-sonnet-4.6".
 *   2. Direct Anthropic (ANTHROPIC_API_KEY) — quick local fallback.
 *   3. Vercel AI Gateway (default) — passes a plain provider/model slug.
 */
function resolveModel(requested?: string): LanguageModel {
  const slug = requested ?? "anthropic/claude-sonnet-4.6";

  if (process.env.BIZROUTER_API_KEY) {
    const baseURL =
      process.env.BIZROUTER_BASE_URL ?? "https://bizrouter.ai/api/v1";
    const bizrouter = createOpenAICompatible({
      name: "bizrouter",
      baseURL,
      apiKey: process.env.BIZROUTER_API_KEY,
    });
    return bizrouter.chatModel(slug);
  }

  if (process.env.ANTHROPIC_API_KEY) {
    const raw = slug.replace(/^anthropic\//, "");
    return anthropic(raw.replace(/\./g, "-"));
  }

  return slug;
}

/**
 * Persistent Chromium profile for local mode. The user logs in once via
 * `npm run login:local` (or interactively during the first agent run), and
 * every subsequent run reuses this profile — same device fingerprint, no
 * Kakao re-verification storms.
 */
function getLocalProfileDir(): string {
  return (
    process.env.DAUM_PROFILE_DIR ??
    path.join(os.homedir(), ".agent-cafe-profile")
  );
}

/* ════════════════════ shared MCP/Chrome instance ════════════════════
 *
 * @playwright/mcp spawns a Chrome process per createMCPClient(). Closing
 * the client closes Chrome — and Chrome forgets short-lived session
 * cookies on close, plus Kakao sometimes invalidates the session if it
 * sees a brand-new browser instance every few minutes.
 *
 * To keep the user logged in across multiple chat messages, we hold ONE
 * MCP client at module scope for the lifetime of the dev server. Every
 * agent run reuses it. Chrome stays open. Cookies stay alive.
 */

type SharedMcp = Awaited<ReturnType<typeof createMCPClient>>;

// Captures the live login Chrome (a Playwright BrowserContext) so we can
// keep it alive across requests. Typed as `unknown` to avoid pulling
// playwright's types into this file's exports.
type LoginContextHandle = {
  context: unknown;
  cdpEndpoint: string;
  close: () => Promise<void>;
};

declare global {
  // Singleton survives Next.js hot reloads (which re-evaluate module code
  // but keep globalThis intact).
  // eslint-disable-next-line no-var
  var __agentCafeMcp: SharedMcp | undefined;
  // eslint-disable-next-line no-var
  var __agentCafeMcpInit: Promise<SharedMcp> | undefined;
  // The login flow leaves Chrome alive after capturing Kakao auth; this
  // handle lets the agent's MCP attach to that Chrome via CDP so all
  // browser ops happen in the SAME process — Kakao session cookies live
  // entirely in memory there and don't get wiped between operations.
  // eslint-disable-next-line no-var
  var __agentCafeLogin: LoginContextHandle | undefined;
}

/**
 * Port Chrome's --remote-debugging-port listens on. Picked above ephemeral
 * range collision risk and unlikely to clash with anything else the user
 * has running. The login route launches Chrome with this port so the agent
 * can attach via CDP later.
 */
export const AGENT_CAFE_CDP_PORT = 39222;
export const AGENT_CAFE_CDP_ENDPOINT = `http://127.0.0.1:${AGENT_CAFE_CDP_PORT}`;

export function setLoginHandle(handle: LoginContextHandle) {
  globalThis.__agentCafeLogin = handle;
}

export async function closeSharedLogin(): Promise<void> {
  const h = globalThis.__agentCafeLogin;
  if (!h) return;
  globalThis.__agentCafeLogin = undefined;
  try {
    await h.close();
  } catch {
    /* ignore */
  }
}

/**
 * Resolve how to launch @playwright/mcp's CLI.
 *
 * - Dev (`next dev`): use `npx -y @playwright/mcp@latest`. Simple and matches
 *   the historical setup; the dev machine already has Node + npm.
 * - Packaged Electron (.dmg/.app): the recipient's machine has neither
 *   Node nor npm guaranteed, so we ship the CLI inside the app and run it
 *   via `process.execPath` (= Electron binary) with ELECTRON_RUN_AS_NODE=1,
 *   which makes Electron behave as a plain Node interpreter.
 *
 * The Electron main process advertises the bundled CLI path through
 * AGENTCAFE_MCP_CLI; the absence of that env var means we're in dev.
 */
function buildMcpSpawn(profileDir: string): {
  command: string;
  args: string[];
  env: Record<string, string>;
} {
  const baseEnv = Object.fromEntries(
    Object.entries(process.env).filter(([, v]) => v !== undefined),
  ) as Record<string, string>;

  // Prefer attaching to the login Chrome via CDP if it's still alive.
  // Same process => same in-memory Kakao session cookies => no logout
  // between agent runs. If no login Chrome is registered, fall back to
  // launching MCP's own Chrome with the persistent user-data-dir (works
  // for runs that don't need fresh auth, e.g. read-only browsing).
  const loginAlive = globalThis.__agentCafeLogin?.cdpEndpoint;
  const mcpArgs = loginAlive
    ? ["--cdp-endpoint", loginAlive, "--viewport-size", "1280,900"]
    : [
        "--browser",
        "chrome",
        "--user-data-dir",
        profileDir,
        "--viewport-size",
        "1280,900",
      ];

  const bundledCli = process.env.AGENTCAFE_MCP_CLI;
  if (bundledCli) {
    return {
      command: process.execPath,
      args: [bundledCli, ...mcpArgs],
      env: { ...baseEnv, ELECTRON_RUN_AS_NODE: "1" },
    };
  }

  return {
    command: "npx",
    args: ["-y", "@playwright/mcp@latest", ...mcpArgs],
    env: baseEnv,
  };
}

async function getSharedMcp(profileDir: string): Promise<SharedMcp> {
  // If a previous request is mid-flight starting MCP, await that promise.
  if (globalThis.__agentCafeMcpInit && !globalThis.__agentCafeMcp) {
    return globalThis.__agentCafeMcpInit;
  }

  // Quick health check on existing instance.
  if (globalThis.__agentCafeMcp) {
    try {
      await globalThis.__agentCafeMcp.tools();
      return globalThis.__agentCafeMcp;
    } catch {
      // Chrome died — drop it and reinit below.
      try {
        await globalThis.__agentCafeMcp.close();
      } catch {
        /* ignore */
      }
      globalThis.__agentCafeMcp = undefined;
    }
  }

  const { command, args, env } = buildMcpSpawn(profileDir);
  globalThis.__agentCafeMcpInit = createMCPClient({
    transport: new StdioClientTransport({
      command,
      args,
      stderr: "inherit",
      env,
    }),
  });

  try {
    const client = await globalThis.__agentCafeMcpInit;
    globalThis.__agentCafeMcp = client;
    return client;
  } finally {
    globalThis.__agentCafeMcpInit = undefined;
  }
}

/**
 * Force-close the shared MCP/Chrome. Used by /api/reset-session and on
 * any error that suggests Chrome is in a bad state.
 */
export async function closeSharedMcp(): Promise<void> {
  if (globalThis.__agentCafeMcp) {
    try {
      await globalThis.__agentCafeMcp.close();
    } catch {
      /* ignore */
    }
    globalThis.__agentCafeMcp = undefined;
  }
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
    // TEMP: mirror to dev console so we can debug local agent runs.
    try {
      const k = String(event.kind ?? "?");
      const m = String(
        event.message ?? event.line ?? event.text ?? event.url ?? "",
      );
      console.log(`[agent] ${k}: ${m.slice(0, 200)}`);
    } catch {
      /* ignore */
    }
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
      const profileDir = getLocalProfileDir();
      await mkdir(profileDir, { recursive: true });
      const storageStatePath = path.join(profileDir, "storage-state.json");

      // First-run guard: if storage-state.json is missing or has no Kakao
      // auth cookies, pop a Chromium for the user to log in. Once captured,
      // continue into the MCP-driven post-writer below.
      await ensureStorageState(profileDir, storageStatePath, emit, signal);

      // System Google Chrome with persistent user-data-dir. Cookies
      // refresh automatically across runs (Kakao rotates session tokens),
      // and the device fingerprint stays consistent — same binary, same
      // profile as /api/login, so Kakao doesn't see "new device" each run.
      emit({
        kind: "phase",
        message: `launching Chrome with persistent profile (${profileDir})`,
      });

      // Reuse the shared Chrome instance — keeps cookies/session alive
      // across multiple chat messages.
      mcpClient = await getSharedMcp(profileDir);

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
  - Confirm you are logged in. If a "로그인" button/link is visible in the
    Daum/cafe nav (or "카페 가입하기" appears for the cafe), STOP IMMEDIATELY
    after the FIRST snapshot and emit a brief final message:
      "NOT_LOGGED_IN: run \`npm run login:local\` once to seed the persistent
       Chromium profile, then retry."
    Do NOT navigate further, do NOT attempt to log in, do NOT try to bypass.
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
      // Don't close the MCP client — it's the shared singleton that keeps
      // Chrome alive (and thus cookies/session) across multiple requests.
      // Use closeSharedMcp() / /api/reset-session if a clean restart is
      // explicitly needed.
      await closeWriter();
    }
  })();

  return readable;
}

export type LocalModerateParams = {
  cafeUrl: string;
  boardHint?: string;
  keywords: string[];
  action: "3일 정지" | "7일 정지" | "영구 차단";
  dryRun: boolean;
  maxPosts?: number;
  maxActions?: number;
  modelId?: string;
};

/**
 * Local headed-browser moderation agent. Mirrors `runLocalPostAgent` but
 * scans the cafe for rule-breaking posts/comments and (in live mode) clicks
 * through the manager's 차단/정지 UI. Headed so the operator can see what's
 * being clicked — sandbox path is blocked by Kakao 2FA from US egress IPs.
 */
export function runLocalModerateAgent(
  params: LocalModerateParams,
  signal?: AbortSignal,
): ReadableStream<Uint8Array> {
  const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
  const writer = writable.getWriter();
  const encoder = new TextEncoder();
  let writerClosed = false;

  const emit = (event: Record<string, unknown>) => {
    if (writerClosed) return;
    // TEMP: mirror to dev console so we can debug local agent runs.
    try {
      const k = String(event.kind ?? "?");
      const m = String(
        event.message ?? event.line ?? event.text ?? event.url ?? "",
      );
      console.log(`[agent] ${k}: ${m.slice(0, 200)}`);
    } catch {
      /* ignore */
    }
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
      const profileDir = getLocalProfileDir();
      await mkdir(profileDir, { recursive: true });
      const storageStatePath = path.join(profileDir, "storage-state.json");

      // First-run guard: if storage-state.json is missing or has no Kakao
      // auth cookies, pop a Chromium for the user to log in. Once captured,
      // continue into the MCP-driven post-writer below.
      await ensureStorageState(profileDir, storageStatePath, emit, signal);

      // System Google Chrome with persistent user-data-dir. Cookies
      // refresh automatically across runs (Kakao rotates session tokens),
      // and the device fingerprint stays consistent — same binary, same
      // profile as /api/login, so Kakao doesn't see "new device" each run.
      emit({
        kind: "phase",
        message: `launching Chrome with persistent profile (${profileDir})`,
      });

      // Reuse the shared Chrome instance — keeps cookies/session alive
      // across multiple chat messages.
      mcpClient = await getSharedMcp(profileDir);

      const tools = await mcpClient.tools();
      emit({
        kind: "phase",
        message: "mcp tools discovered",
        tools: Object.keys(tools),
      });

      const maxPosts = Math.max(1, params.maxPosts ?? 10);
      const maxActions = Math.max(0, params.maxActions ?? 5);
      const keywordList = params.keywords ?? [];

      const boardGuide = params.boardHint
        ? `Target board (navigate into this one first): ${JSON.stringify(params.boardHint)}.`
        : "No specific board specified — pick the most recently active free-talk / 자유게시판.";

      const keywordGuide = keywordList.length
        ? `Flag any post or comment whose text contains any of these substrings (case-insensitive): ${JSON.stringify(keywordList)}.`
        : "No explicit keywords — flag only clear abusive/spam/insulting/promotional content.";

      const modeGuide = params.dryRun
        ? "DRY-RUN MODE: you MUST NOT click any ban/suspend button. Only detect and report."
        : `LIVE MODE: after detecting, you MAY execute moderation. Cap actual moderation actions at ${maxActions}. Skip any case you are unsure about.`;

      const instructions = `
You are AgentCafe-Moderator. You are operating on behalf of the cafe manager
(운영자) of ${params.cafeUrl}. The browser has storageState loaded so you are
already logged in as that manager.

${modeGuide}

STEP 1 — Navigate + force OAuth bounce.
  - browser_navigate to ${params.cafeUrl}.
  - browser_snapshot.
  - If a "로그인" link/button is visible, CLICK IT. Cafe pages reached
    directly often look logged-out even when the persistent profile has
    valid Kakao cookies — clicking 로그인 triggers a silent OAuth bounce
    (1-click account confirm at most) that hydrates cafe.daum.net session
    and reveals the 관리/manager menu. Wait, then browser_snapshot.
  - If after clicking 로그인 a real Kakao login FORM (email/password) shows,
    STOP and emit:
      "NOT_LOGGED_IN: run \`npm run login:local\` once and retry."
  - Confirm manager privileges: 관리 / 카페관리 / 스태프메뉴 should now be
    visible. If still nothing manager-ish after the bounce, STOP and
    report "not a manager".

STEP 2 — Enter a board.
  ${boardGuide}
  - Click into the board list in the left sidebar, pick the target board.
  - You only need the latest ${maxPosts} posts. Don't paginate further.

STEP 3 — Scan each post.
  For each of the latest ${maxPosts} posts (newest first):
    a) Open the post — just navigate, no new tab.
    b) browser_snapshot. Capture: postUrl, author nickname, title,
       first ~500 chars of body.
    c) If comments exist, expand/scroll and capture commenter nickname +
       comment text for each comment (cap at ~30 comments per post).
    d) ${keywordGuide}
    e) For each match, write a single line into your reasoning text in
       this exact form so the host can re-emit it as a structured event:
         VIOLATION_JSON: {"postUrl":"...","author":"...","where":"body|comment",
          "matched":["keyword1",...],"snippet":"...", "reason":"short reason"}
    f) Go back to the board list for the next post.

STEP 4 — Execute actions (LIVE MODE only).
  ${
    params.dryRun
      ? "  — skipped, dry-run."
      : `
  Pick up to ${maxActions} most severe detections and execute:
    a) Open the offending post.
    b) Click the author's nickname (or the ⋯/더보기 menu beside their name).
    c) A menu should offer "회원 차단", "회원 제재", or similar.
    d) Choose: "${params.action}". If exact option missing, pick the closest.
    e) Provide a brief reason if a reason field appears
       (e.g. "카페 규칙 위반 — [matched keyword]").
    f) Confirm. browser_snapshot to verify the success toast or notice.
    g) Emit: ACTION_JSON: {"postUrl":"...","author":"...",
             "action":"${params.action}","success":true|false,"error":"if any"}
    h) If any step raises a permission error or the menu item is missing,
       emit an action with success=false and move on.
  Never attempt the same author twice in one run.
  `
  }

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
  - If you cannot find the specified action option "${params.action}", report,
    don't guess a more severe alternative.
`.trim();

      let stepCount = 0;
      const agent = new ToolLoopAgent({
        model: resolveModel(params.modelId),
        instructions,
        tools,
        stopWhen: stepCountIs(60),
        onStepFinish: async ({
          stepNumber,
          finishReason,
          toolCalls,
          usage,
        }) => {
          stepCount++;
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
        message: `moderator starting (${params.dryRun ? "DRY-RUN" : "LIVE"}, action="${params.action}", posts<=${maxPosts}, actions<=${maxActions})`,
      });

      const result = await agent.stream({
        prompt: `Scan and (if live) moderate now.`,
        abortSignal: signal,
      });

      let final = "";
      for await (const chunk of result.textStream) {
        final += chunk;
        emit({ kind: "chunk", text: chunk });

        for (const m of chunk.matchAll(/VIOLATION_JSON:\s*(\{[^\n]+\})/g)) {
          try {
            emit({ kind: "violation", ...JSON.parse(m[1]) });
          } catch {
            /* ignore malformed JSON in reasoning */
          }
        }
        for (const m of chunk.matchAll(/ACTION_JSON:\s*(\{[^\n]+\})/g)) {
          try {
            emit({ kind: "action", ...JSON.parse(m[1]) });
          } catch {
            /* ignore */
          }
        }
      }

      if (stepCount === 0 && final.trim() === "") {
        emit({
          kind: "error",
          message:
            "agent produced no output (0 steps, empty stream). Likely the model call failed — check the dev server console. Common cause: AI Gateway returned 403 (no card on file) and no ANTHROPIC_API_KEY fallback set in .env.local.",
        });
        return;
      }

      emit({ kind: "done", summary: final, dryRun: params.dryRun });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      emit({ kind: "error", message });
    } finally {
      // Don't close the MCP client — it's the shared singleton that keeps
      // Chrome alive (and thus cookies/session) across multiple requests.
      // Use closeSharedMcp() / /api/reset-session if a clean restart is
      // explicitly needed.
      await closeWriter();
    }
  })();

  return readable;
}

export type LocalDeleteParams = {
  /** Direct URL of the post to delete, e.g. https://cafe.daum.net/.../MTBW/3 */
  postUrl: string;
  /** Optional cafe URL — used only if the agent needs to fall back to the
   *  cafe home to find the post. The post URL itself is the primary handle. */
  cafeUrl?: string;
  modelId?: string;
};

/**
 * Local headed-browser delete agent. Navigates to the given post URL on a
 * Daum cafe, opens the 더보기/⋯ menu, clicks 삭제, and confirms. Only deletes
 * the operator's own post (or any post if the operator is the cafe manager).
 */
export function runLocalDeleteAgent(
  params: LocalDeleteParams,
  signal?: AbortSignal,
): ReadableStream<Uint8Array> {
  const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
  const writer = writable.getWriter();
  const encoder = new TextEncoder();
  let writerClosed = false;

  const emit = (event: Record<string, unknown>) => {
    if (writerClosed) return;
    // TEMP: mirror to dev console so we can debug local agent runs.
    try {
      const k = String(event.kind ?? "?");
      const m = String(
        event.message ?? event.line ?? event.text ?? event.url ?? "",
      );
      console.log(`[agent] ${k}: ${m.slice(0, 200)}`);
    } catch {
      /* ignore */
    }
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
      const profileDir = getLocalProfileDir();
      await mkdir(profileDir, { recursive: true });
      const storageStatePath = path.join(profileDir, "storage-state.json");

      // First-run guard: if storage-state.json is missing or has no Kakao
      // auth cookies, pop a Chromium for the user to log in. Once captured,
      // continue into the MCP-driven post-writer below.
      await ensureStorageState(profileDir, storageStatePath, emit, signal);

      // System Google Chrome with persistent user-data-dir. Cookies
      // refresh automatically across runs (Kakao rotates session tokens),
      // and the device fingerprint stays consistent — same binary, same
      // profile as /api/login, so Kakao doesn't see "new device" each run.
      emit({
        kind: "phase",
        message: `launching Chrome with persistent profile (${profileDir})`,
      });

      // Reuse the shared Chrome instance — keeps cookies/session alive
      // across multiple chat messages.
      mcpClient = await getSharedMcp(profileDir);

      const tools = await mcpClient.tools();
      emit({
        kind: "phase",
        message: "mcp tools discovered",
        tools: Object.keys(tools),
      });

      const cafeHome =
        params.cafeUrl ??
        params.postUrl.replace(
          /^(https?:\/\/cafe\.daum\.net\/[^/]+).*$/,
          "$1",
        );

      const instructions = `
You are AgentCafe-Deleter. Delete ONE post from a Daum cafe.
  - Cafe home: ${cafeHome}
  - Target post: ${params.postUrl}
The browser has a logged-in persistent profile.

STEP 1 — Sync auth via cafe home + force OAuth bounce.
  - browser_navigate to ${cafeHome}
  - browser_snapshot. Going directly to a post URL skips the OAuth bounce
    that hydrates cafe.daum.net session tokens — that's why 수정/삭제 hide.
  - If a "로그인" link/button is visible in the cafe nav, CLICK IT.
    Because the persistent profile already has Kakao cookies, the OAuth
    redirect should complete silently (no login form shown) and land you
    back logged in. Wait for the redirect to finish, then browser_snapshot.
  - After the OAuth bounce: if the page now shows a login FORM (Kakao
    email/password), STOP and emit:
      "NOT_LOGGED_IN: run \`npm run login:local\` once and retry."
  - If the "로그인" link is gone (replaced by user nick / 마이페이지), good
    — the session is hot. Proceed.

STEP 2 — Navigate to the target post.
  - browser_navigate to ${params.postUrl}
  - browser_snapshot. You should now see the post title and body.

STEP 3 — Open the post action menu.
  - Look for "수정" and "삭제" buttons in the post toolbar (usually below
    the title or near the author/date). They should be enabled now.
  - If you see a "기능 더보기" / "⋯" / "더보기" button, click it to expand
    the action dropdown.
  - If "삭제" is still missing or disabled after the cafe-home sync, STOP
    and report — you do NOT own this post or are not the manager.

STEP 4 — Click 삭제.
  - Click "삭제".
  - A confirm dialog usually appears: "정말 삭제하시겠습니까?" or similar.
  - browser_handle_dialog with accept=true, OR if it's an in-page modal,
    click the 확인 / 삭제 button to confirm.

STEP 4 — Verify.
  - browser_snapshot. Expect either:
      · A toast / notice: "삭제되었습니다" / "게시물이 삭제되었습니다"
      · Redirect back to the board list, with the post no longer visible
      · The post URL now showing "삭제된 글" / 404
  - Capture which signal you observed.

STEP 5 — Final report.
  - One line summary stating success or failure with the observed signal.
  - On the very last line emit exactly:  RESULT: SUCCESS  or  RESULT: FAIL
    (host parses this).

GUARDRAILS
  - Do NOT delete any post other than ${params.postUrl}.
  - Do NOT click 신고 (report) — only 삭제.
  - If the 삭제 option is missing (you don't own this post / no manager
    privilege), STOP and report. Do not try to bypass.
  - If you hit a captcha or "의심스러운 접속", STOP and report.
  - Prefer browser_snapshot over browser_screenshot.
`.trim();

      const agent = new ToolLoopAgent({
        model: resolveModel(params.modelId),
        instructions,
        tools,
        stopWhen: stepCountIs(20),
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
        message: `deleter starting (target=${params.postUrl})`,
      });

      const result = await agent.stream({
        prompt: `Delete the post now.`,
        abortSignal: signal,
      });

      let final = "";
      for await (const chunk of result.textStream) {
        final += chunk;
        emit({ kind: "chunk", text: chunk });
      }

      const success = /RESULT:\s*SUCCESS/i.test(final);
      emit({
        kind: "done",
        summary: final,
        postUrl: params.postUrl,
        success,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      emit({ kind: "error", message });
    } finally {
      // Don't close the MCP client — it's the shared singleton that keeps
      // Chrome alive (and thus cookies/session) across multiple requests.
      // Use closeSharedMcp() / /api/reset-session if a clean restart is
      // explicitly needed.
      await closeWriter();
    }
  })();

  return readable;
}

/* ════════════════════ chat agent ════════════════════ */

export type LocalChatParams = {
  message: string;
  cafeUrl: string;
  history?: Array<{ role: "user" | "assistant"; content: string }>;
  modelId?: string;
};

/**
 * One agent for natural-language requests — Claude reads the user's message
 * and figures out which browser actions (post, delete, moderate, browse)
 * to take. Replaces dedicated post/moderate/delete entry points for chat UX.
 */
export function runLocalChatAgent(
  params: LocalChatParams,
  signal?: AbortSignal,
): ReadableStream<Uint8Array> {
  const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
  const writer = writable.getWriter();
  const encoder = new TextEncoder();
  let writerClosed = false;

  const emit = (event: Record<string, unknown>) => {
    if (writerClosed) return;
    try {
      const k = String(event.kind ?? "?");
      const m = String(
        event.message ?? event.line ?? event.text ?? event.url ?? "",
      );
      console.log(`[chat] ${k}: ${m.slice(0, 200)}`);
    } catch {
      /* ignore */
    }
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
      const profileDir = getLocalProfileDir();
      await mkdir(profileDir, { recursive: true });
      const storageStatePath = path.join(profileDir, "storage-state.json");

      await ensureStorageState(profileDir, storageStatePath, emit, signal);

      // Reuse the same system-Chrome + persistent-profile setup as the
      // post/moderate/delete agents. Sharing one Chrome instance keeps
      // Kakao session cookies hot across messages, and using system Chrome
      // (not Playwright's bundled chromium) avoids a 170MB browser download
      // and matches the device fingerprint /api/login already wrote into
      // the profile — Kakao doesn't see a "new device" each chat.
      emit({
        kind: "phase",
        message: `launching Chrome with persistent profile (${profileDir})`,
      });

      mcpClient = await getSharedMcp(profileDir);

      const tools = await mcpClient.tools();
      emit({
        kind: "phase",
        message: "mcp tools discovered",
        tools: Object.keys(tools),
      });

      const historyBlock =
        params.history && params.history.length > 0
          ? `\nPRIOR CONVERSATION (oldest first):\n${params.history
              .map(
                (m) =>
                  `${m.role === "user" ? "USER" : "ASSISTANT"}: ${m.content.slice(0, 600)}`,
              )
              .join("\n")}\n`
          : "";

      const instructions = `
You are AgentCafe — a browser-driving assistant for Daum cafe at ${params.cafeUrl}.
Respond to the user in Korean. Use the browser tools to actually do what they ask.

USER'S CURRENT REQUEST:
"${params.message}"
${historyBlock}

INTENT MATRIX — figure out from the message, then act:

  1. WRITE A POST  ("글 써줘", "후기 써줘", "RTX X 빌드 후기 올려줘"…)
     - Compose a Korean cafe-style post (15-30 char title, 200-700 char body).
     - Casual tone, ~요/네요 endings, 1–2 emojis.
     - browser_navigate ${params.cafeUrl}, click 글쓰기, fill title + body,
       click 등록.
     - 등록 후 cafe 좌측/상단의 "내가 쓴 글" / "내 글" / "내가 쓴 게시글"
       메뉴를 클릭해서 본인 글 목록 화면으로 이동. 메뉴 위치를 못 찾으면
       마이페이지 / 프로필 / 닉네임 영역을 누르면 보통 보입니다.
     - 목록 맨 위에 방금 쓴 글이 있을 것. 그 글의 제목을 클릭해서 본문이
       정상 등록됐는지 한 번 더 snapshot으로 확인.
     - DO NOT output any "URL: https://..." line. 사용자한테는 Chrome 창에
       글이 열려있다고만 안내. 예: "✓ 글 등록 완료. Chrome 창에 방금 쓴
       글이 열려있어요. 거기서 확인해주세요."

  2. DELETE A POST BY TITLE  ("[제목] 삭제해줘", "...글 지워줘"…)
     - Extract the title query from the message.
     - browser_navigate ${params.cafeUrl}.
     - Find the post: try the cafe's 검색 box first (input placeholder
       "검색", "카페내 검색"); else browse 자유게시판/잡담 and match titles.
     - Click into the matched post.
     - Verify the title before deleting.
     - Click the 더보기/메뉴 / 수정·삭제 button → 삭제 → confirm dialog.
     - Report which post was deleted and the URL.
     - If multiple matches, list them and ask the user which one.

  3. MODERATE  ("광고 정리해", "스팸 차단해", "도배글 삭제해"…)
     - browse the most active boards, scan recent posts/comments for spam
       patterns (광고, 무료체험, DM, 홍보, repeated phrases).
     - Report each violation as a chunk first.
     - Only suspend/ban if the user explicitly said "차단" / "정지" /
       "삭제". Otherwise dry-run report.

  4. BROWSE / STATUS  ("최근 글", "오늘 새 글", "회원 수"…)
     - browser_navigate, browser_snapshot, summarize. No mutations.

  5. JOIN A CAFE  ("이 카페 가입해줘", "여기 회원가입 좀", "가입 신청해줘"…)
     - browser_navigate ${params.cafeUrl}.
     - "카페 가입하기" / "가입" / "회원가입" 버튼을 찾아 클릭. 이미 가입된
       상태면 그 버튼이 안 보입니다 → "이미 가입된 카페예요"라고 보고하고
       종료.
     - 가입 폼이 뜨면:
       · 닉네임 필드: 사용자 메시지에 "닉네임 X" 형태로 명시가 있으면 그것을
         사용. 없으면 카카오 기본 닉네임이 미리 채워져 있는 경우 그대로 두고,
         빈 칸이면 "agentcafe-" + 4자리 랜덤 숫자.
       · 가입 인사 / 자기소개 등 필수 텍스트 영역: 사용자 메시지에 "인사말 X"
         형태로 명시가 있으면 그것. 없으면 짧고 자연스러운 한 문장
         (예: "안녕하세요, 잘 부탁드립니다 🙂").
       · 카페가 요구하는 인증 질문/카테고리 선택이 있으면 무난한 답으로 채움.
         답이 막연하면 채우지 말고 "카페가 추가 정보를 요구해요: [질문]" 보고
         후 종료.
       · 약관/개인정보 동의 체크박스 모두 체크.
     - "가입하기" / "신청" 버튼 클릭.
     - browser_snapshot으로 결과 확인:
       · "가입이 완료되었습니다" 류 → 즉시 가입 성공
       · "가입 신청이 접수되었습니다" / "운영자 승인 대기" 류 → 승인 대기
       · 거부/오류 → 메시지 그대로 보고
     - 사용자에게 결과를 한 줄로 보고. URL 출력 금지.

SESSION HYDRATION (do this BEFORE any mutation)
  - On the very first browser_navigate to ${params.cafeUrl}, take a snapshot.
  - If a "로그인" link/button is visible in the cafe header, CLICK IT.
    Cafes reached directly often look logged-out even when the persistent
    profile has valid Kakao cookies — clicking 로그인 triggers a silent
    OAuth bounce (1-click confirm at most) that hydrates cafe.daum.net
    session and reveals the writer/manager menus. Wait for the redirect
    to settle, then snapshot again.
  - ONLY if the post-click page shows a real Kakao login FORM
    (email/password inputs, NOT a 1-click confirm), emit "AWAITING_LOGIN: …"
    and stop. A 1-click "계속하기" / 동의 dialog is fine to confirm.

GUARDRAILS
  - Stay on daum.net / cafe.daum.net.
  - Captcha or "의심스러운 접속" → stop and report.
  - Permission errors (삭제 권한 없음 등) → stop and report.
  - No promotional/political/hateful content.

OUTPUT
  - Talk to the user in Korean throughout (chunks stream live).
  - End with a clear, short Korean summary of what you did.
  - 글 작성 케이스: URL은 절대 출력하지 말고, "Chrome 창에 글이 열려있어요"
    톤으로 마무리. 사용자가 Chrome 창에서 직접 결과를 봅니다.
  - 삭제/조회/모더레이션 케이스: 무엇을 했는지만 한 문단으로 요약.
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

      emit({ kind: "phase", message: "agent starting" });

      const result = await agent.stream({
        prompt: `Handle this user request now: ${params.message}`,
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
      // Don't close the MCP client — it's the shared singleton that keeps
      // Chrome alive (and thus cookies/session) across multiple requests.
      // Use closeSharedMcp() / /api/reset-session if a clean restart is
      // explicitly needed.
      await closeWriter();
    }
  })();

  return readable;
}
