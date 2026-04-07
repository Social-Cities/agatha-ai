import "dotenv/config";
import { Octokit } from "@octokit/rest";
import { spawn } from "child_process";
import fs from "fs";
import path from "path";

type IssueLike = {
  number: number;
  title: string;
  body: string | null;
};

type PRComment = {
  id: number;
  prNumber: number;
  prTitle: string;
  prBranch: string;
  body: string;
};

const octokit = new Octokit({
  auth: process.env.GITHUB_TOKEN,
});

const OWNER = process.env.GITHUB_OWNER;
const REPO = process.env.GITHUB_REPO;
const REPO_PATH = process.env.REPO_PATH;
const BASE_BRANCH = process.env.BASE_BRANCH || "main";
const POLL_MS = Number(process.env.POLL_MS || 30000);

if (!process.env.GITHUB_TOKEN) {
  throw new Error("Missing GITHUB_TOKEN");
}
if (!OWNER || !REPO || !REPO_PATH) {
  throw new Error("Missing GITHUB_OWNER, GITHUB_REPO, or REPO_PATH");
}

function runCommand(
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

function runClaude(prompt: string, cwd: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn("claude", ["--permission-mode", "acceptEdits"], {
      cwd,
      env: process.env,
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
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
            `claude failed with code ${code}\n\nSTDOUT:\n${stdout}\n\nSTDERR:\n${stderr}`
          )
        );
      }
    });

    child.stdin.write(prompt);
    child.stdin.end();
  });
}

function safeBranchName(issueNumber: number): string {
  return `ai/issue-${issueNumber}`;
}

function sanitizeCommitMessage(input: string): string {
  return input.replace(/\s+/g, " ").trim().slice(0, 180);
}

