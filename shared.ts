import "dotenv/config";
import { Octokit } from "@octokit/rest";
import { spawn } from "child_process";
import fs from "fs";
import path from "path";

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

export type PlanAgent = "claude" | "codex";

export type IssueLike = {
  number: number;
  title: string;
  body: string | null;
};

export type RepoConfig = {
  owner: string;
  repo: string;
  path: string;
  baseBranch: string;
  token?: string;
  persona?: string;
};

export type RepoContext = {
  config: RepoConfig;
  octokit: Octokit;
  worktreeDir: string;
  key: string;
};

export type PRComment = {
  id: number;
  prNumber: number;
  prTitle: string;
  prBranch: string;
  body: string;
};

export type IssueComment = {
  id: number;
  issueNumber: number;
  issueTitle: string;
  issueBody: string;
  issueLabels: string[];
  body: string;
};

/* ------------------------------------------------------------------ */
/*  Configuration                                                      */
/* ------------------------------------------------------------------ */

export const POLL_MS = Number(process.env.POLL_MS || 30000);
export const MAX_CONCURRENT = Number(process.env.MAX_CONCURRENT || 3);
export const COMMENT_PREFIX = "/agatha";

const DEFAULT_GITHUB_TOKEN = process.env.GITHUB_TOKEN;

export function loadRepoConfigs(): RepoConfig[] {
  const configPath =
    process.env.REPOS_CONFIG_PATH || path.resolve(process.cwd(), "repos.json");

  if (!fs.existsSync(configPath)) {
    throw new Error(
      `Repos config not found at ${configPath}. Create repos.json or set REPOS_CONFIG_PATH.`
    );
  }

  const raw = fs.readFileSync(configPath, "utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `Failed to parse ${configPath}: ${err instanceof Error ? err.message : String(err)}`
    );
  }

  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new Error(
      `${configPath} must be a non-empty JSON array of repo configs.`
    );
  }

  const configs: RepoConfig[] = [];
  for (const entry of parsed) {
    if (
      !entry ||
      typeof entry !== "object" ||
      typeof (entry as any).owner !== "string" ||
      typeof (entry as any).repo !== "string" ||
      typeof (entry as any).path !== "string"
    ) {
      throw new Error(
        `Each repo config must have string "owner", "repo", and "path". Got: ${JSON.stringify(entry)}`
      );
    }
    const e = entry as any;
    if (!path.isAbsolute(e.path)) {
      throw new Error(
        `Repo "${e.owner}/${e.repo}" path must be absolute: ${e.path}`
      );
    }
    configs.push({
      owner: e.owner,
      repo: e.repo,
      path: e.path,
      baseBranch: typeof e.baseBranch === "string" ? e.baseBranch : "main",
      token: typeof e.token === "string" ? e.token : undefined,
      persona: typeof e.persona === "string" ? e.persona : undefined,
    });
  }

  return configs;
}

export function createRepoContext(config: RepoConfig): RepoContext {
  const token = config.token || DEFAULT_GITHUB_TOKEN;
  if (!token) {
    throw new Error(
      `No GitHub token available for ${config.owner}/${config.repo}. Set GITHUB_TOKEN or add a "token" field to the repo entry.`
    );
  }
  return {
    config,
    octokit: new Octokit({ auth: token }),
    worktreeDir: path.join(config.path, "..", ".ai-worktrees"),
    key: `${config.owner}/${config.repo}`,
  };
}

/* ------------------------------------------------------------------ */
/*  Shell helpers                                                      */
/* ------------------------------------------------------------------ */

export function runCommand(
  command: string,
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv = process.env
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (data) => {
      const text = data.toString();
      stdout += text;
      process.stdout.write(text);
    });

    child.stderr.on("data", (data) => {
      const text = data.toString();
      stderr += text;
      process.stderr.write(text);
    });

    child.on("error", reject);

    child.on("close", (code) => {
      if (code === 0) {
        resolve({ stdout, stderr });
      } else {
        reject(
          new Error(
            `${command} ${args.join(" ")} failed with code ${code}\n\nSTDOUT:\n${stdout}\n\nSTDERR:\n${stderr}`
          )
        );
      }
    });
  });
}

