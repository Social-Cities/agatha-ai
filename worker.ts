import "dotenv/config";
import {
  octokit,
  OWNER,
  REPO,
  REPO_PATH,
  BASE_BRANCH,
  POLL_MS,
  MAX_CONCURRENT,
  runCommand,
  createWorktree,
  removeWorktree,
  cleanupWorktrees,
  safeBranchName,
  getPendingPlanComments,
  getPendingPRComments,
  processPlanIssue,
  processPlanFeedback,
  processIssue,
  processPRComment,
} from "./shared";

/* ------------------------------------------------------------------ */
/*  Job tracking                                                       */
/* ------------------------------------------------------------------ */

const activeJobs = new Map<string, Promise<void>>();
const processedCommentIds = new Set<number>();

/* ------------------------------------------------------------------ */
/*  Job dispatcher                                                     */
/* ------------------------------------------------------------------ */

function dispatch(
  key: string,
  worktreeName: string,
  ref: string,
  newBranch: string | undefined,
  fn: (workDir: string) => Promise<void>
): void {
  const job = (async () => {
    const workDir = await createWorktree(worktreeName, ref, newBranch);
    try {
      await fn(workDir);
    } finally {
      await removeWorktree(worktreeName);
    }
  })();

  const tracked = job.catch((error) => {
    console.error(`Job [${key}] failed:`, error);
  }).finally(() => {
    activeJobs.delete(key);
  });

  activeJobs.set(key, tracked);
}

/* ------------------------------------------------------------------ */
/*  Poll loop                                                          */
/* ------------------------------------------------------------------ */

let polling = false;

async function poll(): Promise<void> {
  if (polling) return;
  polling = true;

  try {
    if (activeJobs.size >= MAX_CONCURRENT) return;

    // Single fetch for all jobs — worktrees share the object store
    await runCommand("git", ["fetch", "origin"], REPO_PATH!);

    const slots = () => MAX_CONCURRENT - activeJobs.size;

    // 1. Plan feedback comments (on ai-planned issues)
    if (slots() > 0) {
      const pendingPlanComments = await getPendingPlanComments(processedCommentIds);
      for (const pc of pendingPlanComments) {
        if (slots() <= 0) break;
        const key = `plan-${pc.issueNumber}`;
        if (activeJobs.has(key)) continue;
        processedCommentIds.add(pc.id);
        dispatch(
          key,
          `plan-${pc.issueNumber}`,
          `origin/${BASE_BRANCH}`,
          undefined,
          (workDir) => processPlanFeedback(pc, workDir)
        );
      }
    }

    // 2. PR feedback comments
    if (slots() > 0) {
      const pendingPRComments = await getPendingPRComments(processedCommentIds);
      for (const pc of pendingPRComments) {
        if (slots() <= 0) break;
        const key = `pr-${pc.prNumber}`;
        if (activeJobs.has(key)) continue;
        processedCommentIds.add(pc.id);
        dispatch(
          key,
          `pr-${pc.prNumber}`,
          `origin/${pc.prBranch}`,
          pc.prBranch,
          (workDir) => processPRComment(pc, workDir)
        );
      }
    }

    // 3. Issues needing a plan
    if (slots() > 0) {
      const planIssues = await octokit.issues.listForRepo({
        owner: OWNER!,
        repo: REPO!,
        state: "open",
        labels: "ai-plan",
        per_page: 20,
      });

      for (const issue of planIssues.data) {
        if (slots() <= 0) break;
        const labelNames = issue.labels.map((label) =>
          typeof label === "string" ? label : label.name || ""
        );
        if (labelNames.includes("ai-planning")) continue;
        if ("pull_request" in issue && issue.pull_request) continue;

        const key = `plan-${issue.number}`;
        if (activeJobs.has(key)) continue;

        dispatch(
          key,
          `plan-${issue.number}`,
          `origin/${BASE_BRANCH}`,
          undefined,
          (workDir) =>
            processPlanIssue(
              { number: issue.number, title: issue.title, body: issue.body ?? null },
              workDir
            )
        );
      }
    }

    // 4. Issues ready for implementation
    if (slots() > 0) {
      const issues = await octokit.issues.listForRepo({
        owner: OWNER!,
        repo: REPO!,
        state: "open",
        labels: "ai-task",
        per_page: 20,
      });

      for (const issue of issues.data) {
        if (slots() <= 0) break;
        const labelNames = issue.labels.map((label) =>
          typeof label === "string" ? label : label.name || ""
        );
        if (labelNames.includes("ai-running")) continue;
        if ("pull_request" in issue && issue.pull_request) continue;

        const key = `issue-${issue.number}`;
        if (activeJobs.has(key)) continue;

        const branch = safeBranchName(issue.number);
        dispatch(
          key,
          `issue-${issue.number}`,
          `origin/${BASE_BRANCH}`,
          branch,
          (workDir) =>
            processIssue(
              { number: issue.number, title: issue.title, body: issue.body ?? null },
              workDir
            )
        );
      }
    }
  } finally {
    polling = false;
  }
}

/* ------------------------------------------------------------------ */
/*  Startup                                                            */
/* ------------------------------------------------------------------ */

async function start(): Promise<void> {
  console.log(
    `Agatha worker starting — polling every ${POLL_MS}ms, max ${MAX_CONCURRENT} concurrent jobs`
  );
  console.log(`Repo: ${REPO_PATH}`);

  // Clean up any leftover worktrees from a previous run
  await cleanupWorktrees();

  // Ensure main repo is on the base branch so worktree branch creation never conflicts
  await runCommand("git", ["checkout", BASE_BRANCH], REPO_PATH!);

  // Start polling
  setInterval(() => {
    poll().catch((error) => {
      console.error("Poll loop failed:", error);
    });
  }, POLL_MS);

  await poll();
}

start().catch((error) => {
  console.error("Startup failed:", error);
  process.exit(1);
});