function buildFeedbackPrompt(
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

function buildClaudePrompt(issueTitle: string, issueBody: string): string {
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

async function addLabel(issueNumber: number, label: string): Promise<void> {
  await octokit.issues.addLabels({
    owner: OWNER!,
    repo: REPO!,
    issue_number: issueNumber,
    labels: [label],
  });
}

async function removeLabel(issueNumber: number, label: string): Promise<void> {
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

async function comment(issueNumber: number, body: string): Promise<void> {
  await octokit.issues.createComment({
    owner: OWNER!,
    repo: REPO!,
    issue_number: issueNumber,
    body,
  });
}

async function markInProgress(issueNumber: number): Promise<void> {
  await addLabel(issueNumber, "ai-running");
  await removeLabel(issueNumber, "ai-task");
  await removeLabel(issueNumber, "ai-failed");
}

async function markFailed(issueNumber: number): Promise<void> {
  await addLabel(issueNumber, "ai-failed");
  await removeLabel(issueNumber, "ai-running");
}

async function markDone(issueNumber: number): Promise<void> {
  await addLabel(issueNumber, "ai-done");
  await removeLabel(issueNumber, "ai-running");
}

async function processIssue(issue: IssueLike): Promise<void> {
  const issueNumber = issue.number;
  const issueTitle = issue.title;
  const issueBody = issue.body || "";
  const branch = safeBranchName(issueNumber);
  const promptFile = path.join(REPO_PATH!, `.ai-issue-${issueNumber}.md`);

  await markInProgress(issueNumber);
  await comment(issueNumber, `🤖 Starting work on \`${branch}\``);

  const prompt = buildClaudePrompt(issueTitle, issueBody);
  fs.writeFileSync(promptFile, prompt, "utf8");

  try {
    await runCommand("git", ["fetch", "origin"], REPO_PATH!);
    await runCommand("git", ["checkout", BASE_BRANCH], REPO_PATH!);
    await runCommand("git", ["pull", "origin", BASE_BRANCH], REPO_PATH!);
    await runCommand("git", ["reset", "--hard", `origin/${BASE_BRANCH}`], REPO_PATH!);
    await runCommand("git", ["clean", "-fd"], REPO_PATH!);

    await runCommand("git", ["checkout", "-B", branch], REPO_PATH!);

    await runClaude(prompt, REPO_PATH!);

    const diffCheck = await runCommand("git", ["status", "--porcelain"], REPO_PATH!);
    if (!diffCheck.stdout.trim()) {
      throw new Error("Claude completed, but no file changes were detected.");
    }

    // Read the AI summary if it was generated
    const summaryPath = path.join(REPO_PATH!, ".ai-summary.md");
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
      REPO_PATH!
    );

    // Find migration files and read their contents
    const diffFiles = await runCommand(
      "git",
      ["diff", "--name-only", BASE_BRANCH],
      REPO_PATH!
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
        const fullPath = path.join(REPO_PATH!, migFile);
        try {
          const content = fs.readFileSync(fullPath, "utf8");
          migrationSection += `### \`${migFile}\`\n\n\`\`\`sql\n${content}\n\`\`\`\n\n`;
        } catch {
          migrationSection += `### \`${migFile}\`\n\n_(could not read file)_\n\n`;
        }
      }
    }

    // Remove the summary file from the commit
    try {
      fs.unlinkSync(summaryPath);
    } catch {
      // Ignore if it doesn't exist
    }

    await runCommand("git", ["add", "."], REPO_PATH!);
    await runCommand(
      "git",
      ["commit", "-m", `AI: ${sanitizeCommitMessage(issueTitle)}`],
      REPO_PATH!
    );
    await runCommand("git", ["push", "-u", "origin", branch], REPO_PATH!);

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

    const prBodyFile = path.join(REPO_PATH!, ".ai-pr-body.md");
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
      REPO_PATH!
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
  } finally {
    for (const f of [promptFile, path.join(REPO_PATH!, ".ai-summary.md"), path.join(REPO_PATH!, ".ai-pr-body.md")]) {
      try {
        fs.unlinkSync(f);
      } catch {
        // Ignore cleanup failure.
      }
    }
  }
}

const COMMENT_PREFIX = "/agatha-ai";
const processedCommentIds = new Set<number>();

async function reactToComment(commentId: number, reaction: "+1" | "eyes" | "rocket"): Promise<void> {
  await octokit.reactions.createForIssueComment({
    owner: OWNER!,
    repo: REPO!,
    comment_id: commentId,
    content: reaction,
  });
}

async function getPendingPRComments(): Promise<PRComment[]> {
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

async function processPRComment(prComment: PRComment): Promise<void> {
  const { id, prNumber, prTitle, prBranch, body } = prComment;
  processedCommentIds.add(id);

  await reactToComment(id, "eyes");
  await comment(prNumber, `🤖 Working on your feedback…\n\n> ${body.split("\n")[0]}`);

  const prompt = buildFeedbackPrompt(prTitle, body);

  try {
    await runCommand("git", ["fetch", "origin"], REPO_PATH!);
    await runCommand("git", ["checkout", prBranch], REPO_PATH!);
    await runCommand("git", ["pull", "origin", prBranch], REPO_PATH!);
    await runCommand("git", ["reset", "--hard", `origin/${prBranch}`], REPO_PATH!);
    await runCommand("git", ["clean", "-fd"], REPO_PATH!);

    await runClaude(prompt, REPO_PATH!);

    const diffCheck = await runCommand("git", ["status", "--porcelain"], REPO_PATH!);
    if (!diffCheck.stdout.trim()) {
      await comment(prNumber, `⚠️ I reviewed the feedback but found no code changes were needed.`);
      return;
    }

    // Read the AI summary if it was generated
    const summaryPath = path.join(REPO_PATH!, ".ai-summary.md");
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
      REPO_PATH!
    );

    await runCommand("git", ["add", "."], REPO_PATH!);
    await runCommand(
      "git",
      ["commit", "-m", `AI: address feedback on #${prNumber}`],
      REPO_PATH!
    );
    await runCommand("git", ["push", "origin", prBranch], REPO_PATH!);

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
  } finally {
    const summaryPath = path.join(REPO_PATH!, ".ai-summary.md");
    try {
      fs.unlinkSync(summaryPath);
    } catch {
      // Ignore cleanup failure.
    }
  }
}

let running = false;

async function poll(): Promise<void> {
  if (running) return;
  running = true;

  try {
    // Check for PR feedback comments first
    const pendingComments = await getPendingPRComments();
    if (pendingComments.length > 0) {
      await processPRComment(pendingComments[0]);
      return;
    }

    // Then check for new issues
    const issues = await octokit.issues.listForRepo({
      owner: OWNER!,
      repo: REPO!,
      state: "open",
      labels: "ai-task",
      per_page: 20,
    });

    for (const issue of issues.data) {
      const labelNames = issue.labels.map((label) =>
        typeof label === "string" ? label : label.name || ""
      );

      if (labelNames.includes("ai-running")) continue;
      if ("pull_request" in issue && issue.pull_request) continue;

      await processIssue({
        number: issue.number,
        title: issue.title,
        body: issue.body ?? null,
      });

      // Process one job at a time.
      break;
    }
  } finally {
    running = false;
  }
}

setInterval(() => {
  poll().catch((error) => {
    console.error("Poll loop failed:", error);
  });
}, POLL_MS);

poll().catch((error) => {
  console.error("Initial poll failed:", error);
});
