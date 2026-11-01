<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

## EduFlow natural-language Git workflow

The user should not need to know Git commands. Translate ordinary Korean requests into the safe workflow below and report outcomes in plain Korean. Show raw Git commands only when the user asks for them.

### Team authority

- The EduFlow team leader and final `main` approver is GitHub user `MinDonG5906`.
- Treat `.github/eduflow-team.json` as the authoritative team roster. Team invitations will be added later; do not invent members or send invitations unless the team leader explicitly asks.
- Personal work is reviewed inside its team. A `team-a`, `team-b`, or `team-c` pull request targeting `main` requires the team leader's explicit approval before merge.
- The private repository is currently owned by a personal GitHub account, so paid-plan branch protection may not be enforceable. Follow these rules even when GitHub does not technically block an unsafe merge.

### Repository structure

- `main`: final version controlled by the team leader.
- `team-a`, `team-b`, `team-c`: integration branches for each two-person team.
- `feature/*`, `fix/*`, `docs/*`: individual task branches.

### Starting a team member's task

When a user says something like `A팀 작업 시작: AI 연결`:

1. Inspect the current branch and working tree first.
2. Preserve all existing user changes. Never reset, discard, or overwrite them.
3. Fetch the remote and update the matching team branch with a fast-forward-only pull.
4. Create a short task branch from that team branch, for example `feature/a-ai-connection`.
5. Confirm the new branch and starting point in plain language, then perform the requested coding work.

If the user's team is unknown, ask only which of A, B, or C they belong to. Do not teach Git before starting.

### Natural-language latest-work shortcut

When the user says `@최신`:

1. Inspect the current branch and working tree before fetching or merging anything. Never discard, stash, reset, or overwrite user changes automatically.
2. If tracked or untracked work is not safely recorded, stop without updating and ask the user to run `@개인저장` first.
3. Determine the update source from the current branch: `feature/a-*`, `fix/a-*`, or `docs/a-*` uses `team-a`, and likewise for B and C. A current team branch uses its matching remote branch; `main` uses `origin/main`. If the team cannot be determined safely, ask only which team the user belongs to.
4. Fetch the remote and verify that the matching remote team branch exists. For team work, also check whether the latest `origin/main` is already contained in that remote team branch. If it is not, do not silently mix `main` into a member branch; report that the team baseline needs the leader's synchronization first.
5. If the current branch is `main` or a team branch, update it only with a fast-forward operation. If a non-fast-forward update would be required, stop and explain.
6. If the current branch is an individual task branch, merge the latest matching `origin/team-*` into that individual branch without rewriting history. If a conflict occurs, abort the merge so the user's branch returns to its previous state, list the conflicting files, and ask for direction.
7. Do not push, open a pull request, approve, or merge a GitHub pull request as part of `@최신`. It updates only the user's local computer. The user can run `@개인저장` afterward to back up the updated individual branch to GitHub.
8. Report in plain Korean whether the local work is current, what was updated, and whether team-leader synchronization is still required.

### Natural-language save shortcuts

Treat the exact shortcuts below as explicit workflow commands in Codex, Claude Code, and Antigravity. Do not require the user to know or repeat Git terminology.

When the user says `@개인저장`:

1. Inspect the current branch and working tree. Preserve and exclude unrelated user changes.
2. Confirm the current branch is an individual task branch matching `feature/[abc]-*`, `fix/[abc]-*`, or `docs/[abc]-*`. If it is `main`, a team branch, or its team cannot be determined safely, stop and ask only for the user's team and task.
3. Check that secrets, API keys, credentials, personal information, and `.env` files are not included.
4. Review the task diff, perform a lightweight sanity check appropriate to the changed files, and commit only the task-related changes with a clear message. If there are no new changes, keep the existing commit unchanged.
5. Push the current individual branch to GitHub. Do not create a pull request and do not change a team branch or `main`.
6. Report in plain Korean that the personal GitHub backup is complete and team review has not been requested.

