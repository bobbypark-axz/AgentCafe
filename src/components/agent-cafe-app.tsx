"use client";

import { useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

/* ────────────────── types ────────────────── */

type RunStep = {
  kind: "phase" | "step";
  message: string;
  toolsUsed?: string[];
  stepNumber?: number;
  t: number;
};

type ChatMessage = {
  id: string;
  role: "user" | "assistant";
  content: string;
  steps: RunStep[];
  status?: "running" | "done" | "error" | "expired";
  postUrl?: string | null;
  errorMessage?: string;
};

type StreamEvent = {
  kind: string;
  message?: string;
  text?: string;
  postUrl?: string | null;
  url?: string;
  stepNumber?: number;
  finishReason?: string;
  toolsUsed?: string[];
  t?: number;
  [k: string]: unknown;
};

const PROMPT_SUGGESTIONS = [
  "RTX 5070 후기 글 하나 써줘",
  "이 카페 가입해줘",
  "오늘 자유게시판 새 글 보여줘",
  "[빌드로그] 주말에 7700X + RTX 4060Ti 조립했어요 🙂 이 제목 삭제해줘",
];

/* ────────────────── icons ────────────────── */

type IconProps = { size?: number; color?: string };

const Ic = {
  Logo: ({ size = 36 }: IconProps) => (
    <svg width={size} height={size} viewBox="0 0 36 36" aria-hidden>
      <defs>
        <linearGradient id="ic-logo" x1="0" x2="1" y1="0" y2="1">
          <stop offset="0%" stopColor="#3182F6" />
          <stop offset="100%" stopColor="#5B37ED" />
        </linearGradient>
      </defs>
      <rect width="36" height="36" rx="10" fill="url(#ic-logo)" />
      <text
        x="50%"
        y="55%"
        textAnchor="middle"
        dominantBaseline="middle"
        fill="#fff"
        fontWeight="800"
        fontSize="16"
        fontFamily="var(--font-brand)"
      >
        A
      </text>
    </svg>
  ),
  Plus: ({ size = 16, color = "currentColor" }: IconProps) => (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <line x1="12" y1="5" x2="12" y2="19" />
      <line x1="5" y1="12" x2="19" y2="12" />
    </svg>
  ),
  Send: ({ size = 16, color = "currentColor" }: IconProps) => (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M22 2 11 13" />
      <path d="m22 2-7 20-4-9-9-4 20-7z" />
    </svg>
  ),
  ChevronDown: ({ size = 14, color = "currentColor" }: IconProps) => (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="6 9 12 15 18 9" />
    </svg>
  ),
  Edit: ({ size = 13, color = "currentColor" }: IconProps) => (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
      <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
    </svg>
  ),
  Sparkle: ({ size = 13, color = "currentColor" }: IconProps) => (
    <svg width={size} height={size} viewBox="0 0 24 24" fill={color} aria-hidden>
      <path d="M12 3l1.7 4.6L18 9l-4.3 1.4L12 15l-1.7-4.6L6 9l4.3-1.4L12 3z" />
    </svg>
  ),
  X: ({ size = 16, color = "currentColor" }: IconProps) => (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2.2" strokeLinecap="round">
      <path d="M6 6l12 12" />
      <path d="M18 6L6 18" />
    </svg>
  ),
  Stop: ({ size = 12, color = "currentColor" }: IconProps) => (
    <svg width={size} height={size} viewBox="0 0 24 24" fill={color} aria-hidden>
      <rect x="6" y="6" width="12" height="12" rx="2" />
    </svg>
  ),
  Check: ({ size = 13, color = "currentColor" }: IconProps) => (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="20 6 9 17 4 12" />
    </svg>
  ),
  Warn: ({ size = 20, color = "currentColor" }: IconProps) => (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
      <line x1="12" y1="9" x2="12" y2="13" />
      <line x1="12" y1="17" x2="12.01" y2="17" />
    </svg>
  ),
  Globe: ({ size = 11, color = "currentColor" }: IconProps) => (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="10" />
      <line x1="2" y1="12" x2="22" y2="12" />
      <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" />
    </svg>
  ),
  Camera: ({ size = 11, color = "currentColor" }: IconProps) => (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z" />
      <circle cx="12" cy="13" r="4" />
    </svg>
  ),
  Mouse: ({ size = 11, color = "currentColor" }: IconProps) => (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="6" y="2" width="12" height="20" rx="6" />
      <line x1="12" y1="6" x2="12" y2="10" />
    </svg>
  ),
  Type: ({ size = 11, color = "currentColor" }: IconProps) => (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="4 7 4 4 20 4 20 7" />
      <line x1="9" y1="20" x2="15" y2="20" />
      <line x1="12" y1="4" x2="12" y2="20" />
    </svg>
  ),
};

const TOOL_META: Record<string, { icon: keyof typeof Ic; label: string }> = {
  browser_navigate: { icon: "Globe", label: "페이지 이동" },
  browser_snapshot: { icon: "Camera", label: "스냅샷" },
  browser_click: { icon: "Mouse", label: "클릭" },
  browser_type: { icon: "Type", label: "입력" },
};

/* ────────────────── root ────────────────── */

export function AgentCafeApp() {
  const [cafeUrl, setCafeUrl] = useState("https://cafe.daum.net/computermaker");
  const [editOpen, setEditOpen] = useState(false);
  const [loginOpen, setLoginOpen] = useState(false);
  const [onboardingOpen, setOnboardingOpen] = useState(false);
  const [sessionReady, setSessionReady] = useState<boolean | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const threadRef = useRef<HTMLDivElement>(null);
  const [sessionLabel] = useState(() =>
    new Date().toLocaleTimeString("ko-KR", {
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }),
  );

  useEffect(() => {
    if (typeof window === "undefined") return;
    const cached = window.localStorage.getItem("agentcafe.cafeUrl");
    if (cached) setCafeUrl(cached);
  }, []);
  useEffect(() => {
    if (typeof window === "undefined") return;
    window.localStorage.setItem("agentcafe.cafeUrl", cafeUrl);
  }, [cafeUrl]);

  const refreshSession = async () => {
    try {
      const r = await fetch("/api/session-status", { cache: "no-store" });
      const j = (await r.json()) as { ready?: boolean };
      setSessionReady(Boolean(j.ready));
    } catch {
      setSessionReady(false);
    }
  };
  useEffect(() => {
    void refreshSession();
  }, []);

  // Show onboarding once on first launch (per-machine via localStorage).
  // Bump the version when card copy changes so returning users see the
  // new architecture explanation (Chrome window stays open, etc.).
  const ONBOARDING_VERSION = "2";
  useEffect(() => {
    if (typeof window === "undefined") return;
    if (
      window.localStorage.getItem("agentcafe.onboarded") !== ONBOARDING_VERSION
    ) {
      setOnboardingOpen(true);
    }
  }, []);
  const dismissOnboarding = () => {
    if (typeof window !== "undefined") {
      window.localStorage.setItem("agentcafe.onboarded", ONBOARDING_VERSION);
    }
    setOnboardingOpen(false);
  };

  useEffect(() => {
    const el = threadRef.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
  }, [messages]);

  async function send(text?: string) {
    const message = (text ?? input).trim();
    if (!message || busy) return;

    if (sessionReady === false) {
      setLoginOpen(true);
      return;
    }

    const userId =
      typeof crypto !== "undefined" && crypto.randomUUID
        ? crypto.randomUUID()
        : `u-${Date.now()}`;
    const assistantId =
      typeof crypto !== "undefined" && crypto.randomUUID
        ? crypto.randomUUID()
        : `a-${Date.now()}`;

    const userMsg: ChatMessage = {
      id: userId,
      role: "user",
      content: message,
      steps: [],
    };
    const assistantMsg: ChatMessage = {
      id: assistantId,
      role: "assistant",
      content: "",
      steps: [],
      status: "running",
    };

    const history = messages.map((m) => ({ role: m.role, content: m.content }));

    setMessages((m) => [...m, userMsg, assistantMsg]);
    setInput("");
    setBusy(true);

    const ac = new AbortController();
    abortRef.current = ac;

    const updateAssistant = (mut: (msg: ChatMessage) => ChatMessage) => {
      setMessages((m) => m.map((x) => (x.id === assistantId ? mut(x) : x)));
    };

    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ message, cafeUrl, history }),
        signal: ac.signal,
      });

      if (!res.ok || !res.body) {
        const txt = await res.text().catch(() => "");
        updateAssistant((x) => ({
          ...x,
          status: "error",
          errorMessage: `${res.status} ${res.statusText} ${txt}`,
        }));
        return;
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      let sawDone = false;
      let sawAwaitingLogin = false;
      let sawError = false;

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
            const ev = JSON.parse(line) as StreamEvent;
            const t = typeof ev.t === "number" ? ev.t : Date.now();

            if (ev.kind === "chunk" && typeof ev.text === "string") {
              const text = ev.text;
              updateAssistant((x) => ({ ...x, content: x.content + text }));
              if (text.includes("AWAITING_LOGIN")) sawAwaitingLogin = true;
            } else if (ev.kind === "done") {
              sawDone = true;
              const u =
                (typeof ev.postUrl === "string" && ev.postUrl) || null;
              updateAssistant((x) => ({ ...x, postUrl: u }));
            } else if (ev.kind === "error") {
              sawError = true;
              const msg = String(ev.message ?? "");
              if (msg.startsWith("AWAITING_LOGIN")) sawAwaitingLogin = true;
              updateAssistant((x) => ({ ...x, errorMessage: msg }));
            } else if (ev.kind === "phase" || ev.kind === "step") {
              const message = String(ev.message ?? "");
              const toolsUsed = ev.toolsUsed ?? [];
              updateAssistant((x) => ({
                ...x,
                steps: [
                  ...x.steps,
                  {
                    kind: ev.kind as "phase" | "step",
                    message,
                    toolsUsed,
                    stepNumber: ev.stepNumber,
                    t,
                  },
                ],
              }));
            }
          } catch {
            /* ignore */
          }
        }
      }

      const finalStatus: ChatMessage["status"] = sawAwaitingLogin
        ? "expired"
        : sawDone && !sawError
          ? "done"
          : "error";
      updateAssistant((x) => ({ ...x, status: finalStatus }));
      if (sawAwaitingLogin) {
        setSessionReady(false);
        setLoginOpen(true);
      }
    } catch (err) {
      if ((err as Error).name === "AbortError") {
        updateAssistant((x) => ({
          ...x,
          status: "error",
          content: x.content + "\n\n[취소됨]",
        }));
        return;
      }
      updateAssistant((x) => ({
        ...x,
        status: "error",
        errorMessage: (err as Error).message,
      }));
    } finally {
      setBusy(false);
      abortRef.current = null;
    }
  }

  function newConversation() {
    abortRef.current?.abort();
    setMessages([]);
    setInput("");
    setBusy(false);
  }

  return (
    <div className="app">
      <Sidebar
        cafeUrl={cafeUrl}
        onEditCafe={() => setEditOpen(true)}
        onNewConversation={newConversation}
        hasMessages={messages.length > 0}
        sessionReady={sessionReady}
        onOpenLogin={() => setLoginOpen(true)}
        onOpenHelp={() => setOnboardingOpen(true)}
      />
      <main className="toss-main">
        <header className="toss-header">
          <span className="crumb">대화</span>
          <span className="session">session · {sessionLabel}</span>
          <span className="meta">모델 · claude-sonnet-4.6</span>
        </header>

        {messages.length === 0 ? (
          <Empty cafeUrl={cafeUrl} onPick={(t) => send(t)} />
        ) : (
          <div className="toss-thread" ref={threadRef}>
            <div className="toss-thread-inner">
              {messages.map((m) => (
                <MessageView key={m.id} msg={m} />
              ))}
            </div>
          </div>
        )}

        <Composer
          value={input}
          onChange={setInput}
          onSend={() => send()}
          disabled={busy}
        />
      </main>

      {editOpen && (
        <EditCafeUrlModal
          initial={cafeUrl}
          onClose={() => setEditOpen(false)}
          onSave={(v) => {
            setCafeUrl(v);
            setEditOpen(false);
          }}
        />
      )}
      {loginOpen && (
        <DaumLoginModal
          onClose={() => setLoginOpen(false)}
          onSuccess={() => {
            setLoginOpen(false);
            void refreshSession();
          }}
        />
      )}
      {onboardingOpen && <OnboardingModal onClose={dismissOnboarding} />}
    </div>
  );
}

