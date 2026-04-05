# GitHub Claude Worker

A tiny worker that polls GitHub issues labeled `ai-task`, asks Claude Code to implement the feature in your local repo, pushes a branch, and opens a PR.

## Files
- `worker.ts` — the worker
- `package.json` — scripts and dependencies
- `tsconfig.json` — TypeScript config
- `.env.example` — environment variables

## Prerequisites
Install these on the MacBook:
- Node.js 20+
- git
- gh
- Claude Code CLI (`claude`)

## Setup
```bash
npm install
cp .env.example .env
```

Fill in `.env`, then export the values into your shell or load them with your process manager.

## Development
```bash
npm run dev
```

## Build and run
```bash
npm run build
npm start
```

## GitHub labels
Create these labels in your repo:
- `ai-task`
- `ai-running`
- `ai-done`
- `ai-failed`

## Suggested flow
1. Create a GitHub issue from your iPad
2. Add the `ai-task` label
3. The worker picks it up
4. Claude Code changes the repo locally
5. The worker commits, pushes, and opens a PR
6. Vercel creates the preview deployment from the PR
