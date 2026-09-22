import { describe, expect, it } from "vitest";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { createMcpServer, type McpSessionContext, type WatchRegistration } from "../src/mcp";
import { snapshotReactions } from "../src/events";
import {
  openWatchStateMutation,
  readStoredWatchState,
  writeStoredWatchState,
  type WatchStorage,
} from "../src/hub";
import type { PrMonitorRegistration, PullRequestSnapshot, StoredWatchState, WatchEvent } from "../src/types";
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
  bodyReactionDetails: [{ id: 900, content: "eyes", author: "alice", authorId: 11, createdAt: "2026-09-05T00:00:00.000Z" }],
  comments: [{
    id: 1,
    author: "reviewer",
    body: "top-level",
    createdAt: "2026-09-05T00:00:00.000Z",
    updatedAt: "2026-09-05T00:00:00.000Z",
    reactions: { "+1": 1 },
    reactionDetails: [
      // Same account as the authenticated user (ID 42) under a login it no longer uses.
      { id: 901, content: "+1", author: "PedroPauloVC-old", authorId: 42, createdAt: "2026-09-05T00:00:00.000Z" },
      { id: 903, content: "rocket", author: "dave", authorId: 12, createdAt: "2026-09-05T00:01:00.000Z" },
    ],
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
    reactionDetails: [{ id: 902, content: "heart", author: "carol", authorId: 13, createdAt: "2026-09-05T00:00:00.000Z" }],
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

const monitor: PrMonitorRegistration = {
  monitorUrl: "https://watch-pr.test/monitor/capability?cursor=event-1",
  cursor: "event-1",
  terminalState: "watching",
};

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
    openMonitor: async () => monitor,
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

async function listTools(
  sessionContext: McpSessionContext = context(),
): Promise<Array<{ name: string; inputSchema: { properties?: Record<string, unknown> }; annotations?: Record<string, unknown> }>> {
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
      method: "tools/list",
      params: {},
    }, sessionId);
    const body = await response.json() as {
      result: { tools: Array<{ name: string; inputSchema: { properties?: Record<string, unknown> }; annotations?: Record<string, unknown> }> };
    };
    return body.result.tools;
  } finally {
    await server.close();
  }
}

describe("MCP JSON output", () => {
  it("returns the full JSON shape for every state tool", async () => {
    expect(JSON.parse(await callTool("watch_pr", {
      repository: "owner/repo",
      number: 7,
    }))).toEqual({ ...registration, monitor });
    expect(JSON.parse(await callTool("list_watched_prs", {}))).toEqual([registration]);
    expect(JSON.parse(await callTool("unwatch_pr", {
      repository: "owner/repo",
      number: 7,
    }))).toEqual({ repository: "owner/repo", number: 7, removed: true });
    expect(JSON.parse(await callTool("get_pr", {
      repository: "owner/repo",
      number: 7,
    }))).toEqual(snapshot);
    expect(JSON.parse(await callTool("list_pr_events", {
      repository: "owner/repo",
      number: 7,
    }))).toEqual({ repository: "owner/repo", number: 7, events: [event] });
  });

  it("does not advertise output mode inputs", async () => {
    const tools = await listTools();
    for (const name of ["watch_pr", "unwatch_pr", "list_watched_prs", "get_pr", "list_pr_events"]) {
      const tool = tools.find((candidate) => candidate.name === name);
      expect(tool).toBeDefined();
      expect(tool?.inputSchema.properties ?? {}).not.toHaveProperty("mode");
    }
  });

  it("exposes exactly the merged tool surface", async () => {
    const tools = await listTools();
    expect(tools.map((tool) => tool.name).sort()).toEqual([
      "get_pr",
      "list_pr_events",
      "list_watched_prs",
      "unwatch_pr",
      "watch_pr",
    ]);
  });

  it("advertises behavior hints matching each tool's side effects", async () => {
    const tools = await listTools();
    expect(Object.fromEntries(tools.map((tool) => [tool.name, tool.annotations]))).toEqual({
      watch_pr: { readOnlyHint: false, destructiveHint: false },
      unwatch_pr: { readOnlyHint: false, destructiveHint: true },
      list_watched_prs: { readOnlyHint: true },
      get_pr: { readOnlyHint: true },
      list_pr_events: { readOnlyHint: true },
    });
  });

  it("serializes a sidecar-backed event history", async () => {
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

    const result = await callTool(
      "list_pr_events",
      { repository: "owner/repo", number: 7 },
      snapshot,
      { ...context(), readWatch: async () => readStoredWatchState(storage, storageKey) },
    );
    expect(JSON.parse(result)).toEqual({
      repository: "owner/repo",
      number: 7,
      events: [{ ...predecessor, snapshot: null }, appended],
    });
  });

  it("keeps unknown reactions in snapshots persisted before they were attributed", async () => {
    const storage = memoryStorage();
    const storageKey = watchStorageKey(42, "owner/repo", 7);
    const withoutDetails = ({ reactionDetails, ...comment }: PullRequestSnapshot["comments"][number]) => comment;
    const { bodyReactionDetails, ...body } = snapshot;
    const legacySnapshot = {
      ...body,
      comments: snapshot.comments.map(withoutDetails),
      reviewComments: snapshot.reviewComments.map(withoutDetails),
    } as unknown as PullRequestSnapshot;
    const legacyEvent: WatchEvent = { ...event, snapshot: legacySnapshot };
    await writeStoredWatchState(storage, storageKey, { snapshot: legacySnapshot, events: [legacyEvent] });

    const stored = await readStoredWatchState(storage, storageKey);
    expect(stored.snapshot?.bodyReactionDetails).toBeUndefined();
    expect(stored.snapshot?.comments[0].reactionDetails).toBeUndefined();
    expect(stored.snapshot?.reviewComments[0].reactionDetails).toBeUndefined();
    expect(stored.events[0].snapshot?.bodyReactionDetails).toBeUndefined();
    expect(snapshotReactions(stored.snapshot as PullRequestSnapshot)).toEqual([]);

    const result = await callTool(
      "get_pr",
      { repository: "owner/repo", number: 7 },
      snapshot,
      { ...context(), readWatch: async () => readStoredWatchState(storage, storageKey) },
    );
    expect(JSON.parse(result)).toEqual(legacySnapshot);
  });

  it("returns every reaction in the exact snapshot without truncation", async () => {
    const crowded: PullRequestSnapshot = {
      ...snapshot,
      bodyReactions: { heart: 20, total_count: 20 },
      bodyReactionDetails: Array.from({ length: 20 }, (_, index) => ({
        id: 1_000 + index,
        content: "heart",
        author: `watcher-${String(index).padStart(2, "0")}`,
        authorId: 100 + index,
        createdAt: "2026-09-05T00:00:00.000Z",
      })),
      comments: [],
      reviewComments: [],
      threads: [],
    };

    expect(JSON.parse(await callTool("get_pr", {
      repository: "owner/repo",
      number: 7,
    }, crowded))).toEqual(crowded);
  });
});
