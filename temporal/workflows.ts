import { proxyActivities } from "@temporalio/workflow";
import type * as activities from "./activities";
import type { IssueLike, IssueComment, PRComment } from "../shared";

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
  processPlanFeedbackActivity,
  processIssueActivity,
  processPRCommentActivity,
} = proxyActivities<typeof activities>({
  startToCloseTimeout: "45m",
  heartbeatTimeout: "2m",
  retry: { maximumAttempts: 2, backoffCoefficient: 1 },
});

/* ------------------------------------------------------------------ */
/*  Workflows                                                          */
/* ------------------------------------------------------------------ */

export async function planIssueWorkflow(
  issue: IssueLike,
  baseBranch: string
): Promise<void> {
  const worktreeName = `plan-${issue.number}`;
  await gitFetchActivity();
  const workDir = await createWorktreeActivity(
    worktreeName,
    `origin/${baseBranch}`,
    undefined
  );
  try {
    await processPlanIssueActivity(issue, workDir);
  } finally {
    await removeWorktreeActivity(worktreeName);
  }
}

export async function planFeedbackWorkflow(
  issueComment: IssueComment,
  baseBranch: string
): Promise<void> {
  const worktreeName = `plan-${issueComment.issueNumber}`;
  await gitFetchActivity();
  const workDir = await createWorktreeActivity(
    worktreeName,
    `origin/${baseBranch}`,
    undefined
  );
  try {
    await processPlanFeedbackActivity(issueComment, workDir);
  } finally {
    await removeWorktreeActivity(worktreeName);
  }
}

export async function implementIssueWorkflow(
  issue: IssueLike,
  branch: string,
  baseBranch: string
): Promise<void> {
  const worktreeName = `issue-${issue.number}`;
  await gitFetchActivity();
  const workDir = await createWorktreeActivity(
    worktreeName,
    `origin/${baseBranch}`,
    branch
  );
  try {
    await processIssueActivity(issue, workDir);
  } finally {
    await removeWorktreeActivity(worktreeName);
  }
}

export async function prFeedbackWorkflow(
  prComment: PRComment,
  baseBranch: string
): Promise<void> {
  const worktreeName = `pr-${prComment.prNumber}`;
  await gitFetchActivity();
  const workDir = await createWorktreeActivity(
    worktreeName,
    `origin/${prComment.prBranch}`,
    prComment.prBranch
  );
  try {
    await processPRCommentActivity(prComment, workDir);
  } finally {
    await removeWorktreeActivity(worktreeName);
  }
}
