# EduFlow Git 협업 규칙

EduFlow는 하나의 GitHub 저장소에서 아래 구조로 협업합니다.

```text
main                 최종 공식 버전
├── team-a           A팀 통합 브랜치
├── team-b           B팀 통합 브랜치
└── team-c           C팀 통합 브랜치

각 팀원 작업:
team-a → feature/a-작업명 → team-a
team-b → feature/b-작업명 → team-b
team-c → feature/c-작업명 → team-c
```

## 반드시 지킬 규칙

1. `main`에서 직접 개발하거나 직접 Push하지 않습니다.
2. 개인 작업은 자신의 팀 브랜치에서 새 `feature/*` 브랜치를 만들어 진행합니다.
3. 개인 작업은 Pull Request(PR)로 팀 브랜치에 합칩니다.
4. 팀 결과물은 팀 브랜치에서 `main`으로 PR을 보냅니다.
5. `main` 반영은 팀장의 검수와 승인 후에만 진행합니다.
6. 비밀번호, API 키, `.env` 파일은 Commit하지 않습니다.

## 처음 참가할 때

```bash
git clone <저장소 주소>
cd storyboard
git fetch origin
```

자신의 팀 브랜치로 이동합니다. A팀의 예시는 다음과 같습니다.

```bash
git switch team-a
git pull origin team-a
```

## 새 작업 시작

먼저 팀 브랜치를 최신 상태로 맞춥니다.

```bash
git switch team-a
git pull origin team-a
git switch -c feature/a-storyboard-api
```

브랜치 이름은 다음 규칙을 사용합니다.

- 새 기능: `feature/팀-작업명`
- 오류 수정: `fix/팀-작업명`
- 문서 수정: `docs/팀-작업명`

예: `feature/a-ai-adapter`, `fix/b-mobile-menu`, `docs/c-test-guide`

## 작업 저장 및 GitHub에 올리기

```bash
git status
git add <변경한 파일>
git commit -m "작업 내용을 짧게 설명"
git push -u origin feature/a-storyboard-api
```

GitHub에서 다음 방향으로 PR을 만듭니다.

```text
feature/a-storyboard-api → team-a
```

같은 팀의 검토가 끝나면 팀 브랜치에 합칩니다.

## 팀 결과를 main에 반영하기

팀 작업이 완료되고 팀 브랜치에서 테스트를 통과하면 다음 PR을 만듭니다.

```text
team-a → main
```

팀장은 변경 내용과 실행 결과를 검수합니다. 수정이 필요하면 PR에서 요청하고, 문제가 없을 때 승인하고 Merge합니다.

## PR 전에 확인할 항목

```bash
npm run typecheck
npm test
npm run build
```

- 기존 기능이 정상 동작하는지 확인합니다.
- 작업과 관계없는 파일은 포함하지 않습니다.
- `.env`와 API 키가 포함되지 않았는지 확인합니다.
- 무엇을 바꿨고 어떻게 확인했는지 PR 설명에 적습니다.

PR을 만들면 GitHub에서도 같은 타입 검사·테스트·빌드가 자동으로 실행됩니다. 자동 검사가 실패하면 결과를 확인하고 수정한 뒤 다시 Push합니다.

## 팀 브랜치의 최신 변경을 개인 작업에 반영하기

작업 중 팀 브랜치가 바뀌었다면 다음 순서로 반영합니다.

```bash
git switch team-a
git pull origin team-a
git switch feature/a-storyboard-api
git merge team-a
```

충돌이 발생하면 임의로 결정하지 말고 같은 부분을 수정한 팀원과 먼저 합의합니다.

## 팀장 운영 원칙

- `main`은 PR을 통해서만 변경합니다.
- `main` PR에는 팀장 승인을 요구합니다.
- 테스트가 실패한 PR은 합치지 않습니다.
- 기능 브랜치를 `main`으로 바로 보내지 않고 먼저 팀 브랜치에서 통합합니다.
- 긴급 수정도 `fix/*` 브랜치와 PR을 사용합니다.
