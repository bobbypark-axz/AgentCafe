"use client";

import { useEffect, useMemo, useRef, useState } from "react";

/* ────────────────── types ────────────────── */

type Mode = "create" | "post" | "moderate";

type AgentState = "form" | "running" | "done" | "expired" | "error";

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
  cafeUrl?: string | null;
  url?: string;
  author?: string;
  where?: string;
  matched?: string[];
  snippet?: string;
  reason?: string;
  action?: string;
  success?: boolean;
  inputTokens?: number;
  outputTokens?: number;
  t?: number;
  [k: string]: unknown;
};

/* ────────────────── constants ────────────────── */

const MODE_LABELS: Record<Mode, string> = {
  create: "카페 생성",
  post: "글 자동 게시",
  moderate: "모더레이션",
};

const TOPIC_HINTS = [
  "새 GPU 후기",
  "주말 빌드 로그",
  "맥북 vs 윈도우",
  "리눅스 입문",
  "키보드 추천",
];

const MOD_ACTIONS: Array<{
  value: "3일 정지" | "7일 정지" | "영구 차단";
  title: string;
  desc: string;
}> = [
  { value: "3일 정지", title: "활동 정지 3일", desc: "가벼운 1차 경고" },
  { value: "7일 정지", title: "활동 정지 7일", desc: "반복 위반 · 권장" },
  { value: "영구 차단", title: "영구 차단", desc: "광고/스팸 확정" },
];

/* ────────────────── icons (currentColor) ────────────────── */

function Icon({ name, size = 18 }: { name: IconName; size?: number }) {
  const path = ICON_PATHS[name];
  return (
    <svg className="ic" viewBox="0 0 24 24" width={size} height={size}>
      {path}
    </svg>
  );
}

type IconName =
  | "home"
  | "write"
  | "shield"
  | "list"
  | "sessions"
  | "setting"
  | "bell"
  | "arrow"
  | "check"
  | "x"
  | "warn"
  | "refresh"
  | "lock"
  | "expand"
  | "sparkle"
  | "copy";

const ICON_PATHS: Record<IconName, React.ReactNode> = {
  home: (
    <path
      d="M3 11.5L12 4l9 7.5V20a1 1 0 0 1-1 1h-5v-6h-6v6H4a1 1 0 0 1-1-1v-8.5z"
      stroke="currentColor"
      strokeWidth="1.6"
      fill="none"
      strokeLinejoin="round"
    />
  ),
  write: (
    <g stroke="currentColor" strokeWidth="1.6" fill="none" strokeLinecap="round" strokeLinejoin="round">
      <path d="M4 20h4l11-11-4-4L4 16v4z" />
      <path d="M14 6l4 4" />
    </g>
  ),
  shield: (
    <path
      d="M12 3l8 3v6c0 4.5-3.4 8.4-8 9-4.6-.6-8-4.5-8-9V6l8-3z"
      stroke="currentColor"
      strokeWidth="1.6"
      fill="none"
      strokeLinejoin="round"
    />
  ),
  list: (
    <g stroke="currentColor" strokeWidth="1.6" strokeLinecap="round">
      <path d="M4 6h16" />
      <path d="M4 12h16" />
      <path d="M4 18h10" />
    </g>
  ),
  sessions: (
    <g stroke="currentColor" strokeWidth="1.6" fill="none" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="5" width="18" height="14" rx="2" />
      <path d="M3 9h18" />
      <circle cx="7" cy="7" r=".6" fill="currentColor" />
    </g>
  ),
  setting: (
    <g stroke="currentColor" strokeWidth="1.6" fill="none" strokeLinecap="round">
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3h0a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8v0a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z" />
    </g>
  ),
  bell: (
    <g stroke="currentColor" strokeWidth="1.6" fill="none" strokeLinecap="round" strokeLinejoin="round">
      <path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9z" />
      <path d="M10 21a2 2 0 0 0 4 0" />
    </g>
  ),
  arrow: (
    <g stroke="currentColor" strokeWidth="1.8" fill="none" strokeLinecap="round" strokeLinejoin="round">
      <path d="M5 12h14" />
      <path d="M13 6l6 6-6 6" />
    </g>
  ),
  check: (
    <path
      d="M5 12.5l4.5 4.5L19 7.5"
      stroke="currentColor"
      strokeWidth="2.2"
      fill="none"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  ),
  x: (
    <g stroke="currentColor" strokeWidth="2.2" strokeLinecap="round">
      <path d="M6 6l12 12" />
      <path d="M18 6L6 18" />
    </g>
  ),
  warn: (
    <g stroke="currentColor" strokeWidth="2" fill="none" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 4l10 17H2L12 4z" />
      <path d="M12 10v5" />
      <circle cx="12" cy="18" r="0.8" fill="currentColor" />
    </g>
  ),
  refresh: (
    <g stroke="currentColor" strokeWidth="1.6" fill="none" strokeLinecap="round" strokeLinejoin="round">
      <path d="M4 12a8 8 0 0 1 14-5.3L20 9" />
      <path d="M20 4v5h-5" />
      <path d="M20 12a8 8 0 0 1-14 5.3L4 15" />
      <path d="M4 20v-5h5" />
    </g>
  ),
  lock: (
    <g stroke="currentColor" strokeWidth="1.6" fill="none">
      <rect x="5" y="11" width="14" height="9" rx="2" />
      <path d="M8 11V8a4 4 0 0 1 8 0v3" />
    </g>
  ),
  expand: (
    <g stroke="currentColor" strokeWidth="1.6" fill="none" strokeLinecap="round">
      <path d="M4 9V4h5" />
      <path d="M20 15v5h-5" />
      <path d="M4 4l6 6" />
      <path d="M20 20l-6-6" />
    </g>
  ),
  sparkle: (
    <g fill="currentColor">
      <path d="M12 3l1.7 4.6L18 9l-4.3 1.4L12 15l-1.7-4.6L6 9l4.3-1.4L12 3z" />
    </g>
  ),
  copy: (
    <g stroke="currentColor" strokeWidth="1.5" fill="none">
      <rect x="8" y="8" width="12" height="12" rx="2" />
      <path d="M16 8V5a1 1 0 0 0-1-1H5a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h3" />
    </g>
  ),
};

