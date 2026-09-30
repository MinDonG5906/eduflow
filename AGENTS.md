<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

## EduFlow natural-language Git workflow

The user should not need to know Git commands. Translate ordinary Korean requests into the safe workflow below and report outcomes in plain Korean. Show raw Git commands only when the user asks for them.

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

### Saving and requesting team review

When a user says `작업 마무리해서 팀 검토 요청 준비해줘`:

1. Review the diff and exclude unrelated files.
2. Check that secrets, API keys, and `.env` files are not included.
3. Run `npm run typecheck`, `npm test`, and `npm run build`.
4. Commit the task with a clear Korean message and push the current task branch.
5. Prepare a pull request whose base is the user's team branch, never `main`.
6. Summarize changes and checks in plain Korean. Get any required confirmation immediately before creating the pull request.

Never merge a personal task branch directly into `main`.

### Team integration and main

- A personal branch may target only its matching `team-a`, `team-b`, or `team-c` branch.
- A team branch may target `main` only after the team says its combined work is ready.
- Before any `main` merge, inspect changes, run checks, explain risks, and wait for the team leader's explicit approval.
- After `main` changes, help each team update its team branch from the new `main` before starting further work.

### Failure and conflict handling

- If the working tree already contains unrelated changes, continue only where those changes can be preserved safely.
- If a merge conflict occurs, explain which files and edits conflict. Do not choose a winner without user direction.
- If a check fails, do not create or merge a pull request as if it passed. Explain the failure and fix it when requested.
- Never force-push, delete a branch, or rewrite history unless the user explicitly requests it and the exact impact has been explained.
