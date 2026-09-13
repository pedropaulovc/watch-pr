import { describe, expect, it } from "vitest";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { createMcpServer, type McpSessionContext, type WatchRegistration } from "../src/mcp";
import {
  openWatchStateMutation,
  readStoredWatchState,
  writeStoredWatchState,
  type WatchStorage,
} from "../src/hub";
import type { PullRequestSnapshot, StoredWatchState, WatchEvent } from "../src/types";
import { watchStorageKey } from "../src/types";

function memoryStorage(): WatchStorage {
  const values = new Map<string, unknown>();
  return {
    get: async (key: string | string[]) => (Array.isArray(key)
      ? new Map<string, unknown>(key.flatMap((entry): [string, unknown][] => (
        values.has(entry) ? [[entry, values.get(entry)]] : []
      )))
      : values.get(key)),
    put: async (key: string | Record<string, unknown>, value?: unknown) => {
      if (typeof key === "string") {
        values.set(key, value);
        return;
      }
      for (const [entry, entryValue] of Object.entries(key)) values.set(entry, entryValue);
    },
    delete: async (key: string | string[]) => {
      let deleted = false;
      for (const entry of Array.isArray(key) ? key : [key]) deleted = values.delete(entry) || deleted;
      return deleted;
    },
  } as unknown as WatchStorage;
}

const snapshot: PullRequestSnapshot = {
  repository: "owner/repo",
  number: 7,
  url: "https://github.com/owner/repo/pull/7",
  title: "Improve watch",
  body: "body",
  state: "open",
  draft: false,
  merged: false,
  mergedAt: null,
  mergeable: false,
  mergeableState: "dirty",
  baseRefName: "main",
  headRefName: "feature",
  headRepository: "owner/repo",
  headSha: "abc",
  author: "author",
  fetchedAt: "2026-09-05T00:00:00.000Z",
  bodyReactions: { eyes: 2, total_count: 2 },
  comments: [{
    id: 1,
    author: "reviewer",
    body: "top-level",
    createdAt: "2026-09-05T00:00:00.000Z",
    updatedAt: "2026-09-05T00:00:00.000Z",
    reactions: { "+1": 1 },
  }],
  reviews: [{
    id: 2,
    author: "reviewer",
    state: "APPROVED",
    body: "looks good",
    submittedAt: "2026-09-05T00:00:00.000Z",
  }],
  reviewComments: [{
    id: 3,
    author: "reviewer",
    body: "<!-- hidden -->inline feedback",
    createdAt: "2026-09-05T00:00:00.000Z",
    updatedAt: "2026-09-05T00:00:00.000Z",
    reactions: { heart: 1 },
    path: "src/index.ts",
    line: 4,
  }],
  checks: [
    {
      id: 4,
      name: "CI",
      status: "completed",
      conclusion: "failure",
      completedAt: "2026-09-05T00:00:00.000Z",
      startedAt: "2026-09-04T23:00:00.000Z",
      url: "https://github.com/check",
      kind: "check_run",
    },
    {
      id: 5,
      name: "Lint",
      status: "completed",
      conclusion: "success",
      completedAt: "2026-09-05T00:00:00.000Z",
      startedAt: "2026-09-04T23:00:00.000Z",
      url: "https://github.com/lint",
      kind: "check_run",
    },
  ],
  threads: [{ id: "thread-1", isResolved: false, commentIds: [3] }],
};

const registration: WatchRegistration = {
  key: "owner/repo#7",
  repository: "owner/repo",
  number: 7,
  resourceUri: "watch-pr://owner/repo/pull/7",
  snapshot,
  refreshScheduled: false,
};

const event: WatchEvent = {
  id: "event-1",
  deliveryId: "delivery-1",
  receivedAt: "2026-09-05T00:00:00.000Z",
  githubEvent: "issue_comment",
  action: "created",
  repository: "owner/repo",
  pullRequestNumber: 7,
  resourceUri: registration.resourceUri,
  payload: { body: "large event payload" },
  snapshot,
  changes: ["comments"],
};

const state: StoredWatchState = { snapshot, events: [event] };

function context(currentSnapshot: PullRequestSnapshot = snapshot): McpSessionContext {
  const currentRegistration = { ...registration, snapshot: currentSnapshot };
  const currentState = { ...state, snapshot: currentSnapshot };
  return {
    user: {
      login: "pedropaulovc",
      id: 42,
      name: "Pedro",
      avatarUrl: null,
      htmlUrl: "https://github.com/pedropaulovc",
    },
    watches: new Set([registration.key]),
    watch: async () => currentRegistration,
    unwatch: async () => true,
    listWatches: async () => [currentRegistration],
    readWatch: async () => currentState,
    openMonitor: async () => ({
      monitorUrl: "https://watch-pr.test/monitor/capability?cursor=event-1",
      cursor: "event-1",
      terminalState: "watching",
    }),
    subscribe: async () => undefined,
    unsubscribe: async () => undefined,
  };
}

