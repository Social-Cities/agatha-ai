import "dotenv/config";
import { Client, Connection } from "@temporalio/client";
import {
  WorkflowExecutionAlreadyStartedError,
  WorkflowIdReusePolicy,
} from "@temporalio/common";
import {
  loadRepoConfigs,
  createRepoContext,
  POLL_MS,
  COMMENT_PREFIX,
  safeBranchName,
  cleanupWorktrees,
  runCommand,
} from "../shared";
import type {
  IssueLike,
  IssueComment,
  PRComment,
  RepoContext,
} from "../shared";

const TASK_QUEUE = process.env.TEMPORAL_TASK_QUEUE || "agatha-github";
const TEMPORAL_ADDRESS = process.env.TEMPORAL_ADDRESS || "localhost:7233";
const TEMPORAL_NAMESPACE = process.env.TEMPORAL_NAMESPACE || "default";

async function startPoller(): Promise<void> {
  const configs = loadRepoConfigs();
  const contexts = configs.map(createRepoContext);

  const connection = await Connection.connect({ address: TEMPORAL_ADDRESS });
  const client = new Client({
    connection,
    namespace: TEMPORAL_NAMESPACE,
  });

  console.log(
    `Temporal poller started — polling every ${POLL_MS}ms, queue "${TASK_QUEUE}"`
  );
  console.log(`Watching ${contexts.length} repo(s):`);
  for (const ctx of contexts) {
    console.log(`  - ${ctx.key} @ ${ctx.config.path} (base: ${ctx.config.baseBranch})`);
  }

  for (const ctx of contexts) {
    await cleanupWorktrees(ctx);
    await runCommand("git", ["checkout", ctx.config.baseBranch], ctx.config.path);
  }

  async function startWorkflow(
    workflowType: string,
    workflowId: string,
    args: unknown[],
    opts?: { rejectDuplicate?: boolean }
  ): Promise<void> {
    try {
      await client.workflow.start(workflowType, {
        taskQueue: TASK_QUEUE,
        workflowId,
        args,
        ...(opts?.rejectDuplicate && {
          workflowIdReusePolicy:
            WorkflowIdReusePolicy.WORKFLOW_ID_REUSE_POLICY_REJECT_DUPLICATE,
        }),
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

  async function pollRepo(ctx: RepoContext): Promise<void> {
    const workflowIdPrefix = `${ctx.config.owner}-${ctx.config.repo}`;

    // 1. Plan feedback comments (on ai-planned issues)
    const planIssues = await ctx.octokit.issues.listForRepo({
      owner: ctx.config.owner,
      repo: ctx.config.repo,
      state: "open",
      labels: "ai-planned",
      per_page: 50,
    });

    for (const issue of planIssues.data) {
      if ("pull_request" in issue && issue.pull_request) continue;

      const comments = await ctx.octokit.issues.listComments({
        owner: ctx.config.owner,
        repo: ctx.config.repo,
        issue_number: issue.number,
        per_page: 100,
      });

      const issueLabels = issue.labels.map((label) =>
        typeof label === "string" ? label : label.name || ""
      );

      for (const c of comments.data) {
        if (c.body && c.body.trimStart().startsWith(COMMENT_PREFIX)) {
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
            `${workflowIdPrefix}-plan-feedback-${issue.number}-${c.id}`,
            [ctx.config, issueComment],
            { rejectDuplicate: true }
          );
        }
      }
    }

    // 2. PR feedback comments
    const pulls = await ctx.octokit.pulls.list({
      owner: ctx.config.owner,
      repo: ctx.config.repo,
      state: "open",
      per_page: 50,
    });

    for (const pr of pulls.data) {
      const comments = await ctx.octokit.issues.listComments({
        owner: ctx.config.owner,
        repo: ctx.config.repo,
        issue_number: pr.number,
        per_page: 100,
      });

      for (const c of comments.data) {
        if (c.body && c.body.trimStart().startsWith(COMMENT_PREFIX)) {
          const prComment: PRComment = {
            id: c.id,
            prNumber: pr.number,
            prTitle: pr.title,
            prBranch: pr.head.ref,
            body: c.body.trimStart().slice(COMMENT_PREFIX.length).trim(),
          };
          await startWorkflow(
            "prFeedbackWorkflow",
            `${workflowIdPrefix}-pr-feedback-${pr.number}-${c.id}`,
            [ctx.config, prComment],
            { rejectDuplicate: true }
          );
        }
      }
    }

    // 3. Issues needing a plan
    const plannable = await ctx.octokit.issues.listForRepo({
      owner: ctx.config.owner,
      repo: ctx.config.repo,
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
        `${workflowIdPrefix}-plan-${issue.number}`,
        [ctx.config, issueLike]
      );
    }

    // 4. Issues ready for implementation
    const taskable = await ctx.octokit.issues.listForRepo({
      owner: ctx.config.owner,
      repo: ctx.config.repo,
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
        `${workflowIdPrefix}-issue-${issue.number}`,
        [ctx.config, issueLike, branch]
      );
    }
  }

  async function poll(): Promise<void> {
    for (const ctx of contexts) {
      try {
        await pollRepo(ctx);
      } catch (error) {
        console.error(`Poll for ${ctx.key} failed:`, error);
      }
    }
  }

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
