import { afterEach, describe, expect, it, vi } from "vitest";
import { mergeReactionKnowledge, monitorEventDetails } from "../src/events";
import { createGithubUsage, githubUser, installationCoverage, pullRequestSnapshot, type GithubUsage } from "../src/github";

/** A PR with no comments, reviews, or checks, so only its body carries reactions. */
function stubPullRequest(options: {
  title: string;
  bodyReactions: Record<string, number>;
  reactions: (url: string) => Response;
  requested: string[];
}): void {
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    options.requested.push(url);
    if (url.includes("/reactions")) return options.reactions(url);
    if (url.endsWith("/pulls/7")) {
      return Response.json({
        number: 7,
        html_url: "https://github.com/owner/repo/pull/7",
        title: options.title,
        state: "open",
        user: { login: "author" },
        head: { ref: "feature", sha: null },
        base: { ref: "main" },
      });
    }
    if (url.endsWith("/issues/7")) return Response.json({ reactions: options.bodyReactions });
    if (url.endsWith("/issues/7/comments?per_page=100")) return Response.json([]);
    if (url.endsWith("/pulls/7/comments?per_page=100")) return Response.json([]);
    if (url.endsWith("/pulls/7/reviews?per_page=100")) return Response.json([]);
    if (url.endsWith("/graphql")) {
      return Response.json({ data: { repository: { pullRequest: { reviewThreads: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } } } } } });
    }
    throw new Error(`unexpected GitHub URL ${url}`);
  });
}

