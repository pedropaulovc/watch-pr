import { describe, expect, it, vi } from "vitest";
import { WatchPrHub, readStoredWatchState, writeStoredWatchState, type Env } from "../src/hub";
import type {
  MonitorCapabilityRecord,
  PrMonitorEvent,
  PullRequestSnapshot,
  SessionRecord,
  StoredWatchState,
  WatchEvent,
} from "../src/types";
import {
  monitorCapabilityStorageKey,
  monitorScopeStorageKey,
  sessionStorageKey,
  watchStorageKey,
} from "../src/types";

class MemoryStorage {
  private readonly values = new Map<string, unknown>();
  afterGet?: (key: string) => void | Promise<void>;

  async get<T>(key: string | string[]): Promise<T | undefined | Map<string, T>> {
    if (Array.isArray(key)) {
      return new Map(key.flatMap((entry) => {
        const value = this.values.get(entry);
        return value === undefined ? [] : [[entry, value as T]];
      }));
    }
    const value = this.values.get(key) as T | undefined;
    await this.afterGet?.(key);
    return value;
  }

  async put<T>(key: string | Record<string, T>, value?: T): Promise<void> {
    if (typeof key === "string") {
      this.values.set(key, value);
      return;
    }
    for (const [entry, entryValue] of Object.entries(key)) this.values.set(entry, entryValue);
  }

  async delete(key: string | string[]): Promise<boolean> {
    if (Array.isArray(key)) {
      let deleted = false;
      for (const entry of key) deleted = this.values.delete(entry) || deleted;
      return deleted;
    }
    return this.values.delete(key);
  }

  async list<T>(options: { prefix?: string } = {}): Promise<Map<string, T>> {
    return new Map([...this.values.entries()]
      .filter(([key]) => !options.prefix || key.startsWith(options.prefix))
      .map(([key, value]) => [key, value as T]));
  }

  async transaction<T>(callback: (storage: MemoryStorage) => Promise<T>): Promise<T> {
    return callback(this);
  }
}

const repository = "owner/repo";
const number = 7;
const watch = `${repository}#${number}`;
const userId = 42;
const sessionToken = "oauth-session";
const capability = "test-monitor-capability";

function snapshot(overrides: Partial<PullRequestSnapshot> = {}): PullRequestSnapshot {
  return {
    repository,
    number,
    url: "https://github.com/owner/repo/pull/7",
    title: "Monitor feed",
    body: "body",
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
    fetchedAt: "2026-09-10T12:00:00.000Z",
    bodyReactions: {},
    comments: [],
    reviews: [],
    reviewComments: [],
    checks: [],
    threads: [],
    ...overrides,
  };
}

function event(id: string, eventSnapshot: PullRequestSnapshot | null = snapshot(), overrides: Partial<WatchEvent> = {}): WatchEvent {
  return {
    id,
    deliveryId: `delivery-${id}`,
    receivedAt: eventSnapshot?.fetchedAt ?? "2026-09-10T12:00:00.000Z",
    githubEvent: "pull_request",
    action: "synchronize",
    repository,
    pullRequestNumber: number,
    resourceUri: "watch-pr://owner/repo/pull/7",
    payload: {},
    snapshot: eventSnapshot,
    changes: ["mergeability"],
    ...overrides,
  };
}

function sessionRecord(overrides: Partial<SessionRecord> = {}): SessionRecord {
  return {
    githubAccessToken: "github-token",
    user: { login: "pedropaulovc", id: userId, name: "Pedro", avatarUrl: null, htmlUrl: "https://github.com/pedropaulovc" },
    createdAt: Date.now(),
    expiresAt: Date.now() + 60_000,
    watches: [watch],
    watchStorageVersion: 1,
    ...overrides,
  };
}