When the user says `@팀저장` or `작업 마무리해서 팀 검토 요청 준비해줘`:

1. Perform every safety and personal-save step above.
2. Run `npm run typecheck`, `npm test`, and `npm run build`.
3. If a check fails, keep the work safely pushed on the individual branch but do not create a pull request. Explain the failure.
4. If all checks pass, create or update one pull request whose base is the matching team branch, never `main`. Its description must include a change summary, completed checks, exact review steps, expected behavior, known risks, and sanitized screen evidence for user-interface changes when capture is available. Never attach real user content, credentials, or personal information.
5. The exact `@팀저장` command is explicit authorization to create or update that team-review pull request; do not ask for a second confirmation. It is not authorization to merge it.
6. Let the repository automation request review from the other registered team member, and report who was requested. If no teammate is registered, explain that the work is saved but automatic reviewer assignment is waiting for the roster.

The repository workflow validates the pull request route and assigns reviewers from `.github/eduflow-team.json`. Never work around a failed route check by changing the target to `main`.

Never merge a personal task branch directly into `main`.

### Natural-language review shortcut

When the user says `@검토`:

1. Treat the command as read-only review authorization. Do not approve, comment on, close, or merge a pull request, and do not modify its branch.
2. Identify the pull request from a number or team/task named by the user. If none is named, find open EduFlow pull requests requesting review from the authenticated GitHub user. If exactly one is relevant, use it; if several are relevant, show short choices and ask which one. If none exists, report that there is no review request.
3. Preserve the user's current files and branch. Fetch the proposed change and inspect it in a clean isolated worktree or equivalent temporary workspace. Never switch or overwrite a dirty active workspace merely to review another person's branch.
4. Verify that the source and destination branches follow the EduFlow route, inspect the full diff, and check for unrelated files, secrets, credentials, `.env` files, personal information, destructive changes, and missing documentation.
5. Run `npm run typecheck`, `npm test`, and `npm run build` in the isolated review workspace. A failure must be reported and may not be presented as a pass.
6. Verify the changed behavior rather than relying only on code:
   - For user-interface work, run the proposed version, exercise the affected flow with sample data, and show the relevant screen or before/after evidence.
   - For API or AI work, show representative sanitized input/output, failure handling, and relevant test evidence.
   - For documents or configuration, show the meaningful before/after diff and explain its operational effect.
7. Compare the observed result with the pull request's expected behavior and review steps. Note anything that could not be reproduced.
8. Return a concise Korean review report with: `변경 내용`, `실행 확인`, `자동 검사`, `위험·미확인`, and one conclusion: `승인 가능`, `수정 후 재검토`, or `검토 불가`.
9. Even when the conclusion is `승인 가능`, wait for a separate explicit instruction such as `승인하고 팀 브랜치에 합쳐줘` before taking any approval or merge action.

### Team integration and main

- A personal branch may target only its matching `team-a`, `team-b`, or `team-c` branch.
- A team branch may target `main` only after the team says its combined work is ready.
- Before any `main` merge, inspect changes, run checks, explain risks, and wait for `MinDonG5906`'s explicit approval.
- After `main` changes, help each team update its team branch from the new `main` before starting further work.

### Failure and conflict handling

- If the working tree already contains unrelated changes, continue only where those changes can be preserved safely.
- If a merge conflict occurs, explain which files and edits conflict. Do not choose a winner without user direction.
- If a check fails, do not create or merge a pull request as if it passed. Explain the failure and fix it when requested.
- Never force-push, delete a branch, or rewrite history unless the user explicitly requests it and the exact impact has been explained.


## UI consistency requested by the user

For every UI change, follow `docs/EDUFLOW_DESIGN.md`: preview → settings → action; keep primary actions reachable after editing; use consistent tabs, switches, input sizing and focus states. Put optional help and detailed cost explanations behind a small information button, but show actionable errors inline. Use ‘스토리보드’ in product copy. Verify narrow layouts and preserve existing user content.
