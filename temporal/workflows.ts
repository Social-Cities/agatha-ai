import { proxyActivities } from "@temporalio/workflow";
import type * as activities from "./activities";
import type { IssueLike, IssueComment, PRComment, RepoConfig } from "../shared";

/* ------------------------------------------------------------------ */
/*  Activity proxies                                                   */
/* ------------------------------------------------------------------ */

const {
  gitFetchActivity,
  createWorktreeActivity,
  removeWorktreeActivity,
} = proxyActivities<typeof activities>({
  startToCloseTimeout: "2m",
  retry: { maximumAttempts: 3 },
});

const {
  processPlanIssueActivity,
  processIssueActivity,
} = proxyActivities<typeof activities>({
  startToCloseTimeout: "45m",
  heartbeatTimeout: "2m",
  retry: { maximumAttempts: 2, backoffCoefficient: 1 },
});

const {
  processPlanFeedbackActivity,
  processPRCommentActivity,
} = proxyActivities<typeof activities>({
  startToCloseTimeout: "45m",
  heartbeatTimeout: "2m",
  retry: { maximumAttempts: 1 },
});

/* ------------------------------------------------------------------ */
/*  Workflows                                                          */
/* ------------------------------------------------------------------ */

export async function planIssueWorkflow(
  config: RepoConfig,
  issue: IssueLike
): Promise<void> {
  const worktreeName = `plan-${issue.number}`;
  await gitFetchActivity(config);
  const workDir = await createWorktreeActivity(
    config,
    worktreeName,
    `origin/${config.baseBranch}`,
    undefined
  );
  try {
    await processPlanIssueActivity(config, issue, workDir);
  } finally {
    await removeWorktreeActivity(config, worktreeName);
  }
}

export async function planFeedbackWorkflow(
  config: RepoConfig,
  issueComment: IssueComment
): Promise<void> {
  const worktreeName = `plan-${issueComment.issueNumber}`;
  await gitFetchActivity(config);
  const workDir = await createWorktreeActivity(
    config,
    worktreeName,
    `origin/${config.baseBranch}`,
    undefined
  );
  try {
    await processPlanFeedbackActivity(config, issueComment, workDir);
  } finally {
    await removeWorktreeActivity(config, worktreeName);
  }
}

export async function implementIssueWorkflow(
  config: RepoConfig,
  issue: IssueLike,
  branch: string
): Promise<void> {
  const worktreeName = `issue-${issue.number}`;
  await gitFetchActivity(config);
  const workDir = await createWorktreeActivity(
    config,
    worktreeName,
    `origin/${config.baseBranch}`,
    branch
  );
  try {
    await processIssueActivity(config, issue, workDir);
  } finally {
    await removeWorktreeActivity(config, worktreeName);
  }
}

export async function prFeedbackWorkflow(
  config: RepoConfig,
  prComment: PRComment
): Promise<void> {
  const worktreeName = `pr-${prComment.prNumber}`;
  await gitFetchActivity(config);
  const workDir = await createWorktreeActivity(
    config,
    worktreeName,
    `origin/${prComment.prBranch}`,
    prComment.prBranch
  );
  try {
    await processPRCommentActivity(config, prComment, workDir);
  } finally {
    await removeWorktreeActivity(config, worktreeName);
  }
}
