import { afterEach, describe, expect, it, vi } from "vitest";
import { mergeReactionKnowledge, monitorEventDetails } from "../src/events";
import { githubUser, pullRequestSnapshot } from "../src/github";

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
  vi.restoreAllMocks();
});

describe("GitHub API adapter", () => {
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

  it("reuses stored reaction details while the summary counts are unchanged", async () => {
    const requested: string[] = [];
    stubPullRequest({ title: "first", bodyReactions: { heart: 1, total_count: 1 }, reactions: () => Response.json([HEART]), requested });
    const first = await pullRequestSnapshot("token", "owner/repo", 7);
    expect(requested.filter((url) => url.includes("/reactions"))).toHaveLength(1);

    requested.length = 0;
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
    expect(second.title).toBe("second");

    requested.length = 0;
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
