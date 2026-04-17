"use client";

import { useCallback, useEffect, useRef, useState } from "react";

type LogEvent = {
  kind: string;
  message?: string;
  line?: string;
  stepNumber?: number;
  finishReason?: string;
  toolsUsed?: string[];
  tools?: string[];
  text?: string;
  summary?: string;
  postUrl?: string | null;
  [k: string]: unknown;
};

const LENGTH_OPTIONS = [
  { value: "short" as const, label: "짧게", desc: "~200자" },
  { value: "medium" as const, label: "보통", desc: "~500자" },
  { value: "long" as const, label: "길게", desc: "~1000자" },
];

export function CafeForm() {
  const [cafeUrl, setCafeUrl] = useState("https://cafe.daum.net/1232123124");
  const [topicHint, setTopicHint] = useState("");
  const [length, setLength] = useState<"short" | "medium" | "long">("medium");
  const [tone, setTone] = useState("");
  const [busy, setBusy] = useState(false);
  const [events, setEvents] = useState<LogEvent[]>([]);
  const [finalUrl, setFinalUrl] = useState<string | null>(null);
  const [logOpen, setLogOpen] = useState(false);
  const [loginOpen, setLoginOpen] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const logEndRef = useRef<HTMLDivElement | null>(null);

  const currentPhase =
    [...events].reverse().find((e) => e.kind === "phase")?.message ?? null;
  const stepCount = events.filter((e) => e.kind === "step").length;
  const hasError = events.some((e) => e.kind === "error");

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setEvents([]);
    setFinalUrl(null);
    setLogOpen(false);

    const ac = new AbortController();
    abortRef.current = ac;

    try {
      const res = await fetch("/api/create-cafe", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          cafeUrl,
          topicHint: topicHint || undefined,
          length,
          tone: tone || undefined,
        }),
        signal: ac.signal,
      });

      if (!res.ok || !res.body) {
        const text = await res.text().catch(() => "");
        setEvents((xs) => [
          ...xs,
          { kind: "error", message: `${res.status} ${res.statusText} ${text}` },
        ]);
        return;
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let i: number;
        while ((i = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, i).trim();
          buf = buf.slice(i + 1);
          if (!line) continue;
          try {
            const event = JSON.parse(line) as LogEvent;
            setEvents((xs) => [...xs, event]);
            if (event.kind === "done" && event.postUrl) {
              setFinalUrl(event.postUrl);
            }
          } catch {
            setEvents((xs) => [...xs, { kind: "log", line }]);
          }
        }
      }
    } catch (err) {
      if ((err as Error).name === "AbortError") return;
      setEvents((xs) => [
        ...xs,
        { kind: "error", message: (err as Error).message },
      ]);
    } finally {
      setBusy(false);
      abortRef.current = null;
    }
  }

  function cancel() {
    abortRef.current?.abort();
  }

  function reset() {
    setEvents([]);
    setFinalUrl(null);
    setLogOpen(false);
  }

  return (
    <div className="flex flex-col min-h-dvh">
      {/* Header */}
      <header className="border-b border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900">
        <div className="mx-auto max-w-2xl px-5 py-4 flex items-center gap-3">
          <div className="flex items-center justify-center w-9 h-9 rounded-lg bg-sky-600 text-white font-bold text-sm shrink-0">
            AC
          </div>
          <div className="flex-1">
            <h1 className="text-lg font-semibold tracking-tight leading-tight">
              AgentCafe
            </h1>
            <p className="text-xs text-zinc-500 dark:text-zinc-400">
              Claude가 글을 창작해서 다음 카페에 게시합니다
            </p>
          </div>
          <button
            type="button"
            onClick={() => setLoginOpen(true)}
            className="inline-flex items-center gap-1.5 rounded-lg border border-zinc-300 dark:border-zinc-700 px-3 py-1.5 text-xs font-medium text-zinc-600 dark:text-zinc-300 hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-colors"
          >
            <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 5.25a3 3 0 013 3m3 0a6 6 0 01-7.029 5.912c-.563-.097-1.159.026-1.563.43L10.5 17.25H8.25v2.25H6v2.25H2.25v-2.818c0-.597.237-1.17.659-1.591l6.499-6.499c.404-.404.527-1 .43-1.563A6 6 0 1121.75 8.25z" />
            </svg>
            세션 로그인
          </button>
        </div>
      </header>

      {/* Main content */}
      <main className="flex-1 mx-auto max-w-2xl w-full px-5 py-6 space-y-5">
        {/* Form Card */}
        <div className="bg-white dark:bg-zinc-900 rounded-xl border border-zinc-200 dark:border-zinc-800 shadow-sm">
          <form onSubmit={submit} className="p-5 space-y-5">
            {/* Cafe URL */}
            <Field label="카페 URL" required>
              <input
                className="input-base"
                value={cafeUrl}
                onChange={(e) => setCafeUrl(e.target.value)}
                placeholder="https://cafe.daum.net/your-cafe"
                required
                disabled={busy}
              />
            </Field>

            {/* Topic */}
            <Field label="주제 힌트" hint="비워두면 Claude가 자유롭게 정합니다">
              <input
                className="input-base"
                value={topicHint}
                onChange={(e) => setTopicHint(e.target.value)}
                maxLength={200}
                placeholder="예: 요즘 쓰는 기계식 키보드 추천"
                disabled={busy}
              />
            </Field>

            {/* Length - Segment control */}
            <Field label="글 길이">
              <div className="inline-flex rounded-lg border border-zinc-200 dark:border-zinc-700 bg-zinc-100 dark:bg-zinc-800 p-0.5">
                {LENGTH_OPTIONS.map((opt) => (
                  <button
                    key={opt.value}
                    type="button"
                    disabled={busy}
                    onClick={() => setLength(opt.value)}
                    className={`
                      px-4 py-1.5 rounded-md text-sm font-medium transition-all
                      disabled:cursor-not-allowed
                      ${
                        length === opt.value
                          ? "bg-white dark:bg-zinc-700 text-zinc-900 dark:text-white shadow-sm"
                          : "text-zinc-500 dark:text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200"
                      }
                    `}
                  >
                    {opt.label}
                    <span className="ml-1 text-xs opacity-50">{opt.desc}</span>
                  </button>
                ))}
              </div>
            </Field>

            {/* Tone */}
            <Field label="말투" hint="선택사항">
              <input
                className="input-base"
                value={tone}
                onChange={(e) => setTone(e.target.value)}
                maxLength={40}
                placeholder="예: 정보전달 / 후기 / 잡담"
                disabled={busy}
              />
            </Field>

            {/* Actions */}
            <div className="flex items-center gap-3 pt-1">
              <button
                type="submit"
                className="inline-flex items-center gap-2 rounded-lg bg-sky-600 px-5 py-2.5 text-sm font-medium text-white shadow-sm hover:bg-sky-500 active:bg-sky-700 transition-colors disabled:cursor-not-allowed disabled:opacity-50"
                disabled={busy || !cafeUrl.trim()}
              >
                {busy && <Spinner />}
                {busy ? "작업 중..." : "글 쓰고 발행"}
              </button>
              {busy && (
                <button
                  type="button"
                  className="inline-flex items-center rounded-lg border border-zinc-300 dark:border-zinc-700 px-4 py-2.5 text-sm font-medium text-zinc-600 dark:text-zinc-300 hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-colors"
                  onClick={cancel}
                >
                  취소
                </button>
              )}
              {!busy && events.length > 0 && (
                <button
                  type="button"
                  className="text-sm text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-200 transition-colors"
                  onClick={reset}
                >
                  초기화
                </button>
              )}
            </div>
          </form>
        </div>

        {/* Progress Card — visible while busy or after completion */}
        {(busy || events.length > 0) && (
          <div className="bg-white dark:bg-zinc-900 rounded-xl border border-zinc-200 dark:border-zinc-800 shadow-sm overflow-hidden">
            {/* Status bar */}
            <div className="px-5 py-3 flex items-center justify-between border-b border-zinc-100 dark:border-zinc-800">
              <div className="flex items-center gap-3">
                {busy && <Spinner className="text-sky-500" />}
                {!busy && finalUrl && (
                  <span className="flex items-center justify-center w-5 h-5 rounded-full bg-emerald-500 text-white text-xs">
                    &#10003;
                  </span>
                )}
                {!busy && hasError && !finalUrl && (
                  <span className="flex items-center justify-center w-5 h-5 rounded-full bg-red-500 text-white text-xs font-bold">
                    !
                  </span>
                )}
                <div>
                  <p className="text-sm font-medium">
                    {busy
                      ? currentPhase ?? "시작하는 중..."
                      : finalUrl
                        ? "완료!"
                        : hasError
                          ? "오류 발생"
                          : "작업 종료"}
                  </p>
                  {busy && stepCount > 0 && (
                    <p className="text-xs text-zinc-400">
                      {stepCount}단계 진행됨
                    </p>
                  )}
                </div>
              </div>
              {/* Progress bar */}
              {busy && (
                <div className="w-24 h-1.5 bg-zinc-200 dark:bg-zinc-700 rounded-full overflow-hidden">
                  <div className="h-full bg-sky-500 rounded-full animate-pulse w-2/3" />
                </div>
              )}
            </div>

            {/* Success result */}
            {finalUrl && (
              <div className="px-5 py-4 bg-emerald-50 dark:bg-emerald-950/30">
                <p className="text-sm text-emerald-700 dark:text-emerald-300 mb-1.5 font-medium">
                  글이 성공적으로 올라갔어요!
                </p>
                <a
                  href={finalUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-1.5 text-sm text-emerald-600 dark:text-emerald-400 font-medium underline underline-offset-2 break-all hover:text-emerald-700 dark:hover:text-emerald-300 transition-colors"
                >
                  {finalUrl}
                  <svg
                    className="w-3.5 h-3.5 shrink-0"
                    fill="none"
                    viewBox="0 0 24 24"
                    stroke="currentColor"
                    strokeWidth={2}
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      d="M13.5 6H5.25A2.25 2.25 0 003 8.25v10.5A2.25 2.25 0 005.25 21h10.5A2.25 2.25 0 0018 18.75V10.5m-4.5-6H21m0 0v7.5m0-7.5L10.5 13.5"
                    />
                  </svg>
                </a>
              </div>
            )}

            {/* Error display */}
            {hasError && (
              <div className="px-5 py-3 bg-red-50 dark:bg-red-950/30">
                {events
                  .filter((e) => e.kind === "error")
                  .map((e, i) => (
                    <p
                      key={i}
                      className="text-sm text-red-600 dark:text-red-400"
                    >
                      {e.message}
                    </p>
                  ))}
              </div>
            )}

            {/* Collapsible log */}
            {events.length > 0 && (
              <div className="border-t border-zinc-100 dark:border-zinc-800">
                <button
                  type="button"
                  className="w-full px-5 py-2.5 flex items-center justify-between text-xs text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-300 transition-colors"
                  onClick={() => setLogOpen((v) => !v)}
                >
                  <span>
                    실행 로그 ({events.length}건)
                  </span>
                  <svg
                    className={`w-4 h-4 transition-transform ${logOpen ? "rotate-180" : ""}`}
                    fill="none"
                    viewBox="0 0 24 24"
                    stroke="currentColor"
                    strokeWidth={2}
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      d="M19.5 8.25l-7.5 7.5-7.5-7.5"
                    />
                  </svg>
                </button>
                {logOpen && (
                  <ol className="px-4 pb-4 space-y-0.5 text-xs font-mono max-h-80 overflow-auto">
                    {events.map((ev, i) => (
                      <EventLine key={i} event={ev} />
                    ))}
                    <div ref={logEndRef} />
                  </ol>
                )}
              </div>
            )}
          </div>
        )}
      </main>

      {/* Login Modal */}
      {loginOpen && <LoginModal onClose={() => setLoginOpen(false)} />}

      {/* Footer */}
      <footer className="border-t border-zinc-200 dark:border-zinc-800 py-3">
        <p className="text-center text-xs text-zinc-400">
          Powered by Claude &middot; AgentCafe
        </p>
      </footer>
    </div>
  );
}

