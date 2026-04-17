"use client";

import { useRef, useState } from "react";

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
          <div>
            <h1 className="text-lg font-semibold tracking-tight leading-tight">
              AgentCafe
            </h1>
            <p className="text-xs text-zinc-500 dark:text-zinc-400">
              Claude가 글을 창작해서 다음 카페에 게시합니다
            </p>
          </div>
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