function formatPromptForComment(prompt: string): string {
  const truncated = prompt.length > 8000 ? prompt.slice(0, 8000) + "\n\n…(truncated)" : prompt;
  return [
    "",
    "<details>",
    "<summary>Prompt (for manual run)</summary>",
    "",
    "```",
    truncated,
    "```",
    "",
    "Run manually with:",
    "```bash",
    'echo \'<prompt>\' | claude --permission-mode acceptEdits',
    "```",
    "</details>",
  ].join("\n");
}

export function runClaude(
  prompt: string,
  cwd: string,
  options?: { onHeartbeat?: () => void }
): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn("claude", ["--permission-mode", "acceptEdits"], {
      cwd,
      env: process.env,
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";

    let heartbeatInterval: ReturnType<typeof setInterval> | undefined;
    if (options?.onHeartbeat) {
      heartbeatInterval = setInterval(options.onHeartbeat, 30_000);
    }

    child.stdout.on("data", (data) => {
      const text = data.toString();
      stdout += text;
      process.stdout.write(text);
    });

    child.stderr.on("data", (data) => {
      const text = data.toString();
      stderr += text;
      process.stderr.write(text);
    });

    child.on("error", (err) => {
      if (heartbeatInterval) clearInterval(heartbeatInterval);
      reject(err);
    });

    child.on("close", (code) => {
      if (heartbeatInterval) clearInterval(heartbeatInterval);
      if (code === 0) {
        resolve();
      } else {
        reject(
          new Error(
            `claude failed with code ${code}\n\nSTDOUT:\n${stdout}\n\nSTDERR:\n${stderr}`
          )
        );
      }
    });

    child.stdin.write(prompt);
    child.stdin.end();
  });
}

export function runCodex(prompt: string, cwd: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn("codex", ["exec", "--full-auto", prompt], {
      cwd,
      env: process.env,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (data) => {
      const text = data.toString();
      stdout += text;
      process.stdout.write(text);
    });

    child.stderr.on("data", (data) => {
      const text = data.toString();
      stderr += text;
      process.stderr.write(text);
    });

    child.on("error", reject);

    child.on("close", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(
          new Error(
            `codex failed with code ${code}\n\nSTDOUT:\n${stdout}\n\nSTDERR:\n${stderr}`
          )
        );
      }
    });
  });
}

export function runPlanAgent(
  agent: PlanAgent,
  prompt: string,
  cwd: string
): Promise<void> {
  if (agent === "codex") return runCodex(prompt, cwd);
  return runClaude(prompt, cwd);
}

export function detectPlanAgent(labels: string[]): PlanAgent {
  if (labels.includes("codex")) return "codex";
  return "claude";
}

/* ------------------------------------------------------------------ */
/*  Clone helper                                                       */
/* ------------------------------------------------------------------ */

export async function ensureRepoCloned(ctx: RepoContext): Promise<void> {
  const repoPath = ctx.config.path;
  const gitDir = path.join(repoPath, ".git");

  if (fs.existsSync(gitDir)) return;

  if (fs.existsSync(repoPath)) {
    throw new Error(
      `${ctx.key}: path ${repoPath} exists but is not a git repository. Remove it or pick a different path.`
    );
  }

  const token = ctx.config.token || DEFAULT_GITHUB_TOKEN;
  if (!token) {
    throw new Error(
      `${ctx.key}: no token available to clone. Set GITHUB_TOKEN or add "token" to the repo config.`
    );
  }

  const parentDir = path.dirname(repoPath);
  fs.mkdirSync(parentDir, { recursive: true });

  const cloneUrl = `https://x-access-token:${token}@github.com/${ctx.config.owner}/${ctx.config.repo}.git`;
  const cleanUrl = `https://github.com/${ctx.config.owner}/${ctx.config.repo}.git`;

  console.log(`Cloning ${ctx.key} into ${repoPath}…`);

  try {
    await runCommand("git", ["clone", cloneUrl, repoPath], parentDir);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(
      `Failed to clone ${ctx.key}: ${message.split(token).join("***")}`
    );
  }

  // Strip the embedded token from .git/config so subsequent fetch/push
  // use the user's existing git credential setup (gh auth, keychain, etc.)
  await runCommand(
    "git",
    ["remote", "set-url", "origin", cleanUrl],
    repoPath
  );
}

/* ------------------------------------------------------------------ */
/*  Git worktree helpers                                               */
/* ------------------------------------------------------------------ */

export function worktreePath(ctx: RepoContext, name: string): string {
  return path.join(ctx.worktreeDir, name);
}