/* ────────────────── root ────────────────── */

export function AgentCafeApp() {
  const [mode, setMode] = useState<Mode>("post");
  const [agentState, setAgentState] = useState<AgentState>("form");
  const [seedOpen, setSeedOpen] = useState(false);

  /* form state — create */
  const [cafeName, setCafeName] = useState("컴퓨터 메이커 모임");
  const [cafeDescription, setCafeDescription] = useState(
    "자작 PC 빌드, 부품 후기, 빌드 로그를 함께 나누는 모임입니다.",
  );
  const [category, setCategory] = useState("컴퓨터/IT");
  const [visibility, setVisibility] = useState<"public" | "private">("public");

  /* form state — post */
  const [cafeUrl, setCafeUrl] = useState("https://cafe.daum.net/computermaker");
  const [topicHint, setTopicHint] = useState("");
  const [length, setLength] = useState<"short" | "medium" | "long">("medium");
  const [tone, setTone] = useState<"friendly" | "neutral" | "casual">("friendly");

  /* form state — moderate */
  const [boardHint, setBoardHint] = useState("자유게시판, 정보공유");
  const [keywords, setKeywords] = useState("도배, 광고, 홍보, 무료체험");
  const [modAction, setModAction] = useState<"3일 정지" | "7일 정지" | "영구 차단">(
    "7일 정지",
  );
  const [dryRun, setDryRun] = useState(true);
  const [maxPosts, setMaxPosts] = useState(40);
  const [maxActions, setMaxActions] = useState(10);

  /* run state */
  const [events, setEvents] = useState<LogEvent[]>([]);
  const [finalUrl, setFinalUrl] = useState<string | null>(null);
  const [viewerUrl, setViewerUrl] = useState<string | null>(null);
  const [startedAt, setStartedAt] = useState<number | null>(null);
  const [elapsedMs, setElapsedMs] = useState(0);

  /* Daum login fallback creds (kept in sessionStorage) */
  const [daumEmail, setDaumEmail] = useState("");
  const [daumPassword, setDaumPassword] = useState("");
  // True once the user has either saved creds or explicitly skipped; prevents
  // the popup from re-arming on every submit.
  const [daumLoginAsked, setDaumLoginAsked] = useState(false);
  const [daumLoginOpen, setDaumLoginOpen] = useState(false);
  useEffect(() => {
    if (typeof window === "undefined") return;
    setDaumEmail(window.sessionStorage.getItem("daum.email") || "");
    setDaumPassword(window.sessionStorage.getItem("daum.password") || "");
    setDaumLoginAsked(window.sessionStorage.getItem("daum.asked") === "1");
  }, []);

  const abortRef = useRef<AbortController | null>(null);

  /* derived */
  const stepCount = useMemo(
    () => events.filter((e) => e.kind === "step").length,
    [events],
  );
  const violations = useMemo(
    () => events.filter((e) => e.kind === "violation"),
    [events],
  );
  const actions = useMemo(
    () => events.filter((e) => e.kind === "action"),
    [events],
  );
  const tokenTotal = useMemo(() => {
    let n = 0;
    for (const e of events) {
      if (typeof e.inputTokens === "number") n += e.inputTokens;
      if (typeof e.outputTokens === "number") n += e.outputTokens;
    }
    return n;
  }, [events]);

  const sessionState: "active" | "expired" =
    agentState === "expired" ? "expired" : "active";

  /* elapsed timer */
  useEffect(() => {
    if (agentState !== "running" || startedAt === null) return;
    const id = setInterval(() => setElapsedMs(Date.now() - startedAt), 1000);
    return () => clearInterval(id);
  }, [agentState, startedAt]);

  /* submit */
  async function submit() {
    if (agentState === "running") return;

    // Post mode benefits from creds when storageState is expired. If we've
    // never asked the user this session, pop the login modal first; they can
    // press "그냥 진행" to skip and rely solely on Blob session.
    if (mode === "post" && !daumLoginAsked) {
      setDaumLoginOpen(true);
      return;
    }

    setEvents([]);
    setFinalUrl(null);
    setViewerUrl(null);
    setAgentState("running");
    setStartedAt(Date.now());
    setElapsedMs(0);

    const ac = new AbortController();
    abortRef.current = ac;

    const endpoint =
      mode === "create"
        ? "/api/create-cafe"
        : mode === "post"
          ? "/api/post"
          : "/api/moderate";

    const body =
      mode === "create"
        ? {
            cafeName,
            cafeDescription: cafeDescription || undefined,
            visibility,
            category: category || undefined,
          }
        : mode === "post"
          ? {
              cafeUrl,
              topicHint: topicHint || undefined,
              length,
              tone,
              daumEmail: daumEmail || undefined,
              daumPassword: daumPassword || undefined,
            }
          : {
              cafeUrl,
              boardHint: boardHint || undefined,
              keywords: keywords
                .split(/[,\n]/)
                .map((s) => s.trim())
                .filter(Boolean),
              action: modAction,
              dryRun,
              maxPosts,
              maxActions,
            };

    try {
      const res = await fetch(endpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: ac.signal,
      });

      if (!res.ok || !res.body) {
        const text = await res.text().catch(() => "");
        setEvents((xs) => [
          ...xs,
          {
            kind: "error",
            message: `${res.status} ${res.statusText} ${text}`,
            t: Date.now(),
          },
        ]);
        setAgentState("error");
        return;
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      let sawDone = false;
      let sawSessionExpired = false;

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
            const ev = JSON.parse(line) as LogEvent;
            if (typeof ev.t !== "number") ev.t = Date.now();
            setEvents((xs) => [...xs, ev]);

            if (ev.kind === "viewer" && typeof ev.url === "string") {
              setViewerUrl(ev.url);
            }
            if (ev.kind === "done") {
              sawDone = true;
              const u =
                (typeof ev.postUrl === "string" && ev.postUrl) ||
                (typeof ev.cafeUrl === "string" && ev.cafeUrl) ||
                null;
              if (u) setFinalUrl(u);
            }
            const text = String(ev.text ?? ev.summary ?? ev.message ?? "");
            if (text.includes("SESSION_EXPIRED")) sawSessionExpired = true;
          } catch {
            setEvents((xs) => [...xs, { kind: "log", line, t: Date.now() }]);
          }
        }
      }

      if (sawSessionExpired) setAgentState("expired");
      else if (sawDone) setAgentState("done");
      else setAgentState("error");
    } catch (err) {
      if ((err as Error).name === "AbortError") {
        setAgentState("form");
        return;
      }
      setEvents((xs) => [
        ...xs,
        { kind: "error", message: (err as Error).message, t: Date.now() },
      ]);
      setAgentState("error");
    } finally {
      abortRef.current = null;
    }
  }

  function cancel() {
    abortRef.current?.abort();
  }

  function reset() {
    abortRef.current?.abort();
    setEvents([]);
    setFinalUrl(null);
    setViewerUrl(null);
    setStartedAt(null);
    setElapsedMs(0);
    setAgentState("form");
  }

  return (
    <div className="app">
      <Sidebar
        mode={mode}
        setMode={setMode}
        sessionState={sessionState}
        onOpenDaumLogin={() => setDaumLoginOpen(true)}
      />
      <div className="main">
        <Topbar mode={mode} agentState={agentState} onReset={reset} />
        {agentState === "form" ? (
          <FormView
            mode={mode}
            setMode={setMode}
            cafeName={cafeName}
            setCafeName={setCafeName}
            cafeDescription={cafeDescription}
            setCafeDescription={setCafeDescription}
            category={category}
            setCategory={setCategory}
            visibility={visibility}
            setVisibility={setVisibility}
            cafeUrl={cafeUrl}
            setCafeUrl={setCafeUrl}
            topicHint={topicHint}
            setTopicHint={setTopicHint}
            length={length}
            setLength={setLength}
            tone={tone}
            setTone={setTone}
            boardHint={boardHint}
            setBoardHint={setBoardHint}
            keywords={keywords}
            setKeywords={setKeywords}
            modAction={modAction}
            setModAction={setModAction}
            dryRun={dryRun}
            setDryRun={setDryRun}
            maxPosts={maxPosts}
            setMaxPosts={setMaxPosts}
            maxActions={maxActions}
            setMaxActions={setMaxActions}
            onRun={submit}
            onSeedClick={() => setSeedOpen(true)}
          />
        ) : (
          <RunView
            mode={mode}
            agentState={agentState}
            events={events}
            stepCount={stepCount}
            elapsedMs={elapsedMs}
            tokenTotal={tokenTotal}
            violations={violations}
            actions={actions}
            viewerUrl={viewerUrl}
            finalUrl={finalUrl}
            cafeUrl={cafeUrl}
            cafeName={cafeName}
            dryRun={dryRun}
            onReset={reset}
            onCancel={cancel}
          />
        )}
      </div>
      {seedOpen && <SeedModal onClose={() => setSeedOpen(false)} />}
      {daumLoginOpen && (
        <DaumLoginModal
          initialEmail={daumEmail}
          initialPassword={daumPassword}
          onClose={() => setDaumLoginOpen(false)}
          onSave={(email, password, runNow) => {
            setDaumEmail(email);
            setDaumPassword(password);
            setDaumLoginAsked(true);
            if (typeof window !== "undefined") {
              window.sessionStorage.setItem("daum.email", email);
              window.sessionStorage.setItem("daum.password", password);
              window.sessionStorage.setItem("daum.asked", "1");
            }
            setDaumLoginOpen(false);
            if (runNow) setTimeout(submit, 0);
          }}
          onSkip={() => {
            setDaumLoginAsked(true);
            if (typeof window !== "undefined") {
              window.sessionStorage.setItem("daum.asked", "1");
            }
            setDaumLoginOpen(false);
            setTimeout(submit, 0);
          }}
        />
      )}
    </div>
  );
}

