import { describe, expect, it } from "vitest";
import { hmacSha256Hex, verifyGithubSignature } from "../src/crypto";
import {
  eventPullRequestNumbers,
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

  it("coalesces a check rerun into one start and one terminal summary", () => {
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
      "checks: CI -> pending, Lint -> pending",
    ]);
    expect(monitorEventDetails(started, partial)).toEqual([]);
    expect(monitorEventDetails(partial, finished)).toEqual([
      "checks: CI -> pass, Lint -> pass",
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

  it("omits unavailable head references and bounds persisted monitor details", () => {
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

    expect(details.length).toBeLessThanOrEqual(24);
    expect(details.join("").length).toBeLessThanOrEqual(3_900);
    expect(details.at(-1)).toMatch(/^\+\d+ more changes$/u);
    const unicodeDetails = monitorEventDetails(snapshot(), snapshot({
      comments: [{ ...comments[0], id: 99, body: `${"x".repeat(238)}😀z` }],
    }));
    expect([...unicodeDetails.join("")].some((character) => {
      const code = character.charCodeAt(0);
      return character.length === 1 && code >= 0xd800 && code <= 0xdfff;
    })).toBe(false);
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

  it("emits only the changed comment body after a PR accumulates many comments", () => {
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
    const newComment = {
      id: 21,
      author: "reviewer",
      body: "<!-- hidden -->Please \u001b[2Kcover the retry race\nbefore merging.",
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
      "comment #21 @reviewer https://github.com/owner/repo/pull/7#issuecomment-21: Please cover the retry race before merging.",
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
      "feedback [PRRT_thread] #21 src/retry.ts:42-44 @reviewer https://github.com/owner/repo/pull/7#discussion_r21: This retry can race the cancellation path.",
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
      bodyReactionDetails: [{ id: 900, content: "+1", author: "alice", createdAt: "2026-09-19T12:05:00.000Z" }],
      comments: [{
        ...comment,
        reactions: { heart: 1, total_count: 1 },
        reactionDetails: [{ id: 901, content: "heart", author: "alice", createdAt: "2026-09-19T12:06:00.000Z" }],
      }],
      reviewComments: [{
        ...reviewComment,
        reactions: { eyes: 1, total_count: 1 },
        reactionDetails: [{ id: 902, content: "eyes", author: "dave", createdAt: "2026-09-19T12:07:00.000Z" }],
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
      reactionDetails: [{ id: 903, content: "rocket", author: "alice", createdAt: "2026-09-19T12:08:00.000Z" }],
      htmlUrl: "https://github.com/owner/repo/pull/7#issuecomment-21",
    };
    const current = snapshot({
      bodyReactions: { hooray: 1, total_count: 1 },
      bodyReactionDetails: [{ id: 904, content: "hooray", author: "alice", createdAt: "2026-09-19T12:09:00.000Z" }],
      comments: [reacted],
    });

    expect(monitorReconciliationDetails(current).some((line) => line.startsWith("reaction"))).toBe(false);
    expect(monitorEventDetails(null, current).some((line) => line.startsWith("reaction"))).toBe(false);
    // Within an ongoing watch the comment and the reaction it already carries are both news.
    expect(monitorEventDetails(snapshot(), current)).toEqual([
      "comment #21 @bob https://github.com/owner/repo/pull/7#issuecomment-21: Top-level note",
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
    const laugh = { id: 905, content: "laugh", author: "alice", createdAt: "2026-09-19T12:10:00.000Z" };
    const before = snapshot({
      bodyReactions: { laugh: 1, total_count: 1 },
      bodyReactionDetails: [laugh],
    });
    const after = snapshot({
      bodyReactions: { confused: 1, total_count: 1 },
      bodyReactionDetails: [{ id: 906, content: "confused", author: "erin", createdAt: "2026-09-19T12:11:00.000Z" }],
    });

    expect(monitorEventDetails(before, after)).toEqual([
      "reaction created: @erin CONFUSED on PR #7 @author https://github.com/owner/repo/pull/7",
      "reaction deleted: @alice LAUGH from PR #7 @author https://github.com/owner/repo/pull/7",
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
