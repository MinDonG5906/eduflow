# EduFlow — 교육 영상 스토리보드 자동 생성 프로토타입

교육 원고나 자료(PDF·PPT·한글·Word·TXT)를 넣으면 AI가 **콘텐츠 구성안**(제목·핵심 요약·학습 목표)과 **장면별 스토리보드**(장면 목적·화면 설명·시각 자료 제안·내레이션·자막·예상 시간)를 만들고, 사람이 장면 단위로 검토·수정·재생성한 뒤 Markdown·CSV로 내보내는 웹 프로토타입입니다.

- 과제 「AI 콘텐츠 기획·제작 자동화 플랫폼」 중 **호롱불 요구사항**(교육 영상 스토리보드·내레이션·자막 자동 생성)을 구현합니다.
- 주요 교육 대상은 산업현장 근무자, 현장 방문자(일반인·기업 관계자·외부 하청업체), 외국인 근로자입니다.
- 각자 PC에서 서버를 띄워 쓰는 **로컬 프로토타입**이며 실서비스로 배포하지 않습니다.

## 빠른 시작

Node.js **22.13 이상**이 필요합니다(지식베이스와 AI 비용 장부가 Node 내장 SQLite를 사용).

```sh
npm ci
cp .env.example .env.local   # Windows PowerShell: Copy-Item .env.example .env.local
npm run dev
```

브라우저에서 **http://127.0.0.1:3000** 을 엽니다. `localhost`·`127.0.0.1`·다른 포트는 브라우저 저장 공간이 서로 다릅니다.

선택 설치(PC마다 한 번):