const HEART = { id: 901, content: "heart", user: { login: "alice", id: 11 }, created_at: "2026-09-19T12:00:00.000Z" };
const ROCKET = { id: 902, content: "rocket", user: { login: "dave", id: 12 }, created_at: "2026-09-19T12:05:00.000Z" };

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("GitHub API adapter", () => {
  it("rejects a failed request wave only after its peers have counted their responses", async () => {
    // The project's lib target predates Promise.withResolvers.
    let releaseIssue!: () => void;
    const issueHeld = new Promise<void>((resolve) => {
      releaseIssue = resolve;
    });
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/pulls/7")) return new Response("bad gateway", { status: 502 });
      if (url.endsWith("/issues/7")) {
        await issueHeld;
        return Response.json({ reactions: {} }, { headers: { "x-ratelimit-resource": "core", "x-ratelimit-remaining": "42" } });
      }
      throw new Error(`unexpected GitHub URL ${url}`);
    });
    const usage = createGithubUsage();
    let usageAtRejection: GithubUsage | undefined;
    const snapshot = pullRequestSnapshot("token", "owner/repo", 7, null, usage).catch((error: unknown) => {
      usageAtRejection = { ...usage };
      throw error;
    });
    // Let the failed pull read propagate as far as it can while the issue read is held.
    for (let turn = 0; turn < 100; turn += 1) await Promise.resolve();
    releaseIssue();

    await expect(snapshot).rejects.toMatchObject({ name: "GithubApiError", status: 502 });
    expect(usageAtRejection).toEqual({ restRequests: 2, notModified: 0, graphqlRequests: 0, coreRateLimitRemaining: 42 });
  });

  it("normalizes pull state, comments, reviews, checks, reactions, and threads", async () => {
    const requested: string[] = [];
    let graphqlCalls = 0;
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      requested.push(url);
      if (url.endsWith("/pulls/7")) {
        return Response.json({
          number: 7,
          html_url: "https://github.com/owner/repo/pull/7",
          title: "Improve watch",
          body: "body",
          state: "open",
          draft: false,
          merged: false,
          merged_at: null,
          mergeable: false,
          mergeable_state: "dirty",
          user: { login: "author" },
          head: { ref: "feature", sha: "abc", repo: { full_name: "Fork/Repo" } },
          base: { ref: "main" },
        });
      }
      if (url.endsWith("/issues/7") && !url.includes("comments")) return Response.json({ reactions: { eyes: 1, total_count: 1 } });
      if (url.endsWith("/issues/7/comments?per_page=100")) {
        return Response.json([
          { id: 1, user: { login: "reviewer" }, body: "top-level", reactions: { "+1": 1 }, created_at: "now", updated_at: "now" },
          { id: 2, user: { login: "reviewer" }, body: "quiet", reactions: { total_count: 0 }, created_at: "now", updated_at: "now" },
        ]);
      }
      if (url.endsWith("/issues/7/reactions?per_page=100")) {
        return Response.json([{ id: 900, content: "eyes", user: { login: "alice", id: 11 }, created_at: "2026-09-19T12:00:00.000Z" }]);
      }
      if (url.endsWith("/issues/comments/1/reactions?per_page=100")) {
        return Response.json([{ id: 901, content: "+1", user: { login: "bob", id: 12 }, created_at: "2026-09-19T12:01:00.000Z" }]);
      }
      if (url.endsWith("/pulls/comments/3/reactions?per_page=100")) {
        return Response.json([{ id: 902, content: "heart", user: { login: "carol" }, created_at: "2026-09-19T12:02:00.000Z" }]);
      }
      if (url.endsWith("/pulls/7/reviews?per_page=100")) return Response.json([{ id: 2, user: { login: "reviewer" }, state: "APPROVED", body: "looks good", submitted_at: "now" }]);
      if (url.endsWith("/pulls/7/comments?per_page=100")) return Response.json([{ id: 3, user: { login: "reviewer" }, body: "inline", path: "src/index.ts", line: 4, diff_hunk: "@@", reactions: { heart: 1 }, created_at: "now", updated_at: "now" }]);
      if (url.endsWith("/commits/abc/check-runs?per_page=100")) {
        return Response.json(
          { check_runs: [{ id: 4, name: "CI", status: "completed", conclusion: "failure", completed_at: "now", started_at: "then", html_url: "https://github.com/check" }] },
          { headers: { link: '<https://api.github.com/repos/owner/repo/commits/abc/check-runs?page=2&per_page=100>; rel="next"' } },
        );
      }
      if (url.includes("/commits/abc/check-runs?page=2")) return Response.json({ check_runs: [{ id: 5, name: "Lint", status: "completed", conclusion: "success", completed_at: "now", started_at: "then", html_url: "https://github.com/lint" }] });
      if (url.endsWith("/commits/abc/statuses?per_page=100")) {
        return Response.json([
          { id: 9, context: "Buildkite/Build", state: "pending", created_at: "2026-09-19T12:00:00.000Z", updated_at: "2026-09-19T12:00:00.000Z", target_url: "https://buildkite.com/build/9" },
          { id: 11, context: "coverage", state: "failure", created_at: "2026-09-19T12:02:00.000Z", updated_at: "2026-09-19T12:02:00.000Z", target_url: "https://example.test/coverage" },
          { id: 10, context: "buildkite/build", state: "success", created_at: "2026-09-19T12:01:00.000Z", updated_at: "2026-09-19T12:01:00.000Z", target_url: "https://buildkite.com/build/10" },
        ]);
      }
      if (url.endsWith("/commits/abc/check-suites?per_page=100")) {
        return Response.json({
          check_suites: [
            // Waiting on a maintainer to approve fork CI: no runs, so only the suite says so.
            { id: 20, status: "completed", conclusion: "action_required", latest_check_runs_count: 0, app: { name: "GitHub Actions" }, created_at: "2026-09-19T12:00:00.000Z", updated_at: "2026-09-19T12:03:00.000Z" },
            // Its runs already report it, so the suite adds nothing.
            { id: 21, status: "completed", conclusion: "action_required", latest_check_runs_count: 2, app: { name: "Other CI" } },
            { id: 22, status: "completed", conclusion: "success", latest_check_runs_count: 0, app: { name: "Idle" } },
          ],
        });
      }
      if (url.endsWith("/graphql")) {
        graphqlCalls += 1;
        if (graphqlCalls === 1) {
          return Response.json({ data: { repository: { pullRequest: { reviewThreads: { nodes: [{ id: "thread-1", isResolved: false, comments: { nodes: [{ databaseId: 8 }] } }], pageInfo: { hasNextPage: true, endCursor: "cursor-1" } } } } } });
        }
        return Response.json({ data: { repository: { pullRequest: { reviewThreads: { nodes: [{ id: "thread-2", isResolved: true, comments: { nodes: [{ databaseId: 9 }] } }], pageInfo: { hasNextPage: false, endCursor: null } } } } } });
      }
      throw new Error(`unexpected GitHub URL ${url} ${init?.method ?? "GET"}`);
    });

    const result = await pullRequestSnapshot("token", "owner/repo", 7);
    expect(result.mergeable).toBe(false);
    expect(result.checks[1]).toMatchObject({ name: "Lint", conclusion: "success", kind: "check_run" });
    expect(result.mergeableState).toBe("dirty");
    expect(result.headRepository).toBe("fork/repo");
    expect(result.bodyReactions).toEqual({ eyes: 1, total_count: 1 });
    expect(result.bodyReactionDetails).toEqual([
      { id: 900, content: "eyes", author: "alice", authorId: 11, createdAt: "2026-09-19T12:00:00.000Z" },
    ]);
    expect(result.comments[0]).toMatchObject({ id: 1, author: "reviewer", reactions: { "+1": 1 } });
    expect(result.comments[0].reactionDetails).toEqual([
      { id: 901, content: "+1", author: "bob", authorId: 12, createdAt: "2026-09-19T12:01:00.000Z" },
    ]);
    // A target whose summary count is zero is never read individually.
    expect(result.comments[1].reactionDetails).toEqual([]);
    expect(requested.some((url) => url.includes("/issues/comments/2/reactions"))).toBe(false);
    expect(result.reviews[0]).toMatchObject({ state: "APPROVED", author: "reviewer" });
    expect(result.reviewComments[0]).toMatchObject({ path: "src/index.ts", reactions: { heart: 1 } });
    expect(result.reviewComments[0].reactionDetails).toEqual([
      // GitHub omitted the actor ID here, so only the login is known.
      { id: 902, content: "heart", author: "carol", authorId: null, createdAt: "2026-09-19T12:02:00.000Z" },
    ]);
    expect(result.checks[0]).toMatchObject({ name: "CI", conclusion: "failure", kind: "check_run" });
    expect(result.checks.filter((check) => check.kind === "commit_status")).toEqual([
      expect.objectContaining({ id: 10, name: "buildkite/build", conclusion: "success" }),
      expect.objectContaining({ id: 11, name: "coverage", conclusion: "failure" }),
    ]);
    expect(result.checks.filter((check) => check.kind === "check_suite")).toEqual([{
      id: 20,
      name: "GitHub Actions",
      status: "completed",
      conclusion: "action_required",
      completedAt: "2026-09-19T12:03:00.000Z",
      startedAt: "2026-09-19T12:00:00.000Z",
      url: "https://github.com/owner/repo/pull/7/checks",
      kind: "check_suite",
    }]);
    expect(result.threads).toEqual([
      { id: "thread-1", isResolved: false, commentIds: [8] },
      { id: "thread-2", isResolved: true, commentIds: [9] },
    ]);
  });

  it("caps concurrent and total reaction reads, then resumes unknown targets next refresh", async () => {
    const comment = (id: number, path?: string) => ({
      id,
      user: { login: "reviewer" },
      body: `comment ${id}`,
      reactions: { heart: 1, total_count: 1 },
      created_at: "now",
      updated_at: "now",
      ...(path ? { path, line: 1, diff_hunk: "@@" } : {}),
    });
    // Every reaction response is held open until the test releases it, so the peak is the
    // real concurrency the adapter asked for rather than a timing artifact.
    const pending: (() => void)[] = [];
    let peakInFlight = 0;
    let reactionRequests = 0;
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (!url.includes("/reactions")) {
        if (url.endsWith("/pulls/7")) {
          return Response.json({
            number: 7,
            html_url: "https://github.com/owner/repo/pull/7",
            state: "open",
            user: { login: "author" },
            head: { ref: "feature", sha: null },
            base: { ref: "main" },
          });
        }
        if (url.endsWith("/issues/7")) return Response.json({ reactions: { heart: 1, total_count: 1 } });
        if (url.endsWith("/issues/7/comments?per_page=100")) {
          return Response.json(Array.from({ length: 40 }, (_, index) => comment(index + 1)));
        }
        if (url.endsWith("/pulls/7/comments?per_page=100")) {
          return Response.json(Array.from({ length: 40 }, (_, index) => comment(index + 100, "src/index.ts")));
        }
        if (url.endsWith("/pulls/7/reviews?per_page=100")) return Response.json([]);
        if (url.endsWith("/graphql")) {
          return Response.json({ data: { repository: { pullRequest: { reviewThreads: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } } } } } });
        }
        throw new Error(`unexpected GitHub URL ${url}`);
      }

      reactionRequests += 1;
      const reactionId = 900 + reactionRequests;
      // The project targets ES2022, which has no Promise.withResolvers.
      let release = () => {};
      const held = new Promise<void>((resolve) => { release = resolve; });
      pending.push(release);
      await held;
      return Response.json([{ id: reactionId, content: "heart", user: { login: "alice" }, created_at: "now" }]);
    });

    let settled = false;
    const snapshot = pullRequestSnapshot("token", "owner/repo", 7)
      .finally(() => { settled = true; });
    for (let round = 0; !settled; round += 1) {
      if (round > 100) throw new Error("snapshot never settled");
      // Drain microtasks so every request this wave will start has registered.
      for (let drain = 0; drain < 50; drain += 1) await Promise.resolve();
      peakInFlight = Math.max(peakInFlight, pending.length);
      for (const release of pending.splice(0, pending.length)) release();
    }

    const result = await snapshot;
    // Eight requests may run together and at most sixty-four pages are read in this refresh.
    expect(reactionRequests).toBe(64);
    expect(peakInFlight).toBe(8);
    const knownTargets = [
      result.bodyReactionDetails,
      ...result.comments.map((entry) => entry.reactionDetails),
      ...result.reviewComments.map((entry) => entry.reactionDetails),
    ];
    expect(knownTargets.filter((details) => details !== undefined)).toHaveLength(64);

    const secondWaveStart = Date.now();
    reactionRequests = 0;
    peakInFlight = 0;
    settled = false;
    const resumedSnapshot = pullRequestSnapshot("token", "owner/repo", 7, result)
      .finally(() => { settled = true; });
    for (let round = 0; !settled; round += 1) {
      if (round > 100) throw new Error("resumed snapshot never settled");
      for (let drain = 0; drain < 50; drain += 1) await Promise.resolve();
      peakInFlight = Math.max(peakInFlight, pending.length);
      for (const release of pending.splice(0, pending.length)) release();
    }
    const resumed = await resumedSnapshot;
    expect(reactionRequests).toBe(17);
    expect(peakInFlight).toBe(8);
    expect(resumed.bodyReactionDetails).toHaveLength(1);
    expect(resumed.comments.every((entry) => entry.reactionDetails?.length === 1)).toBe(true);
    expect(resumed.reviewComments.every((entry) => entry.reactionDetails?.length === 1)).toBe(true);
    // Details reused without a read carry that provenance; the seventeen targets this wave
    // actually read do not.
    expect(resumed.comments.every((entry) => entry.reactionDetailsState === "borrowed")).toBe(true);
    expect(resumed.reviewComments.filter((entry) => entry.reactionDetailsState === undefined)).toHaveLength(17);
    // A borrow is dated by the read it descends from, so it cannot pass for this wave's
    // knowledge; only the targets this wave read are stamped by it.
    expect(resumed.comments.map((entry) => entry.reactionDetailsReadAt))
      .toEqual(result.comments.map((entry) => entry.reactionDetailsReadAt));
    expect(resumed.comments.every((entry) => entry.reactionDetailsReadAt !== undefined)).toBe(true);
    const freshlyRead = resumed.reviewComments.filter((entry) => entry.reactionDetailsState === undefined);
    expect(freshlyRead.every((entry) => Date.parse(entry.reactionDetailsReadAt ?? "") >= secondWaveStart)).toBe(true);
  });

  it("resumes a single reaction collection across request budgets", async () => {
    const requested: string[] = [];
    let page = 0;
    const reactions = () => {
      page += 1;
      const records = Array.from({ length: 100 }, (_, index) => ({
        id: page * 100 + index,
        content: "heart",
        user: { login: `user-${page}-${index}`, id: page * 100 + index },
        created_at: "now",
      }));
      const headers = page < 65
        ? { link: `<https://api.github.com/repos/owner/repo/issues/7/reactions?per_page=100&page=${page + 1}>; rel="next"` }
        : undefined;
      return Response.json(records, { headers });
    };
    stubPullRequest({
      title: "large",
      bodyReactions: { heart: 6_500, total_count: 6_500 },
      reactions,
      requested,
    });
    const partial = await pullRequestSnapshot("token", "owner/repo", 7);
    expect(page).toBe(64);
    expect(partial.bodyReactionDetails).toBeUndefined();
    expect(partial.bodyReactionProgress?.records).toHaveLength(6_400);

    stubPullRequest({
      title: "large",
      bodyReactions: { heart: 6_500, total_count: 6_500 },
      reactions,
      requested,
    });
    const complete = await pullRequestSnapshot("token", "owner/repo", 7, partial);
    expect(page).toBe(65);
    expect(complete.bodyReactionProgress).toBeUndefined();
    expect(complete.bodyReactionDetails).toHaveLength(6_500);
  });

  it("resumes at the page whose request failed instead of re-reading the pages it already had", async () => {
    const requested: string[] = [];
    const record = (id: number) => ({ id, content: "heart", user: { login: `user-${id}`, id }, created_at: "now" });
    const stored = (id: number) => ({ id, content: "heart", author: `user-${id}`, authorId: id, createdAt: "now" });
    const counts = { heart: 2, total_count: 2 };
    const secondPage = "https://api.github.com/repos/owner/repo/issues/7/reactions?per_page=100&page=2";
    let secondPageFails = true;
    const reactions = (url: string) => {
      if (!url.includes("page=2")) {
        return Response.json([record(1)], { headers: { link: `<${secondPage}>; rel="next"` } });
      }
      return secondPageFails
        ? new Response("upstream failure", { status: 502 })
        : Response.json([record(2)]);
    };
    const reactionRequests = () => requested.filter((url) => url.includes("/reactions"));

    stubPullRequest({ title: "flaky page", bodyReactions: counts, reactions, requested });
    const interrupted = await pullRequestSnapshot("token", "owner/repo", 7);
    expect(reactionRequests()).toEqual([
      "https://api.github.com/repos/owner/repo/issues/7/reactions?per_page=100",
      secondPage,
    ]);
    // The page that failed says nothing about the page that succeeded, so the read resumes
    // from the failure rather than paying for the first page again.
    expect(interrupted.bodyReactionDetails).toBeUndefined();
    expect(interrupted.bodyReactionProgress).toEqual({ records: [stored(1)], nextUrl: secondPage });

    requested.length = 0;
    stubPullRequest({ title: "flaky page", bodyReactions: counts, reactions, requested });
    const stillFailing = await pullRequestSnapshot("token", "owner/repo", 7, interrupted);
    expect(reactionRequests()).toEqual([secondPage]);
    expect(stillFailing.bodyReactionProgress).toEqual({ records: [stored(1)], nextUrl: secondPage });

    secondPageFails = false;
    requested.length = 0;
    stubPullRequest({ title: "flaky page", bodyReactions: counts, reactions, requested });
    const complete = await pullRequestSnapshot("token", "owner/repo", 7, stillFailing);
    expect(reactionRequests()).toEqual([secondPage]);
    expect(complete.bodyReactionProgress).toBeUndefined();
    expect(complete.bodyReactionDetails).toEqual([stored(1), stored(2)]);
  });

  it("restarts a resumed reaction read whose stored prefix a mutation between waves invalidated", async () => {
    const requested: string[] = [];
    const record = (id: number) => ({ id, content: "heart", user: { login: `user-${id}`, id }, created_at: "now" });
    const stored = (id: number) => ({ id, content: "heart", author: `user-${id}`, authorId: id, createdAt: "now" });
    const counts = { heart: 3, total_count: 3 };
    stubPullRequest({ title: "paginating", bodyReactions: {}, reactions: () => Response.json([]), requested });
    const empty = await pullRequestSnapshot("token", "owner/repo", 7);
    // A previous refresh ran out of request budget one page into this target.
    const resumable = {
      ...empty,
      bodyReactions: counts,
      bodyReactionDetails: undefined,
      bodyReactionDetailsReadAt: "2026-09-03T00:01:00.000Z",
      bodyReactionProgress: {
        records: [stored(1), stored(2)],
        nextUrl: "https://api.github.com/repos/owner/repo/issues/7/reactions?per_page=100&page=2",
      },
    };

    // A reaction moved while the read was suspended, so the page boundaries shifted and the
    // suffix hands back a record the stored prefix already holds.
    requested.length = 0;
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime("2026-09-03T00:05:00.000Z");
    stubPullRequest({
      title: "mutated",
      bodyReactions: counts,
      reactions: (url) => Response.json(url.includes("page=2") ? [record(1)] : [record(1), record(2), record(3)]),
      requested,
    });
    const incoherent = await pullRequestSnapshot("token", "owner/repo", 7, resumable);
    expect(requested.filter((url) => url.includes("/reactions"))).toEqual([
      "https://api.github.com/repos/owner/repo/issues/7/reactions?per_page=100&page=2",
    ]);
    // Three records against a count of three, but one of them twice: the prefix cannot be
    // part of any coherent read, so it goes with the cursor rather than being replayed.
    expect(incoherent.bodyReactions).toEqual(counts);
    expect(incoherent.bodyReactionDetails).toBeUndefined();
    expect(incoherent.bodyReactionProgress).toBeUndefined();
    // Dropping the cursor here only clears this snapshot; the committed one is removed by the
    // merge, which needs the transition stated and dated by the read that disproved it.
    expect(incoherent.bodyReactionDetailsState).toBe("invalidated");
    expect(incoherent.bodyReactionDetailsReadAt).toBe("2026-09-03T00:05:00.000Z");
    vi.useRealTimers();

    // The next refresh therefore starts at page one and finishes the target.
    requested.length = 0;
    stubPullRequest({
      title: "settled",
      bodyReactions: counts,
      reactions: () => Response.json([record(1), record(2), record(3)]),
      requested,
    });
    const settled = await pullRequestSnapshot("token", "owner/repo", 7, incoherent);
    expect(requested.filter((url) => url.includes("/reactions"))).toEqual([
      "https://api.github.com/repos/owner/repo/issues/7/reactions?per_page=100",
    ]);
    expect(settled.bodyReactionDetails).toEqual([stored(1), stored(2), stored(3)]);
    expect(settled.bodyReactionProgress).toBeUndefined();
  });

  it("reuses stored reaction details while the summary counts are unchanged", async () => {
    const requested: string[] = [];
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime("2026-09-03T00:01:00.000Z");
    stubPullRequest({ title: "first", bodyReactions: { heart: 1, total_count: 1 }, reactions: () => Response.json([HEART]), requested });
    const first = await pullRequestSnapshot("token", "owner/repo", 7);
    expect(requested.filter((url) => url.includes("/reactions"))).toHaveLength(1);
    expect(first.bodyReactionDetailsReadAt).toBe("2026-09-03T00:01:00.000Z");

    requested.length = 0;
    vi.setSystemTime("2026-09-03T00:02:00.000Z");
    stubPullRequest({
      title: "second",
      bodyReactions: { heart: 1, total_count: 1 },
      reactions: () => Response.json([HEART]),
      requested,
    });
    const second = await pullRequestSnapshot("token", "owner/repo", 7, first);
    // The minute poll costs nothing for a target GitHub still summarises the same way.
    expect(requested.some((url) => url.includes("/reactions"))).toBe(false);
    expect(second.bodyReactionDetails).toEqual(first.bodyReactionDetails);
    expect(first.bodyReactionDetailsState).toBeUndefined();
    expect(second.bodyReactionDetailsState).toBe("borrowed");
    // Reuse is not a read: the borrow is still dated by the read it descends from, so it
    // cannot outrank a read another refresh took in between.
    expect(second.bodyReactionDetailsReadAt).toBe("2026-09-03T00:01:00.000Z");
    expect(second.title).toBe("second");

    requested.length = 0;
    vi.setSystemTime("2026-09-03T00:03:00.000Z");
    stubPullRequest({
      title: "third",
      bodyReactions: { heart: 1, rocket: 1, total_count: 2 },
      reactions: () => Response.json([HEART, ROCKET]),
      requested,
    });
    const third = await pullRequestSnapshot("token", "owner/repo", 7, second);
    expect(requested.filter((url) => url.includes("/reactions"))).toHaveLength(1);
    expect(third.bodyReactionDetails).toHaveLength(2);
    expect(third.bodyReactionDetailsState).toBeUndefined();
    expect(third.bodyReactionDetailsReadAt).toBe("2026-09-03T00:03:00.000Z");
  });

  it("dates a zero reaction summary when its own response returned, not when the wave ended", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime("2026-09-03T00:00:00.000Z");
    // Every response is held until the test releases it, and stamps the clock as it returns,
    // so each aggregate lands at a different point of one slow wave.
    const pending: (() => void)[] = [];
    const staged = (time: string, body: unknown, nextPage?: string): Promise<Response> =>
      new Promise<Response>((resolve) => {
        pending.push(() => {
          vi.setSystemTime(time);
          resolve(Response.json(body, nextPage ? { headers: { link: `<${nextPage}>; rel="next"` } } : undefined));
        });
      });
    const listedComment = (id: number, author: string, body: string) => ({
      id,
      user: { login: author },
      body,
      created_at: "2026-09-03T00:00:00.000Z",
      updated_at: "2026-09-03T00:00:00.000Z",
      reactions: { total_count: 0 },
      html_url: `https://github.com/owner/repo/pull/7#issuecomment-${id}`,
    });
    const noReactions = { total_count: 0 };
    globalThis.fetch = vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/pulls/7")) {
        return staged("2026-09-03T00:00:30.000Z", {
          number: 7,
          html_url: "https://github.com/owner/repo/pull/7",
          title: "slow wave",
          state: "open",
          user: { login: "author" },
          head: { ref: "feature", sha: null },
          base: { ref: "main" },
        });
      }
      if (url.endsWith("/issues/7")) return staged("2026-09-03T00:01:00.000Z", { reactions: noReactions });
      // Two pages of one list, minutes apart: a comment is only as fresh as its own page.
      if (url.endsWith("/issues/7/comments?per_page=100")) {
        return staged(
          "2026-09-03T00:02:00.000Z",
          [listedComment(21, "bob", "Top-level note")],
          "https://api.github.com/repos/owner/repo/issues/7/comments?per_page=100&page=2",
        );
      }
      if (url.endsWith("/issues/7/comments?per_page=100&page=2")) {
        return staged("2026-09-03T00:08:00.000Z", [listedComment(22, "bob", "Later note")]);
      }
      if (url.endsWith("/pulls/7/reviews?per_page=100")) return staged("2026-09-03T00:03:00.000Z", []);
      if (url.endsWith("/pulls/7/comments?per_page=100")) {
        return staged("2026-09-03T00:04:00.000Z", [{
          id: 31,
          user: { login: "carol" },
          body: "Inline note",
          created_at: "2026-09-03T00:00:00.000Z",
          updated_at: "2026-09-03T00:00:00.000Z",
          reactions: noReactions,
          html_url: "https://github.com/owner/repo/pull/7#discussion_r31",
        }]);
      }
      if (url.endsWith("/graphql")) {
        return staged("2026-09-03T00:06:00.000Z", {
          data: { repository: { pullRequest: { reviewThreads: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } } } } },
        });
      }
      throw new Error(`unexpected GitHub URL ${url}`);
    }) as typeof fetch;

    let settled = false;
    const wave = pullRequestSnapshot("token", "owner/repo", 7).finally(() => { settled = true; });
    for (let round = 0; !settled; round += 1) {
      if (round > 100) throw new Error("snapshot never settled");
      for (let drain = 0; drain < 50; drain += 1) await Promise.resolve();
      pending.shift()?.();
    }
    const stale = await wave;

    // The wave ends minutes after the summaries it is built from, and no target inherits
    // that end time: each zero is only as authoritative as the response that reported it.
    expect(stale.fetchedAt).toBe("2026-09-03T00:08:00.000Z");
    expect(stale.bodyReactionDetails).toEqual([]);
    expect(stale.bodyReactionDetailsReadAt).toBe("2026-09-03T00:01:00.000Z");
    expect(stale.comments.map((comment) => [comment.id, comment.reactionDetailsReadAt])).toEqual([
      [21, "2026-09-03T00:02:00.000Z"],
      [22, "2026-09-03T00:08:00.000Z"],
    ]);
    expect(stale.reviewComments[0].reactionDetailsReadAt).toBe("2026-09-03T00:04:00.000Z");
    // The aggregates are dated the same way and separately from the reads, because a merge
    // has to order counts against counts when no read stands behind them.
    expect(stale.bodyReactionsObservedAt).toBe("2026-09-03T00:01:00.000Z");
    expect(stale.comments.map((comment) => comment.reactionsObservedAt)).toEqual([
      "2026-09-03T00:02:00.000Z",
      "2026-09-03T00:08:00.000Z",
    ]);
    expect(stale.reviewComments[0].reactionsObservedAt).toBe("2026-09-03T00:04:00.000Z");

    // A concurrent refresh read the body at 00:03 and committed the heart added at 00:02:30.
    const heart = { id: 901, content: "heart", author: "alice", authorId: 11, createdAt: "2026-09-03T00:02:30.000Z" };
    const committed = {
      ...stale,
      fetchedAt: "2026-09-03T00:03:30.000Z",
      bodyReactions: { heart: 1, total_count: 1 },
      bodyReactionDetails: [heart],
      bodyReactionDetailsReadAt: "2026-09-03T00:03:00.000Z",
    };
    const merged = mergeReactionKnowledge(stale, committed);
    // Stamped at the end of the wave the zero would outrank that read and publish the heart
    // as a deletion; dated by its own response it loses, as a stale observation should.
    expect(merged.bodyReactionDetails).toEqual([heart]);
    expect(merged.bodyReactions).toEqual({ heart: 1, total_count: 1 });
    expect(merged.bodyReactionDetailsReadAt).toBe("2026-09-03T00:03:00.000Z");
    expect(monitorEventDetails(committed, merged).some((line) => line.startsWith("reaction"))).toBe(false);
  });

  it("retries reaction details that disagree with their aggregate counts", async () => {
    const requested: string[] = [];
    stubPullRequest({
      title: "raced",
      bodyReactions: { heart: 1, total_count: 1 },
      reactions: () => Response.json([]),
      requested,
    });
    const raced = await pullRequestSnapshot("token", "owner/repo", 7);
    expect(raced.bodyReactions).toEqual({ heart: 1, total_count: 1 });
    expect(raced.bodyReactionDetails).toBeUndefined();
    // Nothing was resumed, so no committed prefix needs removing. Claiming the transition
    // anyway would make the merge discard details a concurrent refresh had already read.
    expect(raced.bodyReactionDetailsState).toBeUndefined();

    requested.length = 0;
    stubPullRequest({
      title: "settled",
      bodyReactions: { heart: 1, total_count: 1 },
      reactions: () => Response.json([HEART]),
      requested,
    });
    const settled = await pullRequestSnapshot("token", "owner/repo", 7, raced);
    expect(requested.filter((url) => url.includes("/reactions"))).toHaveLength(1);
    expect(settled.bodyReactionDetails).toEqual([{
      id: 901,
      content: "heart",
      author: "alice",
      authorId: 11,
      createdAt: "2026-09-19T12:00:00.000Z",
    }]);
  });

  it("leaves a failed reaction read unknown so transactional state wins and the next refresh retries", async () => {
    const requested: string[] = [];
    stubPullRequest({ title: "seed", bodyReactions: { heart: 1, total_count: 1 }, reactions: () => Response.json([HEART]), requested });
    const stored = await pullRequestSnapshot("token", "owner/repo", 7);

    requested.length = 0;
    stubPullRequest({
      title: "upstream moved",
      bodyReactions: { heart: 1, rocket: 1, total_count: 2 },
      reactions: () => new Response("Not Found", { status: 404 }),
      requested,
    });
    const failed = await pullRequestSnapshot("token", "owner/repo", 7, stored);
    // Unknown details tell the transactional merge not to overwrite knowledge a concurrent
    // refresh may have committed while this read was in flight.
    expect(requested.filter((url) => url.includes("/reactions"))).toHaveLength(1);
    expect(failed.bodyReactions).toEqual({ heart: 1, rocket: 1, total_count: 2 });
    expect(failed.bodyReactionDetails).toBeUndefined();
    expect(failed.title).toBe("upstream moved");
    expect(monitorEventDetails(stored, failed)).toEqual([]);
    const preserved = mergeReactionKnowledge(failed, stored);
    expect(preserved.bodyReactions).toEqual(stored.bodyReactions);
    expect(preserved.bodyReactionDetails).toEqual(stored.bodyReactionDetails);

    requested.length = 0;
    stubPullRequest({
      title: "upstream moved",
      bodyReactions: { heart: 1, rocket: 1, total_count: 2 },
      reactions: () => Response.json([HEART, ROCKET]),
      requested,
    });
    // Unknown details force another read even though the summary itself is unchanged.
    const recovered = await pullRequestSnapshot("token", "owner/repo", 7, preserved);
    expect(requested.filter((url) => url.includes("/reactions"))).toHaveLength(1);
    expect(recovered.bodyReactions).toEqual({ heart: 1, rocket: 1, total_count: 2 });
    expect(monitorEventDetails(preserved, recovered)).toEqual([
      "reaction created: @dave ROCKET on PR #7 @author https://github.com/owner/repo/pull/7",
    ]);
  });

  it("reads the authenticated GitHub user profile", async () => {
    globalThis.fetch = vi.fn(async () => Response.json({ login: "pedropaulovc", id: 42, name: "Pedro", avatar_url: "https://avatar", html_url: "https://github.com/pedropaulovc" }));
    await expect(githubUser("token")).resolves.toEqual({ login: "pedropaulovc", id: 42, name: "Pedro", avatarUrl: "https://avatar", htmlUrl: "https://github.com/pedropaulovc" });
  });
});

