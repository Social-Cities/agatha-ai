import "dotenv/config";
import { Client, Connection } from "@temporalio/client";
import { WorkflowExecutionAlreadyStartedError } from "@temporalio/common";
import {
  octokit,
  OWNER,
  REPO,
  BASE_BRANCH,
  POLL_MS,
  COMMENT_PREFIX,
  safeBranchName,
  cleanupWorktrees,
  runCommand,
  REPO_PATH,
} from "../shared";
import type { IssueLike, IssueComment, PRComment } from "../shared";

const TASK_QUEUE = process.env.TEMPORAL_TASK_QUEUE || "agatha-github";
const TEMPORAL_ADDRESS = process.env.TEMPORAL_ADDRESS || "localhost:7233";
const TEMPORAL_NAMESPACE = process.env.TEMPORAL_NAMESPACE || "default";

async function startPoller(): Promise<void> {
  const connection = await Connection.connect({ address: TEMPORAL_ADDRESS });
  const client = new Client({
    connection,
    namespace: TEMPORAL_NAMESPACE,
  });

  console.log(
    `Temporal poller started — polling every ${POLL_MS}ms, queue "${TASK_QUEUE}"`
  );

  // Clean up any leftover worktrees from a previous run
  await cleanupWorktrees();

  // Ensure main repo is on the base branch
  await runCommand("git", ["checkout", BASE_BRANCH], REPO_PATH!);

  async function startWorkflow(
    workflowType: string,
    workflowId: string,
    args: unknown[]
  ): Promise<void> {
    try {
      await client.workflow.start(workflowType, {
        taskQueue: TASK_QUEUE,
        workflowId,
        args,
      });
      console.log(`Started workflow: ${workflowType} (${workflowId})`);
    } catch (err) {
      if (err instanceof WorkflowExecutionAlreadyStartedError) {
        // Already running — skip
        return;
      }
      throw err;
    }
  }

  async function poll(): Promise<void> {
    // 1. Plan feedback comments (on ai-planned issues)
    const planIssues = await octokit.issues.listForRepo({
      owner: OWNER!,
      repo: REPO!,
      state: "open",
      labels: "ai-planned",
      per_page: 50,
    });

    for (const issue of planIssues.data) {
      if ("pull_request" in issue && issue.pull_request) continue;

      const comments = await octokit.issues.listComments({
        owner: OWNER!,
        repo: REPO!,
        issue_number: issue.number,
        per_page: 100,
      });

      const issueLabels = issue.labels.map((label) =>
        typeof label === "string" ? label : label.name || ""
      );

      for (const c of comments.data) {
        if (
          c.body &&
          c.body.trimStart().startsWith(COMMENT_PREFIX)
        ) {
          const issueComment: IssueComment = {
            id: c.id,
            issueNumber: issue.number,
            issueTitle: issue.title,
            issueBody: issue.body || "",
            issueLabels,
            body: c.body.trimStart().slice(COMMENT_PREFIX.length).trim(),
          };
          await startWorkflow(
            "planFeedbackWorkflow",
            `plan-feedback-${issue.number}-${c.id}`,
            [issueComment, BASE_BRANCH]
          );
        }
      }
    }

    // 2. PR feedback comments
    const pulls = await octokit.pulls.list({
      owner: OWNER!,
      repo: REPO!,
      state: "open",
      per_page: 50,
    });

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
          c.body.trimStart().startsWith(COMMENT_PREFIX)
        ) {
          const prComment: PRComment = {
            id: c.id,
            prNumber: pr.number,
            prTitle: pr.title,
            prBranch: pr.head.ref,
            body: c.body.trimStart().slice(COMMENT_PREFIX.length).trim(),
          };
          await startWorkflow(
            "prFeedbackWorkflow",
            `pr-feedback-${pr.number}-${c.id}`,
            [prComment, BASE_BRANCH]
          );
        }
      }
    }

    // 3. Issues needing a plan
    const plannable = await octokit.issues.listForRepo({
      owner: OWNER!,
      repo: REPO!,
      state: "open",
      labels: "ai-plan",
      per_page: 20,
    });

    for (const issue of plannable.data) {
      const labelNames = issue.labels.map((label) =>
        typeof label === "string" ? label : label.name || ""
      );
      if (labelNames.includes("ai-planning")) continue;
      if ("pull_request" in issue && issue.pull_request) continue;

      const issueLike: IssueLike = {
        number: issue.number,
        title: issue.title,
        body: issue.body ?? null,
      };
      await startWorkflow(
        "planIssueWorkflow",
        `plan-${issue.number}`,
        [issueLike, BASE_BRANCH]
      );
    }

    // 4. Issues ready for implementation
    const taskable = await octokit.issues.listForRepo({
      owner: OWNER!,
      repo: REPO!,
      state: "open",
      labels: "ai-task",
      per_page: 20,
    });

    for (const issue of taskable.data) {
      const labelNames = issue.labels.map((label) =>
        typeof label === "string" ? label : label.name || ""
      );
      if (labelNames.includes("ai-running")) continue;
      if ("pull_request" in issue && issue.pull_request) continue;

      const issueLike: IssueLike = {
        number: issue.number,
        title: issue.title,
        body: issue.body ?? null,
      };
      const branch = safeBranchName(issue.number);
      await startWorkflow(
        "implementIssueWorkflow",
        `issue-${issue.number}`,
        [issueLike, branch, BASE_BRANCH]
      );
    }
  }

  // Start polling
  setInterval(() => {
    poll().catch((error) => {
      console.error("Poll loop failed:", error);
    });
  }, POLL_MS);

  await poll();
}

startPoller().catch((err) => {
  console.error("Temporal poller failed:", err);
  process.exit(1);
});
