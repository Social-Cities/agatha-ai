import { Context } from "@temporalio/activity";
import {
  createRepoContext,
  createWorktree,
  removeWorktree,
  runCommand,
  processPlanIssue,
  processPlanFeedback,
  processIssue,
  processPRComment,
} from "../shared";
import type {
  IssueLike,
  IssueComment,
  PRComment,
  RepoConfig,
} from "../shared";

/* ------------------------------------------------------------------ */
/*  Worktree lifecycle activities                                      */
/* ------------------------------------------------------------------ */

export async function createWorktreeActivity(
  config: RepoConfig,
  name: string,
  ref: string,
  newBranch?: string
): Promise<string> {
  const ctx = createRepoContext(config);
  return createWorktree(ctx, name, ref, newBranch);
}

export async function removeWorktreeActivity(
  config: RepoConfig,
  name: string
): Promise<void> {
  const ctx = createRepoContext(config);
  return removeWorktree(ctx, name);
}

export async function gitFetchActivity(config: RepoConfig): Promise<void> {
  await runCommand("git", ["fetch", "origin"], config.path);
}

/* ------------------------------------------------------------------ */
/*  Long-running Claude activities (with heartbeating)                 */
/* ------------------------------------------------------------------ */

export async function processPlanIssueActivity(
  config: RepoConfig,
  issue: IssueLike,
  workDir: string
): Promise<void> {
  const ctx = createRepoContext(config);
  await processPlanIssue(ctx, issue, workDir, {
    onHeartbeat: () => Context.current().heartbeat(),
  });
}

export async function processPlanFeedbackActivity(
  config: RepoConfig,
  issueComment: IssueComment,
  workDir: string
): Promise<void> {
  const ctx = createRepoContext(config);
  await processPlanFeedback(ctx, issueComment, workDir, {
    onHeartbeat: () => Context.current().heartbeat(),
  });
}

export async function processIssueActivity(
  config: RepoConfig,
  issue: IssueLike,
  workDir: string
): Promise<void> {
  const ctx = createRepoContext(config);
  await processIssue(ctx, issue, workDir, {
    onHeartbeat: () => Context.current().heartbeat(),
  });
}

export async function processPRCommentActivity(
  config: RepoConfig,
  prComment: PRComment,
  workDir: string
): Promise<void> {
  const ctx = createRepoContext(config);
  await processPRComment(ctx, prComment, workDir, {
    onHeartbeat: () => Context.current().heartbeat(),
  });
}