/**
 * A GitHub whose REST responses each carry an ETag for their current version and answer 304
 * to a matching `If-None-Match`. Bumping `versions[suffix]` after editing `bodies[suffix]`
 * models the resource changing.
 */
function conditionalGithub() {
  const bodies: Record<string, unknown> = {
    "/pulls/7": {
      number: 7,
      html_url: "https://github.com/owner/repo/pull/7",
      title: "Conditional",
      state: "open",
      user: { login: "author" },
      head: { ref: "feature", sha: "abc" },
      base: { ref: "main" },
    },
    "/issues/7": { reactions: { total_count: 0 } },
    "/issues/7/comments?per_page=100": [
      { id: 1, user: { login: "reviewer" }, body: "top-level", reactions: { total_count: 0 }, created_at: "then", updated_at: "then" },
    ],
    "/pulls/7/reviews?per_page=100": [],
    "/pulls/7/comments?per_page=100": [
      { id: 3, user: { login: "reviewer" }, body: "inline", path: "src/index.ts", line: 4, reactions: { total_count: 0 }, created_at: "then", updated_at: "then" },
    ],
    "/commits/abc/check-runs?per_page=100": { check_runs: [{ id: 4, name: "CI", status: "completed", conclusion: "success" }] },
    "/commits/abc/statuses?per_page=100": [],
    "/commits/abc/check-suites?per_page=100": { check_suites: [] },
  };
  const links: Record<string, string> = {};
  const versions: Record<string, number> = {};
  const requests: Array<{ url: string; ifNoneMatch: string | null }> = [];
  const github = {
    bodies,
    links,
    versions,
    requests,
    threads: (): Response => Response.json({ data: { repository: { pullRequest: { reviewThreads: {
      nodes: [{ id: "thread-1", isResolved: false, comments: { nodes: [{ databaseId: 3 }] } }],
      pageInfo: { hasNextPage: false, endCursor: null },
    } } } } }),
  };
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const ifNoneMatch = new Headers(init?.headers).get("if-none-match");
    requests.push({ url, ifNoneMatch });
    if (url.endsWith("/graphql")) return github.threads();
    const suffix = Object.keys(bodies).find((candidate) => url.endsWith(candidate));
    if (!suffix) throw new Error(`unexpected GitHub URL ${url}`);
    const etag = `"${suffix}@${versions[suffix] ?? 1}"`;
    if (ifNoneMatch === etag) return new Response(null, { status: 304, headers: { etag } });
    return Response.json(bodies[suffix], { headers: { etag, ...(links[suffix] ? { link: links[suffix] } : {}) } });
  });
  return github;
}

