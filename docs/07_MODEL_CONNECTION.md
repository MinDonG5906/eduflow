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

Claude 모델은 가격을 아는 모델만 고를 수 있습니다(100만 토큰당 입력/출력: Opus 5.5 $4/$20, Sonnet 5.5 $2/$10, Haiku 5.5 $0.10/$0.50). 기본 1회 예약 한도는 Opus $0.50, Sonnet $0.25, Haiku $0.02이며 `EDUFLOW_ANTHROPIC_REQUEST_BUDGET_USD`로 낮출 수 있습니다. Claude 요청은 입력 16,000·출력 8,000 토큰으로 고정합니다. Haiku 5.5는 100,000 입력 토큰을 넘으면 가격이 올라가고, 이 상한이어야 보완 1회를 포함한 예약이 기본 1회 한도 안에 들어가기 때문입니다. 개인 설정이 더 낮으면 낮은 값을 유지합니다. 이 상한에서 Opus 5.5는 하루 최소 2회(보완 호출 없이 끝나면 예약이 일부 환급되어 더 많이) 생성할 수 있습니다. Opus 5.5의 사고 토큰도 출력 상한에 포함되므로 장면이 많아 결과가 잘리면 장면 수나 목표 시간을 줄여 주세요. 거절 시 다른 모델로 자동 재실행하는 서버 폴백은 가격이 정해지지 않은 모델로 넘어갈 수 있어 사용하지 않습니다.

## ChatGPT 로그인

OpenAI의 [플랜 사용 안내](https://developers.openai.com/siwc/token-sharing-open-source)는 "오픈소스·로컬 실행 앱"을 대상으로 하지만, [빠른 시작](https://developers.openai.com/siwc/quickstart)은 "공개 오픈소스 앱과 선정된 비공개 클라이언트"에 제공한다고 적고 있습니다. EduFlow는 각자의 PC에서 실행하지만 **비공개 저장소**이므로 대상에 해당하는지 확실하지 않습니다. 그래서 C팀의 첫 연결 기능(PR #11)은 이 기능을 넣지 않았습니다. 팀 기능으로 쓸지는 팀장이 정하고, 필요하면 OpenAI [신청서](https://openai.com/form/sign-in-with-chatgpt-interest/)로 확인합니다. 원격 서버나 유료 서비스로 배포할 때는 반드시 신청해야 합니다.

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
- ChatGPT 로그인 실제 생성(2026-10-27, ChatGPT Plus): Google 계정으로 로그인 후 `chatgpt.tokens.use.direct` 권한과 함께 돌아왔고, 모델 목록에서 `gpt-6-luna`를 선택했습니다. 기본 샘플 원고(산업현장 근무자·보통·3분·장면 수 자동)로 48초 만에 6장면(도입 1·정보전달 4·마무리 1)을 한 번에 생성했습니다. 보완 호출·경고·용어 교정은 없었고, 장면 시간 합계 190초(목표 대비 +5.6%), 자막은 모두 40자 이하, 모든 장면에 원문 근거가 붙었습니다. 결과 메타데이터에는 `chatgpt-plan/gpt-6-luna`, `eduflow-chatgpt-v1-selected-pdf`가 기록됩니다.
- **지식베이스가 비어 있으면 AI 생성이 막힙니다.** 처음 생성하면 "지식베이스에서 이 원고와 관련된 근거를 찾지 못했습니다"(422)로 모델 호출 전에 중단됩니다. 연결 방식과 관계없이 모든 AI 생성에 적용되므로, 처음 테스트할 때는 `/knowledge`에 원고 주제와 관련된 자료를 먼저 등록하세요. 위 확인에서는 샘플 원고 사본을 테스트용 내부 자료로 등록해 통과시켰고, 등록 자료가 원고와 같은 내용이라 보강 자료 근거는 비어 있었습니다. 테스트 후 자료는 비활성화했습니다.
- 개발 서버 로그에는 로그인 콜백 주소(일회용 인증 코드 포함)가 그대로 기록됩니다. 코드는 PKCE로 보호되고 한 번만 쓸 수 있지만, 로그를 공유할 때는 해당 줄을 지우세요.
- Claude 구독(개인 실험)의 실제 생성은 미확인입니다. 각자 계정으로 한 번 생성해 보고 결과를 이 문서에 기록해 주세요.