function hubFixture(): {
  hub: WatchPrHub;
  storage: MemoryStorage;
  pending: Promise<unknown>[];
} {
  const storage = new MemoryStorage();
  const pending: Promise<unknown>[] = [];
  const state = {
    storage,
    waitUntil(promise: Promise<unknown>) {
      pending.push(promise);
    },
  } as unknown as DurableObjectState;
  const env: Env = {
    HUB: {} as DurableObjectNamespace,
    GITHUB_CLIENT_ID: "github-client-id",
    GITHUB_CLIENT_SECRET: "github-client-secret",
    GITHUB_WEBHOOK_SECRET: "webhook-secret",
    PUBLIC_BASE_URL: "https://watch-pr.test",
  };
  return { hub: new WatchPrHub(state, env), storage, pending };
}

function openPullRequestFetch() {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.endsWith("/pulls/7")) {
      return Response.json({
        number,
        html_url: "https://github.com/owner/repo/pull/7",
        title: "Monitor feed",
        body: "body",
        state: "open",
        draft: false,
        merged: false,
        merged_at: null,
        mergeable: true,
        mergeable_state: "clean",
        user: { login: "author" },
        head: { ref: "feature", sha: "reopened" },
        base: { ref: "main" },
      });
    }
    if (url.endsWith("/issues/7")) return Response.json({ reactions: {} });
    if (
      url.endsWith("/issues/7/comments?per_page=100") ||
      url.endsWith("/pulls/7/reviews?per_page=100") ||
      url.endsWith("/pulls/7/comments?per_page=100") ||
      url.endsWith("/commits/reopened/statuses?per_page=100")
    ) return Response.json([]);
    if (url.endsWith("/commits/reopened/check-runs?per_page=100")) return Response.json({ check_runs: [] });
    if (url.endsWith("/graphql")) {
      return Response.json({
        data: {
          repository: {
            pullRequest: {
              reviewThreads: {
                nodes: [],
                pageInfo: { hasNextPage: false, endCursor: null },
              },
            },
          },
        },
      });
    }
    throw new Error(`unexpected GitHub URL ${url}`);
  });
}

function stackedPullRequestFetch(branches: Record<number, { head: string; base: string; sha: string }>) {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith("/graphql")) {
      return Response.json({
        data: {
          repository: {
            pullRequest: {
              reviewThreads: {
                nodes: [],
                pageInfo: { hasNextPage: false, endCursor: null },
              },
            },
          },
        },
      });
    }

    const pullMatch = /\/pulls\/([1-9][0-9]*)$/u.exec(url.pathname);
    if (pullMatch) {
      const pullNumber = Number(pullMatch[1]);
      const branch = branches[pullNumber];
      if (!branch) throw new Error(`unexpected pull request ${pullNumber}`);
      return Response.json({
        number: pullNumber,
        html_url: `https://github.com/${repository}/pull/${pullNumber}`,
        title: "Monitor feed",
        body: "body",
        state: "open",
        draft: false,
        merged: false,
        merged_at: null,
        mergeable: true,
        mergeable_state: "clean",
        user: { login: "author" },
        head: { ref: branch.head, sha: branch.sha },
        base: { ref: branch.base },
      });
    }

    if (/\/issues\/[1-9][0-9]*$/u.test(url.pathname)) return Response.json({ reactions: {} });
    if (url.pathname.endsWith("/check-runs")) return Response.json({ check_runs: [] });
    if (
      url.pathname.endsWith("/comments") ||
      url.pathname.endsWith("/reviews") ||
      url.pathname.endsWith("/statuses")
    ) return Response.json([]);
    throw new Error(`unexpected GitHub URL ${url}`);
  });
}

async function storeMonitor(
  storage: MemoryStorage,
  state: StoredWatchState,
  record = sessionRecord(),
): Promise<void> {
  const capabilityRecord: MonitorCapabilityRecord = {
    sessionToken,
    userId,
    repository,
    pullRequestNumber: number,
    createdAt: Date.now(),
    expiresAt: record.expiresAt,
  };
  await storage.put(sessionStorageKey(sessionToken), record);
  await storage.put(monitorCapabilityStorageKey(capability), capabilityRecord);
  await storage.put(monitorScopeStorageKey(sessionToken, repository, number), capability);
  await writeStoredWatchState(storage as unknown as DurableObjectStorage, watchStorageKey(userId, repository, number), state);
}

