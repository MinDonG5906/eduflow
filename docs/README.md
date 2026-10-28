# 문서 목록

2026-10-27 정리. **현재 기준**은 지금 코드와 맞춰 관리하는 문서이고, **당시 기록**은 날짜 시점의 상태를 보존한 문서입니다. 둘이 다르면 현재 기준 문서와 코드를 따릅니다.

## 현재 기준

| 문서 | 내용 |
| --- | --- |
| [../README.md](../README.md) | 프로젝트 소개, 실행, 생성 모드, 시연 순서, 기능, 구조 |
| [03_AI_SPEC.md](03_AI_SPEC.md) | 생성 요청·응답 형식, 검증·보완, 근거 확인, 용어 교정, 오류 코드 |
| [04_AI_SAFETY.md](04_AI_SAFETY.md) | API 키 보관, 비용 장부와 한도, 로컬 접근 검사 (뒤쪽 날짜 절은 검증 기록) |
| [05_KNOWLEDGE_SOURCES.md](05_KNOWLEDGE_SOURCES.md) | RAG 지식베이스 동작 방식과 공식 자료 등록 기록 |
| [07_MODEL_CONNECTION.md](07_MODEL_CONNECTION.md) | 모델 연결: Gemini 팀 키, 개인 OpenAI·Claude 키 |
| [08_PROMPT_TEMPLATE.md](08_PROMPT_TEMPLATE.md) | 프롬프트 템플릿(과제 산출물): 지시문 원문, 작업 데이터·응답 형식, 서버 검사 범위, 버전 기록 |
| [DOCUMENT_INPUT.md](DOCUMENT_INPUT.md) | PDF·PPT·한글·Word·TXT 불러오기, 원문 위치 확인, 브라우저 저장·복구 |
| [EDUFLOW_DESIGN.md](EDUFLOW_DESIGN.md) | 화면 디자인 원칙과 교육 대상 |
| [GIT_WORKFLOW.md](GIT_WORKFLOW.md) | 팀 브랜치·PR 규칙 (관리자용) |
| [NATURAL_LANGUAGE_WORKFLOW.md](NATURAL_LANGUAGE_WORKFLOW.md) | 팀원용 자연어 협업 문장 |

## 당시 기록

| 문서 | 시점 | 내용 |
| --- | --- | --- |
| [05_PRE_UPLOAD_CHECK.md](05_PRE_UPLOAD_CHECK.md) | 2026-10-10 | Git 업로드 전 점검 결과 |
| [TEAM_STATUS_DIRECTION_2026-09-29.md](TEAM_STATUS_DIRECTION_2026-09-29.md) | 2026-09-29 | UX 프로토타입 단계의 진행 현황과 방향 제안 |
| [RESTORATION_2026-09-29.md](RESTORATION_2026-09-29.md) | 2026-09-29 | Frame → EduFlow 복구 기록 |

## 번호가 비어 있거나 겹치는 이유

- `01_MVP_PRD.md`(원본 요구사항)와 `02_UX.md`는 저장소에 없습니다. 과제 요구사항은 수업 자료를 기준으로 합니다.
- `05`는 지식베이스 기록과 업로드 점검 기록 두 문서가 같은 번호를 씁니다. 다른 문서의 링크가 깨지지 않도록 파일 이름은 그대로 둡니다.
- `06`은 AI 생성 품질 평가 문서(`06_AI_EVAL.md`)가 열린 PR #7에서 쓰고 있어 비워 둡니다.
