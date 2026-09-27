import { afterEach, describe, expect, it, vi } from "vitest";
import { monitorEventDetails } from "../src/events";
import { pullRequestSnapshot } from "../src/github";
import { applyWebhook } from "../src/reducers";
import type { PullRequestComment, PullRequestSnapshot } from "../src/types";

const API = "https://api.github.com/repos/owner/repo";
const VALIDATORS = {
  [`${API}/pulls/7`]: '"pull"',
  [`${API}/issues/7`]: '"issue"',
  [`${API}/issues/7/comments?per_page=100`]: '"comments"',
  [`${API}/pulls/7/reviews?per_page=100`]: '"reviews"',
  [`${API}/pulls/7/comments?per_page=100`]: '"review-comments"',
  [`${API}/commits/abc/check-runs?per_page=100`]: '"check-runs"',
  [`${API}/commits/abc/statuses?per_page=100`]: '"statuses"',
  [`${API}/commits/abc/check-suites?per_page=100`]: '"check-suites"',
};
const RECEIVED_AT = "2026-09-10T13:00:00.000Z";

const HEART = { id: 901, content: "heart", author: "alice", authorId: 11, createdAt: "2026-09-10T11:00:00.000Z" };

function comment(overrides: Partial<PullRequestComment> = {}): PullRequestComment {
  return {
    id: 11,
    author: "bob",
    body: "first",
    createdAt: "2026-09-10T11:00:00.000Z",
    updatedAt: "2026-09-10T11:00:00.000Z",
    reactions: { heart: 1, total_count: 1 },
    htmlUrl: "https://github.com/owner/repo/pull/7#issuecomment-11",
    line: null,
    startLine: null,
    inReplyToId: null,
    reactionsObservedAt: "2026-09-10T11:30:00.000Z",
    reactionDetails: [HEART],
    reactionDetailsReadAt: "2026-09-10T11:30:00.000Z",
    ...overrides,
  };
}

function snapshot(overrides: Partial<PullRequestSnapshot> = {}): PullRequestSnapshot {
  return {
    repository: "owner/repo",
    number: 7,
    url: "https://github.com/owner/repo/pull/7",
    title: "Reducers",
    body: "body",
    state: "open",
    draft: false,
    merged: false,
    mergedAt: null,
    mergeable: true,
    mergeableState: "clean",
    baseRefName: "main",
    headRefName: "feature",
    headRepository: "owner/repo",
    headSha: "abc",
    author: "author",
    updatedAt: "2026-09-10T12:00:00.000Z",
    fetchedAt: "2026-09-10T12:00:00.000Z",
    bodyReactions: {},
    bodyReactionDetails: [],
    comments: [comment()],
    reviews: [],
    reviewComments: [],
    checks: [],
    threads: [{ id: "PRRT_1", isResolved: false, commentIds: [21] }],
    githubValidators: { ...VALIDATORS },
    threadsReadAt: "2026-09-10T12:00:00.000Z",
    ...overrides,
  };
}

function issueComment(overrides: Record<string, unknown> = {}) {
  return {
    id: 11,
    user: { login: "bob" },
    body: "edited",
    created_at: "2026-09-10T11:00:00.000Z",
    updated_at: "2026-09-10T12:30:00.000Z",
    html_url: "https://github.com/owner/repo/pull/7#issuecomment-11",
    reactions: { heart: 1, total_count: 1 },
    ...overrides,
  };
}