type FeedReader = {
  reader: ReadableStreamDefaultReader<Uint8Array>;
  decoder: TextDecoder;
  buffer: string;
};

async function nextMonitorEvent(feed: FeedReader): Promise<PrMonitorEvent> {
  while (true) {
    const boundary = feed.buffer.indexOf("\n\n");
    if (boundary >= 0) {
      const block = feed.buffer.slice(0, boundary);
      feed.buffer = feed.buffer.slice(boundary + 2);
      const data = block.split("\n").find((line) => line.startsWith("data: "));
      if (data) return JSON.parse(data.slice("data: ".length)) as PrMonitorEvent;
      continue;
    }
    const chunk = await feed.reader.read();
    if (chunk.done) throw new Error("monitor feed closed before the next event");
    feed.buffer += feed.decoder.decode(chunk.value, { stream: true });
  }
}

function feedReader(response: Response): FeedReader {
  if (!response.body) throw new Error("monitor response body missing");
  return { reader: response.body.getReader(), decoder: new TextDecoder(), buffer: "" };
}

type HubInternals = {
  activeSessions: Map<string, TestActiveSession>;
  activeMonitorFeeds: Map<string, Set<unknown>>;
  newActiveSession(token: string, record: SessionRecord, kind: "stateful"): TestActiveSession;
  openMonitor(active: TestActiveSession, repository: string, number: number): Promise<{
    monitorUrl: string;
    cursor: string | null;
    terminalState: string;
  }>;
  watch(active: TestActiveSession, repository: string, number: number): Promise<{
    refreshScheduled: boolean;
  }>;
  unwatch(active: TestActiveSession, repository: string, number: number): Promise<boolean>;
  publishEvent(
    userId: number,
    key: string,
    event: WatchEvent,
    state: Pick<StoredWatchState, "snapshot">,
  ): Promise<void>;
  processWebhook(eventName: string, deliveryId: string, payload: Record<string, unknown>): Promise<void>;
};

type TestActiveSession = {
  token: string;
  record: SessionRecord;
  watches: Set<string>;
  subscriptions: Set<string>;
  kind: "stateful";
};

