import "dotenv/config";
import {
  loadRepoConfigs,
  createRepoContext,
  POLL_MS,
  MAX_CONCURRENT,
  RepoContext,
  runCommand,
  createWorktree,
  removeWorktree,
  cleanupWorktrees,
  ensureRepoCloned,
  safeBranchName,
  getPendingPlanComments,
  getPendingPRComments,
  processPlanIssue,
  processPlanFeedback,
  processIssue,
  processPRComment,
  detectPlanAgent,
} from "./shared";

/* ------------------------------------------------------------------ */
/*  Job tracking                                                       */
/* ------------------------------------------------------------------ */

const activeJobs = new Map<string, Promise<void>>();
const processedCommentIds = new Set<number>();
let contexts: RepoContext[] = [];

type CandidateJob = {
  key: string;
  ctx: RepoContext;
  worktreeName: string;
  ref: string;
  newBranch: string | undefined;
  fn: (workDir: string) => Promise<void>;
  commentId?: number;
};

/* ------------------------------------------------------------------ */
/*  Job dispatcher                                                     */
/* ------------------------------------------------------------------ */

function dispatch(
  ctx: RepoContext,
  key: string,
  worktreeName: string,
  ref: string,
  newBranch: string | undefined,
  fn: (workDir: string) => Promise<void>
): void {
  const job = (async () => {
    const workDir = await createWorktree(ctx, worktreeName, ref, newBranch);
    try {
      await fn(workDir);
    } finally {
      await removeWorktree(ctx, worktreeName);
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
/*  Per-repo candidate collection                                      */
/* ------------------------------------------------------------------ */

async function collectPendingJobs(ctx: RepoContext): Promise<CandidateJob[]> {
  const jobs: CandidateJob[] = [];
  const baseRef = `origin/${ctx.config.baseBranch}`;

  // 1. Plan feedback comments (on ai-planned issues)
  const planComments = await getPendingPlanComments(ctx, processedCommentIds);
  for (const pc of planComments) {
    const agent = detectPlanAgent(pc.issueLabels);
    jobs.push({
      key: `${ctx.key}:plan-${pc.issueNumber}`,
      ctx,
      worktreeName: `plan-${pc.issueNumber}`,
      ref: baseRef,
      newBranch: undefined,
      fn: (workDir) => processPlanFeedback(ctx, pc, workDir, { agent }),
      commentId: pc.id,
    });
  }

  // 2. PR feedback comments
  const prComments = await getPendingPRComments(ctx, processedCommentIds);
  for (const pc of prComments) {
    jobs.push({
      key: `${ctx.key}:pr-${pc.prNumber}`,
      ctx,
      worktreeName: `pr-${pc.prNumber}`,
      ref: `origin/${pc.prBranch}`,
      newBranch: pc.prBranch,
      fn: (workDir) => processPRComment(ctx, pc, workDir),
      commentId: pc.id,
    });
  }

  // 3. Issues needing a plan
  const planIssues = await ctx.octokit.issues.listForRepo({
    owner: ctx.config.owner,
    repo: ctx.config.repo,
    state: "open",
    labels: "ai-plan",
    per_page: 20,
  });
  for (const issue of planIssues.data) {
    const labelNames = issue.labels.map((label) =>
      typeof label === "string" ? label : label.name || ""
    );
    if (labelNames.includes("ai-planning")) continue;
    if ("pull_request" in issue && issue.pull_request) continue;

    const agent = detectPlanAgent(labelNames);
    const issueLike = {
      number: issue.number,
      title: issue.title,
      body: issue.body ?? null,
    };
    jobs.push({
      key: `${ctx.key}:plan-${issue.number}`,
      ctx,
      worktreeName: `plan-${issue.number}`,
      ref: baseRef,
      newBranch: undefined,
      fn: (workDir) => processPlanIssue(ctx, issueLike, workDir, { agent }),
    });
  }

  // 4. Issues ready for implementation
  const taskIssues = await ctx.octokit.issues.listForRepo({
    owner: ctx.config.owner,
    repo: ctx.config.repo,
    state: "open",
    labels: "ai-task",
    per_page: 20,
  });
  for (const issue of taskIssues.data) {
    const labelNames = issue.labels.map((label) =>
      typeof label === "string" ? label : label.name || ""
    );
    if (labelNames.includes("ai-running")) continue;
    if ("pull_request" in issue && issue.pull_request) continue;

    const branch = safeBranchName(issue.number);
    const issueLike = {
      number: issue.number,
      title: issue.title,
      body: issue.body ?? null,
    };
    jobs.push({
      key: `${ctx.key}:issue-${issue.number}`,
      ctx,
      worktreeName: `issue-${issue.number}`,
      ref: baseRef,
      newBranch: branch,
      fn: (workDir) => processIssue(ctx, issueLike, workDir),
    });
  }

  return jobs;
}

/* ------------------------------------------------------------------ */
/*  Poll loop                                                          */
/* ------------------------------------------------------------------ */

let polling = false;

async function poll(): Promise<void> {
  if (polling) return;
  polling = true;

  try {
    const slots = () => MAX_CONCURRENT - activeJobs.size;
    if (slots() <= 0) return;

    // Parallel git fetch across all repos — each repo's worktrees share its object store
    await Promise.all(
      contexts.map((ctx) =>
        runCommand("git", ["fetch", "origin"], ctx.config.path).catch((error) => {
          console.error(`Fetch for ${ctx.key} failed:`, error);
        })
      )
    );

    // Parallel candidate collection per repo
    const queues = await Promise.all(
      contexts.map((ctx) =>
        collectPendingJobs(ctx).catch((error) => {
          console.error(`Collect for ${ctx.key} failed:`, error);
          return [] as CandidateJob[];
        })
      )
    );

    // Round-robin dispatch: one job from each repo per pass, loop until slots exhausted
    while (slots() > 0) {
      let dispatchedThisPass = false;
      for (const queue of queues) {
        if (slots() <= 0) break;
        if (queue.length === 0) continue;
        const job = queue.shift()!;
        if (activeJobs.has(job.key)) continue;
        if (job.commentId !== undefined) processedCommentIds.add(job.commentId);
        dispatch(
          job.ctx,
          job.key,
          job.worktreeName,
          job.ref,
          job.newBranch,
          job.fn
        );
        dispatchedThisPass = true;
      }
      if (!dispatchedThisPass) break;
    }
  } finally {
    polling = false;
  }
}

/* ------------------------------------------------------------------ */
/*  Startup                                                            */
/* ------------------------------------------------------------------ */

async function start(): Promise<void> {
  const configs = loadRepoConfigs();
  contexts = configs.map(createRepoContext);

  console.log(
    `Agatha worker starting — polling every ${POLL_MS}ms, max ${MAX_CONCURRENT} concurrent jobs`
  );
  console.log(`Watching ${contexts.length} repo(s):`);
  for (const ctx of contexts) {
    console.log(`  - ${ctx.key} @ ${ctx.config.path} (base: ${ctx.config.baseBranch})`);
  }

  for (const ctx of contexts) {
    await ensureRepoCloned(ctx);
    await cleanupWorktrees(ctx);
    // Ensure main repo is on the base branch so worktree branch creation never conflicts
    await runCommand("git", ["checkout", ctx.config.baseBranch], ctx.config.path);
  }

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