/* ────────────────── sidebar ────────────────── */

function Sidebar({
  mode,
  setMode,
  sessionState,
  onOpenDaumLogin,
}: {
  mode: Mode;
  setMode: (m: Mode) => void;
  sessionState: "active" | "expired";
  onOpenDaumLogin?: () => void;
}) {
  return (
    <aside className="side">
      <div className="brand">
        <div className="brand-mark">A</div>
        <div className="brand-name">AgentCafe</div>
        <span className="brand-tag">v0.1</span>
      </div>

      <div className="side-cat">에이전트</div>
      <button
        type="button"
        className={`side-item ${mode === "create" ? "active" : ""}`}
        onClick={() => setMode("create")}
      >
        <Icon name="home" /> 카페 생성
      </button>
      <button
        type="button"
        className={`side-item ${mode === "post" ? "active" : ""}`}
        onClick={() => setMode("post")}
      >
        <Icon name="write" /> 글 자동 게시
      </button>
      <button
        type="button"
        className={`side-item ${mode === "moderate" ? "active" : ""}`}
        onClick={() => setMode("moderate")}
      >
        <Icon name="shield" /> 모더레이션
      </button>

      <div className="side-cat">기록</div>
      <button type="button" className="side-item" disabled>
        <Icon name="list" /> 실행 이력
      </button>
      <button type="button" className="side-item" disabled>
        <Icon name="sessions" /> 세션 관리
      </button>

      <div className="side-cat">설정</div>
      <button
        type="button"
        className="side-item"
        onClick={() => onOpenDaumLogin?.()}
      >
        <Icon name="lock" /> Daum 계정
      </button>
      <button type="button" className="side-item" disabled>
        <Icon name="setting" /> 환경설정
      </button>

      <div className="side-footer">
        <div className="session-chip" data-state={sessionState}>
          <div className="session-dot" />
          <div className="session-meta">
            <div className="session-l">
              {sessionState === "expired" ? "세션 만료됨" : "다음 세션 활성"}
            </div>
            <div className="session-s">
              {sessionState === "expired"
                ? "재시드 필요"
                : "storageState 캐시됨"}
            </div>
          </div>
        </div>
      </div>
    </aside>
  );
}

/* ────────────────── topbar ────────────────── */