export async function createWorktree(
  ctx: RepoContext,
  name: string,
  ref: string,
  newBranch?: string
): Promise<string> {
  const wtPath = worktreePath(ctx, name);

  await runCommand("git", ["worktree", "prune"], ctx.config.path);

  try {
    await runCommand(
      "git",
      ["worktree", "remove", "--force", wtPath],
      ctx.config.path
    );
  } catch {
    // Doesn't exist — that's fine
  }

  fs.mkdirSync(ctx.worktreeDir, { recursive: true });

  const args = ["worktree", "add"];
  if (newBranch) {
    args.push("-B", newBranch);
  } else {
    args.push("--detach");
  }
  args.push(wtPath, ref);

  await runCommand("git", args, ctx.config.path);
  return wtPath;
}

export async function removeWorktree(
  ctx: RepoContext,
  name: string
): Promise<void> {
  try {
    await runCommand(
      "git",
      ["worktree", "remove", "--force", worktreePath(ctx, name)],
      ctx.config.path
    );
  } catch {
    // Ignore — may already be gone
  }
}

export async function cleanupWorktrees(ctx: RepoContext): Promise<void> {
  await runCommand("git", ["worktree", "prune"], ctx.config.path);
  try {
    const entries = fs.readdirSync(ctx.worktreeDir);
    for (const entry of entries) {
      try {
        await runCommand(
          "git",
          ["worktree", "remove", "--force", path.join(ctx.worktreeDir, entry)],
          ctx.config.path
        );
      } catch {
        // Ignore
      }
    }
  } catch {
    // Directory doesn't exist yet — that's fine
  }
}

/* ------------------------------------------------------------------ */
/*  String helpers                                                     */
/* ------------------------------------------------------------------ */

export function safeBranchName(issueNumber: number): string {
  return `ai/issue-${issueNumber}`;
}

export function sanitizeCommitMessage(input: string): string {
  return input.replace(/\s+/g, " ").trim().slice(0, 180);
}

/* ------------------------------------------------------------------ */
/*  Prompt builders                                                    */
/* ------------------------------------------------------------------ */

export const DEFAULT_PERSONA =
  "a senior TypeScript engineer working in an existing React + TypeScript application deployed on Vercel";

function personaIntro(persona: string | undefined): string {
  return `You are ${persona || DEFAULT_PERSONA}.`;
}

export function buildClaudePrompt(
  issueTitle: string,
  issueBody: string,
  persona?: string
): string {
  return `
${personaIntro(persona)}

Your task is to implement the GitHub issue below.

ISSUE TITLE:
${issueTitle}

ISSUE BODY:
${issueBody}

Rules:
- Follow existing repository patterns and conventions.
- Make the minimum set of changes necessary.
- Do not refactor unrelated code.
- Update frontend and backend as needed.
- Preserve type safety.
- Run the relevant validation commands before finishing.
- If tests exist for the touched area, update or add them.
- Do not create a pull request.
- Do not push to git.
- Do not change git remotes.
- At the end, stop after code and local validation are complete.

Before editing:
1. Inspect the codebase and identify the files likely involved.
2. Make a short implementation plan.
3. Then implement.

Before finishing:
- Run build, typecheck, and tests as appropriate for this repo.
- Write a file called ".ai-summary.md" at the repo root with the following sections:
  ## Approach
  A clear explanation of the technical approach you chose and why.
  ## Changes
  A file-by-file breakdown of what was changed and why.
  ## Database Migrations
  If any database migrations were created or modified, list them here with a brief description. Otherwise write "None".
  ## Risks & Notes
  Any risks, edge cases, or things the reviewer should pay attention to.
`.trim();
}