function pull(overrides: Record<string, unknown> = {}) {
  return {
    number: 7,
    html_url: "https://github.com/owner/repo/pull/7",
    title: "Reducers",
    body: "body",
    state: "open",
    draft: false,
    merged: false,
    merged_at: null,
    mergeable: null,
    mergeable_state: "unknown",
    updated_at: "2026-09-10T12:30:00.000Z",
    user: { login: "author" },
    head: { ref: "feature", sha: "abc", repo: { full_name: "owner/repo" } },
    base: { ref: "main" },
    ...overrides,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("webhook reducers", () => {
  it("drops the validator of each slice a delivery changed and keeps the others", () => {
    const stored = snapshot();
    const { snapshot: next, outcome } = applyWebhook(stored, "issue_comment", { action: "edited", comment: issueComment() }, RECEIVED_AT);

    expect(outcome).toBe("applied");
    expect(next.comments[0].body).toBe("edited");
    expect(next.fetchedAt).toBe(RECEIVED_AT);
    const { [`${API}/issues/7/comments?per_page=100`]: dropped, ...kept } = VALIDATORS;
    expect(dropped).toBeDefined();
    expect(next.githubValidators).toEqual(kept);
    expect(next.threadsReadAt).toBe(stored.threadsReadAt);
  });

  it("keeps a comment's reaction knowledge and moves only its aggregate counts", () => {
    const counts = { heart: 1, rocket: 1, total_count: 2 };
    const { snapshot: next } = applyWebhook(snapshot(), "issue_comment", {
      action: "edited",
      comment: issueComment({ reactions: counts }),
    }, RECEIVED_AT);

    expect(next.comments[0]).toEqual({
      ...comment(),
      body: "edited",
      updatedAt: "2026-09-10T12:30:00.000Z",
      reactions: counts,
      reactionsObservedAt: RECEIVED_AT,
    });
  });

  it("records a created comment's zero reaction summary as known-empty details", () => {
    const { snapshot: next } = applyWebhook(snapshot(), "issue_comment", {
      action: "created",
      comment: issueComment({ id: 12, body: "new", reactions: { heart: 0, total_count: 0 } }),
    }, RECEIVED_AT);

    expect(next.comments.map((candidate) => candidate.id)).toEqual([11, 12]);
    expect(next.comments[1]).toMatchObject({ reactionDetails: [], reactionDetailsReadAt: RECEIVED_AT });
  });

  it("ignores deliveries older than the stored item", () => {
    const stored = snapshot({
      reviews: [{ id: 31, author: "carol", state: "DISMISSED", body: "", submittedAt: "2026-09-10T11:00:00.000Z" }],
      checks: [{
        id: 41,
        name: "test",
        status: "completed",
        conclusion: "success",
        completedAt: "2026-09-10T12:00:00.000Z",
        startedAt: "2026-09-10T11:50:00.000Z",
        url: null,
        kind: "check_run",
      }, {
        id: 51,
        name: "ci/legacy",
        status: "completed",
        conclusion: "success",
        completedAt: "2026-09-10T12:00:00.000Z",
        startedAt: "2026-09-10T11:50:00.000Z",
        url: null,
        kind: "commit_status",
      }],
    });
    const deliveries: [string, Record<string, unknown>][] = [
      ["issue_comment", { action: "edited", comment: issueComment({ updated_at: "2026-09-10T10:00:00.000Z" }) }],
      ["pull_request", { action: "edited", pull_request: pull({ title: "stale", updated_at: "2026-09-10T11:00:00.000Z" }) }],
      ["pull_request_review", {
        action: "submitted",
        review: { id: 31, user: { login: "carol" }, state: "approved", body: "", submitted_at: "2026-09-10T11:00:00.000Z" },
      }],
      ["check_run", { check_run: { id: 41, name: "test", head_sha: "abc", status: "in_progress", completed_at: null } }],
      ["status", { id: 50, sha: "abc", context: "ci/legacy", state: "pending", created_at: "2026-09-10T11:00:00.000Z", updated_at: "2026-09-10T11:00:00.000Z" }],
    ];
    for (const [githubEvent, payload] of deliveries) {
      expect(applyWebhook(stored, githubEvent, payload, RECEIVED_AT), githubEvent).toEqual({ snapshot: stored, outcome: "ignored" });
    }
  });

  it("removes a deleted comment whatever its timestamps say", () => {
    const { snapshot: next, outcome } = applyWebhook(snapshot(), "issue_comment", {
      action: "deleted",
      comment: issueComment({ updated_at: "2026-09-10T10:00:00.000Z" }),
    }, RECEIVED_AT);

    expect(outcome).toBe("applied");
    expect(next.comments).toEqual([]);
  });

  it("ignores checks reported for another head revision", () => {
    const stored = snapshot();
    const deliveries: [string, Record<string, unknown>][] = [
      ["check_run", { check_run: { id: 41, name: "test", head_sha: "old", status: "queued" } }],
      ["check_suite", { check_suite: { id: 61, head_sha: "old", conclusion: "action_required", latest_check_runs_count: 0 } }],
      ["status", { id: 50, sha: "old", context: "ci", state: "failure" }],
    ];
    for (const [githubEvent, payload] of deliveries) {
      expect(applyWebhook(stored, githubEvent, payload, RECEIVED_AT), githubEvent).toEqual({ snapshot: stored, outcome: "ignored" });
    }
  });

  it("keeps stored mergeability unless the payload computed it or the head moved", () => {
    const stored = snapshot({
      checks: [{
        id: 41,
        name: "test",
        status: "completed",
        conclusion: "failure",
        completedAt: "2026-09-10T12:00:00.000Z",
        startedAt: null,
        url: null,
        kind: "check_run",
      }],
    });

    const edited = applyWebhook(stored, "pull_request", { action: "edited", pull_request: pull({ title: "renamed" }) }, RECEIVED_AT);
    expect(edited.outcome).toBe("applied");
    expect(edited.snapshot).toMatchObject({ title: "renamed", mergeable: true, mergeableState: "clean", updatedAt: "2026-09-10T12:30:00.000Z" });
    expect(edited.snapshot.githubValidators).not.toHaveProperty(`${API}/pulls/7`);

    const computed = applyWebhook(stored, "pull_request", {
      action: "labeled",
      pull_request: pull({ mergeable: false, mergeable_state: "dirty" }),
    }, RECEIVED_AT);
    expect(computed.snapshot).toMatchObject({ mergeable: false, mergeableState: "dirty" });

    const pushed = applyWebhook(stored, "pull_request", {
      action: "synchronize",
      pull_request: pull({ head: { ref: "feature", sha: "def", repo: { full_name: "owner/repo" } } }),
    }, RECEIVED_AT);
    expect(pushed.outcome).toBe("applied_mergeability_unknown");
    expect(pushed.snapshot).toMatchObject({ headSha: "def", mergeable: null, mergeableState: "unknown", checks: [] });
    // The old head's check validators went with its checks; slices that stayed keep theirs.
    expect(Object.keys(pushed.snapshot.githubValidators ?? {}).sort()).toEqual([
      `${API}/issues/7`,
      `${API}/issues/7/comments?per_page=100`,
      `${API}/pulls/7/comments?per_page=100`,
      `${API}/pulls/7/reviews?per_page=100`,
    ]);
  });

  it("resolves a known thread and refetches for an unknown one", () => {
    const stored = snapshot();
    const byNode = applyWebhook(stored, "pull_request_review_thread", {
      action: "resolved",
      thread: { node_id: "PRRT_1", comments: [] },
    }, RECEIVED_AT);
    expect(byNode.outcome).toBe("applied");
    expect(byNode.snapshot.threads).toEqual([{ id: "PRRT_1", isResolved: true, commentIds: [21] }]);

    const byComment = applyWebhook(stored, "pull_request_review_thread", {
      action: "resolved",
      thread: { node_id: "PRRT_renamed", comments: [{ id: 21 }] },
    }, RECEIVED_AT);
    expect(byComment.snapshot.threads[0].isResolved).toBe(true);

    expect(applyWebhook(stored, "pull_request_review_thread", {
      action: "resolved",
      thread: { node_id: "PRRT_2", comments: [{ id: 22 }] },
    }, RECEIVED_AT)).toEqual({ snapshot: stored, outcome: "refetch" });
  });

  it("replaces an awaiting-approval suite once a run of that suite reports", () => {
    const awaiting = applyWebhook(snapshot(), "check_suite", {
      action: "completed",
      check_suite: {
        id: 61,
        head_sha: "abc",
        status: "completed",
        conclusion: "action_required",
        latest_check_runs_count: 0,
        app: { name: "GitHub Actions" },
        created_at: "2026-09-10T12:10:00.000Z",
        updated_at: "2026-09-10T12:10:00.000Z",
      },
    }, RECEIVED_AT);
    expect(awaiting.snapshot.checks).toEqual([{
      id: 61,
      name: "GitHub Actions",
      status: "completed",
      conclusion: "action_required",
      completedAt: "2026-09-10T12:10:00.000Z",
      startedAt: "2026-09-10T12:10:00.000Z",
      url: "https://github.com/owner/repo/pull/7/checks",
      kind: "check_suite",
    }]);

    const running = applyWebhook(awaiting.snapshot, "check_run", {
      action: "created",
      check_run: { id: 41, name: "test", head_sha: "abc", status: "queued", check_suite: { id: 61 } },
    }, RECEIVED_AT);
    expect(running.snapshot.checks.map((check) => [check.kind, check.id])).toEqual([["check_run", 41]]);
  });

  it("reads and announces reaction details once a delivery moved a comment's counts", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime("2026-09-10T12:00:00.000Z");
    const apiComment = (reactions: Record<string, number>) => ({ ...issueComment({ body: "first", updated_at: "2026-09-10T11:00:00.000Z" }), reactions });
    const records = [{ id: 901, content: "heart", user: { login: "alice", id: 11 }, created_at: "2026-09-10T11:00:00.000Z" }];
    let listed = apiComment({ heart: 1, total_count: 1 });
    const reactionReads: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/issues/comments/11/reactions?per_page=100")) {
        reactionReads.push(url);
        return Response.json(records);
      }
      if (url.endsWith("/pulls/7")) return Response.json(pull());
      if (url.endsWith("/issues/7")) return Response.json({ reactions: {} });
      if (url.endsWith("/issues/7/comments?per_page=100")) return Response.json([listed]);
      if (url.endsWith("/graphql")) {
        return Response.json({ data: { repository: { pullRequest: { reviewThreads: { nodes: [], pageInfo: { hasNextPage: false } } } } } });
      }
      if (url.includes("/check-runs")) return Response.json({ check_runs: [] });
      if (url.includes("/check-suites")) return Response.json({ check_suites: [] });
      return Response.json([]);
    }));
    const first = await pullRequestSnapshot("token", "owner/repo", 7);
    expect(reactionReads).toHaveLength(1);

    // The delivery carries the new counts but no reaction records.
    const counts = { heart: 1, rocket: 1, total_count: 2 };
    records.push({ id: 902, content: "rocket", user: { login: "dave", id: 12 }, created_at: "2026-09-10T12:20:00.000Z" });
    const { snapshot: reduced } = applyWebhook(first, "issue_comment", {
      action: "edited",
      comment: apiComment(counts),
    }, RECEIVED_AT);
    expect(reduced.comments[0].reactionDetails).toHaveLength(1);

    listed = apiComment(counts);
    reactionReads.length = 0;
    vi.setSystemTime("2026-09-10T13:01:00.000Z");
    const refreshed = await pullRequestSnapshot("token", "owner/repo", 7, reduced);
    expect(reactionReads).toHaveLength(1);
    expect(refreshed.comments[0].reactionDetails).toHaveLength(2);
    expect(monitorEventDetails(reduced, refreshed)).toEqual([
      "reaction created: @dave ROCKET on comment #11 @bob https://github.com/owner/repo/pull/7#issuecomment-11",
    ]);
  });
});