/* ────────────────── sidebar ────────────────── */

function Sidebar({
  cafeUrl,
  onEditCafe,
  onNewConversation,
  hasMessages,
  sessionReady,
  onOpenLogin,
  onOpenHelp,
}: {
  cafeUrl: string;
  onEditCafe: () => void;
  onNewConversation: () => void;
  hasMessages: boolean;
  sessionReady: boolean | null;
  onOpenLogin: () => void;
  onOpenHelp: () => void;
}) {
  const cafeShort = cafeUrl.replace(/^https?:\/\//, "").split("?")[0];
  return (
    <aside className="side">
      <div className="brand">
        <Ic.Logo size={36} />
        <div style={{ display: "flex", flexDirection: "column", lineHeight: 1.1 }}>
          <span className="brand-name">AgentCafe</span>
          <span className="brand-tag">v0.2 · beta</span>
        </div>
      </div>

      <button
        type="button"
        className="toss-new-chat"
        onClick={onNewConversation}
        disabled={!hasMessages}
      >
        <Ic.Plus size={16} /> 새 대화
      </button>

      <div className="toss-section-label">로그인</div>
      <div className="toss-pill">
        <span className={`dot ${sessionReady ? "green" : "blue"}`} />
        <div className="meta">
          <span className="l">
            {sessionReady ? "Daum 로그인됨" : "Daum 로그인 필요"}
          </span>
          <span className="s">cafe.daum.net</span>
        </div>
        <button type="button" className="chip" onClick={onOpenLogin}>
          {sessionReady ? "재로그인" : "로그인"}
        </button>
      </div>

      <div className="toss-section-label">현재 카페</div>
      <button type="button" className="toss-cafe-pill" onClick={onEditCafe} title={cafeUrl}>
        <span className="dot" />
        <span className="url">{cafeShort}</span>
        <span className="icon">
          <Ic.Edit size={13} />
        </span>
      </button>

      <div className="toss-mode-card">
        <div className="av">N</div>
        <div className="meta">
          <span className="l">로컬 모드</span>
          <span className="s">~/.agent-cafe-profile</span>
        </div>
      </div>

      <button
        type="button"
        className="toss-help-btn"
        onClick={onOpenHelp}
        title="사용법 다시 보기"
      >
        <span className="qm">?</span>
        <span>사용법</span>
      </button>
    </aside>
  );
}

/* ────────────────── empty state ────────────────── */

function Empty({
  cafeUrl,
  onPick,
}: {
  cafeUrl: string;
  onPick: (text: string) => void;
}) {
  const cafeShort = cafeUrl.replace(/^https?:\/\/cafe\.daum\.net\//, "");
  return (
    <div className="toss-empty">
      <div className="toss-empty-title">무엇을 도와드릴까요?</div>
      <div className="toss-empty-sub">
        <span className="toss-mono blue">cafe.daum.net/{cafeShort}</span>
        <span> 에서 글 쓰기·삭제·관리·조회를 자연어로 시키면 Claude가 직접 처리합니다.</span>
      </div>
      <div className="toss-empty-prompts">
        {PROMPT_SUGGESTIONS.map((t) => (
          <button
            key={t}
            type="button"
            className="toss-empty-prompt"
            onClick={() => onPick(t)}
          >
            {t}
          </button>
        ))}
      </div>
    </div>
  );
}

/* ────────────────── message view ────────────────── */

function MessageView({ msg }: { msg: ChatMessage }) {
  if (msg.role === "user") {
    return (
      <div className="toss-msg-user">
        <div className="toss-msg-user-bubble">{msg.content}</div>
      </div>
    );
  }

  // assistant
  const stepsOnly = msg.steps.filter((s) => s.kind === "step");
  const showRunCard =
    stepsOnly.length > 0 || msg.status === "running" || msg.status === "done";

  const isAwaiting = msg.status === "expired";
  const isErrored = msg.status === "error";

  return (
    <div className="toss-msg-agent">
      {msg.content ? (
        <ReactMarkdown remarkPlugins={[remarkGfm]}>{msg.content}</ReactMarkdown>
      ) : msg.status === "running" ? (
        <p style={{ color: "var(--grey-500)", fontStyle: "italic" }}>
          생각 중…
        </p>
      ) : null}

      {showRunCard && <RunCard steps={msg.steps} status={msg.status} />}

      {msg.postUrl && (
        <p>
          <a href={msg.postUrl} target="_blank" rel="noreferrer">
            {msg.postUrl}
          </a>
        </p>
      )}

      {isAwaiting && (
        <Callout
          tone="warn"
          title="로그인 필요"
        >
          {msg.errorMessage?.replace(/^AWAITING_LOGIN:\s*/, "") ||
            "Daum/Kakao 로그인이 필요해요. 사이드바의 "}
          {!msg.errorMessage?.startsWith("AWAITING_LOGIN") && (
            <>
              <strong>재로그인</strong>
              {" 버튼을 눌러주시면 이어서 진행해드릴게요."}
            </>
          )}
        </Callout>
      )}

      {isErrored && !isAwaiting && msg.errorMessage && (
        <Callout tone="danger" title="오류">
          {msg.errorMessage}
        </Callout>
      )}
    </div>
  );
}

/* ────────────────── run card ────────────────── */

function RunCard({
  steps,
  status,
}: {
  steps: RunStep[];
  status?: ChatMessage["status"];
}) {
  const [open, setOpen] = useState(true);
  const stepRows = steps.filter((s) => s.kind === "step");
  const phases = steps.filter((s) => s.kind === "phase");

  const statusClass =
    status === "done"
      ? "done"
      : status === "error" || status === "expired"
        ? "error"
        : "running";
  const statusLabel =
    status === "done"
      ? "완료"
      : status === "error"
        ? "오류"
        : status === "expired"
          ? "로그인 필요"
          : "진행 중";

  return (
    <div className="toss-run">
      <button
        type="button"
        className="toss-run-header"
        onClick={() => setOpen((v) => !v)}
      >
        <span className={`toss-run-chev ${open ? "open" : "closed"}`}>
          <Ic.ChevronDown size={14} />
        </span>
        <span className="toss-run-title">실행 단계</span>
        <span className="toss-run-count">{stepRows.length}</span>
        <span className={`toss-run-status ${statusClass}`}>
          <span className="dot" />
          {statusLabel}
        </span>
      </button>
      {open && (
        <div className="toss-run-body">
          {phases.length > 0 && stepRows.length === 0 && (
            <PhaseList phases={phases} />
          )}
          {stepRows.map((s, i) => (
            <StepRow key={i} index={i} step={s} done={i < stepRows.length - 1 || status === "done"} />
          ))}
          {phases.length > 0 && stepRows.length > 0 && (
            <details style={{ marginTop: 6 }}>
              <summary
                style={{
                  fontSize: 11,
                  color: "var(--grey-400)",
                  cursor: "pointer",
                  fontFamily: "var(--font-mono)",
                  padding: "4px 4px",
                }}
              >
                phase 로그 ({phases.length})
              </summary>
              <PhaseList phases={phases} />
            </details>
          )}
        </div>
      )}
    </div>
  );
}

function PhaseList({ phases }: { phases: RunStep[] }) {
  return (
    <div
      style={{
        fontSize: 11,
        fontFamily: "var(--font-mono)",
        color: "var(--grey-500)",
        padding: "4px 8px",
        display: "flex",
        flexDirection: "column",
        gap: 2,
        background: "var(--grey-50)",
        borderRadius: 8,
        margin: "4px 0",
      }}
    >
      {phases.map((p, i) => (
        <div key={i}>· {p.message}</div>
      ))}
    </div>
  );
}

function StepRow({
  index,
  step,
  done,
}: {
  index: number;
  step: RunStep;
  done: boolean;
}) {
  const tools = step.toolsUsed ?? [];
  const primary = tools[0];
  const meta = primary ? TOOL_META[primary] : null;
  const ToolIcon = meta ? Ic[meta.icon] : null;

  // detail: prefer the toolsUsed list, fall back to the message
  const detail =
    tools.length > 1
      ? tools.slice(1).join(", ")
      : step.message
          .replace(/^step \d+\s*·?\s*/i, "")
          .replace(/^tool-calls?\s*/i, "")
          .trim();

  return (
    <div className={`toss-step ${done ? "done" : ""}`}>
      <div className="idx">
        {done ? <Ic.Check size={13} color="var(--toss-green-600)" /> : index}
      </div>
      <div className="body">
        {primary ? (
          <span className="tag">
            {ToolIcon && <ToolIcon size={11} color="var(--grey-500)" />}
            {primary}
          </span>
        ) : (
          <span className="tag">step {step.stepNumber ?? index}</span>
        )}
        {detail && <span className="detail">{detail}</span>}
      </div>
    </div>
  );
}

/* ────────────────── callout ────────────────── */

function Callout({
  tone,
  title,
  children,
}: {
  tone: "warn" | "danger";
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className={`toss-callout ${tone === "warn" ? "warn" : ""}`}>
      <span className="toss-callout-icon">
        <Ic.Warn size={20} />
      </span>
      <div>
        <div className="toss-callout-title">{title}</div>
        <div className="toss-callout-body">{children}</div>
      </div>
    </div>
  );
}

/* ────────────────── composer ────────────────── */

function Composer({
  value,
  onChange,
  onSend,
  disabled,
}: {
  value: string;
  onChange: (v: string) => void;
  onSend: () => void;
  disabled: boolean;
}) {
  const ref = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    const ta = ref.current;
    if (!ta) return;
    ta.style.height = "auto";
    ta.style.height = `${Math.min(ta.scrollHeight, 200)}px`;
  }, [value]);

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      onSend();
    }
  };

  return (
    <div className="toss-composer">
      <div className="toss-composer-box">
        <textarea
          ref={ref}
          className="toss-composer-input"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder="시킬 일을 적어주세요. 예: '이 제목 글 삭제해줘' / 'RTX 5070 후기 써줘'"
          rows={1}
        />
        <button
          type="button"
          className="toss-composer-send"
          onClick={onSend}
          disabled={disabled || value.trim().length === 0}
          aria-label="보내기"
        >
          <Ic.Send size={16} color="#fff" />
        </button>
      </div>
      <div className="toss-composer-hints">
        <span>⌘⏎ 전송</span>
        <span>⇧⏎ 줄바꿈</span>
        <span className="grow" />
        <span>로컬 모드 · 안전 격리됨</span>
      </div>
    </div>
  );
}

