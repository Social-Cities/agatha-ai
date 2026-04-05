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
- Summarize what changed and any risks remaining.
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

    await runCommand("git", ["add", "."], REPO_PATH!);
    await runCommand(
      "git",
      ["commit", "-m", `AI: ${sanitizeCommitMessage(issueTitle)}`],
      REPO_PATH!
    );
    await runCommand("git", ["push", "-u", "origin", branch], REPO_PATH!);

    const prBody = `Closes #${issueNumber}

This PR was generated by the local AI worker using Claude Code.
Please review the Vercel preview and CI results before merging.`;

    const pr = await runCommand(
      "gh",
      [
        "pr",
        "create",
        "--title",
        issueTitle,
        "--body",
        prBody,
        "--base",
        BASE_BRANCH,
        "--head",
        branch,
      ],
      REPO_PATH!
    );

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
    try {
      fs.unlinkSync(promptFile);
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
        body: issue.body,
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
