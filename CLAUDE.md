# Agatha — GitHub Issue Worker

## What This Is

A single-file TypeScript worker (`worker.ts`) that polls a GitHub repo for issues labeled `ai-plan` or `ai-task`, spawns Claude Code to plan or implement changes in a local clone of the target repo, then commits, pushes, and opens a PR. It is NOT the target repo itself — it orchestrates work on a separate repo specified by `REPO_PATH`.

## Commands

- `npm run dev` — run the worker with hot reload (uses `tsx`)
- `npm run build` — compile TypeScript to `dist/`
- `npm start` — run the compiled worker
- `npm run check` — typecheck without emitting

## Architecture

The entire app is in `worker.ts`. There is no framework — it's a long-running Node.js process with a `setInterval` poll loop.

Jobs run concurrently (up to `MAX_CONCURRENT`) using **git worktrees** for isolation — each job gets its own working directory under `../.ai-worktrees/` relative to `REPO_PATH`. The main repo stays on `BASE_BRANCH` and is never modified directly.

Key flow: `poll()` → `dispatch()` → `createWorktree()` → `process*()` → `runClaude()` → cleanup worktree

### Important functions

- `runCommand()` — spawns a child process, captures stdout/stderr, rejects on non-zero exit
- `runClaude()` — spawns the `claude` CLI with `--permission-mode acceptEdits`, pipes the prompt via stdin
- `createWorktree()` / `removeWorktree()` — manage isolated git worktrees for each job
- `dispatch()` — creates a worktree, runs a process function, cleans up the worktree on completion
- `processPlanIssue()` — runs Claude to generate an implementation plan, posts it as an issue comment
- `processPlanFeedback()` — revises an existing plan based on `/agatha` feedback on the issue
- `processIssue()` — implements the issue (optionally following an approved plan), commits, pushes, creates PR
- `processPRComment()` — addresses `/agatha` feedback on an open PR
- `poll()` — collects all pending work (plan feedback, PR feedback, new plans, new tasks), dispatches up to `MAX_CONCURRENT` jobs concurrently

### Label state machines

**Planning flow:**
`ai-plan` → `ai-planning` → `ai-planned` (plan posted as comment) → user adds `ai-task` label → implementation flow

**Implementation flow:**
`ai-task` → `ai-running` → `ai-done` (success) or `ai-failed` (error)

### Feedback loops

- On `ai-planned` issues: comment `/agatha <feedback>` to revise the plan
- On open PRs: comment `/agatha <feedback>` to push code changes addressing the feedback

### Temporary files

Each job works in its own worktree (`../.ai-worktrees/<job-name>/`). Files created and cleaned up per job:
- `.ai-plan.md` — Claude's implementation plan (read then worktree is removed)
- `.ai-summary.md` — Claude's summary of its changes (read then deleted before commit)
- `.ai-pr-body.md` — the assembled PR description (passed to `gh pr create --body-file`)

### Concurrency & worktrees

- Each job (plan, implementation, PR feedback) gets its own git worktree
- Worktrees are created under `REPO_PATH/../.ai-worktrees/`
- Job keys prevent duplicate work: `plan-{issueNumber}`, `issue-{issueNumber}`, `pr-{prNumber}`
- The main repo stays on `BASE_BRANCH` — it is never modified by jobs
- Stale worktrees are cleaned up on startup via `git worktree prune`

## Environment

Config is via `.env` (see `.env.example`). The critical variables are:
- `GITHUB_TOKEN`, `GITHUB_OWNER`, `GITHUB_REPO` — target repo on GitHub
- `REPO_PATH` — absolute path to a local clone of the target repo
- `BASE_BRANCH` — branch to base work off (default: `main`)
- `POLL_MS` — polling interval in ms (default: `30000`)
- `MAX_CONCURRENT` — max concurrent jobs (default: `3`)

## Conventions

- TypeScript strict mode, CommonJS output, ES2022 target
- No classes — plain functions and async/await
- `child_process.spawn` with `shell: false` for all subprocesses
- Errors in issue processing are caught, commented on the issue, and labeled `ai-failed` — the poll loop continues
- Multiple jobs processed concurrently, each in an isolated git worktree

## Things to Watch Out For

- `runCommand` uses `shell: false` — do not pass shell syntax (pipes, redirects) to it
- The main repo (`REPO_PATH`) must stay on `BASE_BRANCH` — worktrees can't share a checked-out branch
- Git worktrees share the object store — a single `git fetch origin` in the main repo updates refs for all worktrees
- Claude is invoked with `--permission-mode acceptEdits` which auto-approves file edits
- PR body is written to a temp file and passed via `--body-file` to avoid shell escaping issues with `gh`
- Migration detection looks for files ending in `.sql` or paths containing `migration` or `supabase/migrations`
- Same job key (e.g. `plan-42`) prevents concurrent work on the same issue/PR — prevents branch conflicts