describe("native monitor feed", () => {
  it("replays events after the reconnect cursor and delivers later events live", async () => {
    const { hub, storage } = hubFixture();
    const first = event("event-1");
    const second = event("event-2");
    await storeMonitor(storage, { snapshot: second.snapshot, events: [first, second] });

    const response = await hub.fetch(new Request(
      `https://watch-pr.test/monitor/${capability}?cursor=event-2`,
      { headers: { "last-event-id": "event-1" } },
    ));
    expect(response.status).toBe(200);
    const feed = feedReader(response);
    await expect(nextMonitorEvent(feed)).resolves.toMatchObject({ id: "event-2", terminalState: "watching" });

    const third = event("event-3", snapshot({ headSha: "def", fetchedAt: "2026-09-10T12:01:00.000Z" }));
    await (hub as unknown as HubInternals).publishEvent(userId, watch, third, { snapshot: third.snapshot });
    await expect(nextMonitorEvent(feed)).resolves.toMatchObject({
      id: "event-3",
      repository,
      pullRequestNumber: number,
      githubEvent: "pull_request",
      terminalState: "watching",
    });
    await feed.reader.cancel();
  });

  it("keeps only the newest active feed for one capability", async () => {
    const { hub, storage } = hubFixture();
    const current = event("event-1");
    await storeMonitor(storage, { snapshot: current.snapshot, events: [current] });
    const url = `https://watch-pr.test/monitor/${capability}?cursor=event-1`;

    const first = await hub.fetch(new Request(url));
    const firstReader = first.body!.getReader();
    await firstReader.read();
    const second = await hub.fetch(new Request(url));

    await expect(firstReader.read()).resolves.toMatchObject({ done: true });
    const activeFeeds = (hub as unknown as HubInternals).activeMonitorFeeds.get(capability);
    expect(activeFeeds?.size).toBe(1);
    await second.body!.cancel();
  });

  it("does not register a feed when its capability is revoked during validation", async () => {
    const { hub, storage } = hubFixture();
    const current = event("event-1");
    await storeMonitor(storage, { snapshot: current.snapshot, events: [current] });
    const stateKey = watchStorageKey(userId, repository, number);
    storage.afterGet = async (key) => {
      if (key !== stateKey) return;
      storage.afterGet = undefined;
      await storage.delete([
        monitorCapabilityStorageKey(capability),
        monitorScopeStorageKey(sessionToken, repository, number),
      ]);
    };

    const response = await hub.fetch(new Request(`https://watch-pr.test/monitor/${capability}?cursor=event-1`));
    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({ error: "monitor_not_found" });
    expect((hub as unknown as HubInternals).activeMonitorFeeds.size).toBe(0);
  });

  it("reconciles from the current snapshot when the cursor fell out of the bounded log", async () => {
    const { hub, storage } = hubFixture();
    const current = snapshot({ headSha: "current" });
    await storeMonitor(storage, { snapshot: current, events: [event("event-100", current)] });

    const response = await hub.fetch(new Request(`https://watch-pr.test/monitor/${capability}?cursor=event-evicted`));
    const feed = feedReader(response);
    await expect(nextMonitorEvent(feed)).resolves.toEqual({
      id: "event-100",
      repository,
      pullRequestNumber: number,
      githubEvent: "reconciliation",
      action: "cursor_miss",
      receivedAt: current.fetchedAt,
      changes: ["reconciled"],
      terminalState: "watching",
    });
    await feed.reader.cancel();
  });

  it("publishes one terminal event and closes the live feed", async () => {
    const { hub, storage } = hubFixture();
    const initial = event("event-1");
    await storeMonitor(storage, { snapshot: initial.snapshot, events: [initial] });
    const response = await hub.fetch(new Request(`https://watch-pr.test/monitor/${capability}?cursor=event-1`));
    const feed = feedReader(response);

    const mergedSnapshot = snapshot({
      state: "closed",
      merged: true,
      mergedAt: "2026-09-10T12:02:00.000Z",
      fetchedAt: "2026-09-10T12:02:00.000Z",
    });
    const terminal = event("event-terminal", mergedSnapshot, { action: "closed", changes: ["lifecycle"] });
    const internals = hub as unknown as HubInternals;
    await internals.publishEvent(userId, watch, terminal, { snapshot: mergedSnapshot });
    await expect(nextMonitorEvent(feed)).resolves.toMatchObject({
      id: "event-terminal",
      action: "closed",
      terminalState: "merged",
    });
    await expect(feed.reader.read()).resolves.toMatchObject({ done: true });

    await internals.publishEvent(userId, watch, event("duplicate-terminal", mergedSnapshot), { snapshot: mergedSnapshot });
    const stored = await readStoredWatchState(storage as unknown as DurableObjectStorage, watchStorageKey(userId, repository, number));
    expect(stored.events.map((storedEvent) => storedEvent.id)).toEqual(["event-1", "event-terminal"]);
  });

  it("suppresses polling and reports terminal state for an already-terminal watch", async () => {
    const { hub, storage, pending } = hubFixture();
    const terminalSnapshot = snapshot({ state: "closed", fetchedAt: "2026-09-10T12:03:00.000Z" });
    const terminal = event("event-closed", terminalSnapshot, { action: "closed", changes: ["lifecycle"] });
    const record = sessionRecord();
    await storeMonitor(storage, { snapshot: terminalSnapshot, events: [terminal] }, record);
    const internals = hub as unknown as HubInternals;
    const active = internals.newActiveSession(sessionToken, record, "stateful");
    const registration = await internals.openMonitor(active, repository, number);
    expect(registration).toMatchObject({ cursor: "event-closed", terminalState: "closed" });

    const fetchMock = vi.fn(async () => new Response("unexpected GitHub request"));
    vi.stubGlobal("fetch", fetchMock);
    try {
      const poll = await hub.fetch(new Request("https://watch-pr.test/internal/poll", { method: "POST" }));
      expect(poll.status).toBe(202);
      await Promise.all(pending);
    } finally {
      vi.unstubAllGlobals();
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("publishes stack pushes only to watches whose head or direct base matches", async () => {
    const { hub, storage } = hubFixture();
    const stack = [
      {
        number: 730,
        head: "recreate-pinion-handle",
        base: "main",
        sha: "sha-730",
      },
      {
        number: 733,
        head: "review-hobby-shop-tolerances",
        base: "recreate-pinion-handle",
        sha: "sha-733",
      },
      {
        number: 734,
        head: "review-machinist-prompt-eval",
        base: "review-hobby-shop-tolerances",
        sha: "sha-734",
      },
    ];
    const record = sessionRecord({
      watches: stack.map((pullRequest) => `${repository}#${pullRequest.number}`),
    });
    await storage.put(sessionStorageKey(sessionToken), record);
    for (const pullRequest of stack) {
      const current = snapshot({
        number: pullRequest.number,
        url: `https://github.com/${repository}/pull/${pullRequest.number}`,
        headRefName: pullRequest.head,
        baseRefName: pullRequest.base,
        headSha: pullRequest.sha,
      });
      await writeStoredWatchState(
        storage as unknown as DurableObjectStorage,
        watchStorageKey(userId, repository, pullRequest.number),
        { snapshot: current, events: [] },
      );
    }

    const fetchMock = stackedPullRequestFetch(Object.fromEntries(
      stack.map((pullRequest) => [pullRequest.number, pullRequest]),
    ));
    vi.stubGlobal("fetch", fetchMock);
    try {
      await (hub as unknown as HubInternals).processWebhook("push", "delivery-730", {
        repository: { full_name: repository },
        ref: "refs/heads/recreate-pinion-handle",
      });

      const after730Push = await Promise.all(stack.map((pullRequest) =>
        readStoredWatchState(
          storage as unknown as DurableObjectStorage,
          watchStorageKey(userId, repository, pullRequest.number),
        )
      ));
      expect(after730Push.map((state) => state.events.map((storedEvent) => storedEvent.deliveryId))).toEqual([
        ["delivery-730"],
        ["delivery-730"],
        [],
      ]);
      expect(fetchMock.mock.calls.some(([input]) => String(input).includes("/pulls/734"))).toBe(false);

      fetchMock.mockClear();
      await (hub as unknown as HubInternals).processWebhook("push", "delivery-733", {
        repository: { full_name: repository },
        ref: "refs/heads/review-hobby-shop-tolerances",
      });
      const downstream = await readStoredWatchState(
        storage as unknown as DurableObjectStorage,
        watchStorageKey(userId, repository, 734),
      );
      expect(downstream.events).toHaveLength(1);
      expect(downstream.events[0]).toMatchObject({
        deliveryId: "delivery-733",
        githubEvent: "push",
        changes: [],
      });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("resumes a closed watch only for a pull_request reopened webhook", async () => {
    const { hub, storage } = hubFixture();
    const closed = snapshot({ state: "closed", fetchedAt: "2026-09-10T12:03:00.000Z" });
    await storeMonitor(storage, {
      snapshot: closed,
      events: [event("event-closed", closed, { action: "closed", changes: ["lifecycle"] })],
    });
    const fetchMock = openPullRequestFetch();
    vi.stubGlobal("fetch", fetchMock);
    try {
      await (hub as unknown as HubInternals).processWebhook("pull_request", "delivery-reopened", {
        action: "reopened",
        repository: { full_name: repository },
        pull_request: { number },
      });
    } finally {
      vi.unstubAllGlobals();
    }

    const stored = await readStoredWatchState(storage as unknown as DurableObjectStorage, watchStorageKey(userId, repository, number));
    expect(stored.snapshot).toMatchObject({ state: "open", merged: false, headSha: "reopened" });
    expect(stored.events.at(-1)).toMatchObject({
      deliveryId: "delivery-reopened",
      githubEvent: "pull_request",
      action: "reopened",
      changes: expect.arrayContaining(["lifecycle"]),
    });
  });

  it("refreshes an explicitly watched closed PR but never refreshes a merged PR", async () => {
    const { hub, storage, pending } = hubFixture();
    const closed = snapshot({ state: "closed", fetchedAt: "2026-09-10T12:03:00.000Z" });
    const record = sessionRecord();
    await storeMonitor(storage, {
      snapshot: closed,
      events: [event("event-closed", closed, { action: "closed", changes: ["lifecycle"] })],
    }, record);
    const internals = hub as unknown as HubInternals;
    const active = internals.newActiveSession(sessionToken, record, "stateful");
    const fetchMock = openPullRequestFetch();
    vi.stubGlobal("fetch", fetchMock);
    try {
      const registration = await internals.watch(active, repository, number);
      expect(registration.refreshScheduled).toBe(true);
      await Promise.all(pending.splice(0));
      const reopened = await readStoredWatchState(storage as unknown as DurableObjectStorage, watchStorageKey(userId, repository, number));
      expect(reopened.snapshot).toMatchObject({ state: "open", headSha: "reopened" });

      const merged = snapshot({
        state: "closed",
        merged: true,
        mergedAt: "2026-09-10T12:04:00.000Z",
        fetchedAt: "2026-09-10T12:04:00.000Z",
      });
      await writeStoredWatchState(
        storage as unknown as DurableObjectStorage,
        watchStorageKey(userId, repository, number),
        { snapshot: merged, events: [event("event-merged", merged, { action: "closed" })] },
      );
      fetchMock.mockClear();
      const mergedRegistration = await internals.watch(active, repository, number);
      expect(mergedRegistration.refreshScheduled).toBe(false);
      expect(pending).toHaveLength(0);
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("revokes the capability and closes its feed when the session unwatches", async () => {
    const { hub, storage } = hubFixture();
    const current = event("event-1");
    const record = sessionRecord();
    await storeMonitor(storage, { snapshot: current.snapshot, events: [current] }, record);
    const internals = hub as unknown as HubInternals;
    const active = internals.newActiveSession(sessionToken, record, "stateful");
    internals.activeSessions.set("mcp-session", active);
    const registration = await internals.openMonitor(active, repository, number);
    const response = await hub.fetch(new Request(registration.monitorUrl));
    const reader = response.body!.getReader();
    await reader.read();

    await expect(internals.unwatch(active, repository, number)).resolves.toBe(true);
    await expect(reader.read()).resolves.toMatchObject({ done: true });
    await expect(hub.fetch(new Request(registration.monitorUrl))).resolves.toMatchObject({ status: 404 });
    await expect(storage.get(monitorCapabilityStorageKey(capability))).resolves.toBeUndefined();
  });

  it("rejects invalid, expired, and out-of-scope capabilities without GitHub access", async () => {
    const { hub, storage } = hubFixture();
    await expect(hub.fetch(new Request("https://watch-pr.test/monitor/unknown-capability"))).resolves.toMatchObject({ status: 404 });

    const expired = sessionRecord({ expiresAt: Date.now() - 1 });
    await storeMonitor(storage, { snapshot: snapshot(), events: [] }, expired);
    const fetchMock = vi.fn(async () => new Response("unexpected GitHub request"));
    vi.stubGlobal("fetch", fetchMock);
    try {
      const response = await hub.fetch(new Request(`https://watch-pr.test/monitor/${capability}`));
      expect(response.status).toBe(404);
      await expect(response.json()).resolves.toMatchObject({ error: "monitor_not_found" });
    } finally {
      vi.unstubAllGlobals();
    }
    expect(fetchMock).not.toHaveBeenCalled();
    await expect(storage.get(monitorCapabilityStorageKey(capability))).resolves.toBeUndefined();
  });
});