describe("conditional snapshot reads", () => {
  it("revalidates every REST read and hands back the stored snapshot when nothing changed", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime("2026-09-03T00:00:00.000Z");
    const github = conditionalGithub();
    const first = await pullRequestSnapshot("token", "owner/repo", 7);
    expect(Object.keys(first.githubValidators ?? {})).toHaveLength(8);
    expect(first.threads).toEqual([{ id: "thread-1", isResolved: false, commentIds: [3] }]);

    github.requests.length = 0;
    const usage = createGithubUsage();
    const second = await pullRequestSnapshot("token", "owner/repo", 7, first, usage);

    expect(second).toEqual(first);
    // Every REST read carried the stored ETag for its own URL, and the review comments' 304
    // with a recent threads read left GraphQL, which cannot revalidate, unasked.
    expect(github.requests).toHaveLength(8);
    for (const request of github.requests) {
      expect(request.ifNoneMatch).toBe(first.githubValidators?.[request.url]);
    }
    expect(usage).toMatchObject({ restRequests: 0, notModified: 8, graphqlRequests: 0 });
  });

  it("replaces only the slice whose endpoint answered with a new response", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime("2026-09-03T00:00:00.000Z");
    const github = conditionalGithub();
    const first = await pullRequestSnapshot("token", "owner/repo", 7);

    github.bodies["/pulls/7/reviews?per_page=100"] = [
      { id: 2, user: { login: "reviewer" }, state: "APPROVED", body: "ship it", submitted_at: "now" },
    ];
    github.versions["/pulls/7/reviews?per_page=100"] = 2;
    const usage = createGithubUsage();
    const second = await pullRequestSnapshot("token", "owner/repo", 7, first, usage);

    const reviewsUrl = "https://api.github.com/repos/owner/repo/pulls/7/reviews?per_page=100";
    expect(second.reviews).toEqual([{ id: 2, author: "reviewer", state: "APPROVED", body: "ship it", submittedAt: "now" }]);
    expect(second).toEqual({
      ...first,
      reviews: second.reviews,
      githubValidators: { ...first.githubValidators, [reviewsUrl]: '"/pulls/7/reviews?per_page=100@2"' },
    });
    expect(usage).toMatchObject({ restRequests: 1, notModified: 7, graphqlRequests: 0 });
  });

  it("stores no validator for a list that runs past one page", async () => {
    const github = conditionalGithub();
    github.links["/commits/abc/check-runs?per_page=100"] =
      '<https://api.github.com/repos/owner/repo/commits/abc/check-runs?page=2&per_page=100>; rel="next"';
    github.bodies["/check-runs?page=2&per_page=100"] = { check_runs: [{ id: 5, name: "Lint", status: "completed", conclusion: "success" }] };
    const firstPage = "https://api.github.com/repos/owner/repo/commits/abc/check-runs?per_page=100";

    const first = await pullRequestSnapshot("token", "owner/repo", 7);
    expect(first.checks.map((check) => check.name)).toEqual(["CI", "Lint"]);
    expect(first.githubValidators).not.toHaveProperty(firstPage);

    github.requests.length = 0;
    const second = await pullRequestSnapshot("token", "owner/repo", 7, first);
    // One page's ETag cannot vouch for the list, so every page is read again in full.
    expect(github.requests.filter((request) => request.url.includes("/check-runs"))).toEqual([
      { url: firstPage, ifNoneMatch: null },
      { url: "https://api.github.com/repos/owner/repo/commits/abc/check-runs?page=2&per_page=100", ifNoneMatch: null },
    ]);
    expect(second.checks.map((check) => check.name)).toEqual(["CI", "Lint"]);
  });

  it("keeps the stored threads when their read fails, and retries it on the next refresh", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime("2026-09-03T00:00:00.000Z");
    const github = conditionalGithub();
    const first = await pullRequestSnapshot("token", "owner/repo", 7);

    // Old enough that the next refresh must read the threads again, and GraphQL fails.
    vi.setSystemTime("2026-09-03T00:15:00.000Z");
    github.threads = () => new Response("unavailable", { status: 502 });
    const failed = await pullRequestSnapshot("token", "owner/repo", 7, first);
    expect(failed.threads).toEqual(first.threads);
    expect(failed.threadsReadAt).toBeUndefined();

    // Everything answers 304, but a failed read left no read time to trust, so it is retried.
    github.requests.length = 0;
    vi.setSystemTime("2026-09-03T00:16:00.000Z");
    const usage = createGithubUsage();
    const retried = await pullRequestSnapshot("token", "owner/repo", 7, failed, usage);
    expect(usage).toMatchObject({ restRequests: 0, notModified: 8, graphqlRequests: 1 });
    expect(retried.threads).toEqual(first.threads);
  });

  it("reads the threads again once the stored read is fifteen minutes old", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime("2026-09-03T00:00:00.000Z");
    const github = conditionalGithub();
    const first = await pullRequestSnapshot("token", "owner/repo", 7);

    vi.setSystemTime("2026-09-03T00:14:59.999Z");
    const fresh = createGithubUsage();
    const reused = await pullRequestSnapshot("token", "owner/repo", 7, first, fresh);
    expect(fresh.graphqlRequests).toBe(0);
    expect(reused.threadsReadAt).toBe("2026-09-03T00:00:00.000Z");

    vi.setSystemTime("2026-09-03T00:15:00.000Z");
    const stale = createGithubUsage();
    const reread = await pullRequestSnapshot("token", "owner/repo", 7, reused, stale);
    expect(stale).toMatchObject({ restRequests: 0, notModified: 8, graphqlRequests: 1 });
    expect(reread.threadsReadAt).toBe("2026-09-03T00:15:00.000Z");
    expect(github.requests.filter((request) => request.url.endsWith("/graphql"))).toHaveLength(2);
  });
});

