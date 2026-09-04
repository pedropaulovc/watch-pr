import { afterEach, describe, expect, it, vi } from "vitest";
import { githubUser, pullRequestSnapshot } from "../src/github";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

describe("GitHub API adapter", () => {
  it("normalizes pull state, comments, reviews, checks, reactions, and threads", async () => {
    let graphqlCalls = 0;
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
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
          head: { ref: "feature", sha: "abc" },
          base: { ref: "main" },
        });
      }
      if (url.endsWith("/issues/7") && !url.includes("comments")) return Response.json({ reactions: { eyes: 2, total_count: 2 } });
      if (url.endsWith("/issues/7/comments?per_page=100")) return Response.json([{ id: 1, user: { login: "reviewer" }, body: "top-level", reactions: { "+1": 1 }, created_at: "now", updated_at: "now" }]);
      if (url.endsWith("/pulls/7/reviews?per_page=100")) return Response.json([{ id: 2, user: { login: "reviewer" }, state: "APPROVED", body: "looks good", submitted_at: "now" }]);
      if (url.endsWith("/pulls/7/comments?per_page=100")) return Response.json([{ id: 3, user: { login: "reviewer" }, body: "inline", path: "src/index.ts", line: 4, diff_hunk: "@@", reactions: { heart: 1 }, created_at: "now", updated_at: "now" }]);
      if (url.endsWith("/commits/abc/check-runs?per_page=100")) {
        return Response.json(
          { check_runs: [{ id: 4, name: "CI", status: "completed", conclusion: "failure", completed_at: "now", started_at: "then", html_url: "https://github.com/check" }] },
          { headers: { link: '<https://api.github.com/repos/owner/repo/commits/abc/check-runs?page=2&per_page=100>; rel="next"' } },
        );
      }
      if (url.includes("/commits/abc/check-runs?page=2")) return Response.json({ check_runs: [{ id: 5, name: "Lint", status: "completed", conclusion: "success", completed_at: "now", started_at: "then", html_url: "https://github.com/lint" }] });
      if (url.endsWith("/commits/abc/statuses?per_page=100")) return Response.json([]);
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
    expect(result.bodyReactions).toEqual({ eyes: 2, total_count: 2 });
    expect(result.comments[0]).toMatchObject({ id: 1, author: "reviewer", reactions: { "+1": 1 } });
    expect(result.reviews[0]).toMatchObject({ state: "APPROVED", author: "reviewer" });
    expect(result.reviewComments[0]).toMatchObject({ path: "src/index.ts", reactions: { heart: 1 } });
    expect(result.checks[0]).toMatchObject({ name: "CI", conclusion: "failure", kind: "check_run" });
    expect(result.threads).toEqual([
      { id: "thread-1", isResolved: false, commentIds: [8] },
      { id: "thread-2", isResolved: true, commentIds: [9] },
    ]);
  });

  it("reads the authenticated GitHub user profile", async () => {
    globalThis.fetch = vi.fn(async () => Response.json({ login: "pedropaulovc", id: 42, name: "Pedro", avatar_url: "https://avatar", html_url: "https://github.com/pedropaulovc" }));
    await expect(githubUser("token")).resolves.toEqual({ login: "pedropaulovc", id: 42, name: "Pedro", avatarUrl: "https://avatar", htmlUrl: "https://github.com/pedropaulovc" });
  });
});