/* ─── Subcomponents ──────────────────────── */

function Field({
  label,
  required,
  hint,
  children,
}: {
  label: string;
  required?: boolean;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <label className="block">
      <span className="flex items-baseline gap-2 mb-1.5">
        <span className="text-sm font-medium">
          {label}
          {required && <span className="text-red-400 ml-0.5">*</span>}
        </span>
        {hint && (
          <span className="text-xs text-zinc-400">{hint}</span>
        )}
      </span>
      {children}
    </label>
  );
}

function Spinner({ className = "" }: { className?: string }) {
  return (
    <svg
      className={`animate-spin h-4 w-4 ${className}`}
      fill="none"
      viewBox="0 0 24 24"
    >
      <circle
        className="opacity-25"
        cx="12"
        cy="12"
        r="10"
        stroke="currentColor"
        strokeWidth="4"
      />
      <path
        className="opacity-75"
        fill="currentColor"
        d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
      />
    </svg>
  );
}

/* ─── Login Modal ────────────────────────── */

function LoginModal({ onClose }: { onClose: () => void }) {
  const [phase, setPhase] = useState<"idle" | "starting" | "active" | "saving" | "done">("idle");
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [screenshot, setScreenshot] = useState<string | null>(null);
  const [statusInfo, setStatusInfo] = useState<{ url?: string; title?: string }>({});
  const [inputText, setInputText] = useState("");
  const [message, setMessage] = useState("");
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const stopPolling = useCallback(() => {
    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
  }, []);

  // Poll for screenshots
  useEffect(() => {
    if (phase !== "active" || !sessionId) return;
    const poll = async () => {
      try {
        const res = await fetch("/api/auth", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ action: "screenshot", sessionId }),
        });
        if (res.ok) {
          const data = await res.json();
          if (data.screenshot) setScreenshot(data.screenshot);
          if (data.status) setStatusInfo(data.status);
        }
      } catch { /* ignore */ }
    };
    pollRef.current = setInterval(poll, 3000);
    return stopPolling;
  }, [phase, sessionId, stopPolling]);

  async function startLogin() {
    setPhase("starting");
    setMessage("Sandbox 준비 중... (1~2분 소요)");
    try {
      const res = await fetch("/api/auth", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "start" }),
      });
      const data = await res.json();
      if (data.error) {
        setMessage(`오류: ${data.error}`);
        setPhase("idle");
        return;
      }
      setSessionId(data.sessionId);
      setScreenshot(data.screenshot);
      setStatusInfo(data.status ?? {});
      setPhase("active");
      setMessage("");
    } catch (err) {
      setMessage(`오류: ${(err as Error).message}`);
      setPhase("idle");
    }
  }

  async function sendCommand(cmd: Record<string, unknown>) {
    if (!sessionId) return;
    try {
      const res = await fetch("/api/auth", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "command", sessionId, command: cmd }),
      });
      const data = await res.json();
      if (data.screenshot) setScreenshot(data.screenshot);
      if (data.status) setStatusInfo(data.status);
    } catch { /* ignore */ }
  }

  async function handleType() {
    if (!inputText.trim()) return;
    await sendCommand({ action: "type", text: inputText });
    setInputText("");
  }

  async function handleClick(e: React.MouseEvent<HTMLImageElement>) {
    const img = e.currentTarget;
    const rect = img.getBoundingClientRect();
    const scaleX = 1280 / rect.width;
    const scaleY = 900 / rect.height;
    const x = Math.round((e.clientX - rect.left) * scaleX);
    const y = Math.round((e.clientY - rect.top) * scaleY);
    await sendCommand({ action: "click", x, y });
  }

  async function saveSession() {
    if (!sessionId) return;
    setPhase("saving");
    setMessage("세션 저장 중...");
    stopPolling();
    try {
      const res = await fetch("/api/auth", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "save", sessionId }),
      });
      const data = await res.json();
      if (data.ok) {
        setPhase("done");
        setMessage("세션이 저장되었습니다! 이제 글쓰기가 가능합니다.");
      } else {
        setMessage(`저장 실패: ${data.error}`);
        setPhase("active");
      }
    } catch (err) {
      setMessage(`오류: ${(err as Error).message}`);
      setPhase("active");
    }
  }

  async function handleStop() {
    stopPolling();
    if (sessionId) {
      await fetch("/api/auth", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "stop", sessionId }),
      }).catch(() => {});
    }
    onClose();
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
      <div className="bg-white dark:bg-zinc-900 rounded-xl border border-zinc-200 dark:border-zinc-800 shadow-2xl w-full max-w-3xl max-h-[90vh] flex flex-col overflow-hidden">
        {/* Modal header */}
        <div className="px-5 py-3 border-b border-zinc-200 dark:border-zinc-800 flex items-center justify-between shrink-0">
          <h2 className="text-sm font-semibold">다음 카페 세션 로그인</h2>
          <button onClick={handleStop} className="text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-200">
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* Modal body */}
        <div className="flex-1 overflow-auto p-5 space-y-4">
          {phase === "idle" && (
            <div className="text-center py-8 space-y-4">
              <p className="text-sm text-zinc-500">
                Sandbox에서 브라우저를 열고 카카오 로그인을 진행합니다.<br />
                2차 인증이 필요하면 이 화면에서 직접 입력할 수 있습니다.
              </p>
              <button onClick={startLogin} className="inline-flex items-center gap-2 rounded-lg bg-sky-600 px-5 py-2.5 text-sm font-medium text-white hover:bg-sky-500 transition-colors">
                로그인 시작
              </button>
            </div>
          )}

          {phase === "starting" && (
            <div className="text-center py-12 space-y-3">
              <Spinner className="mx-auto text-sky-500 !h-8 !w-8" />
              <p className="text-sm text-zinc-400">{message}</p>
            </div>
          )}

          {(phase === "active" || phase === "saving") && (
            <>
              {/* Status bar */}
              <div className="text-xs text-zinc-400 truncate">
                {statusInfo.title && <span className="font-medium text-zinc-500 dark:text-zinc-300">{statusInfo.title}</span>}
                {statusInfo.url && <span className="ml-2">{statusInfo.url}</span>}
              </div>

              {/* Screenshot — clickable */}
              {screenshot && (
                <div className="border border-zinc-200 dark:border-zinc-700 rounded-lg overflow-hidden cursor-crosshair">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={`data:image/png;base64,${screenshot}`}
                    alt="Browser"
                    className="w-full"
                    onClick={handleClick}
                  />
                </div>
              )}

              {/* Input controls */}
              <div className="flex gap-2">
                <input
                  className="input-base flex-1"
                  value={inputText}
                  onChange={(e) => setInputText(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") { e.preventDefault(); handleType(); }
                  }}
                  placeholder="텍스트 입력 (2FA 코드, 등)"
                  disabled={phase === "saving"}
                />
                <button
                  type="button"
                  onClick={handleType}
                  disabled={phase === "saving" || !inputText.trim()}
                  className="rounded-lg bg-zinc-200 dark:bg-zinc-700 px-3 py-2 text-xs font-medium hover:bg-zinc-300 dark:hover:bg-zinc-600 disabled:opacity-50 transition-colors"
                >
                  입력
                </button>
                <button
                  type="button"
                  onClick={() => sendCommand({ action: "press", key: "Enter" })}
                  disabled={phase === "saving"}
                  className="rounded-lg bg-zinc-200 dark:bg-zinc-700 px-3 py-2 text-xs font-medium hover:bg-zinc-300 dark:hover:bg-zinc-600 disabled:opacity-50 transition-colors"
                >
                  Enter
                </button>
              </div>

              {/* Action buttons */}
              <div className="flex items-center gap-3">
                <button
                  type="button"
                  onClick={saveSession}
                  disabled={phase === "saving"}
                  className="inline-flex items-center gap-2 rounded-lg bg-emerald-600 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-500 disabled:opacity-50 transition-colors"
                >
                  {phase === "saving" && <Spinner />}
                  {phase === "saving" ? "저장 중..." : "로그인 완료 — 세션 저장"}
                </button>
                <p className="text-xs text-zinc-400">
                  로그인 완료 후 이 버튼을 누르세요
                </p>
              </div>
            </>
          )}

          {phase === "done" && (
            <div className="text-center py-8 space-y-4">
              <div className="flex items-center justify-center w-12 h-12 rounded-full bg-emerald-100 dark:bg-emerald-900/30 mx-auto">
                <span className="text-emerald-600 dark:text-emerald-400 text-xl">&#10003;</span>
              </div>
              <p className="text-sm text-emerald-600 dark:text-emerald-400 font-medium">{message}</p>
              <button onClick={onClose} className="rounded-lg bg-zinc-200 dark:bg-zinc-700 px-4 py-2 text-sm font-medium hover:bg-zinc-300 dark:hover:bg-zinc-600 transition-colors">
                닫기
              </button>
            </div>
          )}

          {message && phase !== "done" && phase !== "starting" && (
            <p className="text-xs text-amber-500">{message}</p>
          )}
        </div>
      </div>
    </div>
  );
}

function EventLine({ event }: { event: LogEvent }) {
  const { kind } = event;
  const colors: Record<string, string> = {
    error: "text-red-400",
    phase: "text-sky-400",
    step: "text-amber-400",
    done: "text-emerald-400",
    chunk: "text-zinc-300 dark:text-zinc-400",
  };
  const color = colors[kind] ?? "text-zinc-500";

  const stepSummary =
    kind === "step"
      ? `step ${event.stepNumber} · ${event.finishReason ?? ""} · tools: ${event.toolsUsed?.join(", ") ?? "—"}`
      : undefined;
  const primary =
    event.message ??
    event.line ??
    event.text ??
    event.summary ??
    stepSummary ??
    "";

  return (
    <li className={`${color} whitespace-pre-wrap break-words py-0.5 leading-relaxed`}>
      <span className="inline-block min-w-[3.5rem] opacity-40 select-none">
        [{kind}]
      </span>{" "}
      {primary}
    </li>
  );
}