function Topbar({
  mode,
  agentState,
  onReset,
}: {
  mode: Mode;
  agentState: AgentState;
  onReset: () => void;
}) {
  return (
    <div className="topbar">
      <div className="crumbs">
        에이전트 · <strong>{MODE_LABELS[mode]}</strong>
        {agentState === "running" && (
          <>
            <span style={{ opacity: 0.5 }}>›</span>
            <span style={{ color: "var(--semantic-primary-normal)", fontWeight: 600 }}>
              실행 중
            </span>
          </>
        )}
        {agentState === "done" && (
          <>
            <span style={{ opacity: 0.5 }}>›</span>
            <span style={{ color: "var(--atomic-green-40)", fontWeight: 600 }}>
              완료
            </span>
          </>
        )}
        {agentState === "expired" && (
          <>
            <span style={{ opacity: 0.5 }}>›</span>
            <span style={{ color: "var(--atomic-orange-39)", fontWeight: 600 }}>
              세션 만료
            </span>
          </>
        )}
        {agentState === "error" && (
          <>
            <span style={{ opacity: 0.5 }}>›</span>
            <span style={{ color: "var(--atomic-red-40)", fontWeight: 600 }}>
              오류
            </span>
          </>
        )}
      </div>
      <div className="top-actions">
        {agentState !== "form" && (
          <button className="btn btn-ghost btn-sm" type="button" onClick={onReset}>
            <Icon name="refresh" size={14} /> 새 작업
          </button>
        )}
        <button type="button" className="icon-btn">
          <Icon name="bell" />
        </button>
        <div className="avatar">박</div>
      </div>
    </div>
  );
}

/* ────────────────── form view ────────────────── */

type FormProps = {
  mode: Mode;
  setMode: (m: Mode) => void;
  cafeName: string;
  setCafeName: (v: string) => void;
  cafeDescription: string;
  setCafeDescription: (v: string) => void;
  category: string;
  setCategory: (v: string) => void;
  visibility: "public" | "private";
  setVisibility: (v: "public" | "private") => void;
  cafeUrl: string;
  setCafeUrl: (v: string) => void;
  topicHint: string;
  setTopicHint: (v: string) => void;
  length: "short" | "medium" | "long";
  setLength: (v: "short" | "medium" | "long") => void;
  tone: "friendly" | "neutral" | "casual";
  setTone: (v: "friendly" | "neutral" | "casual") => void;
  boardHint: string;
  setBoardHint: (v: string) => void;
  keywords: string;
  setKeywords: (v: string) => void;
  modAction: "3일 정지" | "7일 정지" | "영구 차단";
  setModAction: (v: "3일 정지" | "7일 정지" | "영구 차단") => void;
  dryRun: boolean;
  setDryRun: (v: boolean) => void;
  maxPosts: number;
  setMaxPosts: (v: number) => void;
  maxActions: number;
  setMaxActions: (v: number) => void;
  onRun: () => void;
  onSeedClick: () => void;
};

function FormView(props: FormProps) {
  const { mode, setMode, onRun, onSeedClick } = props;

  return (
    <div className="content">
      <div className="page-head">
        <div className="page-title">에이전트에게 시킬 작업</div>
        <div className="page-sub">
          Claude가 다음 카페 UI를 직접 조작합니다 · 본인 계정의 정상 이용 범위
          내에서만 사용하세요.
        </div>
      </div>

      <div className="seed-banner">
        <span className="seed-ic">
          <Icon name="sparkle" size={20} />
        </span>
        <div style={{ flex: 1 }}>
          다음 로그인 세션이 <code>sessions/daum-storage-state.json</code>에
          저장돼 있어요. 세션이 만료되면 로컬에서 <code>npm run seed</code>로
          재발급하세요.
        </div>
        <button type="button" className="btn btn-ghost btn-sm" onClick={onSeedClick}>
          시드 안내 보기
        </button>
      </div>

      <div className="tabs" role="tablist">
        <button
          type="button"
          className={`tab ${mode === "create" ? "active" : ""}`}
          onClick={() => setMode("create")}
        >
          <Icon name="home" size={16} /> 카페 생성
        </button>
        <button
          type="button"
          className={`tab ${mode === "post" ? "active" : ""}`}
          onClick={() => setMode("post")}
        >
          <Icon name="write" size={16} /> 글 자동 게시
        </button>
        <button
          type="button"
          className={`tab ${mode === "moderate" ? "active" : ""}`}
          onClick={() => setMode("moderate")}
        >
          <Icon name="shield" size={16} /> 모더레이션
        </button>
      </div>

      <div className="card form-card">
        <div className="form-grid">
          {mode === "create" && <CreateFields {...props} />}
          {mode === "post" && <PostFields {...props} />}
          {mode === "moderate" && <ModerateFields {...props} />}
        </div>

        <div className="form-foot">
          <button
            type="button"
            className="btn btn-primary"
            onClick={onRun}
            disabled={
              (mode === "create" && !props.cafeName.trim()) ||
              (mode !== "create" && !props.cafeUrl.trim()) ||
              (mode === "moderate" && props.keywords.trim().length === 0)
            }
          >
            {mode === "create" && "카페 만들기"}
            {mode === "post" && "글 자동 게시"}
            {mode === "moderate" && (props.dryRun ? "Dry-run으로 검토" : "Live 모드로 실행")}
            <Icon name="arrow" size={16} />
          </button>
          <div className="legal-note">
            카카오 약관에 따라 본인 계정의 일반적인 이용 범위 내에서만 자동화가
            허용됩니다. 대량 생성 · 광고 도배는 금지.
          </div>
        </div>
      </div>
    </div>
  );
}