export function buildFeedbackPrompt(
  prTitle: string,
  feedbackBody: string,
  persona?: string
): string {
  return `
${personaIntro(persona)}

You previously opened a PR with the following title:
${prTitle}

A reviewer has left the following feedback on your PR:

---
${feedbackBody}
---

Rules:
- Follow existing repository patterns and conventions.
- Make the minimum set of changes necessary to address the feedback.
- Do not refactor unrelated code.
- Preserve type safety.
- Run the relevant validation commands before finishing.
- If tests exist for the touched area, update or add them.
- Do not create a pull request.
- Do not push to git.
- Do not change git remotes.
- At the end, stop after code and local validation are complete.

Before editing:
1. Inspect the codebase and the current diff to understand the existing changes.
2. Make a short plan for addressing the feedback.
3. Then implement.

Before finishing:
- Run build, typecheck, and tests as appropriate for this repo.
- Write a file called ".ai-summary.md" at the repo root with the following sections:
  ## Feedback Addressed
  A summary of the reviewer feedback and how you addressed it.
  ## Changes
  A file-by-file breakdown of what was changed and why.
  ## Risks & Notes
  Any risks, edge cases, or things the reviewer should pay attention to.

## PR Description Updates
If the feedback asks you to update the PR description (title, body, or summary) rather than
change code, write a file called ".ai-pr-update.md" at the repo root. The file format is:

TITLE: <new PR title, or leave blank to keep the current title>

<new PR body in markdown>

Only write this file when the feedback is specifically about the PR description, not code.
You may write both code changes AND a PR description update if the feedback asks for both.
`.trim();
}

export function buildPlanPrompt(
  issueTitle: string,
  issueBody: string,
  persona?: string
): string {
  return `
${personaIntro(persona)}

Your task is to create a detailed implementation plan for the GitHub issue below. Do NOT implement anything — only plan.

ISSUE TITLE:
${issueTitle}

ISSUE BODY:
${issueBody}

Rules:
- Inspect the codebase thoroughly before planning.
- Follow existing repository patterns and conventions.
- Do not create, edit, or delete any source files.
- Do not create a pull request or push to git.

Create a plan and write it to a file called ".ai-plan.md" at the repo root with the following sections:

## Summary
A brief overview of what needs to be done and the overall approach.

## Files to Change
A list of files that will need to be created, modified, or deleted, with a brief description of the changes for each.

## Implementation Steps
A numbered list of concrete implementation steps in the order they should be executed. Each step should be specific enough that an engineer (or AI) could follow it without ambiguity.

## Database Migrations
If any database migrations are needed, describe them here. Otherwise write "None".

## Testing Strategy
How the changes should be tested — which existing tests to update, any new tests to add.

## Risks & Open Questions
Any risks, edge cases, ambiguities, or decisions that need human input before implementation.
`.trim();
}

export function buildPlanRevisionPrompt(
  issueTitle: string,
  issueBody: string,
  currentPlan: string,
  feedback: string,
  persona?: string
): string {
  return `
${personaIntro(persona)}

You previously created an implementation plan for the GitHub issue below. A reviewer has provided feedback on the plan. Update the plan accordingly.

ISSUE TITLE:
${issueTitle}

ISSUE BODY:
${issueBody}

CURRENT PLAN:
${currentPlan}

REVIEWER FEEDBACK:
${feedback}

Rules:
- Inspect the codebase as needed to address the feedback.
- Follow existing repository patterns and conventions.
- Do not create, edit, or delete any source files (only update the plan).
- Do not create a pull request or push to git.

Write the updated plan to ".ai-plan.md" at the repo root, keeping the same sections:
## Summary, ## Files to Change, ## Implementation Steps, ## Database Migrations, ## Testing Strategy, ## Risks & Open Questions
`.trim();
}

/* ------------------------------------------------------------------ */
/*  GitHub helpers                                                     */
/* ------------------------------------------------------------------ */

export async function addLabel(
  ctx: RepoContext,
  issueNumber: number,
  label: string
): Promise<void> {
  await ctx.octokit.issues.addLabels({
    owner: ctx.config.owner,
    repo: ctx.config.repo,
    issue_number: issueNumber,
    labels: [label],
  });
}

export async function removeLabel(
  ctx: RepoContext,
  issueNumber: number,
  label: string
): Promise<void> {
  try {
    await ctx.octokit.issues.removeLabel({
      owner: ctx.config.owner,
      repo: ctx.config.repo,
      issue_number: issueNumber,
      name: label,
    });
  } catch {
    // Ignore if label does not exist.
  }
}

export async function comment(
  ctx: RepoContext,
  issueNumber: number,
  body: string
): Promise<void> {
  await ctx.octokit.issues.createComment({
    owner: ctx.config.owner,
    repo: ctx.config.repo,
    issue_number: issueNumber,
    body,
  });
}

