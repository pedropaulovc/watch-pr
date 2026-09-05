import { describe, expect, it } from "vitest";
import { hmacSha256Hex, verifyGithubSignature } from "../src/crypto";
import { eventPullRequestNumbers, parseResourceUri, resourceUri, snapshotChanges, watchKey } from "../src/events";
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
    expect(eventPullRequestNumbers("status", payload, ["owner/repo#2", "owner/repo#7", "other/repo#9"])).toEqual([2, 7]);
  });

  it("routes issue comments only when the issue is a pull request", () => {
    const watched = ["owner/repo#7", "owner/repo#9"];
    expect(eventPullRequestNumbers("issue_comment", {
      repository: { full_name: "owner/repo" },
      issue: { number: 7 },
    }, watched)).toEqual([]);
    expect(eventPullRequestNumbers("issue_comment", {
      repository: { full_name: "owner/repo" },
      issue: { number: 9, pull_request: { url: "https://api.github.com/repos/owner/repo/pulls/9" } },
    }, watched)).toEqual([9]);
  });

  it("fans commit comments and merge-group deliveries out to watched repository PRs", () => {
    const watched = ["owner/repo#2", "owner/repo#7", "other/repo#9"];
    const payload = { repository: { full_name: "owner/repo" }, comment: { body: "commit note" } };
    expect(eventPullRequestNumbers("commit_comment", payload, watched)).toEqual([2, 7]);
    expect(eventPullRequestNumbers("merge_group", payload, watched)).toEqual([2, 7]);
  });
  it("routes linked webhook deliveries and filters explicit PR associations", () => {
    const watched = ["owner/repo#2", "owner/repo#7", "other/repo#9"];
    const directPayload = { repository: { full_name: "owner/repo" }, pull_request: { number: 7 } };
    for (const eventName of ["pull_request", "pull_request_review", "pull_request_review_comment", "pull_request_review_thread"]) {
      expect(eventPullRequestNumbers(eventName, directPayload, watched)).toEqual([7]);
    }
    expect(eventPullRequestNumbers("check_run", {
      repository: { full_name: "owner/repo" },
      check_run: { pull_requests: [{ number: 7 }, { number: 99 }] },
    }, watched)).toEqual([7]);
    expect(eventPullRequestNumbers("check_suite", {
      repository: { full_name: "owner/repo" },
      check_suite: { pull_requests: [{ number: 2 }] },
    }, watched)).toEqual([2]);
    expect(eventPullRequestNumbers("status", {
      repository: { full_name: "owner/repo" },
      status: { pull_requests: [{ number: 7 }] },
    }, watched)).toEqual([7]);
    expect(eventPullRequestNumbers("deployment_status", {
      repository: { full_name: "owner/repo" },
      deployment_status: { pull_requests: [{ number: 2 }] },
    }, watched)).toEqual([2]);
    expect(eventPullRequestNumbers("deployment", {
      repository: { full_name: "owner/repo" },
      deployment: { pull_requests: [{ number: 7 }] },
    }, watched)).toEqual([7]);
    expect(eventPullRequestNumbers("check_run", {
      repository: { full_name: "owner/repo" },
      check_run: { pull_requests: [] },
    }, watched)).toEqual([]);
    expect(eventPullRequestNumbers("push", { repository: { full_name: "owner/repo" } }, watched)).toEqual([2, 7]);
    expect(eventPullRequestNumbers("merge_group", { repository: { full_name: "owner/repo" } }, watched)).toEqual([2, 7]);
  });

  it("detects description, mergeability, review, check, and reaction changes", () => {
    const before = snapshot();
    const after = snapshot({ body: "updated", mergeable: false, mergeableState: "dirty", bodyReactions: { eyes: 1 }, checks: [{ id: 1, name: "CI", status: "completed", conclusion: "failure", completedAt: "now", startedAt: "then", url: null, kind: "check_run" }] });
    expect(snapshotChanges(before, after)).toEqual(["description", "mergeability", "checks", "reactions"]);
  });

  it("detects merged timestamp changes as lifecycle changes", () => {
    expect(snapshotChanges(snapshot(), snapshot({ merged: true, mergedAt: "2026-09-03T01:00:00.000Z" }))).toEqual(["lifecycle"]);
  });

  it("verifies GitHub's HMAC signature and rejects tampering", async () => {
    const body = JSON.stringify({ action: "opened" });
    const signature = `sha256=${await hmacSha256Hex("secret", body)}`;
    await expect(verifyGithubSignature(body, signature, "secret")).resolves.toBe(true);
    await expect(verifyGithubSignature(`${body}!`, signature, "secret")).resolves.toBe(false);
    await expect(verifyGithubSignature(body, "sha1=bad", "secret")).resolves.toBe(false);
  });
});