function CreateFields(p: FormProps) {
  return (
    <>
      <div className="form-row">
        <div className="form-label">
          카페 이름<span className="req">*</span>
          <div className="form-help">8~20자, 한글/영문 가능</div>
        </div>
        <input
          className="text-input"
          value={p.cafeName}
          onChange={(e) => p.setCafeName(e.target.value)}
          placeholder="예: 주말 PC 빌드 클럽"
          maxLength={40}
        />
      </div>
      <div className="form-row">
        <div className="form-label">
          카페 소개
          <div className="form-help">어떤 카페인지 1~2문장</div>
        </div>
        <textarea
          className="textarea-input"
          value={p.cafeDescription}
          onChange={(e) => p.setCafeDescription(e.target.value)}
          maxLength={400}
        />
      </div>
      <div className="form-row">
        <div className="form-label">카테고리</div>
        <select
          className="select-input"
          value={p.category}
          onChange={(e) => p.setCategory(e.target.value)}
        >
          <option>컴퓨터/IT</option>
          <option>취미</option>
          <option>스포츠/레저</option>
          <option>학문/교육</option>
          <option>문화/엔터테인먼트</option>
        </select>
      </div>
      <div className="form-row">
        <div className="form-label">공개 여부</div>
        <div className="seg">
          <button
            type="button"
            className={`seg-opt ${p.visibility === "public" ? "on" : ""}`}
            onClick={() => p.setVisibility("public")}
          >
            공개
          </button>
          <button
            type="button"
            className={`seg-opt ${p.visibility === "private" ? "on" : ""}`}
            onClick={() => p.setVisibility("private")}
          >
            비공개
          </button>
        </div>
      </div>
    </>
  );
}

function PostFields(p: FormProps) {
  return (
    <>
      <div className="form-row">
        <div className="form-label">
          카페 URL<span className="req">*</span>
        </div>
        <input
          className="text-input"
          type="url"
          value={p.cafeUrl}
          onChange={(e) => p.setCafeUrl(e.target.value)}
          autoComplete="off"
          spellCheck={false}
        />
      </div>
      <div className="form-row">
        <div className="form-label">
          주제 힌트
          <div className="form-help">비워두면 게시판 분위기에 맞춰 알아서 정해요</div>
        </div>
        <div>
          <input
            className="text-input"
            value={p.topicHint}
            onChange={(e) => p.setTopicHint(e.target.value)}
            placeholder="예: RTX 5090 첫 인상, 주말 빌드 후기"
            maxLength={200}
          />
          <div className="hint-chips">
            {TOPIC_HINTS.map((h) => (
              <button
                type="button"
                key={h}
                className="hint-chip"
                onClick={() => p.setTopicHint(h)}
              >
                + {h}
              </button>
            ))}
          </div>
        </div>
      </div>
      <div className="form-row">
        <div className="form-label">글 길이</div>
        <div className="seg">
          {(
            [
              ["short", "짧게 · 200자"],
              ["medium", "보통 · 450자"],
              ["long", "길게 · 750자"],
            ] as const
          ).map(([v, label]) => (
            <button
              type="button"
              key={v}
              className={`seg-opt ${p.length === v ? "on" : ""}`}
              onClick={() => p.setLength(v)}
            >
              {label}
            </button>
          ))}
        </div>
      </div>
      <div className="form-row">
        <div className="form-label">말투</div>
        <div className="seg">
          {(
            [
              ["friendly", "친근하게 (~요/네요)"],
              ["neutral", "담백하게"],
              ["casual", "가볍게 (반말 X)"],
            ] as const
          ).map(([v, label]) => (
            <button
              type="button"
              key={v}
              className={`seg-opt ${p.tone === v ? "on" : ""}`}
              onClick={() => p.setTone(v)}
            >
              {label}
            </button>
          ))}
        </div>
      </div>
    </>
  );
}

function ModerateFields(p: FormProps) {
  return (
    <>
      <div className="form-row">
        <div className="form-label">
          카페 URL<span className="req">*</span>
        </div>
        <input
          className="text-input"
          type="url"
          value={p.cafeUrl}
          onChange={(e) => p.setCafeUrl(e.target.value)}
          autoComplete="off"
          spellCheck={false}
        />
      </div>
      <div className="form-row">
        <div className="form-label">
          대상 게시판
          <div className="form-help">비우면 자유게시판 + 최근 N개</div>
        </div>
        <input
          className="text-input"
          value={p.boardHint}
          onChange={(e) => p.setBoardHint(e.target.value)}
          placeholder="자유게시판, 정보공유"
          maxLength={60}
        />
      </div>
      <div className="form-row">
        <div className="form-label">
          차단 키워드<span className="req">*</span>
          <div className="form-help">쉼표 또는 줄바꿈으로 구분</div>
        </div>
        <textarea
          className="textarea-input"
          value={p.keywords}
          onChange={(e) => p.setKeywords(e.target.value)}
        />
      </div>
      <div className="form-row">
        <div className="form-label">제재 액션</div>
        <div className="radio-grid">
          {MOD_ACTIONS.map((a) => (
            <button
              type="button"
              key={a.value}
              className={`radio-card ${p.modAction === a.value ? "on" : ""}`}
              onClick={() => p.setModAction(a.value)}
            >
              <div className="rc-h">
                {a.title}
                <span className="rc-dot" />
              </div>
              <div className="rc-d">{a.desc}</div>
            </button>
          ))}
        </div>
      </div>
      <div className="form-row">
        <div className="form-label">실행 모드</div>
        <button
          type="button"
          className="toggle-row"
          onClick={() => p.setDryRun(!p.dryRun)}
          style={{ cursor: "pointer", textAlign: "left" }}
        >
          <div className="tx">
            <div className="tx-h">Dry-run으로 먼저 검토</div>
            <div className="tx-d">
              제재는 안 하고 위반 후보만 보고해요. 사람이 확인 후 live로 실행
              가능
            </div>
          </div>
          <span className={`sw ${p.dryRun ? "on" : ""}`} />
        </button>
      </div>
      <div className="form-row">
        <div className="form-label">
          상한
          <div className="form-help">스캔/액션 횟수 안전장치</div>
        </div>
        <div style={{ display: "flex", gap: 10 }}>
          <div className="input-with-prefix" style={{ flex: 1 }}>
            <span className="input-prefix">스캔</span>
            <input
              className="text-input"
              type="number"
              min={1}
              max={100}
              value={p.maxPosts}
              onChange={(e) =>
                p.setMaxPosts(Math.max(1, Math.min(100, Number(e.target.value) || 1)))
              }
            />
          </div>
          <div className="input-with-prefix" style={{ flex: 1 }}>
            <span className="input-prefix">액션</span>
            <input
              className="text-input"
              type="number"
              min={0}
              max={50}
              value={p.maxActions}
              disabled={p.dryRun}
              onChange={(e) =>
                p.setMaxActions(Math.max(0, Math.min(50, Number(e.target.value) || 0)))
              }
            />
          </div>
        </div>
      </div>
    </>
  );
}

