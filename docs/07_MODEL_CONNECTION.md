# 모델 연결: API 키·ChatGPT 로그인·Claude 구독(개인 실험)

작성일: 2026-10-27. 화면 상단의 연결 배지를 누르면 **모델 연결** 창이 열립니다. 설정은 각자의 PC에서 실행하는 EduFlow 서버의 `.eduflow-private/connection.json`(폴더 700, 파일 600)에만 저장하고, 키·토큰은 화면이나 브라우저 저장소로 다시 보내지 않습니다. 이 파일과 폴더는 Git에 올리지 않습니다.

로컬 LLM(Ollama) 방식은 사용하지 않습니다. 모델은 아래 방식으로만 연결합니다.

| 방식 | 결제 | 보호 장치 |
| --- | --- | --- |
| 무료 데모 | 없음 | 외부 전송 없음 |
| OpenAI API 키 | 내 OpenAI 키 | 하루 $1·월 $5 비용 장부, 입력 토큰 사전 계산, 출력 상한 |
| Claude API 키 | 내 Claude Console 키 | 같은 비용 장부. Opus 5.5(기본)·Sonnet 5.5·Haiku 5.5만 고정 가격으로 선택 |
| ChatGPT 로그인 | ChatGPT Plus·Pro 플랜 사용량 | 한 번에 1건, 시간당 10건(`EDUFLOW_SUBSCRIPTION_REQUESTS_PER_HOUR`) |
| Claude 구독 (개인 실험) | 이 PC의 Claude Code 로그인 | 기본 꺼짐. 한 번에 1건, 시간당 10건 |

## API 키

키를 입력하고 유료 호출 동의를 선택한 뒤 저장합니다. 저장한 키는 `EDUFLOW_AI_ENABLED` 없이도 사용하지만, 비용 한도와 토큰 상한은 기존 `.env.local` 값과 팀 공통 상한(하루 $1·월 $5)을 그대로 따릅니다. 화면에 저장한 OpenAI 키가 없으면 예전처럼 `.env.local`의 `EDUFLOW_AI_API_KEY`를 씁니다.

Claude 모델은 가격을 아는 모델만 고를 수 있습니다(100만 토큰당 입력/출력: Opus 5.5 $4/$20, Sonnet 5.5 $2/$10, Haiku 5.5 $0.10/$0.50). 기본 1회 예약 한도는 Opus $0.50, Sonnet $0.25, Haiku $0.02이며 `EDUFLOW_ANTHROPIC_REQUEST_BUDGET_USD`로 낮출 수 있습니다. 기본 상한(입력 16,000·출력 8,000 토큰)에서 Opus 5.5는 하루 최소 2회(보완 호출 없이 끝나면 예약이 일부 환급되어 더 많이) 생성할 수 있습니다. Opus 5.5의 사고 토큰도 출력 상한에 포함되므로 장면이 많아 결과가 잘리면 `EDUFLOW_AI_MAX_OUTPUT_TOKENS`를 비용 한도 안에서 올리세요. 거절 시 다른 모델로 자동 재실행하는 서버 폴백은 가격이 정해지지 않은 모델로 넘어갈 수 있어 사용하지 않습니다.

## ChatGPT 로그인

OpenAI의 [Sign in with ChatGPT 플랜 사용](https://developers.openai.com/siwc/token-sharing-open-source)은 오픈소스·로컬 실행 앱용입니다. EduFlow는 각자의 PC에서 실행하므로 이 조건에 맞춥니다. 원격 서버나 유료 서비스로 배포하려면 OpenAI 신청서를 먼저 제출해야 합니다.

1. `http://127.0.0.1:3000`으로 화면을 엽니다(`localhost`는 다른 주소로 취급되어 로그인할 수 없습니다).
2. **Continue with ChatGPT**를 누르고 OpenAI 화면에서 로그인·플랜 사용을 허용합니다.
3. 돌아오면 생성 모델을 고릅니다. 목록은 로그인한 계정에서 쓸 수 있는 모델입니다.

PKCE·일회용 state·nonce와 OpenAI 공개키로 ID 토큰을 검증하고, `chatgpt.tokens.use.direct` 권한이 있을 때만 생성합니다. 요청은 미리보기 규칙에 따라 `store:false`, `stream:true`로 보내며 `max_output_tokens`·`temperature` 등은 넣지 않습니다. 출력 길이는 받는 동안 끊어서 제한합니다. 토큰은 만료 2분 전에 갱신하고, 갱신 토큰을 쓸 수 없으면 다시 로그인하도록 안내합니다. 로그아웃하면 OpenAI에 갱신 토큰 폐기를 요청한 뒤 이 PC의 토큰을 지웁니다. ChatGPT 설정의 앱 연결에서도 언제든 해제할 수 있습니다.

## Claude 구독 (개인 실험)

Anthropic은 승인 없이 제품에서 claude.ai 로그인이나 구독 한도를 제공하는 것을 허용하지 않습니다([Agent SDK 안내](https://code.claude.com/docs/en/agent-sdk/quickstart), [법률·준수](https://code.claude.com/docs/en/legal-and-compliance)). 이 옵션은 **본인 PC에서 본인 계정으로만** 쓰는 실험용이며 팀 기능으로 제공하지 않습니다. 계정 제한 등의 위험은 각자 부담합니다.

- `.env.local`에 `EDUFLOW_EXPERIMENTAL_CLAUDE_SUBSCRIPTION=true`를 넣고 서버를 재시작해야 선택지가 보입니다.
- 터미널에서 `claude`로 본인 계정에 로그인한 뒤, 연결 창의 확인란을 선택합니다.
- EduFlow는 Claude 토큰을 읽거나 저장하지 않습니다. Agent SDK가 이 PC의 Claude Code 로그인을 그대로 씁니다.
- 하위 프로세스에는 API 키·클라우드 공급자 설정·EduFlow 비밀값을 전달하지 않으며, 세션이 API 키로 시작되면 생성을 중단합니다.
- 도구·MCP·설정 파일·세션 저장을 모두 끄고 빈 임시 폴더에서 실행합니다.
- 모델 별칭은 `EDUFLOW_CLAUDE_SUBSCRIPTION_MODEL`(기본 `opus`)로 바꿀 수 있습니다.

## 확인한 내용

- 자동 테스트: 키 동의·저장 권한·상태 응답에 키 미포함·손상 파일 보존, Claude 요청 형식과 거절·잘림·인증 오류, ChatGPT PKCE·state 재사용 차단·nonce·플랜 권한·토큰 갱신·로그아웃, 플랜 요청의 금지 필드 제외와 사용량 한도 오류, Claude 구독 실험의 도구·환경 변수 차단.
- 화면: 연결 창 열기, Claude API 선택, 테스트 키 저장(마스킹 표시)과 삭제, 배지 갱신. 다른 출처의 설정 변경 요청은 403으로 거부됩니다.
- 실제 계정 생성은 미확인입니다. ChatGPT 로그인과 Claude 구독은 각자 계정으로 한 번 생성해 보고 결과를 이 문서에 기록해 주세요.
