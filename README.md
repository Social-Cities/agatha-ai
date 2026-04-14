# Agatha — GitHub Issue Worker

A background worker that monitors a GitHub repository for issues labeled `ai-task`, uses [Claude Code](https://docs.anthropic.com/en/docs/claude-code) to implement the requested changes, and opens a pull request for review.

## How It Works

1. The worker polls the GitHub repo for open issues with the `ai-task` label.
2. When it finds one, it labels the issue `ai-running` and checks out a fresh branch from the base branch.
3. It sends the issue title and body to Claude Code, which reads the codebase, plans an approach, implements the changes, and runs validation (build, typecheck, tests).
4. If Claude produces file changes, the worker commits them, pushes the branch, and opens a PR.
5. The PR description includes a detailed summary of the approach, a file-by-file changelog, diff stats, and the full SQL content of any database migrations (ready to copy/paste into Supabase).
6. The issue is labeled `ai-done` on success or `ai-failed` on error (with a comment explaining what went wrong).

## Prerequisites

- **Node.js** >= 20
- **Claude Code** CLI installed and available on `$PATH` (`claude`)
- **GitHub CLI** (`gh`) installed and authenticated
- A **GitHub personal access token** with repo access

## Setup

```bash
git clone <this-repo> && cd agatha
npm install
cp .env.example .env
```

Edit `.env` with your values:

| Variable | Description | Required |
|---|---|---|
| `GITHUB_TOKEN` | GitHub personal access token with repo scope | Yes |
| `GITHUB_OWNER` | Repository owner (user or org) | Yes |
| `GITHUB_REPO` | Repository name | Yes |
| `REPO_PATH` | Absolute path to a local clone of the target repo | Yes |
| `BASE_BRANCH` | Branch to base work off of (default: `main`) | No |
| `POLL_MS` | Polling interval in milliseconds (default: `30000`) | No |

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

1. Open an issue in the target repository.
2. Write a clear title and description of the feature or bug fix.
3. Add the `ai-task` label.

The worker will pick it up on the next poll cycle.

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

### Configuration

Add these to your `.env` (all optional — defaults shown):

| Variable | Default | Description |
|---|---|---|
| `TEMPORAL_ADDRESS` | `localhost:7233` | Temporal server gRPC address |
| `TEMPORAL_NAMESPACE` | `default` | Temporal namespace |
| `TEMPORAL_TASK_QUEUE` | `agatha-github` | Task queue name |

The standard variables (`GITHUB_TOKEN`, `REPO_PATH`, `MAX_CONCURRENT`, etc.) are shared between both modes.

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