export async function reactToComment(
  ctx: RepoContext,
  commentId: number,
  reaction: "+1" | "eyes" | "rocket"
): Promise<void> {
  await ctx.octokit.reactions.createForIssueComment({
    owner: ctx.config.owner,
    repo: ctx.config.repo,
    comment_id: commentId,
    content: reaction,
  });
}

export async function markInProgress(
  ctx: RepoContext,
  issueNumber: number
): Promise<void> {
  await addLabel(ctx, issueNumber, "ai-running");
  await removeLabel(ctx, issueNumber, "ai-task");
  await removeLabel(ctx, issueNumber, "ai-failed");
}

export async function markFailed(
  ctx: RepoContext,
  issueNumber: number
): Promise<void> {
  await addLabel(ctx, issueNumber, "ai-failed");
  await removeLabel(ctx, issueNumber, "ai-running");
}

export async function markDone(
  ctx: RepoContext,
  issueNumber: number
): Promise<void> {
  await addLabel(ctx, issueNumber, "ai-done");
  await removeLabel(ctx, issueNumber, "ai-running");
}

/* ------------------------------------------------------------------ */
/*  Plan extraction                                                    */
/* ------------------------------------------------------------------ */

export function extractPlanFromComment(body: string): string {
  const header = "## 📋 Implementation Plan\n\n";
  const revisedHeader = "## 📋 Implementation Plan (Revised)\n\n";
  let planStart: number;

  if (body.includes(revisedHeader)) {
    planStart = body.indexOf(revisedHeader) + revisedHeader.length;
  } else if (body.includes(header)) {
    planStart = body.indexOf(header) + header.length;
  } else {
    return "";
  }

  const planEnd = body.lastIndexOf("\n\n---\n");
  return planEnd > planStart ? body.slice(planStart, planEnd) : body.slice(planStart);
}

export async function findLatestPlan(
  ctx: RepoContext,
  issueNumber: number
): Promise<string> {
  const comments = await ctx.octokit.issues.listComments({
    owner: ctx.config.owner,
    repo: ctx.config.repo,
    issue_number: issueNumber,
    per_page: 100,
  });

  for (const c of [...comments.data].reverse()) {
    if (c.body && c.body.includes("## 📋 Implementation Plan")) {
      const plan = extractPlanFromComment(c.body);
      if (plan) return plan;
    }
  }
  return "";
}

/* ------------------------------------------------------------------ */
/*  Work item collectors                                               */
/* ------------------------------------------------------------------ */

export async function getPendingPlanComments(
  ctx: RepoContext,
  processedCommentIds: Set<number>
): Promise<IssueComment[]> {
  const issues = await ctx.octokit.issues.listForRepo({
    owner: ctx.config.owner,
    repo: ctx.config.repo,
    state: "open",
    labels: "ai-planned",
    per_page: 50,
  });

  const pending: IssueComment[] = [];

  for (const issue of issues.data) {
    if ("pull_request" in issue && issue.pull_request) continue;

    const comments = await ctx.octokit.issues.listComments({
      owner: ctx.config.owner,
      repo: ctx.config.repo,
      issue_number: issue.number,
      per_page: 100,
    });

    for (const c of comments.data) {
      if (
        c.body &&
        c.body.trimStart().startsWith(COMMENT_PREFIX) &&
        !processedCommentIds.has(c.id)
      ) {
        pending.push({
          id: c.id,
          issueNumber: issue.number,
          issueTitle: issue.title,
          issueBody: issue.body || "",
          issueLabels: issue.labels.map((label) =>
            typeof label === "string" ? label : label.name || ""
          ),
          body: c.body.trimStart().slice(COMMENT_PREFIX.length).trim(),
        });
      }
    }
  }

  return pending;
}

export async function getPendingPRComments(
  ctx: RepoContext,
  processedCommentIds: Set<number>
): Promise<PRComment[]> {
  const pulls = await ctx.octokit.pulls.list({
    owner: ctx.config.owner,
    repo: ctx.config.repo,
    state: "open",
    per_page: 50,
  });

  const pending: PRComment[] = [];

  for (const pr of pulls.data) {
    const comments = await ctx.octokit.issues.listComments({
      owner: ctx.config.owner,
      repo: ctx.config.repo,
      issue_number: pr.number,
      per_page: 100,
    });

    for (const c of comments.data) {
      if (
        c.body &&
        c.body.trimStart().startsWith(COMMENT_PREFIX) &&
        !processedCommentIds.has(c.id)
      ) {
        pending.push({
          id: c.id,
          prNumber: pr.number,
          prTitle: pr.title,
          prBranch: pr.head.ref,
          body: c.body.trimStart().slice(COMMENT_PREFIX.length).trim(),
        });
      }
    }
  }

  return pending;
}

