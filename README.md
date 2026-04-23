# Agatha — GitHub Issue Worker

A background worker that monitors one or more GitHub repositories (across multiple organizations) for issues labeled `ai-task`, uses [Claude Code](https://docs.anthropic.com/en/docs/claude-code) to implement the requested changes, and opens a pull request for review.

## How It Works

1. The worker polls each configured GitHub repo for open issues with the `ai-task` label.
2. When it finds one, it labels the issue `ai-running` and checks out a fresh branch from that repo's base branch.
3. It sends the issue title and body to Claude Code, which reads the codebase, plans an approach, implements the changes, and runs validation (build, typecheck, tests).
4. If Claude produces file changes, the worker commits them, pushes the branch, and opens a PR.
5. The PR description includes a detailed summary of the approach, a file-by-file changelog, diff stats, and the full SQL content of any database migrations (ready to copy/paste into Supabase).
6. The issue is labeled `ai-done` on success or `ai-failed` on error (with a comment explaining what went wrong).

Jobs run concurrently (up to `MAX_CONCURRENT`) in isolated git worktrees. When multiple repos have pending work, the dispatcher uses **interleaved round-robin scheduling** — one job from each repo per pass — so no single repo can starve the others.

## Prerequisites

- **Node.js** >= 20
- **Claude Code** CLI installed and available on `$PATH` (`claude`)
- **GitHub CLI** (`gh`) installed and authenticated
- A **GitHub personal access token** with repo access

## Setup

```bash
git clone <this-repo> && cd agatha
npm install
cp env.example .env
cp repos.example.json repos.json
```

### 1. Environment variables

Edit `.env`:

| Variable | Description | Required |
|---|---|---|
| `GITHUB_TOKEN` | Default GitHub PAT — used for any repo in `repos.json` that doesn't set its own `token` | Yes* |
| `REPOS_CONFIG_PATH` | Path to the multi-repo config file (default: `./repos.json`) | No |
| `POLL_MS` | Polling interval in milliseconds (default: `30000`) | No |
| `MAX_CONCURRENT` | Max concurrent jobs across all repos (default: `3`) | No |

\* `GITHUB_TOKEN` is optional if every repo in `repos.json` has its own `token` field.

### 2. Multi-repo config (`repos.json`)

`repos.json` is a JSON array listing every repo the worker should watch. Each entry can target a different owner/org, and can optionally override the GitHub token (e.g. if repos live in different organizations and you need a separate PAT for each).

```json
[
  {
    "owner": "your-org",
    "repo": "your-repo-one",
    "path": "/Users/yourname/code/your-repo-one",
    "baseBranch": "main"
  },
  {
    "owner": "another-org",
    "repo": "another-repo",
    "path": "/Users/yourname/code/another-repo",
    "baseBranch": "develop",
    "token": "ghp_optional_override_token_for_this_repo"
  }
]
```

| Field | Required | Description |
|---|---|---|
| `owner` | Yes | GitHub user or org that owns the repo |
| `repo` | Yes | Repo name |
| `path` | Yes | Absolute path to a local clone of the repo |
| `baseBranch` | No | Branch to base work off (default: `main`) |
| `token` | No | Per-repo GitHub PAT; falls back to `GITHUB_TOKEN` if omitted |
| `persona` | No | Engineer framing for this repo (e.g. `"a senior Go engineer working in a microservices backend"`). Defaults to a TypeScript/React/Vercel persona. Tip: for anything richer than a one-liner, put it in the target repo's `CLAUDE.md` — Claude Code picks that up automatically. |

**Before starting the worker**, make sure each `path` points at a clean clone checked out on its `baseBranch`. The worker creates worktrees under `<path>/../.ai-worktrees/` for each repo, so the main clone stays untouched.

> `repos.json` is gitignored — commit `repos.example.json` if you want to share the schema.

## Usage

Development (with hot reload):

```bash
npm run dev
```

Production:

```bash
npm run build
npm start
```

The worker runs in a loop — leave it running and it will pick up new `ai-task` issues as they appear.

## Creating Tasks

1. Open an issue in any repo listed in `repos.json`.
2. Write a clear title and description of the feature or bug fix.
3. Add the `ai-task` label.

The worker will pick it up on the next poll cycle. Jobs are namespaced per repo (`${owner}/${repo}:issue-${number}`), so issues with the same number in different repos never collide.

### Setting Up an Issue Template

To make it easy for contributors to create AI tasks with the right label and structure, add a GitHub issue template to your target repo.

1. Create the file `.github/ISSUE_TEMPLATE/ai-task.yml` in the target repository.
2. Paste the following contents:

```yaml
name: Feature Request (AI)
description: Request a feature to be built by the AI agent
title: "[AI] "
labels: ["ai-task"]

body:
  - type: textarea
    id: description
    attributes:
      label: Feature Description
      description: Clearly describe the feature
      placeholder: Add event capacity and prevent overbooking
    validations:
      required: true

  - type: textarea
    id: requirements
    attributes:
      label: Requirements
      description: Acceptance criteria
      placeholder: |
        - Add capacity field to event
        - Prevent overbooking
        - Show error in UI
```

3. Commit and push. A new "Feature Request (AI)" option will now appear when anyone opens an issue, pre-labeled with `ai-task`.

## PR Feedback Comments

Once Agatha opens a PR, you can ask it to make follow-up changes by commenting directly on the PR.

### How It Works

1. On any open PR created by the worker, leave a comment starting with `/agatha` followed by your feedback. For example:

   ```
   /agatha rename the `getUsers` function to `fetchActiveUsers` and add a JSDoc comment
   ```

2. The worker reacts with 👀 and comments that it's working on the feedback.
3. It checks out the PR branch, sends your feedback to Claude Code, commits any resulting changes, and pushes to the same branch.
4. When done, it replies with a summary and diff stats (or notes if no changes were needed).

### Tips

- One piece of feedback per comment works best — keep instructions focused.
- The worker processes one comment at a time per poll cycle. If you leave multiple comments, they'll be handled in order.
- If something goes wrong, the worker replies with the error details so you can adjust and try again.

## Labels

| Label | Meaning |
|---|---|
| `ai-task` | Issue is ready for the worker to pick up |
| `ai-running` | Worker is actively processing the issue |
| `ai-done` | PR has been created successfully |
| `ai-failed` | Something went wrong (check the issue comment for details) |

## PR Output

Each generated PR includes:

- **Approach** — explanation of the technical strategy
- **Changes** — file-by-file breakdown
- **Diff summary** — `git diff --stat` output
- **Database migrations** — full SQL rendered in code blocks for easy copy/paste into Supabase
- **Risks & notes** — edge cases or things to watch for during review


## Temporal Mode (Alternative)

Instead of the built-in poll-and-dispatch loop, you can run Agatha on top of [Temporal.io](https://temporal.io/) for durable execution, crash recovery, built-in retry, and a web UI for monitoring running jobs.

### Prerequisites

Everything from the standard setup, plus:

- **Temporal CLI** — `brew install temporal`

### Quick Start

```bash
# Terminal 1 — start a local Temporal dev server
temporal server start-dev
```

This starts the Temporal server on `localhost:7233` and a Web UI at [http://localhost:8233](http://localhost:8233).

```bash
# Terminal 2 — start the Temporal worker (executes workflows and activities)
npm run temporal:dev:worker

# Terminal 3 — start the GitHub poller (detects work and starts workflows)
npm run temporal:dev:poller
```

### How It Works

The Temporal mode splits the original worker into two processes:

1. **Poller** (`temporal/start.ts`) — polls GitHub for labeled issues and `/agatha` comments, then starts Temporal workflow executions with deterministic IDs (e.g. `plan-42`, `issue-42`). Temporal deduplicates by workflow ID, so no in-memory tracking is needed.

2. **Worker** (`temporal/worker.ts`) — runs the Temporal Worker which executes workflows and activities. Each job (plan, implement, PR feedback) is a workflow that creates a git worktree, runs Claude, and cleans up. Long-running Claude activities heartbeat every 30 seconds so Temporal can detect stalls.

Both the poller and the worker read `repos.json` at startup and the per-repo config is passed through every workflow and activity, so a single Temporal worker process serves all repos.

### Configuration

Add these to your `.env` (all optional — defaults shown):

| Variable | Default | Description |
|---|---|---|
| `TEMPORAL_ADDRESS` | `localhost:7233` | Temporal server gRPC address |
| `TEMPORAL_NAMESPACE` | `default` | Temporal namespace |
| `TEMPORAL_TASK_QUEUE` | `agatha-github` | Task queue name |

Temporal mode reads the same `repos.json` as the standard worker. The other shared variables (`GITHUB_TOKEN`, `MAX_CONCURRENT`, `POLL_MS`, `REPOS_CONFIG_PATH`) apply to both modes. Workflow IDs are namespaced per repo (e.g. `your-org-your-repo-issue-42`) so the same issue number in different repos produces distinct workflow executions.

### Monitoring

Open [http://localhost:8233](http://localhost:8233) to see the Temporal Web UI. From there you can:

- View running and completed workflows
- Inspect workflow history and activity inputs/outputs
- Terminate or cancel stuck workflows
- Search workflows by ID or type

### Production with PM2

```bash
npm run build
pm2 start ecosystem.config.js
```

This starts the Temporal worker and poller as PM2 processes alongside or instead of the standard worker (see `ecosystem.config.js`).

> **Note:** Do not run the standard worker and Temporal mode simultaneously — they use the same worktree directory and will conflict.

# Running on mac as a persistent worker

To setup an install
```
npm install -g pm2
npm run build
pm2 start ecosystem.config.js
pm2 save
pm2 startup
```

To remove the app
```
pm2 delete agatha-ai
pm2 save --force
```


To view processes running
```
pm2 list
```

To view logs
```
pm2 logs agatha-ai
```