/* ────────────────── login modal ────────────────── */

function DaumLoginModal({
  onClose,
  onSuccess,
}: {
  onClose: () => void;
  onSuccess: () => void;
}) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);

  const canSubmit = email.includes("@") && password.length > 0 && !busy;

  async function submit() {
    if (!canSubmit) return;
    setBusy(true);
    setError(null);
    setProgress(["로그인 시도 중…"]);

    try {
      const res = await fetch("/api/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email, password }),
      });
      if (!res.ok || !res.body) {
        setError(`서버 오류: ${res.status} ${res.statusText}`);
        return;
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      let succeeded = false;
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
            const ev = JSON.parse(line) as { kind: string; message?: string };
            if (ev.kind === "phase") {
              setProgress((p) => [...p, ev.message ?? ""]);
            } else if (ev.kind === "done") {
              setProgress((p) => [...p, ev.message ?? "✓ 로그인 성공"]);
              succeeded = true;
            } else if (ev.kind === "error") {
              setError(ev.message ?? "로그인 실패");
            }
          } catch {
            /* ignore */
          }
        }
      }
      if (succeeded) {
        setTimeout(() => onSuccess(), 600);
      } else if (!error) {
        setError("로그인 완료되지 않음");
      }
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="modal-backdrop" onClick={busy ? undefined : onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-h">
          <div className="t">Daum 로그인</div>
          {!busy && (
            <button type="button" className="icon-btn" onClick={onClose}>
              <Ic.X size={16} />
            </button>
          )}
        </div>
        <div className="modal-body">
          <div
            style={{
              fontSize: 13,
              lineHeight: 1.6,
              color: "var(--grey-700)",
              background: "var(--grey-50)",
              border: "1px solid var(--border-subtle)",
              borderRadius: 10,
              padding: "10px 12px",
            }}
          >
            <div style={{ fontWeight: 700, color: "var(--grey-900)", marginBottom: 4 }}>
              로그인 동작 방식
            </div>
            ① 로그인 시 <strong>별도의 Chrome 창</strong>이 자동으로 열립니다.
            <br />
            ② 그 Chrome 창에서 자동 입력 + (필요하면) 2FA 직접 통과.
            <br />
            ③ 로그인 성공 후 <strong>그 Chrome 창은 절대 닫지 마세요</strong> —
            에이전트가 같은 창에서 작업합니다. 닫으면 다시 로그인 필요.
            <br />
            ④ AgentCafe 앱을 ⌘Q로 종료하면 Chrome 창도 같이 정리됩니다.
            <br />
            <span style={{ fontSize: 12, color: "var(--grey-500)" }}>
              입력값은 매 요청 body로만 전달, 서버에 저장 안 함.
            </span>
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            <input
              className="text-input"
              type="email"
              autoComplete="username"
              placeholder="email@daum.net"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              disabled={busy}
              autoFocus
            />
            <input
              className="text-input"
              type="password"
              autoComplete="current-password"
              placeholder="비밀번호"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              disabled={busy}
              onKeyDown={(e) => {
                if (e.key === "Enter") submit();
              }}
            />
          </div>

          {progress.length > 0 && (
            <div
              style={{
                fontSize: 12,
                color: "var(--grey-500)",
                fontFamily: "var(--font-mono)",
                background: "var(--grey-50)",
                padding: "8px 10px",
                borderRadius: 8,
                border: "1px solid var(--border-subtle)",
                maxHeight: 140,
                overflowY: "auto",
              }}
            >
              {progress.map((p, i) => (
                <div key={i}>· {p}</div>
              ))}
            </div>
          )}

          {error && (
            <div
              style={{
                fontSize: 13,
                color: "var(--toss-red-500)",
                background: "rgba(240,66,81,0.06)",
                padding: "10px 12px",
                borderRadius: 8,
                border: "1px solid var(--toss-red-100)",
              }}
            >
              {error}
            </div>
          )}

          <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
            {!busy && (
              <button
                type="button"
                className="btn btn-out btn-sm"
                onClick={onClose}
              >
                취소
              </button>
            )}
            <button
              type="button"
              className="btn btn-primary btn-sm"
              disabled={!canSubmit}
              onClick={submit}
            >
              {busy ? "로그인 중…" : "로그인"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

/* ────────────────── onboarding modal ────────────────── */

type OnboardingCard = {
  emoji: string;
  title: string;
  body: React.ReactNode;
};

const ONBOARDING_CARDS: OnboardingCard[] = [
  {
    emoji: "👋",
    title: "AgentCafe에 오신 걸 환영합니다",
    body: (
      <>
        Daum 카페에 글 쓰기·삭제·관리·조회를 자연어로 시키면 Claude가 직접
        Chrome 브라우저를 열어서 처리해주는 운영자용 도구입니다. 모든 작업은 본
        PC에서만 일어나고 외부 서버로 자료가 빠져나가지 않아요.
      </>
    ),
  },
  {
    emoji: "🔐",
    title: "처음에 한 번만 로그인",
    body: (
      <>
        사이드바의 <strong>로그인</strong> 버튼을 누르면 별도의 Chrome 창이
        열리고 자동으로 Daum/카카오 로그인을 진행합니다. 2FA가 뜨면 그 Chrome
        창에서 직접 통과해 주세요. 한 번 로그인하면 <strong>앱이 켜져있는
        동안</strong>은 계속 유지됩니다.
      </>
    ),
  },
  {
    emoji: "🪟",
    title: "Chrome 창은 절대 닫지 마세요",
    body: (
      <>
        로그인 후 뜨는 그 Chrome 창이 곧 <strong>에이전트의 작업 창</strong>
        이에요. 모든 글 작성·삭제·조회가 그 한 창에서 일어납니다.
        창을 닫으면 카카오 세션이 끊겨서 다시 로그인해야 해요.
        <br />
        앱을 끝낼 땐 AgentCafe를 ⌘Q로 종료하시면 Chrome 창도 같이 정리됩니다.
      </>
    ),
  },
  {
    emoji: "💬",
    title: "이렇게 시키면 됩니다",
    body: (
      <>
        <ul style={{ margin: "8px 0 0", paddingLeft: 18, lineHeight: 1.7 }}>
          <li>“RTX 5070 후기 글 하나 써줘”</li>
          <li>“[제목 일부] 이 글 삭제해줘”</li>
          <li>“오늘 자유게시판 새 글 보여줘”</li>
          <li>“광고 도배글 5개 차단해줘”</li>
        </ul>
        <p style={{ marginTop: 10, fontSize: 12.5, color: "var(--grey-500)" }}>
          ⚠️ 한 번에 30개씩 시키면 Daum의 연속 등록 제한에 걸려요.{" "}
          <strong>5~10개씩 끊어서</strong> 시키세요.
        </p>
      </>
    ),
  },
];

function OnboardingModal({ onClose }: { onClose: () => void }) {
  const [step, setStep] = useState(0);
  const total = ONBOARDING_CARDS.length;
  const card = ONBOARDING_CARDS[step];
  const isLast = step === total - 1;

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-h">
          <div className="t">사용법 안내</div>
          <button type="button" className="icon-btn" onClick={onClose}>
            <Ic.X size={16} />
          </button>
        </div>
        <div className="modal-body">
          <div
            style={{
              fontSize: 40,
              lineHeight: 1,
              textAlign: "center",
              padding: "8px 0 4px",
            }}
            aria-hidden
          >
            {card.emoji}
          </div>
          <div
            style={{
              fontSize: 17,
              fontWeight: 700,
              textAlign: "center",
              color: "var(--grey-900)",
            }}
          >
            {card.title}
          </div>
          <div
            style={{
              fontSize: 13.5,
              color: "var(--grey-600)",
              lineHeight: 1.65,
              padding: "0 4px",
            }}
          >
            {card.body}
          </div>

          <div
            style={{
              display: "flex",
              justifyContent: "center",
              gap: 6,
              padding: "4px 0 0",
            }}
            aria-label="진행 단계"
          >
            {ONBOARDING_CARDS.map((_, i) => (
              <span
                key={i}
                style={{
                  width: i === step ? 18 : 6,
                  height: 6,
                  borderRadius: 3,
                  background:
                    i === step ? "var(--toss-blue-500)" : "var(--grey-200)",
                  transition: "width 160ms ease",
                }}
              />
            ))}
          </div>

          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              gap: 8,
              paddingTop: 4,
            }}
          >
            <button
              type="button"
              className="btn btn-out btn-sm"
              onClick={() => setStep((s) => Math.max(0, s - 1))}
              disabled={step === 0}
            >
              이전
            </button>
            {isLast ? (
              <button
                type="button"
                className="btn btn-primary btn-sm"
                onClick={onClose}
              >
                시작하기
              </button>
            ) : (
              <button
                type="button"
                className="btn btn-primary btn-sm"
                onClick={() => setStep((s) => Math.min(total - 1, s + 1))}
              >
                다음
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

/* ────────────────── edit cafe modal ────────────────── */

function EditCafeUrlModal({
  initial,
  onClose,
  onSave,
}: {
  initial: string;
  onClose: () => void;
  onSave: (v: string) => void;
}) {
  const [v, setV] = useState(initial);
  const valid = /^https?:\/\/cafe\.daum\.net\/.+/.test(v.trim());
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-h">
          <div className="t">대상 카페 변경</div>
          <button type="button" className="icon-btn" onClick={onClose}>
            <Ic.X size={16} />
          </button>
        </div>
        <div className="modal-body">
          <p>모든 명령이 이 카페에서 실행됩니다.</p>
          <input
            className="text-input"
            type="url"
            value={v}
            onChange={(e) => setV(e.target.value)}
            placeholder="https://cafe.daum.net/..."
            autoFocus
          />
          <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
            <button type="button" className="btn btn-out btn-sm" onClick={onClose}>
              취소
            </button>
            <button
              type="button"
              className="btn btn-primary btn-sm"
              disabled={!valid}
              onClick={() => onSave(v.trim())}
            >
              저장
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