/* ────────────────── run view ────────────────── */

function RunView(props: {
  mode: Mode;
  agentState: AgentState;
  events: LogEvent[];
  stepCount: number;
  elapsedMs: number;
  tokenTotal: number;
  violations: LogEvent[];
  actions: LogEvent[];
  viewerUrl: string | null;
  finalUrl: string | null;
  cafeUrl: string;
  cafeName: string;
  dryRun: boolean;
  onReset: () => void;
  onCancel: () => void;
}) {
  const {
    mode,
    agentState,
    events,
    stepCount,
    elapsedMs,
    tokenTotal,
    violations,
    actions,
    viewerUrl,
    finalUrl,
    cafeUrl,
    cafeName,
    dryRun,
    onReset,
    onCancel,
  } = props;

  const elapsedSec = Math.round(elapsedMs / 1000);
  const actionFails = actions.filter((a) => a.success === false).length;
  const actionSuccess = actions.length - actionFails;

  return (
    <div className="content">
      {agentState === "done" && (
        <div className="state-banner success">
          <div className="state-icon">
            <Icon name="check" size={28} />
          </div>
          <div className="state-h">
            <div className="state-t">
              {mode === "create" && "카페가 만들어졌어요"}
              {mode === "post" && "글이 정상 게시되었어요"}
              {mode === "moderate" &&
                `모더레이션 완료 · ${violations.length}건 감지 · ${actionSuccess}건 처리`}
            </div>
            <div className="state-d">
              {mode === "post" && `소요 시간 ${elapsedSec}초 · ${stepCount}단계`}
              {mode === "create" && `소요 시간 ${elapsedSec}초 · ${stepCount}단계`}
              {mode === "moderate" &&
                `위반 ${violations.length}건 · 액션 ${actionSuccess}건 성공${
                  actionFails > 0 ? ` / ${actionFails}건 실패` : ""
                }`}
            </div>
            {finalUrl && (
              <a className="state-link" href={finalUrl} target="_blank" rel="noreferrer">
                {finalUrl}
                <Icon name="copy" size={12} />
              </a>
            )}
          </div>
          <div className="state-actions">
            <button type="button" className="btn btn-out" onClick={onReset}>
              닫기
            </button>
          </div>
        </div>
      )}

      {agentState === "expired" && (
        <div className="state-banner expired">
          <div className="state-icon">
            <Icon name="warn" size={28} />
          </div>
          <div className="state-h">
            <div className="state-t">다음 세션이 만료되었어요</div>
            <div className="state-d">
              로그인 쿠키가 더 이상 유효하지 않아 에이전트를 진행할 수
              없습니다. 로컬 머신에서{" "}
              <code className="mono" style={{
                padding: "1px 6px",
                background: "var(--semantic-fill-alternative)",
                borderRadius: 4,
              }}>
                npm run seed
              </code>{" "}
              로 새 세션을 발급한 뒤 다시 시도해주세요.
            </div>
          </div>
          <div className="state-actions">
            <button type="button" className="btn btn-primary" onClick={onReset}>
              다시 시도
            </button>
          </div>
        </div>
      )}

      {agentState === "error" && (
        <div className="state-banner error">
          <div className="state-icon">
            <Icon name="x" size={28} />
          </div>
          <div className="state-h">
            <div className="state-t">에이전트가 중단됐어요</div>
            <div className="state-d">
              다음 카페 UI가 변경되었거나 일시적인 셀렉터 미일치일 수 있어요.
              아래 로그를 확인하고 다시 시도해보세요.
            </div>
          </div>
          <div className="state-actions">
            <button type="button" className="btn btn-primary" onClick={onReset}>
              새 작업
            </button>
          </div>
        </div>
      )}

      <div className="page-head">
        <div className="page-title">
          {mode === "create" && (agentState === "running" ? "카페 생성 중" : "카페 생성")}
          {mode === "post" && (agentState === "running" ? "글 자동 게시 중" : "글 자동 게시")}
          {mode === "moderate" &&
            (agentState === "running" ? "모더레이션 실행 중" : "모더레이션")}
          {agentState === "running" && (
            <span className="running-pill">● 실행 중</span>
          )}
        </div>
        <div className="page-sub">
          {mode === "post" && cafeUrl}
          {mode === "create" && `${cafeName}`}
          {mode === "moderate" && `${cafeUrl} · ${dryRun ? "Dry-run" : "Live"}`}
        </div>
      </div>

      <div className="metrics-row">
        <div className="metric accent">
          <div className="metric-l">단계</div>
          <div className="metric-n">
            {stepCount}
            <span style={{ fontSize: 14, color: "var(--semantic-label-alternative)", fontWeight: 500 }}>
              {" "}/ 50
            </span>
          </div>
          <div className="metric-d">stopWhen=stepCountIs(50)</div>
        </div>
        <div className="metric">
          <div className="metric-l">경과 시간</div>
          <div className="metric-n">
            {elapsedSec}
            <span style={{ fontSize: 14, color: "var(--semantic-label-alternative)", fontWeight: 500 }}>
              s
            </span>
          </div>
          <div className="metric-d">목표 ≤ 90s</div>
        </div>
        {mode === "moderate" ? (
          <>
            <div className="metric warn">
              <div className="metric-l">감지된 위반</div>
              <div className="metric-n">{violations.length}</div>
              <div className="metric-d">실시간 누적</div>
            </div>
            <div className="metric danger">
              <div className="metric-l">실행된 제재</div>
              <div className="metric-n">
                {actionSuccess}
                <span style={{ fontSize: 14, color: "var(--semantic-label-alternative)", fontWeight: 500 }}>
                  {" "}/ {actions.length}
                </span>
              </div>
              <div className="metric-d">
                {actionFails > 0 ? `${actionFails}건 실패` : "성공률 100%"}
              </div>
            </div>
          </>
        ) : (
          <>
            <div className="metric">
              <div className="metric-l">토큰 사용</div>
              <div className="metric-n">
                {tokenTotal > 0 ? tokenTotal.toLocaleString() : "—"}
              </div>
              <div className="metric-d">claude-sonnet-4.6</div>
            </div>
            <div className="metric">
              <div className="metric-l">상태</div>
              <div
                className="metric-n"
                style={{
                  fontSize: 18,
                  fontWeight: 600,
                  letterSpacing: 0,
                  fontFamily: "var(--font-family-mono)",
                }}
              >
                {agentState}
              </div>
              <div className="metric-d">Vercel Sandbox · noVNC</div>
            </div>
          </>
        )}
      </div>

      <div className="run-grid">
        <Viewer viewerUrl={viewerUrl} agentState={agentState} />
        <StreamRail
          events={events}
          agentState={agentState}
          stepCount={stepCount}
          onCancel={onCancel}
        />
      </div>
    </div>
  );
}