/* ------------------------------------------------------------------ */
/*  Process: plan an issue                                             */
/* ------------------------------------------------------------------ */

export async function processPlanIssue(
  ctx: RepoContext,
  issue: IssueLike,
  workDir: string,
  options?: { onHeartbeat?: () => void; agent?: PlanAgent }
): Promise<void> {
  const { number: issueNumber, title: issueTitle, body } = issue;
  const issueBody = body || "";
  const agent = options?.agent ?? "claude";
  const agentName = agent === "codex" ? "Codex" : "Claude";

  await addLabel(ctx, issueNumber, "ai-planning");
  await removeLabel(ctx, issueNumber, "ai-plan");

  await comment(
    ctx,
    issueNumber,
    `🤖 Creating an implementation plan using ${agentName}…`
  );

  const prompt = buildPlanPrompt(issueTitle, issueBody, ctx.config.persona);

  try {
    if (agent === "codex") {
      await runCodex(prompt, workDir);
    } else {
      await runClaude(prompt, workDir, options);
    }

    const planPath = path.join(workDir, ".ai-plan.md");
    let plan = "";
    try {
      plan = fs.readFileSync(planPath, "utf8");
    } catch {
      throw new Error(
        "Claude completed, but no plan file (.ai-plan.md) was generated."
      );
    }

    await comment(
      ctx,
      issueNumber,
      `## 📋 Implementation Plan\n\n${plan}\n\n---\n_Comment \`/agatha <your feedback>\` to revise this plan, or add the \`ai-task\` label to start implementation._`
    );

    await removeLabel(ctx, issueNumber, "ai-planning");
    await addLabel(ctx, issueNumber, "ai-planned");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await comment(
      ctx,
      issueNumber,
      `❌ Failed while creating plan.\n\n\`\`\`\n${message.slice(0, 6000)}\n\`\`\`${formatPromptForComment(prompt)}`
    );
    await removeLabel(ctx, issueNumber, "ai-planning");
    await addLabel(ctx, issueNumber, "ai-failed");
  }
}

/* ------------------------------------------------------------------ */
/*  Process: revise a plan based on feedback                           */
/* ------------------------------------------------------------------ */

export async function processPlanFeedback(
  ctx: RepoContext,
  issueComment: IssueComment,
  workDir: string,
  options?: { onHeartbeat?: () => void; agent?: PlanAgent }
): Promise<void> {
  const { id, issueNumber, issueTitle, issueBody, body } = issueComment;
  const agent = options?.agent ?? "claude";
  const agentName = agent === "codex" ? "Codex" : "Claude";

  await reactToComment(ctx, id, "eyes");
  await comment(
    ctx,
    issueNumber,
    `🤖 Revising the plan using ${agentName} based on your feedback…\n\n> ${body.split("\n")[0]}`
  );

  const currentPlan = await findLatestPlan(ctx, issueNumber);

  if (!currentPlan) {
    await comment(
      ctx,
      issueNumber,
      `⚠️ Could not find an existing plan to revise. Add the \`ai-plan\` label to generate one first.`
    );
    return;
  }

  const prompt = buildPlanRevisionPrompt(
    issueTitle,
    issueBody,
    currentPlan,
    body,
    ctx.config.persona
  );

  try {
    if (agent === "codex") {
      await runCodex(prompt, workDir);
    } else {
      await runClaude(prompt, workDir, options);
    }

    const planPath = path.join(workDir, ".ai-plan.md");
    let plan = "";
    try {
      plan = fs.readFileSync(planPath, "utf8");
    } catch {
      throw new Error(
        "Claude completed, but no updated plan file (.ai-plan.md) was generated."
      );
    }

    await comment(
      ctx,
      issueNumber,
      `## 📋 Implementation Plan (Revised)\n\n${plan}\n\n---\n_Comment \`/agatha <your feedback>\` to revise this plan further, or add the \`ai-task\` label to start implementation._`
    );
    await reactToComment(ctx, id, "rocket");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await comment(
      ctx,
      issueNumber,
      `❌ Failed while revising plan.\n\n\`\`\`\n${message.slice(0, 6000)}\n\`\`\`${formatPromptForComment(prompt)}`
    );
  }
}

