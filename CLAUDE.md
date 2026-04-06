# Agatha — GitHub Issue Worker

## What This Is

A single-file TypeScript worker (`worker.ts`) that polls a GitHub repo for issues labeled `ai-task`, spawns Claude Code to implement the changes in a local clone of the target repo, then commits, pushes, and opens a PR. It is NOT the target repo itself — it orchestrates work on a separate repo specified by `REPO_PATH`.

## Commands

- `npm run dev` — run the worker with hot reload (uses `tsx`)
- `npm run build` — compile TypeScript to `dist/`
- `npm start` — run the compiled worker
- `npm run check` — typecheck without emitting

## Architecture

The entire app is in `worker.ts`. There is no framework — it's a long-running Node.js process with a `setInterval` poll loop.

Key flow: `poll()` → `processIssue()` → `runClaude()` → git commit/push → `gh pr create`

### Important functions

- `runCommand()` — spawns a child process, captures stdout/stderr, rejects on non-zero exit
- `runClaude()` — spawns the `claude` CLI with `--permission-mode acceptEdits`, pipes the prompt via stdin
- `buildClaudePrompt()` — constructs the prompt sent to Claude, including instructions to write `.ai-summary.md`
- `processIssue()` — the main orchestration: git setup, run Claude, collect summary/migrations, build PR body, push, create PR
- `poll()` — fetches issues with `ai-task` label, skips ones already `ai-running`, processes one at a time

### Label state machine

`ai-task` → `ai-running` → `ai-done` (success) or `ai-failed` (error)

### Temporary files

The worker creates and cleans up these files in the target repo (`REPO_PATH`):
- `.ai-issue-{number}.md` — the prompt file
- `.ai-summary.md` — Claude's summary of its changes (read then deleted before commit)
- `.ai-pr-body.md` — the assembled PR description (passed to `gh pr create --body-file`)

## Environment

Config is via `.env` (see `.env.example`). The critical variables are:
- `GITHUB_TOKEN`, `GITHUB_OWNER`, `GITHUB_REPO` — target repo on GitHub
- `REPO_PATH` — absolute path to a local clone of the target repo
- `BASE_BRANCH` — branch to base work off (default: `main`)
- `POLL_MS` — polling interval in ms (default: `30000`)

## Conventions

- TypeScript strict mode, CommonJS output, ES2022 target
- No classes — plain functions and async/await
- `child_process.spawn` with `shell: false` for all subprocesses
- Errors in issue processing are caught, commented on the issue, and labeled `ai-failed` — the poll loop continues
- One issue processed per poll cycle (sequential, not parallel)

## Things to Watch Out For

- `runCommand` uses `shell: false` — do not pass shell syntax (pipes, redirects) to it
- The worker does `git reset --hard` and `git clean -fd` on the target repo before each issue — any uncommitted work in `REPO_PATH` will be destroyed
- Claude is invoked with `--permission-mode acceptEdits` which auto-approves file edits
- PR body is written to a temp file and passed via `--body-file` to avoid shell escaping issues with `gh`
- Migration detection looks for files ending in `.sql` or paths containing `migration` or `supabase/migrations`