- PPT/PPTX 불러오기: [LibreOffice](https://www.libreoffice.org/download/download-libreoffice/) 설치
- HWP/HWPX 불러오기: `npm run setup:hwp`

## 생성 모드와 AI 연결

| 모드 | 설정 방법 | 비용 | 원고 전송 |
| --- | --- | --- | --- |
| 무료 데모 (기본값) | 설정 없음 | 없음 | 없음. 원문을 나누는 발췌 데모로, PDF 해석·지식베이스·어휘 재작성·번역은 하지 않음 |
| Gemini 팀 키 | 운영자가 `.env.local`에 `EDUFLOW_GENERATOR=gemini`, `EDUFLOW_GEMINI_API_KEY` | Google 무료 등급은 0원 (결제 연결 시 과금) | Google |
| OpenAI | `.env.local` 서버 설정 또는 화면 **모델 연결**에서 개인 키 | 키 소유자 | OpenAI |
| Claude | 화면 **모델 연결**에서 개인 키 (Opus·Sonnet·Haiku 5.5) | 키 소유자 | Anthropic |

- 화면 상단의 연결 배지로 현재 모드를 확인하고 **모델 연결** 창에서 바꿉니다. Gemini 팀 키를 쓰면 사용자는 키를 입력하지 않습니다.
- 모든 AI 모드는 PC마다 **하루 $1·월 $5**, 시간당 5회, 동시 1건으로 제한합니다. 생성 중 서버를 강제 종료하면 비용 예약이 남아 이후 호출이 막힐 수 있습니다.
- 키는 채팅·소스 코드·GitHub에 넣지 않습니다. `.env.local`과 `.eduflow-private/`는 Git에서 제외됩니다.
- 자세히: [모델 연결](docs/07_MODEL_CONNECTION.md), [키·비용 보호](docs/04_AI_SAFETY.md)

**지식베이스(RAG):** AI 모드는 생성 전에 `/knowledge`에 등록한 공식·내부 자료에서 원고와 관련된 구간을 찾아 장면의 **보강 자료 근거**로 씁니다. 관련 자료가 없으면 **원고만으로 생성**하고 편집 화면 상단에 "보강 자료 없음"을 표시합니다. 지식베이스는 PC마다 따로 저장되고 처음에는 비어 있습니다. 공식 자료로 설명을 보강하려면 원고와 같은 주제의 자료를 등록한 뒤 생성하세요. 등록 예시와 동작 방식은 [05_KNOWLEDGE_SOURCES](docs/05_KNOWLEDGE_SOURCES.md)에 있습니다.

## 시연 순서

1. **무료 데모:** 샘플 원고 사용 → 조건 선택 → 스토리보드 생성 → 장면 편집·이동·재생성 → 내보내기.
2. **AI:** 모델 연결 확인 → 원고 입력 또는 PDF·PPT·한글 페이지 선택 → 스토리보드 생성 → 장면의 **원문 위치 확인** → 내보내기. 공식 자료 보강까지 보이려면 먼저 `/knowledge`에 같은 주제의 자료를 등록하고, 장면의 **보강 자료 근거**를 확인합니다.

샘플 원고는 "탄소중립" 주제라 산업안전 지식베이스 자료와 맞지 않아 보강 없이 원고만으로 생성됩니다.

## 주요 기능

- 원고 직접 입력, PDF·PPT/PPTX·HWP/HWPX·Word(.docx)·UTF-8 TXT 가져오기 및 드롭, 길이 검증
- PDF 업로드 후 페이지 선택 자동 안내, 원본 미리보기, 선택 페이지의 표·그림을 포함한 AI 생성
- PPT/PPTX·HWP/HWPX를 로컬에서 PDF로 변환한 뒤 페이지/슬라이드 선택, 원본 파일명·번호 저장
- Word·TXT의 제목·본문 키워드로 제작할 부분 찾기, 원고 확인·수정 후 AI 생성
- 산업현장 근무자, 현장 방문자(일반인·기업 관계자·외부 하청업체), 외국인 근로자 대상 선택
- 대상·난이도·길이·장면 수·톤·키워드·출력 언어·추가 요청
- 진행 상태, 중복 요청 차단, 취소, 오류 및 재시도
- 개요, 제목, 학습 목표와 모든 장면 내용의 직접 편집
- 원문 근거의 페이지·문장 위치 표시, 원문 열기·일치 구절 강조·검색, 검토 표시, 수정한 필드 표시
- AI 모드에서 도입부·정보전달부·마무리 구성, 등록된 지식베이스 검색과 장면별 근거 표시
- 선택 장면 재생성 및 교체 안내
- 선택 위치 뒤에 장면 추가, 삭제 확인, 위/아래 순서 이동
- 자동 저장 및 새로고침 복구, 새 작업 초기화 확인
- 전체 Markdown 복사, Markdown·CSV 다운로드 (UTF-8 BOM, 셀 이스케이프)
- 모바일 레이아웃, 키보드 조작, 접근성 레이블, 모달 포커스 관리

문서 업로드·원문 위치 확인·브라우저 저장의 상세 동작은 [문서 입력 상세](docs/DOCUMENT_INPUT.md)에 있습니다.

## 프로젝트 구조

| 경로 | 내용 |
| --- | --- |
| `app/page.tsx` | 메인 작업 화면 (원고 입력 → 스토리보드 편집 → 내보내기) |
| `app/knowledge/` | 지식베이스 관리 화면 |
| `app/api/` | 서버 API: `generate`(생성), `connection`(모델 연결), `documents`(문서 변환·미리보기·원문), `knowledge`(지식베이스) |
| `components/studio/` | 작업 화면 부품 (원고·설정 패널, 장면 목록·편집기, 모델 연결 창 등) |
| `hooks/` | 화면 상태 훅 (자동 저장, 연결 상태, PDF 선택) |
| `lib/` | 공통 로직과 테스트 (`*.test.ts`) |
| `lib/server/` | 서버 전용 코드: AI 어댑터(`openai`·`anthropic`·`gemini`·`demo`), 비용 보호, 지식베이스, 문서 변환 |
| `docs/` | 문서 ([문서 목록](docs/README.md)) |
| `scripts/` | 한글 변환 도구 설치 스크립트 |

## 기술 구성

- Next.js 16.3.5 App Router, React 19, TypeScript, Tailwind CSS 4, shadcn/ui(Base UI), Lucide 아이콘
- Zod 입력·출력 검증, Next.js Route Handler
- AI: OpenAI SDK(GPT-5.4 mini), Anthropic SDK(Claude 5.5), Google Gen AI SDK(Gemini 3.8 Flash·3.5 Flash-Lite)
- 문서: pdf.js·pdf-parse·pdf-lib(PDF), mammoth(Word), LibreOffice(PPT 변환), rhwp(한글 변환), @napi-rs/canvas(표 영역 이미지)
- 저장: 브라우저 localStorage·IndexedDB(작업), 로컬 SQLite(지식베이스·비용 장부, `.eduflow-private/`)
- 로컬 Inter / JetBrains Mono 글꼴, 한글은 시스템 한글 글꼴

개발 서버와 빌드는 Webpack을 사용합니다. Turbopack 개발 서버가 스타일 파일의 최신 변경을 반영하지 않는 현상을 확인하여 Webpack으로 통일했습니다.

## 검증

```sh
npm run typecheck
npm test
npm run build
```

GitHub의 PR과 팀 브랜치 푸시에서도 같은 검사가 자동 실행됩니다(Ubuntu). Windows에서는 파일 권한·임시 폴더 삭제 방식 차이로 테스트 2개(`saved keys need consent…`, `110000 input tokens fit…`)가 실패하며 기능 오류는 아닙니다.

- TypeScript 검사 및 프로덕션 빌드
- 5개 교육 원고 × 3/6/20 장면: 필수 구조, 원문 근거, 목표 시간 합계
- 입력 경계 및 조건 검증
- 텍스트 없는 PDF 업로드, 범위 선택, 선택본의 픽셀 보존, 회전·잘림 영역을 보존한 호환 PDF, multipart 검증 및 계산·생성·보완 요청의 PDF 일치와 별도 이미지 첨부 없음
- 텍스트 16페이지의 이미지 첨부 제거, 혼합 PDF의 표·그림·스캔 보존, 원본 번호 매핑 및 장면별 출처 범위 선택
- 재생성 시 입력 객체 보존과 선택 장면 근거 유지
- 장면 시간 소수 입력의 저장·복구, 잘못된 입력의 저장 차단
- 실패한 요청의 입력·대상 유지, 재시도 시 수정·삭제된 대상 보호
- 생성 응답의 부분 보완, 정상 장면 보존, 원문 근거 경고, 취소·시간 초과·안전한 오류 응답
- 최신 편집/순서의 Markdown·CSV 반영, 따옴표/줄바꿈, 수식 주입 방지
- 인앱 브라우저: 샘플 생성, 장면 수정, 선택 장면 재생성, 새로고침 복구, 전체 복사
- 데스크톱·모바일 레이아웃 확인 (모바일 브라우저의 실제 CSS 너비 354px, 수평 넘침 없음)
- 모바일 메뉴 포커스 순환, Escape 닫기, 메뉴 버튼으로 포커스 복귀 확인

복구·디자인 적용 후 검증 기록: `docs/RESTORATION_2026-09-29.md`.

브라우저 다운로드 이벤트는 인앱 브라우저 도구에서 확인되지 않았으므로 일반 Chrome/Safari의 실제 파일 저장은 별도 확인이 필요합니다. 내보내기 문자열은 자동 테스트로 검증했습니다. Chrome/Edge/Safari 전체 호환성 및 실제 AI 품질(원문 충실도, 대상·난이도별 표현, 번역) 평가는 미실시 상태입니다.

## 문서

전체 목록과 각 문서의 상태는 [docs/README.md](docs/README.md)에 있습니다. 원본 요구사항 문서(`01_MVP_PRD.md`)와 UX 문서는 저장소에 없습니다.

## 팀 협업

팀원은 Git 명령어를 외울 필요가 없습니다. Codex에 `A팀 작업 시작: 할 일`이라고 말하고, 완료되면 `작업 마무리해서 팀 검토 요청 준비해줘`라고 말하면 됩니다. [팀원용 자연어 협업 안내](docs/NATURAL_LANGUAGE_WORKFLOW.md)에 필요한 문장만 정리되어 있습니다.

내부적으로는 공용 저장소 하나에서 `개인 작업 → 팀별 통합 → 팀장 승인 → main` 순서로 처리됩니다. 관리자를 위한 자세한 절차는 [Git 협업 규칙](docs/GIT_WORKFLOW.md)을 확인하세요.