async function callTool(
  name: string,
  arguments_: Record<string, unknown>,
  currentSnapshot: PullRequestSnapshot = snapshot,
  sessionContext: McpSessionContext = context(currentSnapshot),
): Promise<string> {
  const transport = new WebStandardStreamableHTTPServerTransport({
    enableJsonResponse: true,
    sessionIdGenerator: () => "test-session",
  });
  const server = createMcpServer(sessionContext);
  await server.connect(transport);
  const request = (body: unknown, sessionId?: string) => transport.handleRequest(new Request("https://watch-pr.test/mcp", {
    method: "POST",
    headers: {
      accept: "application/json, text/event-stream",
      "content-type": "application/json",
      "mcp-protocol-version": "2025-06-18",
      ...(sessionId ? { "mcp-session-id": sessionId } : {}),
    },
    body: JSON.stringify(body),
  }));

  try {
    const initialized = await request({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "mcp-output-test", version: "1.0.0" },
      },
    });
    const sessionId = initialized.headers.get("mcp-session-id");
    if (!sessionId) throw new Error("MCP session ID missing");
    const response = await request({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name, arguments: arguments_ },
    }, sessionId);
    const body = await response.json() as { result: { content: [{ text: string }] } };
    return body.result.content[0].text;
  } finally {
    await server.close();
  }
}

describe("MCP output modes", () => {
  it("defaults to watcher-style brief output and preserves full snapshots", async () => {
    const brief = await callTool("get_pr", { repository: "owner/repo", number: 7 });
    expect(brief).toContain("PR 7: OPEN");
    expect(brief).toContain("head: feature@abc");
    expect(brief).toContain("mergeable: no (DIRTY)");
    expect(brief).toContain("reviews: 1");
    expect(brief).toContain("check CI: fail @2026-09-05T00:00:00.000Z");
    expect(brief).toContain("check Lint: pass @2026-09-05T00:00:00.000Z");
    expect(brief).toContain("rebase: DIRTY");
    expect(brief).toContain("review reviewer: APPROVED @2026-09-05T00:00:00.000Z");
    expect(brief).toContain("comments: 1");
    expect(brief).toContain("review-comments: 1");
    expect(brief).toContain("reaction EYES: 2");
    expect(brief).toContain("comment-reaction THUMBS_UP: 1");
    expect(brief).toContain("feedback [thread-1] src/index.ts:4 @reviewer inline feedback");
    expect(brief).not.toContain('"snapshot"');

    const full = await callTool("get_pr", { repository: "owner/repo", number: 7, mode: "full" });
    expect(JSON.parse(full)).toEqual(snapshot);

    const unknown = await callTool(
      "get_pr",
      { repository: "owner/repo", number: 7 },
      { ...snapshot, mergeable: null, mergeableState: "unknown" },
    );
    expect(unknown).toContain("mergeable: unknown (UNKNOWN)");
  });

  it("formats registrations, unwatch results, and event history briefly", async () => {
    await expect(callTool("watch_pr", { repository: "owner/repo", number: 7 })).resolves.toContain("watching owner/repo#7");
    await expect(callTool("list_watched_prs", {})).resolves.toContain("resource: watch-pr://owner/repo/pull/7");
    await expect(callTool("unwatch_pr", { repository: "owner/repo", number: 7 })).resolves.toBe("unwatched owner/repo#7");
    await expect(callTool("list_pr_events", { repository: "owner/repo", number: 7 })).resolves.toBe("event issue_comment created (comments) @2026-09-05T00:00:00.000Z");

    const full = await callTool("list_pr_events", { repository: "owner/repo", number: 7, mode: "full" });
    expect(JSON.parse(full)).toEqual({ repository: "owner/repo", number: 7, events: [event] });
  });

  it("returns the read-only monitor capability as JSON text", async () => {
    const result = JSON.parse(await callTool("open_pr_monitor", {
      repository: "owner/repo",
      number: 7,
    })) as Record<string, unknown>;
    expect(result).toEqual({
      monitorUrl: "https://watch-pr.test/monitor/capability?cursor=event-1",
      cursor: "event-1",
      terminalState: "watching",
    });
  });

  it("serializes a sidecar-backed event history in full mode", async () => {
    const storage = memoryStorage();
    const storageKey = watchStorageKey(42, "owner/repo", 7);
    const predecessor: WatchEvent = {
      ...event,
      id: "event-predecessor",
      deliveryId: "delivery-predecessor",
      payload: { body: "x".repeat(20_000) },
    };
    await writeStoredWatchState(storage, storageKey, { snapshot, events: [predecessor] });
    const mutation = await openWatchStateMutation(storage, storageKey);
    const appended: WatchEvent = {
      ...event,
      id: "event-appended",
      deliveryId: "delivery-appended",
      payload: { appended: true },
    };
    await mutation.append(appended, snapshot);

    const full = await callTool(
      "list_pr_events",
      { repository: "owner/repo", number: 7, mode: "full" },
      snapshot,
      { ...context(), readWatch: async () => readStoredWatchState(storage, storageKey) },
    );
    expect(JSON.parse(full)).toEqual({
      repository: "owner/repo",
      number: 7,
      events: [{ ...predecessor, snapshot: null }, appended],
    });
  });
});