/* ------------------------------------------------------------------ */
/*  Process: implement an issue                                        */
/* ------------------------------------------------------------------ */

export async function processIssue(
  ctx: RepoContext,
  issue: IssueLike,
  workDir: string,
  options?: { onHeartbeat?: () => void }
): Promise<void> {
  const { number: issueNumber, title: issueTitle, body } = issue;
  const issueBody = body || "";
  const branch = safeBranchName(issueNumber);
  const baseBranch = ctx.config.baseBranch;

  await markInProgress(ctx, issueNumber);
  await removeLabel(ctx, issueNumber, "ai-planned");

  const existingPlan = await findLatestPlan(ctx, issueNumber);

  await comment(
    ctx,
    issueNumber,
    existingPlan
      ? `🤖 Starting work on \`${branch}\` using the approved plan.`
      : `🤖 Starting work on \`${branch}\``
  );

  const prompt = existingPlan
    ? buildClaudePrompt(
        issueTitle,
        issueBody + "\n\n## Approved Implementation Plan\n\n" + existingPlan,
        ctx.config.persona
      )
    : buildClaudePrompt(issueTitle, issueBody, ctx.config.persona);

  try {
    await runClaude(prompt, workDir, options);

    const diffCheck = await runCommand(
      "git",
      ["status", "--porcelain"],
      workDir
    );
    if (!diffCheck.stdout.trim()) {
      throw new Error("Claude completed, but no file changes were detected.");
    }

    const summaryPath = path.join(workDir, ".ai-summary.md");
    let aiSummary = "";
    try {
      aiSummary = fs.readFileSync(summaryPath, "utf8");
    } catch {
      // Summary wasn't created — we'll build a minimal one from the diff
    }

    const diffStat = await runCommand(
      "git",
      ["diff", "--stat", baseBranch],
      workDir
    );

    const diffFiles = await runCommand(
      "git",
      ["diff", "--name-only", baseBranch],
      workDir
    );
    const changedFiles = diffFiles.stdout.trim().split("\n").filter(Boolean);
    const migrationFiles = changedFiles.filter(
      (f) =>
        f.endsWith(".sql") ||
        f.includes("migration") ||
        f.includes("supabase/migrations")
    );

    let migrationSection = "";
    if (migrationFiles.length > 0) {
      migrationSection = "## 🗄️ Database Migrations\n\n";
      migrationSection +=
        "The following migration files are included. Copy and paste into Supabase as needed:\n\n";
      for (const migFile of migrationFiles) {
        const fullPath = path.join(workDir, migFile);
        try {
          const content = fs.readFileSync(fullPath, "utf8");
          migrationSection += `### \`${migFile}\`\n\n\`\`\`sql\n${content}\n\`\`\`\n\n`;
        } catch {
          migrationSection += `### \`${migFile}\`\n\n_(could not read file)_\n\n`;
        }
      }
    }

    try {
      fs.unlinkSync(summaryPath);
    } catch {
      // Ignore if it doesn't exist
    }

    await runCommand("git", ["add", "."], workDir);
    await runCommand(
      "git",
      ["commit", "-m", `AI: ${sanitizeCommitMessage(issueTitle)}`],
      workDir
    );
    await runCommand(
      "git",
      ["push", "-u", "origin", branch],
      workDir
    );

    const prBody = [
      `Closes #${issueNumber}`,
      "",
      `> 🤖 This PR was generated by the local AI worker using Claude Code.`,
      "",
      aiSummary || `_No detailed summary was generated. Review the diff below._`,
      "",
      "## 📊 Diff Summary",
      "",
      "```",
      diffStat.stdout.trim(),
      "```",
      "",
      migrationSection,
      "---",
      "_Please review the Vercel preview and CI results before merging._",
    ].join("\n");

    const prBodyFile = path.join(workDir, ".ai-pr-body.md");
    fs.writeFileSync(prBodyFile, prBody, "utf8");

    const pr = await runCommand(
      "gh",
      [
        "pr",
        "create",
        "--title",
        issueTitle,
        "--body-file",
        prBodyFile,
        "--base",
        baseBranch,
        "--head",
        branch,
      ],
      workDir
    );

    try {
      fs.unlinkSync(prBodyFile);
    } catch {
      // Ignore cleanup failure.
    }

    await comment(ctx, issueNumber, `✅ PR created:\n\n${pr.stdout}`);
    await markDone(ctx, issueNumber);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await comment(
      ctx,
      issueNumber,
      `❌ Failed while processing this task.\n\n\`\`\`\n${message.slice(0, 6000)}\n\`\`\`${formatPromptForComment(prompt)}`
    );
    await markFailed(ctx, issueNumber);
  }
}

