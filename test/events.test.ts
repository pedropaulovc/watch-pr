import { describe, expect, it } from "vitest";
import { hmacSha256Hex, verifyGithubSignature } from "../src/crypto";
import {
  eventPullRequestNumbers,
  mergeReactionKnowledge,
  reactionKnowledgeAdvanced,
  monitorEventDetails,
  monitorReconciliationDetails,
  parseResourceUri,
  resourceUri,
  snapshotChanges,
  watchKey,
} from "../src/events";
import type { PullRequestSnapshot } from "../src/types";

const snapshot = (overrides: Partial<PullRequestSnapshot> = {}): PullRequestSnapshot => ({
  repository: "owner/repo",
  number: 7,
  url: "https://github.com/owner/repo/pull/7",
  title: "Change",
  body: "",
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
  fetchedAt: "2026-09-03T00:00:00.000Z",
  bodyReactions: {},
  bodyReactionDetails: [],
  comments: [],
  reviews: [],
  reviewComments: [],
  checks: [],
  threads: [],
  ...overrides,
});
const watched = (keys: string[]) => keys.map((key) => ({ key, snapshot: null }));


describe("watch-pr event contracts", () => {
  it("round-trips a resource URI and normalizes repository keys", () => {
    const key = watchKey("Owner/Repo", 7);
    const uri = resourceUri("Owner/Repo", 7);
    expect(key).toBe("owner/repo#7");
    expect(uri).toBe("watch-pr://owner/repo/pull/7");
    expect(parseResourceUri(uri)).toEqual({ repository: "owner/repo", number: 7 });
  });

  it("fans status deliveries out to every watched PR in the repository", () => {
    const payload = { repository: { full_name: "owner/repo" }, status: { state: "pending" } };
    expect(eventPullRequestNumbers("status", payload, watched(["owner/repo#2", "owner/repo#7", "other/repo#9"]))).toEqual([2, 7]);
  });

  it("routes issue comments only when the issue is a pull request", () => {
    const watchedPullRequests = watched(["owner/repo#7", "owner/repo#9"]);
    expect(eventPullRequestNumbers("issue_comment", {
      repository: { full_name: "owner/repo" },
      issue: { number: 7 },
    }, watchedPullRequests)).toEqual([]);
    expect(eventPullRequestNumbers("issue_comment", {
      repository: { full_name: "owner/repo" },
      issue: { number: 9, pull_request: { url: "https://api.github.com/repos/owner/repo/pulls/9" } },
    }, watchedPullRequests)).toEqual([9]);
  });

  it("fans commit comments and merge-group deliveries out to watched repository PRs", () => {
    const watchedPullRequests = watched(["owner/repo#2", "owner/repo#7", "other/repo#9"]);
    const payload = { repository: { full_name: "owner/repo" }, comment: { body: "commit note" } };
    expect(eventPullRequestNumbers("commit_comment", payload, watchedPullRequests)).toEqual([2, 7]);
    expect(eventPullRequestNumbers("merge_group", payload, watchedPullRequests)).toEqual([2, 7]);
  });
  it("routes linked webhook deliveries and filters explicit PR associations", () => {
    const watchedPullRequests = watched(["owner/repo#2", "owner/repo#7", "other/repo#9"]);
    const directPayload = { repository: { full_name: "owner/repo" }, pull_request: { number: 7 } };
    for (const eventName of ["pull_request", "pull_request_review", "pull_request_review_comment", "pull_request_review_thread"]) {
      expect(eventPullRequestNumbers(eventName, directPayload, watchedPullRequests)).toEqual([7]);
    }
    expect(eventPullRequestNumbers("check_run", {
      repository: { full_name: "owner/repo" },
      check_run: { pull_requests: [{ number: 7 }, { number: 99 }] },
    }, watchedPullRequests)).toEqual([7]);
    expect(eventPullRequestNumbers("check_suite", {
      repository: { full_name: "owner/repo" },
      check_suite: { pull_requests: [{ number: 2 }] },
    }, watchedPullRequests)).toEqual([2]);
    expect(eventPullRequestNumbers("status", {
      repository: { full_name: "owner/repo" },
      status: { pull_requests: [{ number: 7 }] },
    }, watchedPullRequests)).toEqual([7]);
    expect(eventPullRequestNumbers("deployment_status", {
      repository: { full_name: "owner/repo" },
      deployment_status: { pull_requests: [{ number: 2 }] },
    }, watchedPullRequests)).toEqual([2]);
    expect(eventPullRequestNumbers("deployment", {
      repository: { full_name: "owner/repo" },
      deployment: { pull_requests: [{ number: 7 }] },
    }, watchedPullRequests)).toEqual([7]);
    expect(eventPullRequestNumbers("check_run", {
      repository: { full_name: "owner/repo" },
      check_run: { pull_requests: [] },
    }, watchedPullRequests)).toEqual([]);
    expect(eventPullRequestNumbers("push", { repository: { full_name: "owner/repo" } }, watchedPullRequests)).toEqual([2, 7]);
    expect(eventPullRequestNumbers("merge_group", { repository: { full_name: "owner/repo" } }, watchedPullRequests)).toEqual([2, 7]);
  });

  it("routes a stacked-PR push only to watches whose head or direct base changed", () => {
    const stack = [
      {
        key: "owner/repo#730",
        snapshot: snapshot({ number: 730, headRefName: "recreate-pinion-handle", baseRefName: "main" }),
      },
      {
        key: "owner/repo#733",
        snapshot: snapshot({
          number: 733,
          headRefName: "review-hobby-shop-tolerances",
          baseRefName: "recreate-pinion-handle",
        }),
      },
      {
        key: "owner/repo#734",
        snapshot: snapshot({
          number: 734,
          headRefName: "review-machinist-prompt-eval",
          baseRefName: "review-hobby-shop-tolerances",
        }),
      },
    ];

    expect(eventPullRequestNumbers("push", {
      repository: { full_name: "owner/repo" },
      ref: "refs/heads/recreate-pinion-handle",
    }, stack)).toEqual([730, 733]);
  });

  it("routes a direct-base push even when the watched snapshot itself is unchanged", () => {
    const stack = [
      {
        key: "owner/repo#733",
        snapshot: snapshot({
          number: 733,
          headRefName: "review-hobby-shop-tolerances",
          baseRefName: "recreate-pinion-handle",
        }),
      },
      {
        key: "owner/repo#734",
        snapshot: snapshot({
          number: 734,
          headRefName: "review-machinist-prompt-eval",
          baseRefName: "review-hobby-shop-tolerances",
        }),
      },
    ];

    expect(eventPullRequestNumbers("push", {
      repository: { full_name: "owner/repo" },
      ref: "refs/heads/review-hobby-shop-tolerances",
    }, stack)).toEqual([733, 734]);
  });

  it("does not confuse a fork head with a same-named branch in the base repository", () => {
    const forkWatch = [{
      key: "owner/repo#735",
      snapshot: snapshot({
        number: 735,
        headRefName: "feature",
        headRepository: "contributor/repo",
        baseRefName: "main",
      }),
    }];

    expect(eventPullRequestNumbers("push", {
      repository: { full_name: "owner/repo" },
      ref: "refs/heads/feature",
    }, forkWatch)).toEqual([]);
    expect(eventPullRequestNumbers("push", {
      repository: { full_name: "contributor/repo" },
      ref: "refs/heads/feature",
    }, forkWatch)).toEqual([735]);
    expect(eventPullRequestNumbers("push", {
      repository: { full_name: "owner/repo" },
      ref: "refs/heads/main",
    }, forkWatch)).toEqual([735]);
  });

  it("conservatively routes legacy fork snapshots without a stored head repository", () => {
    const legacyWatch = [{
      key: "owner/repo#735",
      snapshot: snapshot({
        number: 735,
        headRefName: "feature",
        headRepository: null,
        baseRefName: "main",
      }),
    }];

    expect(eventPullRequestNumbers("push", {
      repository: { full_name: "owner/repo" },
      ref: "refs/heads/feature",
    }, legacyWatch)).toEqual([735]);
  });

  it("detects description, mergeability, review, check, and reaction changes", () => {
    const before = snapshot();
    const after = snapshot({ body: "updated", mergeable: false, mergeableState: "dirty", bodyReactions: { eyes: 1 }, checks: [{ id: 1, name: "CI", status: "completed", conclusion: "failure", completedAt: "now", startedAt: "then", url: null, kind: "check_run" }] });
    expect(snapshotChanges(before, after)).toEqual(["description", "mergeability", "checks", "reactions"]);
  });

  it("detects merged timestamp changes as lifecycle changes", () => {
    expect(snapshotChanges(snapshot(), snapshot({ merged: true, mergedAt: "2026-09-03T01:00:00.000Z" }))).toEqual(["lifecycle"]);
  });

  it("coalesces a check rerun into one start and one terminal set of records", () => {
    const pending = (id: number, name: string) => ({
      id,
      name,
      status: "in_progress",
      conclusion: null,
      completedAt: null,
      startedAt: "2026-09-19T12:00:00.000Z",
      url: `https://github.com/owner/repo/actions/runs/${id}`,
      kind: "check_run" as const,
    });
    const completed = (id: number, name: string) => ({
      ...pending(id, name),
      status: "completed",
      conclusion: "success",
      completedAt: "2026-09-19T12:01:00.000Z",
    });
    const before = snapshot();
    const started = snapshot({ checks: [pending(1, "CI"), pending(2, "Lint")] });
    const partial = snapshot({ checks: [completed(1, "CI"), pending(2, "Lint")] });
    const finished = snapshot({ checks: [completed(1, "CI"), completed(2, "Lint")] });

    expect(monitorEventDetails(before, started)).toEqual([
      "checks: CI -> pending",
      "checks: Lint -> pending",
    ]);
    expect(monitorEventDetails(started, partial)).toEqual([]);
    expect(monitorEventDetails(partial, finished)).toEqual([
      "checks: CI -> pass",
      "checks: Lint -> pass",
    ]);
  });

  it("tracks commit status waves by context when GitHub assigns a new status ID", () => {
    const pendingStatus = {
      id: 9,
      name: "Buildkite/Build",
      status: "completed",
      conclusion: "pending",
      completedAt: "2026-09-19T12:00:00.000Z",
      startedAt: null,
      url: "https://buildkite.com/build/9",
      kind: "commit_status" as const,
    };
    const completedStatus = {
      ...pendingStatus,
      id: 10,
      name: "buildkite/build",
      conclusion: "success",
      completedAt: "2026-09-19T12:01:00.000Z",
      url: "https://buildkite.com/build/10",
    };

    expect(monitorEventDetails(snapshot(), snapshot({ checks: [pendingStatus] }))).toEqual([
      "checks: Buildkite/Build -> pending",
    ]);
    expect(monitorEventDetails(
      snapshot({ checks: [pendingStatus] }),
      snapshot({ checks: [completedStatus] }),
    )).toEqual([
      "checks: buildkite/build -> pass",
    ]);
  });

  it("renders current check state and review feedback during reconciliation", () => {
    const pending = {
      id: 1,
      name: "CI",
      status: "in_progress",
      conclusion: null,
      completedAt: null,
      startedAt: "2026-09-19T12:00:00.000Z",
      url: null,
      kind: "check_run" as const,
    };
    const feedback = {
      id: 22,
      author: "reviewer",
      body: "Please keep this visible.",
      createdAt: "2026-09-19T12:00:00.000Z",
      updatedAt: "2026-09-19T12:00:00.000Z",
      reactions: {},
      reactionDetails: [],
      path: "src/retry.ts",
      line: 9,
    };
    const resolvedFeedback = { ...feedback, id: 23, body: "Already resolved." };
    const unknownThreadFeedback = { ...feedback, id: 24, body: "Membership was truncated." };

    expect(monitorReconciliationDetails(snapshot({
      checks: [pending],
      reviewComments: [feedback, resolvedFeedback, unknownThreadFeedback],
      threads: [
        { id: "thread-open", isResolved: false, commentIds: [22] },
        { id: "thread-resolved", isResolved: true, commentIds: [23] },
      ],
    }))).toEqual([
      "mergeability: head -> feature@abc",
      "checks: CI -> pending",
      "active comments: now 2",
      "feedback [thread-open] #22 src/retry.ts:9 @reviewer: Please keep this visible.",
      "feedback [-] #24 src/retry.ts:9 @reviewer: Membership was truncated.",
    ]);
    expect(monitorReconciliationDetails(snapshot({
      checks: [{ ...pending, status: "completed", conclusion: "success" }],
    }))).toEqual([
      "mergeability: head -> feature@abc",
      "checks: CI -> pass",
    ]);
  });

  it("reports retargets, cleared conflicts, reopened threads, and deleted feedback", () => {
    const comment = {
      id: 21,
      author: "reviewer",
      body: "Old feedback",
      createdAt: "2026-09-19T12:00:00.000Z",
      updatedAt: "2026-09-19T12:00:00.000Z",
      reactions: {},
      reactionDetails: [],
    };
    const review = {
      id: 31,
      author: "reviewer",
      body: "Old review",
      state: "CHANGES_REQUESTED",
      submittedAt: "2026-09-19T12:00:00.000Z",
    };
    const reviewComment = { ...comment, id: 41, path: "src/retry.ts", line: 12 };
    const before = snapshot({
      mergeableState: "dirty",
      comments: [comment],
      reviews: [review],
      reviewComments: [reviewComment],
      threads: [{ id: "PRRT_thread", isResolved: true, commentIds: [41] }],
    });
    const after = snapshot({
      baseRefName: "release/2",
      mergeableState: "clean",
      threads: [{ id: "PRRT_thread", isResolved: false, commentIds: [41] }],
    });

    expect(monitorEventDetails(before, after)).toEqual([
      "mergeability: base main -> release/2, state -> CLEAN",
      "comment #21 deleted",
      "review #31 deleted",
      "feedback [PRRT_thread] #41 deleted",
      "thread PRRT_thread: reopened",
    ]);
    expect(monitorEventDetails(
      snapshot({ mergeableState: "dirty" }),
      snapshot({ mergeableState: "unknown" }),
    )).toEqual([]);
  });

  it("reports active review-comment deltas for reopened and resolved threads", () => {
    const reviewComments = [1, 2, 3, 4].map((id) => ({
      id,
      author: "reviewer",
      body: `Feedback ${id}`,
      createdAt: "2026-09-19T12:00:00.000Z",
      updatedAt: "2026-09-19T12:00:00.000Z",
      reactions: {},
      reactionDetails: [],
      path: "src/retry.ts",
      line: id,
    }));
    const partlyResolved = snapshot({
      reviewComments,
      threads: [
        { id: "thread-one", isResolved: false, commentIds: [1, 2] },
        { id: "thread-two", isResolved: true, commentIds: [3, 4] },
      ],
    });
    const allOpen = snapshot({
      reviewComments,
      threads: [
        { id: "thread-one", isResolved: false, commentIds: [1, 2] },
        { id: "thread-two", isResolved: false, commentIds: [3, 4] },
      ],
    });
    const allResolved = snapshot({
      reviewComments,
      threads: [
        { id: "thread-one", isResolved: true, commentIds: [1, 2] },
        { id: "thread-two", isResolved: true, commentIds: [3, 4] },
      ],
    });

    expect(monitorEventDetails(partlyResolved, allOpen)).toEqual([
      "active comments: +2, now 4",
      "thread thread-two: reopened",
    ]);
    expect(monitorEventDetails(allOpen, allResolved)).toEqual([
      "active comments: -4, now 0",
      "thread thread-one: resolved",
      "thread thread-two: resolved",
    ]);
  });

  it("reports deployment status in one detailed line", () => {
    const unchanged = snapshot();
    expect(monitorEventDetails(unchanged, unchanged, {
      githubEvent: "deployment_status",
      action: "created",
      payload: {
        deployment: { environment: "production", ref: "feature" },
        deployment_status: {
          state: "success",
          environment_url: "https://example.test/deployments/1",
        },
      },
    })).toEqual([
      "deployment: production (feature) -> success https://example.test/deployments/1",
    ]);
  });

  it("keeps full body records outside the bounded non-body detail budget", () => {
    expect(monitorReconciliationDetails(snapshot({ headRefName: null, headSha: null }))).toEqual([]);
    const comments = Array.from({ length: 30 }, (_, index) => ({
      id: index + 1,
      author: "reviewer",
      body: `feedback ${index} ${"x".repeat(1_000)}`,
      createdAt: "2026-09-19T12:00:00.000Z",
      updatedAt: "2026-09-19T12:00:00.000Z",
      reactions: {},
      reactionDetails: [],
    }));
    const details = monitorEventDetails(snapshot(), snapshot({ comments }));

    expect(details).toHaveLength(30);
    expect(details[0]).toBe(`comment #1 @reviewer: feedback 0 ${"x".repeat(1_000)}`);
    expect(details[29]).toBe(`comment #30 @reviewer: feedback 29 ${"x".repeat(1_000)}`);
    const removed = {
      id: 100,
      author: "reviewer",
      body: "removed comment",
      createdAt: "2026-09-19T12:00:00.000Z",
      updatedAt: "2026-09-19T12:00:00.000Z",
      reactions: {},
      reactionDetails: [],
    };
    expect(monitorEventDetails(
      snapshot({ comments: [removed] }),
      snapshot({ comments }),
    )).toContain("comment #100 deleted");


    const failedCheck = (id: number, name: string) => ({
      id,
      name,
      status: "completed",
      conclusion: "failure",
      completedAt: "2026-09-19T12:01:00.000Z",
      startedAt: "2026-09-19T12:00:00.000Z",
      url: null,
      kind: "check_run" as const,
    });
    const bounded = monitorEventDetails(
      snapshot({ comments: [removed] }),
      snapshot({
        checks: Array.from({ length: 30 }, (_, index) => failedCheck(index + 1, `CI-${index}`)),
        comments: [],
      }),
    );
    expect(bounded).toContain("+22 more checks");
    expect(bounded).toContain("comment #100 deleted");
    expect(bounded.length).toBeLessThanOrEqual(24);
    expect(bounded.join("").length).toBeLessThanOrEqual(3_900);
    const weighted = monitorEventDetails(
      snapshot({ headRefName: "before" }),
      snapshot({
        headRefName: "x".repeat(480),
        checks: Array.from(
          { length: 30 },
          (_, index) => failedCheck(
            index + 1,
            `${String(index).padStart(2, "0")}${"x".repeat(466)}`,
          ),
        ),
      }),
    );
    expect(weighted.at(-1)).toBe("+24 more changes");

    const unicodeDetails = monitorEventDetails(snapshot(), snapshot({
      comments: [{ ...comments[0], id: 99, body: `${"x".repeat(238)}😀z` }],
    }));
    expect(unicodeDetails[0]).toContain("😀z");

    expect(monitorEventDetails(
      snapshot(),
      snapshot({ checks: [failedCheck(1, "\u001b[31mCI\u001b[0m\nspoof")] }),
    )).toEqual(["checks: CIspoof -> fail"]);
    const sharedPrefix = "x".repeat(600);
    const duplicateAfterTruncation = monitorEventDetails(snapshot(), snapshot({
      checks: [
        failedCheck(2, `${sharedPrefix}A`),
        failedCheck(3, `${sharedPrefix}B`),
      ],
    }));
    expect(duplicateAfterTruncation).toHaveLength(1);
  });

  it("emits only the changed comment with its full multiline body and ID", () => {
    const existing = Array.from({ length: 20 }, (_, index) => ({
      id: index + 1,
      author: "reviewer",
      body: `old comment ${index + 1}`,
      createdAt: "2026-09-18T12:00:00.000Z",
      updatedAt: "2026-09-18T12:00:00.000Z",
      reactions: {},
      reactionDetails: [],
      htmlUrl: `https://github.com/owner/repo/pull/7#issuecomment-${index + 1}`,
    }));
    const body = `<!-- hidden -->Please \u001b[2Kcover the retry race\nbefore merging.\n${"long body ".repeat(80)}`;
    const newComment = {
      id: 21,
      author: "reviewer",
      body,
      createdAt: "2026-09-19T12:00:00.000Z",
      updatedAt: "2026-09-19T12:00:00.000Z",
      reactions: {},
      reactionDetails: [],
      htmlUrl: "https://github.com/owner/repo/pull/7#issuecomment-21",
    };

    expect(monitorEventDetails(
      snapshot({ comments: existing }),
      snapshot({ comments: [...existing, newComment] }),
    )).toEqual([
      `comment #21 @reviewer: ${body}`,
    ]);
  });

  it("omits the body delimiter for empty comments", () => {
    const empty = {
      id: 22,
      author: "reviewer",
      body: " \t",
      createdAt: "2026-09-19T12:00:00.000Z",
      updatedAt: "2026-09-19T12:00:00.000Z",
      reactions: {},
      reactionDetails: [],
    };
    expect(monitorEventDetails(snapshot(), snapshot({ comments: [empty] }))).toEqual([
      "comment #22 @reviewer",
    ]);
  });

  it("includes the changed review comment body, comment ID, and thread ID inline", () => {
    const reviewComment = {
      id: 21,
      author: "reviewer",
      body: "This retry can race the cancellation path.",
      createdAt: "2026-09-19T12:00:00.000Z",
      updatedAt: "2026-09-19T12:00:00.000Z",
      reactions: {},
      reactionDetails: [],
      path: "src/retry.ts",
      line: 44,
      startLine: 42,
      htmlUrl: "https://github.com/owner/repo/pull/7#discussion_r21",
    };
    const after = snapshot({
      reviewComments: [reviewComment],
      threads: [{ id: "PRRT_thread", isResolved: false, commentIds: [21] }],
    });

    expect(monitorEventDetails(snapshot(), after)).toEqual([
      "active comments: +1, now 1",
      "feedback [PRRT_thread] #21 src/retry.ts:42-44 @reviewer: This retry can race the cancellation path.",
    ]);
  });
  it("includes the full review body and omits its URL", () => {
    const body = `Review line one\n${"review body ".repeat(80)}`;
    const review = {
      id: 31,
      author: "reviewer",
      body,
      state: "CHANGES_REQUESTED",
      submittedAt: "2026-09-19T12:00:00.000Z",
      htmlUrl: "https://github.com/owner/repo/pull/7#pullrequestreview-31",
    };
    expect(monitorEventDetails(snapshot(), snapshot({ reviews: [review] }))).toEqual([
      `review #31 @reviewer CHANGES_REQUESTED: ${body}`,
    ]);
  });


  it("attributes reactions added to and removed from the PR body, comments, and inline feedback", () => {
    const comment = {
      id: 21,
      author: "bob",
      body: "Top-level note",
      createdAt: "2026-09-19T12:00:00.000Z",
      updatedAt: "2026-09-19T12:00:00.000Z",
      reactions: {},
      reactionDetails: [],
      htmlUrl: "https://github.com/owner/repo/pull/7#issuecomment-21",
    };
    const reviewComment = {
      ...comment,
      id: 41,
      author: "carol",
      path: "src/retry.ts",
      line: 12,
      htmlUrl: "https://github.com/owner/repo/pull/7#discussion_r41",
    };
    const before = snapshot({ comments: [comment], reviewComments: [reviewComment] });
    const after = snapshot({
      bodyReactions: { "+1": 1, total_count: 1 },
      bodyReactionDetails: [{ id: 900, content: "+1", author: "alice", authorId: 11, createdAt: "2026-09-19T12:05:00.000Z" }],
      comments: [{
        ...comment,
        reactions: { heart: 1, total_count: 1 },
        reactionDetails: [{ id: 901, content: "heart", author: "alice", authorId: 11, createdAt: "2026-09-19T12:06:00.000Z" }],
      }],
      reviewComments: [{
        ...reviewComment,
        reactions: { eyes: 1, total_count: 1 },
        reactionDetails: [{ id: 902, content: "eyes", author: "dave", authorId: 12, createdAt: "2026-09-19T12:07:00.000Z" }],
      }],
    });

    expect(monitorEventDetails(before, after)).toEqual([
      "reaction created: @alice THUMBS_UP on PR #7 @author https://github.com/owner/repo/pull/7",
      "reaction created: @alice HEART on comment #21 @bob https://github.com/owner/repo/pull/7#issuecomment-21",
      "reaction created: @dave EYES on feedback #41 @carol https://github.com/owner/repo/pull/7#discussion_r41",
    ]);
    expect(monitorEventDetails(after, before)).toEqual([
      "reaction deleted: @alice THUMBS_UP from PR #7 @author https://github.com/owner/repo/pull/7",
      "reaction deleted: @alice HEART from comment #21 @bob https://github.com/owner/repo/pull/7#issuecomment-21",
      "reaction deleted: @dave EYES from feedback #41 @carol https://github.com/owner/repo/pull/7#discussion_r41",
    ]);
    expect(snapshotChanges(before, after)).toEqual(["comments", "review_comments", "reactions"]);
  });

  it("suppresses reaction history only for reconciliation, not for targets new to a watch", () => {
    const reacted = {
      id: 21,
      author: "bob",
      body: "Top-level note",
      createdAt: "2026-09-19T12:00:00.000Z",
      updatedAt: "2026-09-19T12:00:00.000Z",
      reactions: { rocket: 1, total_count: 1 },
      reactionDetails: [{ id: 903, content: "rocket", author: "alice", authorId: 11, createdAt: "2026-09-19T12:08:00.000Z" }],
      htmlUrl: "https://github.com/owner/repo/pull/7#issuecomment-21",
    };
    const current = snapshot({
      bodyReactions: { hooray: 1, total_count: 1 },
      bodyReactionDetails: [{ id: 904, content: "hooray", author: "alice", authorId: 11, createdAt: "2026-09-19T12:09:00.000Z" }],
      comments: [reacted],
    });

    expect(monitorReconciliationDetails(current).some((line) => line.startsWith("reaction"))).toBe(false);
    expect(monitorEventDetails(null, current).some((line) => line.startsWith("reaction"))).toBe(false);
    // Within an ongoing watch the comment and the reaction it already carries are both news.
    expect(monitorEventDetails(snapshot(), current)).toEqual([
      "comment #21 @bob: Top-level note",
      "reaction created: @alice HOORAY on PR #7 @author https://github.com/owner/repo/pull/7",
      "reaction created: @alice ROCKET on comment #21 @bob https://github.com/owner/repo/pull/7#issuecomment-21",
    ]);
    // A target that disappeared is reported by its own deletion line, not by its reactions.
    expect(monitorEventDetails(current, snapshot())).toEqual([
      "comment #21 deleted",
      "reaction deleted: @alice HOORAY from PR #7 @author https://github.com/owner/repo/pull/7",
    ]);
  });

  it("reports a reaction swap on one target as a removal and an addition", () => {
    const laugh = { id: 905, content: "laugh", author: "alice", authorId: 11, createdAt: "2026-09-19T12:10:00.000Z" };
    const before = snapshot({
      bodyReactions: { laugh: 1, total_count: 1 },
      bodyReactionDetails: [laugh],
    });
    const after = snapshot({
      bodyReactions: { confused: 1, total_count: 1 },
      bodyReactionDetails: [{ id: 906, content: "confused", author: "erin", authorId: 13, createdAt: "2026-09-19T12:11:00.000Z" }],
    });

    expect(monitorEventDetails(before, after)).toEqual([
      "reaction created: @erin CONFUSED on PR #7 @author https://github.com/owner/repo/pull/7",
      "reaction deleted: @alice LAUGH from PR #7 @author https://github.com/owner/repo/pull/7",
    ]);
  });

  it("treats unknown reactions as a baseline and diffs the target from then on", () => {
    const reaction = { id: 907, content: "heart", author: "alice", authorId: 11, createdAt: "2026-09-19T12:12:00.000Z" };
    const counts = { heart: 1, total_count: 1 };
    // A snapshot persisted before individual reactions existed: counted, never enumerated.
    const legacy = snapshot({ bodyReactions: counts, bodyReactionDetails: undefined });
    const enriched = snapshot({ bodyReactions: counts, bodyReactionDetails: [reaction] });
    const added = snapshot({
      bodyReactions: { heart: 1, rocket: 1, total_count: 2 },
      bodyReactionDetails: [reaction, { id: 908, content: "rocket", author: "dave", authorId: 12, createdAt: "2026-09-19T12:13:00.000Z" }],
    });

    // Learning the baseline is neither a reaction change nor reportable activity.
    expect(monitorEventDetails(legacy, enriched)).toEqual([]);
    expect(snapshotChanges(legacy, enriched)).toEqual([]);
    expect(monitorEventDetails(enriched, added)).toEqual([
      "reaction created: @dave ROCKET on PR #7 @author https://github.com/owner/repo/pull/7",
    ]);
    // A read that failed leaves the target unknown again; that is not a deletion.
    const unread = snapshot({ bodyReactions: { heart: 1, rocket: 1, total_count: 2 }, bodyReactionDetails: undefined });
    expect(monitorEventDetails(added, unread)).toEqual([]);
  });

  it("identifies a reaction actor by GitHub ID, so a rename is not a swap", () => {
    const before = snapshot({
      bodyReactions: { heart: 1, total_count: 1 },
      bodyReactionDetails: [{ id: 909, content: "heart", author: "Alice", authorId: 11, createdAt: "2026-09-19T12:14:00.000Z" }],
    });
    const renamed = snapshot({
      bodyReactions: { heart: 1, total_count: 1 },
      bodyReactionDetails: [{ id: 909, content: "heart", author: "alice-codes", authorId: 11, createdAt: "2026-09-19T12:14:00.000Z" }],
    });

    expect(monitorEventDetails(before, renamed)).toEqual([]);
  });

  it("enriches a reaction record that predates actor IDs without reporting a swap", () => {
    const legacyDetails = [{ id: 909, content: "heart", author: "Alice", createdAt: "2026-09-19T12:14:00.000Z" }];
    // Persisted before actor IDs were stored: the record has no `authorId` at all.
    const legacy = snapshot({
      bodyReactions: { heart: 1, total_count: 1 },
      bodyReactionDetails: legacyDetails as PullRequestSnapshot["bodyReactionDetails"],
    });
    const enriched = snapshot({
      bodyReactions: { heart: 1, total_count: 1 },
      bodyReactionDetails: [{ id: 909, content: "heart", author: "alice", authorId: 11, createdAt: "2026-09-19T12:14:00.000Z" }],
    });
    const swapped = snapshot({
      bodyReactions: { heart: 1, total_count: 1 },
      bodyReactionDetails: [{ id: 909, content: "heart", author: "erin", authorId: 14, createdAt: "2026-09-19T12:15:00.000Z" }],
    });

    expect(monitorEventDetails(legacy, enriched)).toEqual([]);
    expect(monitorEventDetails(legacy, swapped)).toEqual([
      "reaction created: @erin HEART on PR #7 @author https://github.com/owner/repo/pull/7",
      "reaction deleted: @Alice HEART from PR #7 @author https://github.com/owner/repo/pull/7",
    ]);
  });

  it("merges reaction knowledge into the base snapshot without taking anything else from the source", () => {
    const reaction = { id: 910, content: "heart", author: "alice", authorId: 11, createdAt: "2026-09-19T12:16:00.000Z" };
    const comment = {
      id: 21,
      author: "bob",
      body: "Top-level note",
      createdAt: "2026-09-19T12:00:00.000Z",
      updatedAt: "2026-09-19T12:00:00.000Z",
      reactions: { rocket: 1, total_count: 1 },
      htmlUrl: "https://github.com/owner/repo/pull/7#issuecomment-21",
    };
    const commentReaction = { id: 911, content: "rocket", author: "dave", authorId: 12, createdAt: "2026-09-19T12:17:00.000Z" };
    const base = snapshot({
      title: "renamed while a refresh was in flight",
      headSha: "pushed",
      checks: [{ id: 1, name: "CI", status: "completed", conclusion: "failure", completedAt: "now", startedAt: "then", url: null, kind: "check_run" }],
      fetchedAt: "2026-09-19T12:30:00.000Z",
      bodyReactions: { heart: 1, total_count: 1 },
      bodyReactionDetails: undefined,
      comments: [comment],
    });
    const source = snapshot({
      bodyReactions: { heart: 1, total_count: 1 },
      bodyReactionDetails: [reaction],
      comments: [{ ...comment, reactionDetails: [commentReaction] }],
    });

    const merged = mergeReactionKnowledge(base, source);
    expect(merged).toMatchObject({
      title: base.title,
      headSha: "pushed",
      checks: base.checks,
      fetchedAt: "2026-09-19T12:30:00.000Z",
      bodyReactionDetails: [reaction],
      comments: [{ reactionDetails: [commentReaction] }],
    });
    // Known details are never replaced, and a snapshot that learns nothing is untouched.
    expect(mergeReactionKnowledge(source, base)).toBe(source);
    expect(mergeReactionKnowledge(merged, source)).toBe(merged);
  });

  it("merges and persists resumable reaction pagination progress", () => {
    const unknown = snapshot({
      bodyReactions: { heart: 6_500, total_count: 6_500 },
      bodyReactionDetails: undefined,
    });
    const firstPage = {
      records: [{ id: 1, content: "heart", author: "alice", authorId: 11, createdAt: "now" }],
      nextUrl: "https://api.github.com/reactions?page=2",
    };
    const partial = snapshot({
      bodyReactions: unknown.bodyReactions,
      bodyReactionDetails: undefined,
      bodyReactionProgress: firstPage,
      bodyReactionDetailsReadAt: "2026-09-03T00:01:00.000Z",
    });
    expect(reactionKnowledgeAdvanced(unknown, partial)).toBe(true);
    expect(mergeReactionKnowledge(unknown, partial).bodyReactionProgress).toEqual(firstPage);

    // A later read of the same target supersedes the cursor it started from, and the merge
    // carries that read's time so the next overlapping refresh can still be ordered.
    const complete = snapshot({
      fetchedAt: "2026-09-03T00:05:00.000Z",
      bodyReactions: { heart: 1, total_count: 1 },
      bodyReactionDetails: firstPage.records,
      bodyReactionDetailsReadAt: "2026-09-03T00:04:00.000Z",
    });
    const completed = mergeReactionKnowledge(partial, complete);
    expect(reactionKnowledgeAdvanced(partial, complete)).toBe(true);
    expect(completed.bodyReactionDetails).toEqual(firstPage.records);
    expect(completed.bodyReactionProgress).toBeUndefined();
    expect(completed.bodyReactionDetailsReadAt).toBe("2026-09-03T00:04:00.000Z");
  });

  it("keeps a live reaction cursor over stored details the newer read contradicts", () => {
    const heart = { id: 1, content: "heart", author: "alice", authorId: 11, createdAt: "now" };
    const stored = snapshot({
      bodyReactions: { heart: 1, total_count: 1 },
      bodyReactionDetails: [heart],
      bodyReactionDetailsReadAt: "2026-09-03T00:01:00.000Z",
    });
    const cursor = {
      records: [heart],
      nextUrl: "https://api.github.com/repos/owner/repo/issues/7/reactions?per_page=100&page=2",
    };
    // The target outgrew one refresh's request budget, so this refresh holds only a cursor
    // into counts the stored details predate.
    const refreshed = snapshot({
      fetchedAt: "2026-09-03T00:05:00.000Z",
      bodyReactions: { heart: 6_500, total_count: 6_500 },
      bodyReactionDetails: undefined,
      bodyReactionProgress: cursor,
      bodyReactionDetailsReadAt: "2026-09-03T00:04:00.000Z",
    });

    const merged = mergeReactionKnowledge(refreshed, stored);
    expect(merged.bodyReactionProgress).toEqual(cursor);
    expect(merged.bodyReactionDetails).toBeUndefined();
    expect(merged.bodyReactions).toEqual({ heart: 6_500, total_count: 6_500 });
    // Copying the stored pair back would erase the cursor and report no change, so the
    // write would be dropped and every later refresh would restart at page one.
    expect(snapshotChanges(stored, merged)).toEqual(["reactions"]);
  });

  it("prefers a newer cursor over a longer cursor for different aggregate counts", () => {
    const heart = { id: 1, content: "heart", author: "alice", authorId: 11, createdAt: "now" };
    const rocket = { id: 2, content: "rocket", author: "bob", authorId: 12, createdAt: "now" };
    const olderLonger = snapshot({
      bodyReactions: { heart: 1, rocket: 1, total_count: 2 },
      bodyReactionsObservedAt: "2026-09-03T00:01:00.000Z",
      bodyReactionDetails: undefined,
      bodyReactionDetailsReadAt: "2026-09-03T00:01:00.000Z",
      bodyReactionProgress: {
        records: [heart, rocket],
        nextUrl: "https://api.github.com/reactions?page=3",
      },
    });
    const newerShorter = snapshot({
      bodyReactions: { heart: 1, total_count: 1 },
      bodyReactionsObservedAt: "2026-09-03T00:02:00.000Z",
      bodyReactionDetails: undefined,
      bodyReactionDetailsReadAt: "2026-09-03T00:02:00.000Z",
      bodyReactionProgress: {
        records: [heart],
        nextUrl: "https://api.github.com/reactions?page=2",
      },
    });

    const merged = mergeReactionKnowledge(olderLonger, newerShorter);
    expect(merged.bodyReactions).toEqual(newerShorter.bodyReactions);
    expect(merged.bodyReactionProgress).toEqual(newerShorter.bodyReactionProgress);
    expect(merged.bodyReactionDetailsReadAt).toBe("2026-09-03T00:02:00.000Z");
  });

  it("keeps a newer partial cursor over stale complete details", () => {
    const heart = { id: 1, content: "heart", author: "alice", authorId: 11, createdAt: "now" };
    const staleComplete = snapshot({
      fetchedAt: "2026-09-03T00:05:00.000Z",
      bodyReactions: { heart: 1, total_count: 1 },
      bodyReactionsObservedAt: "2026-09-03T00:01:00.000Z",
      bodyReactionDetails: [heart],
      bodyReactionDetailsReadAt: "2026-09-03T00:01:00.000Z",
    });
    const newerPartial = snapshot({
      fetchedAt: "2026-09-03T00:04:00.000Z",
      bodyReactions: { heart: 101, total_count: 101 },
      bodyReactionsObservedAt: "2026-09-03T00:02:00.000Z",
      bodyReactionDetails: undefined,
      bodyReactionDetailsReadAt: "2026-09-03T00:03:00.000Z",
      bodyReactionProgress: {
        records: [heart],
        nextUrl: "https://api.github.com/reactions?page=2",
      },
    });

    const merged = mergeReactionKnowledge(staleComplete, newerPartial);
    expect(merged.bodyReactions).toEqual(newerPartial.bodyReactions);
    expect(merged.bodyReactionDetails).toBeUndefined();
    expect(merged.bodyReactionProgress).toEqual(newerPartial.bodyReactionProgress);
    expect(merged.bodyReactionDetailsReadAt).toBe("2026-09-03T00:03:00.000Z");
  });

  it("orders reaction details by each target's own read, not by the snapshot around it", () => {
    const heart = { id: 1, content: "heart", author: "alice", authorId: 11, createdAt: "2026-09-03T00:00:30.000Z" };
    const rocket = { id: 2, content: "rocket", author: "dave", authorId: 12, createdAt: "2026-09-03T00:02:30.000Z" };
    const eyes = { id: 3, content: "eyes", author: "erin", authorId: 13, createdAt: "2026-09-03T00:04:30.000Z" };
    const comment = {
      id: 21,
      author: "bob",
      body: "Top-level note",
      createdAt: "2026-09-03T00:00:00.000Z",
      updatedAt: "2026-09-03T00:00:00.000Z",
      reactions: { heart: 1, total_count: 1 },
      htmlUrl: "https://github.com/owner/repo/pull/7#issuecomment-21",
    };
    const both = { heart: 1, rocket: 1, total_count: 2 };
    // A refresh whose wave ended at 00:04 read the body at 00:03 and the comment at 00:02,
    // and committed first.
    const committed = snapshot({
      fetchedAt: "2026-09-03T00:04:00.000Z",
      bodyReactions: both,
      bodyReactionDetails: [heart, rocket],
      bodyReactionDetailsReadAt: "2026-09-03T00:03:00.000Z",
      comments: [{ ...comment, reactionDetails: [heart], reactionDetailsReadAt: "2026-09-03T00:02:00.000Z" }],
    });
    // This refresh's wave ended later, at 00:06, but its body read succeeded back at 00:01,
    // before the rocket existed. Only its comment read, at 00:05, is the newer one.
    const commentBoth = { ...comment, reactions: both, reactionDetails: [heart, eyes] };
    const overlapping = snapshot({
      fetchedAt: "2026-09-03T00:06:00.000Z",
      title: "renamed while a refresh was in flight",
      bodyReactions: { heart: 1, total_count: 1 },
      bodyReactionDetails: [heart],
      bodyReactionDetailsReadAt: "2026-09-03T00:01:00.000Z",
      comments: [{
        ...commentBoth,
        reactions: { heart: 1, eyes: 1, total_count: 2 },
        reactionDetailsReadAt: "2026-09-03T00:05:00.000Z",
      }],
    });

    const merged = mergeReactionKnowledge(overlapping, committed);
    // The body keeps the read that returned later even though it arrived in the older wave.
    expect(merged.bodyReactionDetails).toEqual([heart, rocket]);
    expect(merged.bodyReactions).toEqual(both);
    expect(merged.bodyReactionDetailsReadAt).toBe("2026-09-03T00:03:00.000Z");
    // The same snapshot still contributes the comment read that did return later.
    expect(merged.comments[0].reactionDetails).toEqual([heart, eyes]);
    expect(merged.comments[0].reactionDetailsReadAt).toBe("2026-09-03T00:05:00.000Z");
    // Ordering by `fetchedAt` would drop the rocket and publish it as a deletion.
    expect(merged.title).toBe("renamed while a refresh was in flight");
    // The comment's summary counts moved with its newer read, hence `comments` too.
    expect(snapshotChanges(committed, merged)).toEqual(["description", "comments", "reactions"]);
    // Exactly one reaction line, for the reaction the newer read found: no deletion of the
    // rocket the older body read predates.
    expect(monitorEventDetails(committed, merged)).toEqual([
      "reaction created: @erin EYES on comment #21 @bob https://github.com/owner/repo/pull/7#issuecomment-21",
    ]);

    // With the stored snapshot as the base - the silent enrichment that announces nothing -
    // neither read moves: the older body read must not regress what is committed, and the
    // newer comment read is left to the refresh that can publish the reaction it found
    // rather than being folded in behind an event nobody receives.
    expect(mergeReactionKnowledge(committed, overlapping)).toBe(committed);
  });

  it("never lets borrowed reaction details overwrite what a concurrent write learned", () => {
    const heart = { id: 1, content: "heart", author: "alice", authorId: 11, createdAt: "2026-09-03T00:01:00.000Z" };
    const rocket = { id: 2, content: "rocket", author: "dave", authorId: 12, createdAt: "2026-09-03T00:02:00.000Z" };
    const comment = {
      id: 21,
      author: "bob",
      body: "Top-level note",
      createdAt: "2026-09-03T00:00:00.000Z",
      updatedAt: "2026-09-03T00:00:00.000Z",
      reactions: { heart: 1, total_count: 1 },
      htmlUrl: "https://github.com/owner/repo/pull/7#issuecomment-21",
    };
    const both = { heart: 1, rocket: 1, total_count: 2 };
    // Another refresh read the added reaction and committed it first.
    const committed = snapshot({
      bodyReactions: both,
      bodyReactionDetails: [heart, rocket],
      comments: [{ ...comment, reactions: both, reactionDetails: [heart, rocket] }],
    });
    // This refresh saw the counts it started with, so it reused its details unread: nothing
    // it carries is evidence that the reaction the other writer read is gone.
    const borrowed = snapshot({
      fetchedAt: "2026-09-03T00:03:00.000Z",
      title: "renamed while a refresh was in flight",
      bodyReactions: { heart: 1, total_count: 1 },
      bodyReactionDetails: [heart],
      bodyReactionDetailsState: "borrowed",
      comments: [{ ...comment, reactionDetails: [heart], reactionDetailsState: "borrowed" }],
    });

    const merged = mergeReactionKnowledge(borrowed, committed);
    expect(merged.title).toBe("renamed while a refresh was in flight");
    expect(merged.bodyReactionDetails).toEqual([heart, rocket]);
    expect(merged.bodyReactions).toEqual(both);
    expect(merged.comments[0].reactionDetails).toEqual([heart, rocket]);
    expect(merged.comments[0].reactions).toEqual(both);
    // No false deletion, and the borrow is resolved rather than persisted.
    expect(snapshotChanges(committed, merged)).toEqual(["description"]);
    expect(monitorEventDetails(committed, merged).some((line) => line.startsWith("reaction"))).toBe(false);
    expect(merged.bodyReactionDetailsState).toBeUndefined();
    expect(merged.comments[0].reactionDetailsState).toBeUndefined();

    // The same holds when the concurrent writer is still paginating that target: borrowed
    // details must not erase a cursor either.
    const cursor = { records: [heart], nextUrl: "https://api.github.com/reactions?page=2" };
    const paginating = snapshot({
      bodyReactions: both,
      bodyReactionDetails: undefined,
      bodyReactionProgress: cursor,
    });
    const resumable = mergeReactionKnowledge(borrowed, paginating);
    expect(resumable.bodyReactionProgress).toEqual(cursor);
    expect(resumable.bodyReactionDetails).toBeUndefined();
  });

  it("resolves borrowed reaction details against the counts the write lands on", () => {
    const heart = { id: 1, content: "heart", author: "alice", authorId: 11, createdAt: "now" };
    const borrowed = snapshot({
      fetchedAt: "2026-09-03T00:03:00.000Z",
      title: "still moving",
      bodyReactions: { heart: 1, total_count: 1 },
      bodyReactionDetails: [heart],
      bodyReactionDetailsState: "borrowed",
    });

    // Counts the committed state agrees with confirm the borrow, so the baseline stands.
    const agreeing = snapshot({ bodyReactions: { heart: 1, total_count: 1 }, bodyReactionDetails: [heart] });
    const confirmed = mergeReactionKnowledge(borrowed, agreeing);
    expect(confirmed.bodyReactionDetails).toEqual([heart]);
    expect(confirmed.bodyReactionDetailsState).toBeUndefined();

    // Counts it disagrees with do not, and there is nothing read to fall back on: the target
    // goes back to unknown so the next refresh reads it instead of inheriting the borrow.
    const contradicting = snapshot({
      bodyReactions: { heart: 1, rocket: 1, total_count: 2 },
      bodyReactionDetails: undefined,
    });
    const unresolved = mergeReactionKnowledge(borrowed, contradicting);
    expect(unresolved.bodyReactionDetails).toBeUndefined();
    expect(unresolved.bodyReactionDetailsState).toBeUndefined();
    expect(monitorEventDetails(contradicting, unresolved).some((line) => line.startsWith("reaction"))).toBe(false);
  });

  it("orders a terminal disagreement by when each side observed the counts", () => {
    const alice = { id: 1, content: "heart", author: "alice", authorId: 11, createdAt: "2026-09-03T00:01:00.000Z" };
    const bob = { id: 2, content: "heart", author: "bob", authorId: 12, createdAt: "2026-09-03T00:02:00.000Z" };
    // A merge whose counts matched its starting snapshot, so its details were never re-read.
    const merged = snapshot({
      state: "closed",
      merged: true,
      mergedAt: "2026-09-03T00:04:00.000Z",
      fetchedAt: "2026-09-03T00:04:00.000Z",
      bodyReactions: { heart: 1, total_count: 1 },
      bodyReactionsObservedAt: "2026-09-03T00:04:00.000Z",
      bodyReactionDetails: [alice],
      bodyReactionDetailsState: "borrowed",
      bodyReactionDetailsReadAt: "2026-09-03T00:01:30.000Z",
    });

    // The committed pair was observed before the merge's counts: no refresh will ever look
    // again, so the last observation stands and the reactions behind it stay unattributed.
    const older = snapshot({
      fetchedAt: "2026-09-03T00:03:00.000Z",
      bodyReactions: { heart: 2, total_count: 2 },
      bodyReactionsObservedAt: "2026-09-03T00:03:00.000Z",
      bodyReactionDetails: [alice, bob],
      bodyReactionDetailsReadAt: "2026-09-03T00:03:00.000Z",
    });
    const settled = mergeReactionKnowledge(merged, older);
    expect(settled.bodyReactions).toEqual({ heart: 1, total_count: 1 });
    expect(settled.bodyReactionDetails).toBeUndefined();
    expect(settled.bodyReactionDetailsState).toBeUndefined();
    expect(monitorEventDetails(older, settled).filter((line) => line.startsWith("reaction"))).toEqual([
      "reaction counts: HEART 2 -> 1 on PR #7 @author https://github.com/owner/repo/pull/7 (attribution unavailable)",
    ]);

    // A committed observation that arrived after the merge's own is the later word on the
    // target, and it comes with details: terminal or not, that pair wins.
    const newer = snapshot({
      fetchedAt: "2026-09-03T00:03:00.000Z",
      bodyReactions: { heart: 2, total_count: 2 },
      bodyReactionsObservedAt: "2026-09-03T00:05:00.000Z",
      bodyReactionDetails: [alice, bob],
      bodyReactionDetailsReadAt: "2026-09-03T00:05:00.000Z",
    });
    const adopted = mergeReactionKnowledge(merged, newer);
    expect(adopted.bodyReactions).toEqual({ heart: 2, total_count: 2 });
    expect(adopted.bodyReactionDetails).toEqual([alice, bob]);
  });

  it("settles a resumed read that disproved itself against the read and the counts around it", () => {
    const alice = { id: 1, content: "heart", author: "alice", authorId: 11, createdAt: "2026-09-03T00:01:00.000Z" };
    const bob = { id: 2, content: "heart", author: "bob", authorId: 12, createdAt: "2026-09-03T00:02:00.000Z" };
    // This refresh resumed a committed cursor and its suffix contradicted its own counts, so
    // the prefix behind it - here and in storage - cannot be part of any coherent read.
    const disproved = {
      bodyReactions: { heart: 1, total_count: 1 },
      bodyReactionsObservedAt: "2026-09-03T00:04:00.000Z",
      bodyReactionDetails: undefined,
      bodyReactionDetailsState: "invalidated" as const,
      bodyReactionDetailsReadAt: "2026-09-03T00:04:10.000Z",
    };
    // Committed while it was in flight: a slow read that finished later still describes the
    // target, even though the summary it answers was observed before this refresh's.
    const committed = snapshot({
      fetchedAt: "2026-09-03T00:03:00.000Z",
      bodyReactions: { heart: 2, total_count: 2 },
      bodyReactionsObservedAt: "2026-09-03T00:03:00.000Z",
      bodyReactionDetails: [alice, bob],
      bodyReactionDetailsReadAt: "2026-09-03T00:05:00.000Z",
    });
    const watching = mergeReactionKnowledge(
      snapshot({ fetchedAt: "2026-09-03T00:04:00.000Z", ...disproved }),
      committed,
    );
    expect(watching.bodyReactions).toEqual({ heart: 2, total_count: 2 });
    expect(watching.bodyReactionDetails).toEqual([alice, bob]);
    expect(watching.bodyReactionDetailsState).toBeUndefined();

    // Past a merge the same pair loses: nothing will read this target again, so the counts
    // this refresh observed last stand alone and the reactions behind them go unattributed.
    const merged = snapshot({
      state: "closed",
      merged: true,
      mergedAt: "2026-09-03T00:04:00.000Z",
      fetchedAt: "2026-09-03T00:04:00.000Z",
      ...disproved,
    });
    const settled = mergeReactionKnowledge(merged, committed);
    expect(settled.bodyReactions).toEqual({ heart: 1, total_count: 1 });
    expect(settled.bodyReactionDetails).toBeUndefined();
    expect(settled.bodyReactionProgress).toBeUndefined();
    expect(settled.bodyReactionDetailsState).toBeUndefined();
    expect(monitorEventDetails(committed, settled).filter((line) => line.startsWith("reaction"))).toEqual([
      "reaction counts: HEART 2 -> 1 on PR #7 @author https://github.com/owner/repo/pull/7 (attribution unavailable)",
    ]);
  });

  it("keeps terminal counts ahead of a stored cursor whose last page returned later", () => {
    const alice = { id: 1, content: "heart", author: "alice", authorId: 11, createdAt: "2026-09-03T00:01:00.000Z" };
    const bob = { id: 2, content: "heart", author: "bob", authorId: 12, createdAt: "2026-09-03T00:02:00.000Z" };
    // The merge read this target itself: one heart, seen after every other observation here.
    const merged = snapshot({
      state: "closed",
      merged: true,
      mergedAt: "2026-09-03T00:04:00.000Z",
      fetchedAt: "2026-09-03T00:04:00.000Z",
      bodyReactions: { heart: 1, total_count: 1 },
      bodyReactionsObservedAt: "2026-09-03T00:04:00.000Z",
      bodyReactionDetails: [alice],
      bodyReactionDetailsReadAt: "2026-09-03T00:04:00.000Z",
    });
    // Committed in the meantime: an unfinished read of the counts the merge has already left
    // behind, whose last page happened to come back after the merge's read did.
    const partial = snapshot({
      fetchedAt: "2026-09-03T00:03:00.000Z",
      bodyReactions: { heart: 2, total_count: 2 },
      bodyReactionsObservedAt: "2026-09-03T00:03:00.000Z",
      bodyReactionDetails: undefined,
      bodyReactionDetailsReadAt: "2026-09-03T00:05:00.000Z",
      bodyReactionProgress: {
        records: [alice, bob],
        nextUrl: "https://api.github.com/repos/owner/repo/issues/7/reactions?per_page=100&page=2",
      },
    });
    const settled = mergeReactionKnowledge(merged, partial);
    // Nothing will resume that cursor, and the aggregate behind it is the older one: taking
    // either would leave the watch permanently stating a reaction state it has moved past.
    expect(settled.bodyReactions).toEqual({ heart: 1, total_count: 1 });
    expect(settled.bodyReactionProgress).toBeUndefined();
    expect(settled.bodyReactionDetails).toEqual([alice]);
    // Who holds the remaining heart is known; who removed the other one never will be, and
    // this is the last event on the pull request, so the movement is stated unattributed.
    expect(monitorEventDetails(partial, settled).filter((line) => line.startsWith("reaction"))).toEqual([
      "reaction counts: HEART 2 -> 1 on PR #7 @author https://github.com/owner/repo/pull/7 (attribution unavailable)",
    ]);
  });

  it("verifies GitHub's HMAC signature and rejects tampering", async () => {
    const body = JSON.stringify({ action: "opened" });
    const signature = `sha256=${await hmacSha256Hex("secret", body)}`;
    await expect(verifyGithubSignature(body, signature, "secret")).resolves.toBe(true);
    await expect(verifyGithubSignature(`${body}!`, signature, "secret")).resolves.toBe(false);
    await expect(verifyGithubSignature(body, "sha1=bad", "secret")).resolves.toBe(false);
  });
});
