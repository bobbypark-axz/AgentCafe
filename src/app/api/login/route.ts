import { z } from "zod";
import { mkdir, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { chromium } from "playwright";
import {
  AGENT_CAFE_CDP_ENDPOINT,
  AGENT_CAFE_CDP_PORT,
  closeSharedLogin,
  closeSharedMcp,
  setLoginHandle,
} from "@/lib/local-agent";

export const runtime = "nodejs";
export const maxDuration = 600;

const BodySchema = z.object({
  email: z.string().email(),
  password: z.string().min(1).max(200),
});

const KAKAO_AUTH_COOKIES = ["_kawlt", "_karmt", "_KHAID"] as const;

export async function POST(req: Request) {
  let creds: z.infer<typeof BodySchema>;
  try {
    creds = BodySchema.parse(await req.json());
  } catch (err) {
    return Response.json(
      {
        error: "invalid request body",
        detail: err instanceof Error ? err.message : String(err),
      },
      { status: 400 },
    );
  }

  // Stream NDJSON so the client can show progress (typing, 2FA wait, etc).
  const stream = runLoginFlow(creds, req.signal);
  return new Response(stream, {
    headers: {
      "content-type": "application/x-ndjson; charset=utf-8",
      "cache-control": "no-store, no-transform",
      "x-content-type-options": "nosniff",
    },
  });
}

function runLoginFlow(
  { email, password }: { email: string; password: string },
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
    let context: Awaited<ReturnType<typeof chromium.launchPersistentContext>> | null =
      null;
    try {
      const profileDir =
        process.env.DAUM_PROFILE_DIR ??
        path.join(os.homedir(), ".agent-cafe-profile");
      await mkdir(profileDir, { recursive: true });
      const storageStatePath = path.join(profileDir, "storage-state.json");

      // Tear down anything still holding profileDir or a prior login Chrome
      // — the new Chrome we're about to launch needs an exclusive lock on
      // the user-data-dir.
      emit({ kind: "phase", message: "releasing any prior agent browser" });
      await closeSharedMcp();
      await closeSharedLogin();
      // Brief grace period so Chrome's lock-file cleanup on exit completes
      // before we relaunch.
      await new Promise((r) => setTimeout(r, 600));
      // Defensive: a Chrome that crashed or was force-killed leaves three
      // singleton symlinks behind in the profile dir. They're broken (point
      // at a dead PID) but Chrome refuses to start until they're gone.
      for (const f of ["SingletonLock", "SingletonCookie", "SingletonSocket"]) {
        await unlink(path.join(profileDir, f)).catch(() => {});
      }

      emit({ kind: "phase", message: "launching Chrome (system)" });
      // Open with --remote-debugging-port so the agent's MCP can attach
      // via CDP after login. Same Chrome process for login + agent =
      // Kakao session cookies stay alive in memory (the only place
      // they live, since they're session cookies by design).
      context = await chromium.launchPersistentContext(profileDir, {
        headless: false,
        channel: "chrome",
        locale: "ko-KR",
        timezoneId: "Asia/Seoul",
        viewport: { width: 1280, height: 860 },
        args: [`--remote-debugging-port=${AGENT_CAFE_CDP_PORT}`],
      });
      const page = context.pages()[0] ?? (await context.newPage());

      emit({ kind: "phase", message: "navigating to Kakao login" });
      await page.goto(
        "https://logins.daum.net/accounts/loginform.do?url=https%3A%2F%2Fwww.daum.net%2F",
        { waitUntil: "domcontentloaded" },
      );

      // Daum's login button typically redirects to Kakao SSO. Detect and
      // follow if present.
      try {
        const kakaoLink = page
          .getByText(/카카오계정으로 로그인|카카오로 로그인|카카오/, {
            exact: false,
          })
          .first();
        if (await kakaoLink.isVisible({ timeout: 2000 }).catch(() => false)) {
          await kakaoLink.click({ timeout: 3000 }).catch(() => {});
        }
      } catch {
        /* not present */
      }

      // Kakao OAuth often redirects multiple times — wait until traffic
      // settles before hunting for inputs.
      await page
        .waitForLoadState("networkidle", { timeout: 20000 })
        .catch(() => {});

      // Some flows show "select existing account" first. Click "다른 계정으로
      // 로그인" / "새로 로그인" if visible to surface the form.
      try {
        const newAcct = page.getByText(
          /다른 계정으로 로그인|새로 로그인|다른 카카오계정/,
          { exact: false },
        ).first();
        if (await newAcct.isVisible({ timeout: 1500 }).catch(() => false)) {
          await newAcct.click({ timeout: 2000 }).catch(() => {});
          await page
            .waitForLoadState("networkidle", { timeout: 10000 })
            .catch(() => {});
        }
      } catch {
        /* ignore */
      }

      emit({ kind: "phase", message: "looking for credential inputs" });
      // Try several selector patterns; first one that's visible wins.
      const idSelectors = [
        'input[name="loginKey"]',
        'input[name="loginId"]',
        'input[name="email"]',
        'input[name="userId"]',
        'input#loginKey',
        'input#loginId',
        'input#email',
        'input#loginEmail',
        'input[type="email"]',
        'input[placeholder*="이메일"]',
        'input[placeholder*="아이디"]',
        'input[placeholder*="카카오"]',
        // last resort: first non-password, non-hidden text input on page
        'form input:not([type="password"]):not([type="hidden"]):not([type="checkbox"]):not([type="submit"]):not([type="button"]):not([type="search"])',
      ];

      let idLocator = null;
      let idHit = "";
      for (const sel of idSelectors) {
        const cand = page.locator(sel).first();
        if (await cand.isVisible({ timeout: 1500 }).catch(() => false)) {
          idLocator = cand;
          idHit = sel;
          break;
        }
      }
      if (!idLocator) {
        const url = page.url();
        throw new Error(
          `로그인 폼의 ID 입력칸을 찾지 못했어요. 현재 URL: ${url}. 페이지 구조가 바뀌었거나 캡차가 떴을 수 있어요.`,
        );
      }
      emit({ kind: "phase", message: `found id input via ${idHit}` });

      await idLocator.fill(email);

      const pwLocator = page
        .locator('input[type="password"], input[name="password"], input#password')
        .first();
      await pwLocator.waitFor({ timeout: 5000 });
      await pwLocator.fill(password);

      emit({ kind: "phase", message: "submitting login" });
      const submit = page.locator(
        'button[type="submit"], input[type="submit"], button:has-text("로그인")',
      );
      await submit.first().click({ timeout: 5000 }).catch(async () => {
        // Some forms accept Enter on password field as submit.
        await pwLocator.press("Enter").catch(() => {});
      });

      emit({
        kind: "phase",
        message:
          "submitted — waiting for Kakao auth cookies (handle 2FA in the open Chromium if shown). Up to 5 min.",
      });

      const deadline = Date.now() + 5 * 60 * 1000;
      let captured = false;
      while (!captured && Date.now() < deadline) {
        if (signal?.aborted) throw new Error("aborted");
        await new Promise((r) => setTimeout(r, 1500));
        try {
          const cookies = await context.cookies();
          const hit = cookies.some(
            (c) =>
              (KAKAO_AUTH_COOKIES as readonly string[]).includes(c.name) ||
              c.name.startsWith("_kawlt"),
          );
          if (hit) {
            // Kakao auth cookies are session cookies (expires=-1) by design,
            // so Chrome wipes them from the persistent profile on close —
            // every subsequent agent run would look logged-out. Pin them as
            // 30-day persistent cookies before snapshotting + closing, so
            // both the user-data-dir and storage-state.json carry survivors.
            const KAKAO_SESSION_AUTH = [
              "_kawlt",
              "_kawltea",
              "_karmt",
              "_karmtea",
              "_kahai",
              "_kau",
              "_kaweb",
            ];
            const futureExpires =
              Math.floor(Date.now() / 1000) + 30 * 24 * 60 * 60;
            const toPin = cookies
              .filter(
                (c) =>
                  c.domain.endsWith("kakao.com") &&
                  KAKAO_SESSION_AUTH.includes(c.name) &&
                  (c.expires === undefined ||
                    c.expires === -1 ||
                    c.expires < Math.floor(Date.now() / 1000)),
              )
              .map((c) => ({ ...c, expires: futureExpires }));
            if (toPin.length > 0) {
              await context.addCookies(toPin);
              emit({
                kind: "phase",
                message: `pinned ${toPin.length} session cookies as 30-day persistent`,
              });
            }

            const state = await context.storageState();
            await writeFile(
              storageStatePath,
              JSON.stringify(state),
              "utf8",
            );

            // Hand the live Chrome off to the agent layer. The agent's MCP
            // will attach via CDP to THIS process — same in-memory cookies,
            // no logout between operations. Chrome stays alive until the
            // user explicitly resets the session or quits the app.
            const liveContext = context;
            setLoginHandle({
              context: liveContext,
              cdpEndpoint: AGENT_CAFE_CDP_ENDPOINT,
              close: async () => {
                try {
                  await liveContext.close();
                } catch {
                  /* already gone */
                }
              },
            });
            emit({
              kind: "done",
              message: `✓ login captured (${state.cookies.length} cookies). Chrome 창은 그대로 두세요 — 에이전트가 같은 창을 사용합니다.`,
              cookies: state.cookies.length,
            });
            captured = true;
          }
        } catch {
          /* tearing down */
        }
      }

      if (!captured) {
        throw new Error(
          "5분 안에 인증 쿠키가 잡히지 않았어요. 2FA 통과했는지 확인 후 다시 시도해주세요.",
        );
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      emit({ kind: "error", message });
    } finally {
      // Only close the Chrome on FAILURE — on success, Chrome stays alive
      // and is owned by the global login handle (set above) until the user
      // hits /api/reset-session or the app exits.
      const captured = Boolean(globalThis.__agentCafeLogin);
      if (!captured && context) {
        try {
          await context.close();
        } catch {
          /* ignore */
        }
      }
      await closeWriter();
    }
  })();

  return readable;
}
