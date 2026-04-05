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