describe("installation coverage lookup", () => {
  function installationsGithub() {
    const bodies: Record<string, unknown> = {
      "/user/installations?per_page=100": {
        total_count: 3,
        installations: [
          { id: 1, account: { login: "Owner" }, repository_selection: "selected", suspended_at: null },
          { id: 2, account: { login: "Org" }, repository_selection: "all", suspended_at: null },
          { id: 3, account: { login: "Paused" }, repository_selection: "all", suspended_at: "2026-01-01T00:00:00Z" },
        ],
      },
      "/user/installations/1/repositories?per_page=100": {
        total_count: 1,
        repositories: [{ full_name: "Owner/Covered" }],
      },
    };
    const requests: Array<{ path: string; status: number }> = [];
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      const path = `${url.pathname}${url.search}`;
      if (!Object.hasOwn(bodies, path)) throw new Error(`unexpected GitHub URL ${url}`);
      const etag = `"${path}"`;
      const status = new Headers(init?.headers).get("if-none-match") === etag ? 304 : 200;
      requests.push({ path, status });
      if (status === 304) return new Response(null, { status, headers: { etag } });
      return Response.json(bodies[path], { headers: { etag } });
    });
    return requests;
  }

  it("finds a selected installation's repository, and repeats the lookup as two 304s", async () => {
    const requests = installationsGithub();
    const first = await installationCoverage("token", "owner/covered", null);
    expect(first.coverage).toBe("repository");

    const usage = createGithubUsage();
    const repeat = await installationCoverage("token", "owner/covered", first.lookup, usage);
    expect(repeat).toEqual(first);
    expect(requests.slice(2)).toEqual([
      { path: "/user/installations?per_page=100", status: 304 },
      { path: "/user/installations/1/repositories?per_page=100", status: 304 },
    ]);
    expect(usage.notModified).toBe(2);

    // Another repository of the same selected installation is answered from the same lists.
    await expect(installationCoverage("token", "owner/uncovered", repeat.lookup)).resolves.toMatchObject({ coverage: "none" });
  });

  it("covers every repository of an account-wide installation without listing them", async () => {
    const requests = installationsGithub();
    await expect(installationCoverage("token", "org/anything", null)).resolves.toMatchObject({ coverage: "account" });
    expect(requests.map(({ path }) => path)).toEqual(["/user/installations?per_page=100"]);
  });

  it("reports no coverage for suspended installations and other owners", async () => {
    installationsGithub();
    await expect(installationCoverage("token", "paused/repo", null)).resolves.toMatchObject({ coverage: "none" });
    await expect(installationCoverage("token", "can1357/oh-my-pi", null)).resolves.toMatchObject({ coverage: "none" });
  });

  it("throws when GitHub refuses the lookup", async () => {
    globalThis.fetch = vi.fn(async () => Response.json({ message: "Forbidden" }, { status: 403 }));
    await expect(installationCoverage("token", "owner/repo", null)).rejects.toThrow();
  });
});
