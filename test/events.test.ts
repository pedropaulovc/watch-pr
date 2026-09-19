import { describe, expect, it } from "vitest";
import { hmacSha256Hex, verifyGithubSignature } from "../src/crypto";
import {
  eventPullRequestNumbers,
  monitorEventDetails,
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
      "checks: rerun started (pending: CI, Lint)",
    ]);
    expect(monitorEventDetails(started, partial)).toEqual([]);
    expect(monitorEventDetails(partial, finished)).toEqual([
      "checks: all terminal (pass: 2, fail: 0, skipping: 0, cancel: 0)",
    ]);
  });

  it("emits only the changed comment body after a PR accumulates many comments", () => {
    const existing = Array.from({ length: 20 }, (_, index) => ({
      id: index + 1,
      author: "reviewer",
      body: `old comment ${index + 1}`,
      createdAt: "2026-09-18T12:00:00.000Z",
      updatedAt: "2026-09-18T12:00:00.000Z",
      reactions: {},
      htmlUrl: `https://github.com/owner/repo/pull/7#issuecomment-${index + 1}`,
    }));
    const newComment = {
      id: 21,
      author: "reviewer",
      body: "<!-- hidden -->Please cover the retry race\nbefore merging.",
      createdAt: "2026-09-19T12:00:00.000Z",
      updatedAt: "2026-09-19T12:00:00.000Z",
      reactions: {},
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
      "feedback [PRRT_thread] #21 src/retry.ts:42-44 @reviewer https://github.com/owner/repo/pull/7#discussion_r21: This retry can race the cancellation path.",
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
