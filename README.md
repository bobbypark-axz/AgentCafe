# AgentCafe

Claude 에이전트가 로그인된 다음(Daum) 세션을 이어받아 **카페를 대신 만들어주는** 웹앱입니다.
Next.js UI + Vercel Sandbox(브라우저 자동화) + Vercel AI Gateway(Claude) + Vercel Blob(세션 저장).

> ⚠️  다음카페 자동화는 공식 API가 없어서 브라우저 조작으로 수행합니다. 본인 소유
> 계정에 한해, 이용약관을 준수하는 범위에서만 사용하세요.

---

## 아키텍처

```
브라우저(폼 입력)
   └─► POST /api/create-cafe                 (Next.js Fluid Compute 함수)
         ├─► @vercel/blob.list()             → storageState.json 공개 URL 조회
         └─► Vercel Sandbox (Amazon Linux µVM)
               ├── dnf: Chromium 시스템 라이브러리 설치
               ├── npm install (agent 의존성)
               ├── npx playwright install chromium
               └── node agent.mjs
                     ├─ fetch(storageStateUrl) → /tmp/daum-storage-state.json
                     ├─ spawn @playwright/mcp --storage-state ...
                     ├─ createMCPClient(stdio)    ← AI SDK
                     └─ ToolLoopAgent(model: anthropic/claude-sonnet-4.6)
                           └─ 카페 생성 단계 자율 실행, JSON 로그 스트림
```

에이전트는 stdout 한 줄당 `{ kind, ... }` JSON 이벤트를 방출합니다.
라우트는 그걸 NDJSON으로 그대로 중계하고, 프론트엔드는 한 줄씩 파싱해 실시간 로그로 보여줍니다.

## 사전 준비

1. **Vercel CLI 로그인 + 프로젝트 연결**

   ```sh
   npm i -g vercel@latest
   vercel login
   vercel link        # 새 프로젝트 생성 or 기존 프로젝트 선택
   ```

2. **Vercel Blob 스토어 생성**
   대시보드 → Storage → Blob 생성. `BLOB_READ_WRITE_TOKEN`이 프로젝트 환경변수로 자동 주입됩니다.

3. **AI Gateway 활성화**
   대시보드 → Project Settings → AI Gateway 활성화. 인증은 OIDC(`VERCEL_OIDC_TOKEN`)가 기본입니다.

4. **로컬 환경변수 동기화**

   ```sh
   vercel env pull .env.local
   ```

   `.env.example`에 필요한 키 목록이 있습니다. 로컬에서 Vercel Sandbox를 쓰려면
   `VERCEL_TOKEN`, `VERCEL_TEAM_ID`, `VERCEL_PROJECT_ID` 도 추가로 필요합니다
   (개인 엑세스 토큰 생성 → `vercel env add ...`).

5. **다음 로그인 세션 시드**

   ```sh
   npm run seed
   ```

   Chromium 창이 열리면 다음 계정으로 로그인(캡차/2FA 포함 전부 수동)하고,
   터미널로 돌아와 Enter를 누르면 `storageState.json`이 Blob에 업로드됩니다.
   쿠키가 만료되거나 봇감지에 걸리면 같은 명령을 다시 실행해서 재시드하세요.

## 로컬 실행

```sh
npm run dev         # http://localhost:3000
```

폼에 카페 이름, 소개, 공개/비공개, 카테고리를 입력하고 "카페 만들기"를 누르면
Sandbox가 콜드스타트(30~60초) 후 에이전트를 실행합니다.

## 배포

```sh
vercel           # Preview
vercel --prod    # Production
```

## 콜드스타트 최적화 (선택)

시스템 라이브러리 + npm install + Chromium 다운로드는 한 번에 ~1분. 한 번 돌려서
이상 없으면 스냅샷으로 굳혀서 매 실행을 1초 미만으로 단축할 수 있습니다.

```sh
npm run snapshot
# 출력된 snap_xxx ID를 환경변수에 등록:
vercel env add AGENT_BROWSER_SNAPSHOT_ID production preview development
vercel env pull .env.local --yes
```

## 파일 구조

```
.
├── next.config.ts             # sandbox/ 파일 tracing include 설정
├── sandbox/
│   ├── package.json           # agent.mjs 전용 의존성
│   └── agent.mjs              # Sandbox 안에서 도는 AI 에이전트
├── scripts/
│   ├── seed-session.ts        # 로컬 헤드 브라우저 로그인 → Blob 업로드
│   └── create-snapshot.ts     # Sandbox 스냅샷 사전 빌드
└── src/
    ├── app/
    │   ├── page.tsx           # CafeForm 렌더
    │   └── api/create-cafe/route.ts   # POST → runCafeAgent 스트림
    ├── components/cafe-form.tsx
    └── lib/
        ├── blob.ts            # Blob에서 storageState URL 조회
        └── sandbox.ts         # Sandbox 생성 + 에이전트 실행 + NDJSON 스트림
```

## 환경변수 레퍼런스

| 변수 | 필수 | 용도 |
|------|------|------|
| `BLOB_READ_WRITE_TOKEN`       | 필수 | Vercel Blob 읽기/쓰기 (세션 저장) |
| `VERCEL_OIDC_TOKEN`           | 필수 | AI Gateway + Sandbox 인증 (로컬은 `vercel env pull`, 배포에서는 자동) |
| `VERCEL_TOKEN` + `VERCEL_TEAM_ID` + `VERCEL_PROJECT_ID` | 로컬만 | 로컬 Sandbox 호출시 인증. Vercel 내부 실행 시 OIDC 대체 |
| `AGENT_BROWSER_SNAPSHOT_ID`   | 선택 | Sandbox 스냅샷 ID — 있으면 콜드스타트 스킵 |
| `DAUM_SESSION_BLOB_KEY`       | 선택 | Blob 상 storageState 경로 (기본 `sessions/daum-storage-state.json`) |

## 트러블슈팅

- **"No session blob found"** → `npm run seed` 실행 안 됨. 다시 시드하세요.
- **에이전트가 로그인 페이지에 도착** → 세션 만료. `npm run seed` 재실행.
- **"의심스러운 접속" / 캡차 페이지** → 봇감지 발동. 시드한 계정으로 짧은 시간 안에
  너무 많이 실행했을 가능성. 잠시 쉬고, 시드 IP와 같은 리전에서 실행하거나,
  Sandbox 리전 고정을 고려.
- **dnf install 실패** → Amazon Linux 패키지 이름이 바뀌었을 수 있음.
  `src/lib/sandbox.ts`의 `CHROMIUM_SYSTEM_DEPS` 확인.
- **10분 초과 타임아웃** → Vercel Functions `maxDuration`은 최대 800s(Pro). 이미 600초.
  더 긴 작업은 Workflow DevKit으로 전환 고려.

## 보안 주의

- `storageState.json`은 **다음 계정 쿠키 전체**가 들어있는 민감 데이터입니다.
  Blob URL은 비밀 토큰(랜덤 접미사)으로만 접근 가능하지만, URL 자체가 유출되면 계정 탈취 가능.
  - `access: 'private'` Blob(베타)로 바꾸고 `get()` 서버사이드 호출로 바꾸면 더 안전.
- AI Gateway 요청은 기본적으로 프롬프트/응답을 저장하지 않지만, 조직 정책에 따라
  로깅을 켜둔 경우 카페 제목·설명이 로그에 남을 수 있음.

## 라이선스 및 책임

이 프로젝트는 데모/학습용입니다. 카카오(다음)의 이용약관을 확인하고, 대량 생성이나
자동화가 금지된 행위에 해당하지 않는 선에서만 사용하세요.