/* ────────────────── viewer ────────────────── */

function Viewer({
  viewerUrl,
  agentState,
}: {
  viewerUrl: string | null;
  agentState: AgentState;
}) {
  return (
    <div className="viewer">
      <div className="viewer-bar">
        <div className="vb-dots">
          <span className="vb-dot" />
          <span className="vb-dot" />
          <span className="vb-dot" />
        </div>
        <div className="vb-url" title={viewerUrl ?? ""}>
          <Icon name="lock" size={11} />
          <span className="vb-url-text">
            {viewerUrl
              ? viewerUrl.replace(/^https?:\/\//, "").replace(/\?.*$/, "")
              : "viewer 부팅 중…"}
          </span>
        </div>
        <div className="vb-meta">
          {viewerUrl ? (
            <span className="live-pill">
              <span className="live-dot" />
              LIVE
            </span>
          ) : (
            <span
              className="live-pill"
              style={{
                background: "var(--semantic-fill-normal)",
                color: "var(--semantic-label-alternative)",
              }}
            >
              IDLE
            </span>
          )}
          {viewerUrl && (
            <a
              className="icon-btn"
              href={viewerUrl}
              target="_blank"
              rel="noreferrer"
              title="새 창"
            >
              <Icon name="expand" size={14} />
            </a>
          )}
        </div>
      </div>
      <div className="viewer-stage">
        {viewerUrl ? (
          <iframe
            src={viewerUrl}
            title="agent live viewer"
            style={{
              position: "absolute",
              inset: 0,
              width: "100%",
              height: "100%",
              border: 0,
              background: "#000",
            }}
            allow="clipboard-read; clipboard-write"
          />
        ) : (
          <div className="stage-cover">
            {agentState === "running" ? (
              <>
                <div className="stage-spinner" />
                <div>마이크로VM 부팅 중…</div>
                <div className="small">
                  Vercel Sandbox + Xvnc + websockify 셋업 (콜드스타트 ~60초)
                </div>
              </>
            ) : (
              <>
                <div style={{ fontSize: 13, color: "#989BA2" }}>
                  viewer 대기 중
                </div>
                <div className="small">실행을 시작하면 여기에 라이브 화면이 떠요</div>
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

/* ────────────────── stream rail ────────────────── */

function StreamRail({
  events,
  agentState,
  stepCount,
  onCancel,
}: {
  events: LogEvent[];
  agentState: AgentState;
  stepCount: number;
  onCancel: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (ref.current) ref.current.scrollTop = ref.current.scrollHeight;
  }, [events.length]);

  // Approximate progress: 50 max steps, otherwise show running animation
  const progress =
    agentState === "done"
      ? 1
      : agentState === "running"
        ? Math.min(0.9, stepCount / 50)
        : 0;

  return (
    <div className="stream">
      <div className="stream-h">
        <div className="t">에이전트 스트림</div>
        <div className="meta">
          NDJSON · {events.length} ev
        </div>
        {agentState === "running" && (
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            onClick={onCancel}
            style={{ marginLeft: 8, padding: "4px 8px" }}
          >
            중단
          </button>
        )}
      </div>
      <div className="stream-progress" style={{ "--p": `${progress * 100}%` } as React.CSSProperties} />
      <div className="events" ref={ref}>
        {events.map((e, i) => (
          <EventLine key={i} ev={e} last={i === events.length - 1 && agentState === "running"} />
        ))}
        {agentState === "running" && (
          <div className="ev" style={{ opacity: 0.55 }}>
            <div className="ev-rail">
              <div
                className="ev-icon pulse-ring"
                style={{ background: "var(--semantic-primary-normal)" }}
              />
            </div>
            <div className="ev-body">
              <div
                className="ev-msg"
                style={{
                  fontStyle: "italic",
                  color: "var(--semantic-label-alternative)",
                }}
              >
                다음 도구 호출 결정 중…
              </div>
            </div>
          </div>
        )}
        {events.length === 0 && agentState !== "running" && (
          <div
            style={{
              color: "var(--semantic-label-alternative)",
              fontSize: 13,
              padding: "20px 4px",
              textAlign: "center",
            }}
          >
            아직 이벤트가 없어요
          </div>
        )}
      </div>
    </div>
  );
}

function EventLine({ ev, last }: { ev: LogEvent; last: boolean }) {
  // ev.t is stamped when the event is added to state, so this is pure.
  const time =
    typeof ev.t === "number"
      ? new Date(ev.t).toLocaleTimeString("ko-KR", { hour12: false })
      : "";

  const iconClass =
    ev.kind === "action" && ev.success === false
      ? "action"
      : ev.kind === "action" && ev.success === true
        ? "action ok"
        : ev.kind;

  const iconChar =
    ev.kind === "step"
      ? String(ev.stepNumber ?? "•")
      : ev.kind === "phase"
        ? "◆"
        : ev.kind === "status"
          ? "›"
          : ev.kind === "violation"
            ? "!"
            : ev.kind === "action"
              ? ev.success === false
                ? "×"
                : "✓"
              : ev.kind === "done"
                ? "✓"
                : ev.kind === "error"
                  ? "!"
                  : ev.kind === "viewer"
                    ? "▶"
                    : "·";

  const primary =
    ev.message ??
    ev.line ??
    ev.text ??
    ev.summary ??
    (ev.kind === "step"
      ? `step ${ev.stepNumber} · ${ev.finishReason ?? ""}`
      : ev.kind === "violation"
        ? `${ev.author ?? "(unknown)"} · ${ev.where ?? ""}`
        : ev.kind === "action"
          ? `${ev.author ?? "(unknown)"} → ${ev.action ?? ""} (${ev.success ? "OK" : "FAIL"})`
          : "");

  const tools = ev.toolsUsed ?? ev.tools ?? [];

  return (
    <div className="ev">
      <div className="ev-rail">
        <div className={`ev-icon ${iconClass}`}>{iconChar}</div>
        {!last && <div className="ev-line" />}
      </div>
      <div className="ev-body">
        <div className="ev-h">
          <span className="ev-kind">{ev.kind}</span>
          <span className="ev-time">{time}</span>
        </div>
        <div className="ev-msg">{primary}</div>
        {tools.length > 0 && (
          <div className="ev-tools">
            {tools.map((tn) => (
              <span key={tn} className="ev-tool">
                {tn}
              </span>
            ))}
          </div>
        )}
        {ev.kind === "chunk" && ev.text && (
          <div className="ev-chunk">{ev.text}</div>
        )}
        {ev.kind === "violation" && (
          <ViolationCard ev={ev} />
        )}
        {ev.kind === "action" && (
          <div className="violation-card">
            <div className="violation-h">
              <span className="author">{ev.author ?? "(unknown)"}</span>
              <span className="where">· {ev.action ?? ""}</span>
              <span className={`action-status ${ev.success ? "success" : "fail"}`}>
                {ev.success ? "성공" : "실패"}
              </span>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function ViolationCard({ ev }: { ev: LogEvent }) {
  const matched = ev.matched ?? [];
  const snippet = ev.snippet ?? "";
  return (
    <div className="violation-card" data-sev="high">
      <div className="violation-h">
        <span className="author">{ev.author ?? "(unknown)"}</span>
        <span className="where">· {ev.where ?? ""}</span>
        <span className="action-status pending">검토 대기</span>
      </div>
      {snippet && (
        <div className="violation-snippet">{highlight(snippet, matched)}</div>
      )}
      {matched.length > 0 && (
        <div className="violation-foot">
          {matched.map((k) => (
            <span key={k} className="matched-chip">
              #{k}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

function highlight(text: string, kws: string[]): React.ReactNode[] {
  let parts: Array<string | React.ReactNode> = [text];
  kws.forEach((kw, kwi) => {
    parts = parts.flatMap((part, pi) => {
      if (typeof part !== "string") return [part];
      const re = new RegExp(`(${escapeRegExp(kw)})`, "gi");
      const splits = part.split(re);
      return splits.map((s, i) =>
        i % 2 === 1 ? <mark key={`${kwi}-${pi}-${i}`}>{s}</mark> : s,
      );
    });
  });
  return parts as React.ReactNode[];
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/* ────────────────── daum login modal ────────────────── */

function DaumLoginModal({
  initialEmail,
  initialPassword,
  onSave,
  onSkip,
  onClose,
}: {
  initialEmail: string;
  initialPassword: string;
  onSave: (email: string, password: string, runNow: boolean) => void;
  onSkip: () => void;
  onClose: () => void;
}) {
  const [email, setEmail] = useState(initialEmail);
  const [password, setPassword] = useState(initialPassword);
  const canSave = email.includes("@") && password.length > 0;
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-h">
          <div className="t">Daum 계정 (선택)</div>
          <button type="button" className="icon-btn" onClick={onClose}>
            <Icon name="x" size={16} />
          </button>
        </div>
        <div className="modal-body">
          <p>
            카페 세션이 만료되면 에이전트가 이 계정으로 자동 로그인 시도합니다.
            2FA(이메일 인증/캡차)가 뜨면 위 라이브 iframe에서 직접 통과해 주세요
            — 에이전트가 로그인 완료까지 최대 8분 대기합니다.
          </p>
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            <input
              className="text-input"
              type="email"
              autoComplete="username"
              placeholder="email@daum.net"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
            <input
              className="text-input"
              type="password"
              autoComplete="current-password"
              placeholder="비밀번호"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </div>
          <p style={{ fontSize: 11, color: "var(--semantic-label-alternative)" }}>
            ※ 입력한 값은 브라우저 sessionStorage에만 저장되며, 서버에는 매 요청
            body로만 전달됩니다 (영구 저장 X).
          </p>
          <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
            <button type="button" className="btn btn-out btn-sm" onClick={onSkip}>
              그냥 진행
            </button>
            <button
              type="button"
              className="btn btn-primary btn-sm"
              disabled={!canSave}
              onClick={() => onSave(email, password, true)}
            >
              저장 후 실행
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

/* ────────────────── seed modal ────────────────── */

function SeedModal({ onClose }: { onClose: () => void }) {
  const [copied, setCopied] = useState(false);
  const cmd = "npm run seed";
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-h">
          <div className="t">세션 재발급</div>
          <button type="button" className="icon-btn" onClick={onClose}>
            <Icon name="x" size={16} />
          </button>
        </div>
        <div className="modal-body">
          <p>
            세션이 만료되면 <strong>로컬 터미널</strong>에서 아래 명령을
            실행해주세요. 카카오가 미국 IP에서 이메일 인증을 요구하기 때문에
            서버에서는 자동 시드가 안 돼요.
          </p>
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <code style={{ flex: 1 }}>{cmd}</code>
            <button
              type="button"
              className="btn btn-out btn-sm"
              onClick={async () => {
                try {
                  await navigator.clipboard.writeText(cmd);
                  setCopied(true);
                  setTimeout(() => setCopied(false), 1500);
                } catch {
                  /* ignore */
                }
              }}
            >
              {copied ? "복사됨" : "복사"}
            </button>
          </div>
          <ol style={{ margin: 0, paddingLeft: 20, fontSize: 13, lineHeight: 1.7, color: "var(--semantic-label-alternative)" }}>
            <li>위 명령 실행 → Chromium 창이 열려요</li>
            <li>다음/카카오 로그인을 손으로 완료</li>
            <li>쿠키 자동 감지 → Blob 업로드 완료 메시지 확인</li>
            <li>이 창 닫고 다시 작업 실행</li>
          </ol>
          <div style={{ display: "flex", justifyContent: "flex-end" }}>
            <button type="button" className="btn btn-out btn-sm" onClick={onClose}>
              닫기
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