/* ------------------------------------------------------------------ */
/*  Process: PR feedback                                               */
/* ------------------------------------------------------------------ */

export async function processPRComment(
  ctx: RepoContext,
  prComment: PRComment,
  workDir: string,
  options?: { onHeartbeat?: () => void }
): Promise<void> {
  const { id, prNumber, prTitle, prBranch, body } = prComment;

  await reactToComment(ctx, id, "eyes");
  await comment(
    ctx,
    prNumber,
    `🤖 Working on your feedback…\n\n> ${body.split("\n")[0]}`
  );

  const prompt = buildFeedbackPrompt(prTitle, body, ctx.config.persona);

  try {
    await runClaude(prompt, workDir, options);

    const prUpdatePath = path.join(workDir, ".ai-pr-update.md");
    let prUpdated = false;
    try {
      const prUpdateContent = fs.readFileSync(prUpdatePath, "utf8");
      const titleMatch = prUpdateContent.match(/^TITLE:\s*(.*)$/m);
      const newTitle = titleMatch?.[1]?.trim() || undefined;
      const bodyStart = prUpdateContent.indexOf("\n", prUpdateContent.indexOf("TITLE:"));
      const newBody = bodyStart >= 0 ? prUpdateContent.slice(bodyStart + 1).trim() : undefined;

      const updatePayload: Record<string, string> = {};
      if (newTitle) updatePayload.title = newTitle;
      if (newBody) updatePayload.body = newBody;

      if (Object.keys(updatePayload).length > 0) {
        await ctx.octokit.pulls.update({
          owner: ctx.config.owner,
          repo: ctx.config.repo,
          pull_number: prNumber,
          ...updatePayload,
        });
        prUpdated = true;
      }

      fs.unlinkSync(prUpdatePath);
    } catch {
      // No PR update file — that's fine
    }

    const diffCheck = await runCommand(
      "git",
      ["status", "--porcelain"],
      workDir
    );
    const hasCodeChanges = !!diffCheck.stdout.trim();

    if (!hasCodeChanges && !prUpdated) {
      await comment(
        ctx,
        prNumber,
        `⚠️ I reviewed the feedback but found no code changes were needed.`
      );
      return;
    }

    if (!hasCodeChanges && prUpdated) {
      await comment(ctx, prNumber, `✅ I've updated the PR description.`);
      await reactToComment(ctx, id, "rocket");
      return;
    }

    const summaryPath = path.join(workDir, ".ai-summary.md");
    let aiSummary = "";
    try {
      aiSummary = fs.readFileSync(summaryPath, "utf8");
    } catch {
      // Summary wasn't created
    }

    try {
      fs.unlinkSync(summaryPath);
    } catch {
      // Ignore
    }

    const diffStat = await runCommand(
      "git",
      ["diff", "--stat", `origin/${prBranch}`],
      workDir
    );

    await runCommand("git", ["add", "."], workDir);
    await runCommand(
      "git",
      ["commit", "-m", `AI: address feedback on #${prNumber}`],
      workDir
    );
    await runCommand("git", ["push", "origin", prBranch], workDir);

    const responseParts = [
      `✅ I've pushed changes to address your feedback.`,
    ];
    if (prUpdated) {
      responseParts.push("I also updated the PR description.");
    }
    responseParts.push(
      "",
      aiSummary || "_No detailed summary was generated. Review the diff below._",
      "",
      "## 📊 Diff Summary",
      "",
      "```",
      diffStat.stdout.trim(),
      "```"
    );

    await comment(ctx, prNumber, responseParts.join("\n"));
    await reactToComment(ctx, id, "rocket");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await comment(
      ctx,
      prNumber,
      `❌ Failed while addressing feedback.\n\n\`\`\`\n${message.slice(0, 6000)}\n\`\`\`${formatPromptForComment(prompt)}`
    );
  }
}
