import "dotenv/config";
import { Octokit } from "@octokit/rest";
import { spawn } from "child_process";
import fs from "fs";
import path from "path";

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

export type IssueLike = {
  number: number;
  title: string;
  body: string | null;
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
  body: string;
};

/* ------------------------------------------------------------------ */
/*  Configuration                                                      */
/* ------------------------------------------------------------------ */

export const octokit = new Octokit({
  auth: process.env.GITHUB_TOKEN,
});

export const OWNER = process.env.GITHUB_OWNER;
export const REPO = process.env.GITHUB_REPO;
export const REPO_PATH = process.env.REPO_PATH;
export const BASE_BRANCH = process.env.BASE_BRANCH || "main";
export const POLL_MS = Number(process.env.POLL_MS || 30000);
export const MAX_CONCURRENT = Number(process.env.MAX_CONCURRENT || 3);
export const WORKTREE_DIR = path.join(REPO_PATH!, "..", ".ai-worktrees");
export const COMMENT_PREFIX = "/agatha";

if (!process.env.GITHUB_TOKEN) {
  throw new Error("Missing GITHUB_TOKEN");
}
if (!OWNER || !REPO || !REPO_PATH) {
  throw new Error("Missing GITHUB_OWNER, GITHUB_REPO, or REPO_PATH");
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

/* ------------------------------------------------------------------ */
/*  Git worktree helpers                                               */
/* ------------------------------------------------------------------ */

export function worktreePath(name: string): string {
  return path.join(WORKTREE_DIR, name);
}

export async function createWorktree(
  name: string,
  ref: string,
  newBranch?: string
): Promise<string> {
  const wtPath = worktreePath(name);

  // Prune stale worktree references (e.g. from a previous crash)
  await runCommand("git", ["worktree", "prune"], REPO_PATH!);

  // Force-remove if this worktree already exists
  try {
    await runCommand(
      "git",
      ["worktree", "remove", "--force", wtPath],
      REPO_PATH!
    );
  } catch {
    // Doesn't exist — that's fine
  }

  fs.mkdirSync(WORKTREE_DIR, { recursive: true });

  const args = ["worktree", "add"];
  if (newBranch) {
    args.push("-B", newBranch);
  } else {
    args.push("--detach");
  }
  args.push(wtPath, ref);

  await runCommand("git", args, REPO_PATH!);
  return wtPath;
}

export async function removeWorktree(name: string): Promise<void> {
  try {
    await runCommand(
      "git",
      ["worktree", "remove", "--force", worktreePath(name)],
      REPO_PATH!
    );
  } catch {
    // Ignore — may already be gone
  }
}

export async function cleanupWorktrees(): Promise<void> {
  await runCommand("git", ["worktree", "prune"], REPO_PATH!);
  try {
    const entries = fs.readdirSync(WORKTREE_DIR);
    for (const entry of entries) {
      try {
        await runCommand(
          "git",
          ["worktree", "remove", "--force", path.join(WORKTREE_DIR, entry)],
          REPO_PATH!
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

export function buildClaudePrompt(issueTitle: string, issueBody: string): string {
  return `
You are a senior TypeScript engineer working in an existing React + TypeScript application deployed on Vercel.

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
  feedbackBody: string
): string {
  return `
You are a senior TypeScript engineer working in an existing React + TypeScript application deployed on Vercel.

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
`.trim();
}

export function buildPlanPrompt(issueTitle: string, issueBody: string): string {
  return `
You are a senior TypeScript engineer working in an existing React + TypeScript application deployed on Vercel.

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
  feedback: string
): string {
  return `
You are a senior TypeScript engineer working in an existing React + TypeScript application deployed on Vercel.

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

export async function addLabel(issueNumber: number, label: string): Promise<void> {
  await octokit.issues.addLabels({
    owner: OWNER!,
    repo: REPO!,
    issue_number: issueNumber,
    labels: [label],
  });
}

export async function removeLabel(issueNumber: number, label: string): Promise<void> {
  try {
    await octokit.issues.removeLabel({
      owner: OWNER!,
      repo: REPO!,
      issue_number: issueNumber,
      name: label,
    });
  } catch {
    // Ignore if label does not exist.
  }
}

export async function comment(issueNumber: number, body: string): Promise<void> {
  await octokit.issues.createComment({
    owner: OWNER!,
    repo: REPO!,
    issue_number: issueNumber,
    body,
  });
}

export async function reactToComment(
  commentId: number,
  reaction: "+1" | "eyes" | "rocket"
): Promise<void> {
  await octokit.reactions.createForIssueComment({
    owner: OWNER!,
    repo: REPO!,
    comment_id: commentId,
    content: reaction,
  });
}

export async function markInProgress(issueNumber: number): Promise<void> {
  await addLabel(issueNumber, "ai-running");
  await removeLabel(issueNumber, "ai-task");
  await removeLabel(issueNumber, "ai-failed");
}

export async function markFailed(issueNumber: number): Promise<void> {
  await addLabel(issueNumber, "ai-failed");
  await removeLabel(issueNumber, "ai-running");
}

export async function markDone(issueNumber: number): Promise<void> {
  await addLabel(issueNumber, "ai-done");
  await removeLabel(issueNumber, "ai-running");
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

export async function findLatestPlan(issueNumber: number): Promise<string> {
  const comments = await octokit.issues.listComments({
    owner: OWNER!,
    repo: REPO!,
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
  processedCommentIds: Set<number>
): Promise<IssueComment[]> {
  const issues = await octokit.issues.listForRepo({
    owner: OWNER!,
    repo: REPO!,
    state: "open",
    labels: "ai-planned",
    per_page: 50,
  });

  const pending: IssueComment[] = [];

  for (const issue of issues.data) {
    if ("pull_request" in issue && issue.pull_request) continue;

    const comments = await octokit.issues.listComments({
      owner: OWNER!,
      repo: REPO!,
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
          body: c.body.trimStart().slice(COMMENT_PREFIX.length).trim(),
        });
      }
    }
  }

  return pending;
}

export async function getPendingPRComments(
  processedCommentIds: Set<number>
): Promise<PRComment[]> {
  const pulls = await octokit.pulls.list({
    owner: OWNER!,
    repo: REPO!,
    state: "open",
    per_page: 50,
  });

  const pending: PRComment[] = [];

  for (const pr of pulls.data) {
    const comments = await octokit.issues.listComments({
      owner: OWNER!,
      repo: REPO!,
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
  issue: IssueLike,
  workDir: string,
  options?: { onHeartbeat?: () => void }
): Promise<void> {
  const { number: issueNumber, title: issueTitle, body } = issue;
  const issueBody = body || "";

  await addLabel(issueNumber, "ai-planning");
  await removeLabel(issueNumber, "ai-plan");

  await comment(issueNumber, `🤖 Creating an implementation plan…`);

  const prompt = buildPlanPrompt(issueTitle, issueBody);

  try {
    await runClaude(prompt, workDir, options);

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
      issueNumber,
      `## 📋 Implementation Plan\n\n${plan}\n\n---\n_Comment \`/agatha <your feedback>\` to revise this plan, or add the \`ai-task\` label to start implementation._`
    );

    await removeLabel(issueNumber, "ai-planning");
    await addLabel(issueNumber, "ai-planned");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await comment(
      issueNumber,
      `❌ Failed while creating plan.\n\n\`\`\`\n${message.slice(0, 6000)}\n\`\`\``
    );
    await removeLabel(issueNumber, "ai-planning");
    await addLabel(issueNumber, "ai-failed");
  }
}

/* ------------------------------------------------------------------ */
/*  Process: revise a plan based on feedback                           */
/* ------------------------------------------------------------------ */

export async function processPlanFeedback(
  issueComment: IssueComment,
  workDir: string,
  options?: { onHeartbeat?: () => void }
): Promise<void> {
  const { id, issueNumber, issueTitle, issueBody, body } = issueComment;

  await reactToComment(id, "eyes");
  await comment(
    issueNumber,
    `🤖 Revising the plan based on your feedback…\n\n> ${body.split("\n")[0]}`
  );

  const currentPlan = await findLatestPlan(issueNumber);

  if (!currentPlan) {
    await comment(
      issueNumber,
      `⚠️ Could not find an existing plan to revise. Add the \`ai-plan\` label to generate one first.`
    );
    return;
  }

  const prompt = buildPlanRevisionPrompt(
    issueTitle,
    issueBody,
    currentPlan,
    body
  );

  try {
    await runClaude(prompt, workDir, options);

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
      issueNumber,
      `## 📋 Implementation Plan (Revised)\n\n${plan}\n\n---\n_Comment \`/agatha <your feedback>\` to revise this plan further, or add the \`ai-task\` label to start implementation._`
    );
    await reactToComment(id, "rocket");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await comment(
      issueNumber,
      `❌ Failed while revising plan.\n\n\`\`\`\n${message.slice(0, 6000)}\n\`\`\``
    );
  }
}

/* ------------------------------------------------------------------ */
/*  Process: implement an issue                                        */
/* ------------------------------------------------------------------ */

export async function processIssue(
  issue: IssueLike,
  workDir: string,
  options?: { onHeartbeat?: () => void }
): Promise<void> {
  const { number: issueNumber, title: issueTitle, body } = issue;
  const issueBody = body || "";
  const branch = safeBranchName(issueNumber);

  await markInProgress(issueNumber);
  await removeLabel(issueNumber, "ai-planned");

  // Check if there's an existing plan from the ai-plan workflow
  const existingPlan = await findLatestPlan(issueNumber);

  await comment(
    issueNumber,
    existingPlan
      ? `🤖 Starting work on \`${branch}\` using the approved plan.`
      : `🤖 Starting work on \`${branch}\``
  );

  const prompt = existingPlan
    ? buildClaudePrompt(
        issueTitle,
        issueBody + "\n\n## Approved Implementation Plan\n\n" + existingPlan
      )
    : buildClaudePrompt(issueTitle, issueBody);

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

    // Read the AI summary if it was generated
    const summaryPath = path.join(workDir, ".ai-summary.md");
    let aiSummary = "";
    try {
      aiSummary = fs.readFileSync(summaryPath, "utf8");
    } catch {
      // Summary wasn't created — we'll build a minimal one from the diff
    }

    // Get diff stats for the PR description
    const diffStat = await runCommand(
      "git",
      ["diff", "--stat", BASE_BRANCH],
      workDir
    );

    // Find migration files and read their contents
    const diffFiles = await runCommand(
      "git",
      ["diff", "--name-only", BASE_BRANCH],
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

    // Remove the summary file before committing
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
        BASE_BRANCH,
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

    await comment(issueNumber, `✅ PR created:\n\n${pr.stdout}`);
    await markDone(issueNumber);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await comment(
      issueNumber,
      `❌ Failed while processing this task.\n\n\`\`\`\n${message.slice(0, 6000)}\n\`\`\``
    );
    await markFailed(issueNumber);
  }
}

/* ------------------------------------------------------------------ */
/*  Process: PR feedback                                               */
/* ------------------------------------------------------------------ */

export async function processPRComment(
  prComment: PRComment,
  workDir: string,
  options?: { onHeartbeat?: () => void }
): Promise<void> {
  const { id, prNumber, prTitle, prBranch, body } = prComment;

  await reactToComment(id, "eyes");
  await comment(
    prNumber,
    `🤖 Working on your feedback…\n\n> ${body.split("\n")[0]}`
  );

  const prompt = buildFeedbackPrompt(prTitle, body);

  try {
    await runClaude(prompt, workDir, options);

    const diffCheck = await runCommand(
      "git",
      ["status", "--porcelain"],
      workDir
    );
    if (!diffCheck.stdout.trim()) {
      await comment(
        prNumber,
        `⚠️ I reviewed the feedback but found no code changes were needed.`
      );
      return;
    }

    // Read the AI summary if it was generated
    const summaryPath = path.join(workDir, ".ai-summary.md");
    let aiSummary = "";
    try {
      aiSummary = fs.readFileSync(summaryPath, "utf8");
    } catch {
      // Summary wasn't created
    }

    // Remove the summary file before committing
    try {
      fs.unlinkSync(summaryPath);
    } catch {
      // Ignore
    }

    // Get diff stats
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

    const responseBody = [
      `✅ I've pushed changes to address your feedback.`,
      "",
      aiSummary || "_No detailed summary was generated. Review the diff below._",
      "",
      "## 📊 Diff Summary",
      "",
      "```",
      diffStat.stdout.trim(),
      "```",
    ].join("\n");

    await comment(prNumber, responseBody);
    await reactToComment(id, "rocket");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await comment(
      prNumber,
      `❌ Failed while addressing feedback.\n\n\`\`\`\n${message.slice(0, 6000)}\n\`\`\``
    );
  }
}
