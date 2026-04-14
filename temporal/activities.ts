import { Context } from "@temporalio/activity";
import {
  createWorktree,
  removeWorktree,
  runCommand,
  processPlanIssue,
  processPlanFeedback,
  processIssue,
  processPRComment,
  REPO_PATH,
} from "../shared";
import type { IssueLike, IssueComment, PRComment } from "../shared";

/* ------------------------------------------------------------------ */
/*  Worktree lifecycle activities                                      */
/* ------------------------------------------------------------------ */

export async function createWorktreeActivity(
  name: string,
  ref: string,
  newBranch?: string
): Promise<string> {
  return createWorktree(name, ref, newBranch);
}

export async function removeWorktreeActivity(name: string): Promise<void> {
  return removeWorktree(name);
}

export async function gitFetchActivity(): Promise<void> {
  await runCommand("git", ["fetch", "origin"], REPO_PATH!);
}

/* ------------------------------------------------------------------ */
/*  Long-running Claude activities (with heartbeating)                 */
/* ------------------------------------------------------------------ */

export async function processPlanIssueActivity(
  issue: IssueLike,
  workDir: string
): Promise<void> {
  await processPlanIssue(issue, workDir, {
    onHeartbeat: () => Context.current().heartbeat(),
  });
}

export async function processPlanFeedbackActivity(
  issueComment: IssueComment,
  workDir: string
): Promise<void> {
  await processPlanFeedback(issueComment, workDir, {
    onHeartbeat: () => Context.current().heartbeat(),
  });
}

export async function processIssueActivity(
  issue: IssueLike,
  workDir: string
): Promise<void> {
  await processIssue(issue, workDir, {
    onHeartbeat: () => Context.current().heartbeat(),
  });
}

export async function processPRCommentActivity(
  prComment: PRComment,
  workDir: string
): Promise<void> {
  await processPRComment(prComment, workDir, {
    onHeartbeat: () => Context.current().heartbeat(),
  });
}
