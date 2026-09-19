import { describe, expect, it, vi } from "vitest";
import { hmacSha256Hex, sha256Base64Url } from "../src/crypto";
import {
  WatchPrHub,
  openWatchStateMutation,
  readStoredWatchState,
  writeStoredWatchState,
  type Env,
} from "../src/hub";
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
  watchSidecarEventKey,
  watchSidecarIndexKey,
  watchStorageKey,
} from "../src/types";

class MemoryStorage {
  private readonly values = new Map<string, unknown>();
  readonly deleteKeys: string[] = [];
  readonly putKeys: string[] = [];
  readonly getKeys: string[] = [];
  afterGet?: (key: string) => void | Promise<void>;
  putError?: (key: string) => unknown;
  async get<T>(key: string | string[]): Promise<T | undefined | Map<string, T>> {
    if (Array.isArray(key)) {
      this.getKeys.push(...key);
      const entries = new Map(key.flatMap((entry) => {
        const value = this.values.get(entry);
        return value === undefined ? [] : [[entry, value as T]];
      }));
      for (const entry of key) await this.afterGet?.(entry);
      return entries;
    }
    this.getKeys.push(key);
    const value = this.values.get(key) as T | undefined;
    await this.afterGet?.(key);
    return value;
  }

  async put<T>(key: string | Record<string, T>, value?: T): Promise<void> {
    if (typeof key === "string") {
      const error = this.putError?.(key);
      if (error !== undefined) throw error;
      this.putKeys.push(key);
      this.values.set(key, value);
      return;
    }
    for (const [entry, entryValue] of Object.entries(key)) {
      const error = this.putError?.(entry);
      if (error !== undefined) throw error;
      this.putKeys.push(entry);
      this.values.set(entry, entryValue);
    }
  }

  async delete(key: string | string[]): Promise<boolean> {
    if (Array.isArray(key)) {
      this.deleteKeys.push(...key);
      let deleted = false;
      for (const entry of key) deleted = this.values.delete(entry) || deleted;
      return deleted;
    }
    this.deleteKeys.push(key);
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
    headRepository: repository,
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
  restart(): WatchPrHub;
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
  return { hub: new WatchPrHub(state, env), storage, pending, restart: () => new WatchPrHub(state, env) };
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
        head: { ref: "feature", sha: "reopened", repo: { full_name: repository } },
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

function stackedPullRequestFetch(
  branches: Record<number, { head: string; headRepository: string; base: string; sha: string }>,
) {
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
        head: { ref: branch.head, sha: branch.sha, repo: { full_name: branch.headRepository } },
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
  listWatches(active: TestActiveSession): Promise<{ key: string }[]>;
  readWatch(active: TestActiveSession, repository: string, number: number): Promise<StoredWatchState>;
  publishEvent(
    userId: number,
    key: string,
    event: WatchEvent,
    state: Pick<StoredWatchState, "snapshot">,
  ): Promise<void>;
  processWebhook(eventName: string, deliveryId: string, payload: Record<string, unknown>): Promise<void>;
  invalidateSession(token: string, expectedGithubToken?: string): Promise<number>;
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
      details: ["mergeability: head -> feature@def"],
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
      details: ["mergeability: head -> feature@current"],
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

  it("deduplicates an already-persisted delivery inside the state transaction", async () => {
    const { hub, storage } = hubFixture();
    const incoming = event("event-duplicate", snapshot());
    const internals = hub as unknown as HubInternals;

    await internals.publishEvent(userId, watch, incoming, { snapshot: incoming.snapshot });
    await internals.publishEvent(userId, watch, incoming, { snapshot: incoming.snapshot });

    const stored = await readStoredWatchState(
      storage as unknown as DurableObjectStorage,
      watchStorageKey(userId, repository, number),
    );
    expect(stored.events.map((storedEvent) => storedEvent.deliveryId)).toEqual([incoming.deliveryId]);
  });

  it("logs chunked Durable Object state writes", async () => {
    const { hub } = hubFixture();
    const current = snapshot();
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      await (hub as unknown as HubInternals).publishEvent(
        userId,
        watch,
        event("event-large", current, { payload: "x".repeat(80_000) }),
        { snapshot: current },
      );
      const record = log.mock.calls
        .map(([value]) => JSON.parse(String(value)) as Record<string, unknown>)
        .find((entry) => entry.event === "watch_pr.do_storage");
      expect(record).toMatchObject({
        event: "watch_pr.do_storage",
        sample_rate: 1,
        sample_reason: "all",
        source: "webhook",
        state_format: "chunked",
      });
      expect(record?.state_chunk_count).toBeGreaterThanOrEqual(4);
      expect(record?.storage_key_writes).toBeGreaterThanOrEqual(4);
    } finally {
      log.mockRestore();
    }
  });

  it("logs compact Durable Object state writes", async () => {
    const { hub } = hubFixture();
    const current = snapshot();
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      await (hub as unknown as HubInternals).publishEvent(
        userId,
        watch,
        event("event-compact", current),
        { snapshot: current },
      );
      const record = log.mock.calls
        .map(([value]) => JSON.parse(String(value)) as Record<string, unknown>)
        .find((entry) => entry.event === "watch_pr.do_storage");
      expect(record).toMatchObject({
        event: "watch_pr.do_storage",
        sample_rate: 1,
        sample_reason: "all",
        source: "webhook",
        state_format: "compact",
      });
      expect(record?.storage_key_writes).toBeLessThan(4);
    } finally {
      log.mockRestore();
    }
  });

  it("keeps ten thousand single-watch deliveries with a 4,000-byte body below sixty percent of the free write limit", async () => {
    const { storage } = hubFixture();
    const storageKey = watchStorageKey(userId, repository, number);
    const deliveries = 10_000;
    const freeTierRowsWrittenPerDay = 100_000;
    let totalRowsWritten = 0;
    let largestDeliveryWrite = 0;

    // Force a changing snapshot and event-window eviction on every steady-state append.
    for (let index = 0; index < deliveries; index += 1) {
      const current = snapshot({
        body: "x".repeat(4_000),
        headSha: `quota-stress-${index}`,
        fetchedAt: new Date(1_700_000_000_000 + index).toISOString(),
      });
      const mutation = await openWatchStateMutation(
        storage as unknown as DurableObjectStorage,
        storageKey,
      );
      const putsBefore = storage.putKeys.length;
      const deletesBefore = storage.deleteKeys.length;
      const write = await mutation.append(
        event(`quota-stress-${index}`, current, {
          payload: { action: "synchronize", pull_request: { number, head: { sha: current.headSha } } },
        }),
        current,
      );
      // Every matched webhook persists its durable deduplication marker after fanout.
      await storage.put(`delivery:quota-stress-${index}`, Date.now());
      const rowsWritten = storage.putKeys.length - putsBefore + storage.deleteKeys.length - deletesBefore;
      expect(rowsWritten).toBe(write.puts + write.deletes + 1);
      totalRowsWritten += rowsWritten;
      largestDeliveryWrite = Math.max(largestDeliveryWrite, rowsWritten);
    }

    expect(largestDeliveryWrite).toBeLessThanOrEqual(6);
    expect(totalRowsWritten).toBeLessThan(freeTierRowsWrittenPerDay * 0.6);
    const stored = await readStoredWatchState(storage as unknown as DurableObjectStorage, storageKey);
    expect(stored.events).toHaveLength(100);
    expect(stored.events.at(-1)?.id).toBe("quota-stress-9999");
  }, 30_000);

  it("deduplicates matched deliveries after a hub restart", async () => {
    const { hub, pending, restart, storage } = hubFixture();
    await storeMonitor(storage, { snapshot: snapshot(), events: [] });
    const deliveryId = "persistent-delivery";
    const body = JSON.stringify({
      action: "synchronize",
      repository: { full_name: repository },
      pull_request: { number },
    });
    const headers = {
      "x-github-delivery": deliveryId,
      "x-github-event": "pull_request",
      "x-hub-signature-256": `sha256=${await hmacSha256Hex("webhook-secret", body)}`,
    };
    const fetchMock = openPullRequestFetch();
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.stubGlobal("fetch", fetchMock);
    try {
      const first = await hub.fetch(new Request("https://watch-pr.test/webhooks/github", {
        method: "POST",
        headers,
        body,
      }));
      expect(first.status).toBe(202);
      await Promise.all(pending.splice(0));
      await expect(storage.get<number>(`delivery:${deliveryId}`)).resolves.toEqual(expect.any(Number));
      fetchMock.mockClear();

      const duplicate = await restart().fetch(new Request("https://watch-pr.test/webhooks/github", {
        method: "POST",
        headers,
        body,
      }));
      await expect(duplicate.json()).resolves.toMatchObject({ accepted: true, duplicate: true });
      const records = log.mock.calls.map(([value]) => JSON.parse(String(value)) as Record<string, unknown>);
      expect(records.filter((entry) => entry.event === "watch_pr.webhook_admission")).toEqual([
        expect.objectContaining({ github_event: "pull_request", outcome: "accepted" }),
        expect.objectContaining({ github_event: "pull_request", outcome: "duplicate_persisted" }),
      ]);
      expect(records.filter((entry) => entry.event === "watch_pr.webhook_fanout")).toEqual([
        expect.objectContaining({
          outcome: "completed",
          routed_watches: 1,
          published_watches: 1,
          storage_key_puts: 4,
          storage_key_deletes: 1,
          storage_key_writes: 5,
        }),
      ]);

      const stored = await readStoredWatchState(
        storage as unknown as DurableObjectStorage,
        watchStorageKey(userId, repository, number),
      );
      expect(stored.events).toHaveLength(1);
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
      log.mockRestore();
    }
  });

  it("logs zero-write fanout for an authenticated unmatched webhook", async () => {
    const { hub, pending } = hubFixture();
    const body = JSON.stringify({
      action: "synchronize",
      repository: { full_name: "other/repository" },
      pull_request: { number: 8 },
    });
    const headers = {
      "x-github-delivery": "unmatched-delivery",
      "x-github-event": "pull_request",
      "x-hub-signature-256": `sha256=${await hmacSha256Hex("webhook-secret", body)}`,
    };
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      const response = await hub.fetch(new Request("https://watch-pr.test/webhooks/github", {
        method: "POST",
        headers,
        body,
      }));
      expect(response.status).toBe(202);
      await Promise.all(pending.splice(0));

      const records = log.mock.calls.map(([value]) => JSON.parse(String(value)) as Record<string, unknown>);
      expect(records.filter((entry) => entry.event === "watch_pr.webhook_admission")).toEqual([
        expect.objectContaining({ github_event: "pull_request", outcome: "accepted" }),
      ]);
      expect(records.filter((entry) => entry.event === "watch_pr.webhook_fanout")).toEqual([
        expect.objectContaining({
          sample_rate: 1,
          sample_reason: "all",
          outcome: "completed",
          candidate_watches: 0,
          routed_watches: 0,
          published_watches: 0,
          storage_key_writes: 0,
        }),
      ]);
    } finally {
      log.mockRestore();
    }
  });

  it("omits unrecognized event names from authenticated admissions", async () => {
    const { hub } = hubFixture();
    const body = "{}";
    const headers = {
      "x-github-delivery": "unsupported-delivery",
      "x-github-event": "unsupported-event-name",
      "x-hub-signature-256": `sha256=${await hmacSha256Hex("webhook-secret", body)}`,
    };
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      const response = await hub.fetch(new Request("https://watch-pr.test/webhooks/github", {
        method: "POST",
        headers,
        body,
      }));
      await expect(response.json()).resolves.toMatchObject({ accepted: true, ignored: true });

      const admission = log.mock.calls
        .map(([value]) => JSON.parse(String(value)) as Record<string, unknown>)
        .find((entry) => entry.event === "watch_pr.webhook_admission");
      expect(admission).toMatchObject({ outcome: "unsupported_event" });
      expect(admission).not.toHaveProperty("github_event");
    } finally {
      log.mockRestore();
    }
  });


  it("retries a matched delivery after fanout storage fails", async () => {
    const { hub, pending, storage } = hubFixture();
    await storeMonitor(storage, { snapshot: snapshot(), events: [] });
    const deliveryId = "fanout-failure-delivery";
    const body = JSON.stringify({
      action: "synchronize",
      repository: { full_name: repository },
      pull_request: { number },
    });
    const headers = {
      "x-github-delivery": deliveryId,
      "x-github-event": "pull_request",
      "x-hub-signature-256": `sha256=${await hmacSha256Hex("webhook-secret", body)}`,
    };
    const indexKey = watchSidecarIndexKey(watchStorageKey(userId, repository, number));
    storage.putError = (key) => key === indexKey
      ? new Error("watch state write failed")
      : undefined;
    const fetchMock = openPullRequestFetch();
    vi.stubGlobal("fetch", fetchMock);
    try {
      const first = await hub.fetch(new Request("https://watch-pr.test/webhooks/github", {
        method: "POST",
        headers,
        body,
      }));
      expect(first.status).toBe(202);
      await Promise.all(pending.splice(0));
      await expect(storage.get<number>(`delivery:${deliveryId}`)).resolves.toBeUndefined();
      fetchMock.mockClear();
      storage.putError = undefined;

      const retry = await hub.fetch(new Request("https://watch-pr.test/webhooks/github", {
        method: "POST",
        headers,
        body,
      }));
      await expect(retry.json()).resolves.toMatchObject({ accepted: true, deliveryId });
      await Promise.all(pending.splice(0));
      expect(fetchMock).toHaveBeenCalled();
      await expect(storage.get<number>(`delivery:${deliveryId}`)).resolves.toEqual(expect.any(Number));

      const stored = await readStoredWatchState(
        storage as unknown as DurableObjectStorage,
        watchStorageKey(userId, repository, number),
      );
      expect(stored.events).toHaveLength(1);
      expect(stored.events[0]?.deliveryId).toBe(deliveryId);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("logs and resumes partial high-write fanout after a later target fails", async () => {
    const { hub, pending, storage } = hubFixture();
    const watcherIds = [41, 42, 43, 44, 45];
    for (const watcherId of watcherIds) {
      await storage.put(sessionStorageKey(`partial-failure-${watcherId}`), sessionRecord({
        user: { ...sessionRecord().user, id: watcherId },
        watches: [watch],
      }));
      await writeStoredWatchState(
        storage as unknown as DurableObjectStorage,
        watchStorageKey(watcherId, repository, number),
        { snapshot: snapshot(), events: [] },
      );
    }
    const failingIndexKey = watchSidecarIndexKey(watchStorageKey(45, repository, number));
    storage.putError = (key) => key === failingIndexKey
      ? new Error("later watch state write failed")
      : undefined;
    const deliveryId = "partial-failure-delivery";
    const body = JSON.stringify({
      action: "synchronize",
      repository: { full_name: repository },
      pull_request: { number },
    });
    const headers = {
      "x-github-delivery": deliveryId,
      "x-github-event": "pull_request",
      "x-hub-signature-256": `sha256=${await hmacSha256Hex("webhook-secret", body)}`,
    };
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.stubGlobal("fetch", openPullRequestFetch());
    try {
      const response = await hub.fetch(new Request("https://watch-pr.test/webhooks/github", {
        method: "POST",
        headers,
        body,
      }));
      expect(response.status).toBe(202);
      await Promise.all(pending.splice(0));
      await expect(storage.get<number>(`delivery:${deliveryId}`)).resolves.toBeUndefined();

      const records = log.mock.calls.map(([value]) => JSON.parse(String(value)) as Record<string, unknown>);
      expect(records.find((entry) => entry.event === "watch_pr.webhook_fanout")).toMatchObject({
        sample_rate: 1,
        sample_reason: "all",
        outcome: "failed",
        routed_watches: 5,
        published_watches: 4,
        // Four targets complete each event, snapshot, index, and root retirement. The fifth
        // persists its event and snapshot and retires the root before its index write fails.
        storage_key_puts: 14,
        storage_key_deletes: 5,
        storage_key_writes: 19,
      });
      expect(records.find((entry) => entry.event === "watch_pr.webhook_failure")).toMatchObject({
        delivery_fingerprint: await sha256Base64Url(deliveryId),
        error_kind: "unexpected",
        error_name: "Error",
      });

      storage.putError = undefined;
      const retry = await hub.fetch(new Request("https://watch-pr.test/webhooks/github", {
        method: "POST",
        headers,
        body,
      }));
      await expect(retry.json()).resolves.toMatchObject({ accepted: true, deliveryId });
      await Promise.all(pending.splice(0));
      await expect(storage.get<number>(`delivery:${deliveryId}`)).resolves.toEqual(expect.any(Number));

      const states = await Promise.all(watcherIds.map((watcherId) => readStoredWatchState(
        storage as unknown as DurableObjectStorage,
        watchStorageKey(watcherId, repository, number),
      )));
      expect(states.every((state) => state.events.length === 1 && state.events[0]?.deliveryId === deliveryId)).toBe(true);
    } finally {
      vi.unstubAllGlobals();
      log.mockRestore();
    }
  });



  it("counts invalidated session deletes in webhook fanout telemetry", async () => {
    const { hub, pending, storage } = hubFixture();
    await storeMonitor(storage, { snapshot: snapshot(), events: [] });
    const deliveryId = "invalidated-session-delivery";
    const body = JSON.stringify({
      action: "synchronize",
      repository: { full_name: repository },
      pull_request: { number },
    });
    const headers = {
      "x-github-delivery": deliveryId,
      "x-github-event": "pull_request",
      "x-hub-signature-256": `sha256=${await hmacSha256Hex("webhook-secret", body)}`,
    };
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ message: "Bad credentials" }, { status: 401 })));
    try {
      const response = await hub.fetch(new Request("https://watch-pr.test/webhooks/github", {
        method: "POST",
        headers,
        body,
      }));
      expect(response.status).toBe(202);
      await Promise.all(pending.splice(0));

      const telemetry = log.mock.calls
        .map(([value]) => JSON.parse(String(value)) as Record<string, unknown>)
        .find((entry) => entry.event === "watch_pr.webhook_fanout");
      expect(telemetry).toMatchObject({
        event: "watch_pr.webhook_fanout",
        sample_rate: 1,
        sample_reason: "all",
        outcome: "completed",
        delivery_dedupe_puts: 1,
        storage_key_puts: 1,
        storage_key_deletes: 3,
        storage_key_writes: 4,
      });
    } finally {
      vi.unstubAllGlobals();
      log.mockRestore();
    }
  });

  it("avoids no-op deletes while invalidating a session", async () => {
    const { hub, storage } = hubFixture();
    await storage.put(sessionStorageKey(sessionToken), sessionRecord({ watches: [watch] }));

    const deleted = await (hub as unknown as HubInternals).invalidateSession(sessionToken, "github-token");

    expect(deleted).toBe(1);
    expect(storage.deleteKeys).toEqual([sessionStorageKey(sessionToken)]);
  });
  it("retries after delivery admission storage fails", async () => {
    const { hub, pending, storage } = hubFixture();
    await storeMonitor(storage, { snapshot: snapshot(), events: [] });
    const deliveryId = "admission-retry-delivery";
    const body = JSON.stringify({
      action: "synchronize",
      repository: { full_name: repository },
      pull_request: { number },
    });
    const headers = {
      "x-github-delivery": deliveryId,
      "x-github-event": "pull_request",
      "x-hub-signature-256": `sha256=${await hmacSha256Hex("webhook-secret", body)}`,
    };
    storage.afterGet = (key) => {
      if (key !== `delivery:${deliveryId}`) return;
      storage.afterGet = undefined;
      throw new Error("admission read failed");
    };
    const fetchMock = openPullRequestFetch();
    vi.stubGlobal("fetch", fetchMock);
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      await expect(hub.fetch(new Request("https://watch-pr.test/webhooks/github", {
        method: "POST",
        headers,
        body,
      }))).rejects.toThrow("admission read failed");

      const admission = log.mock.calls
        .map(([value]) => JSON.parse(String(value)) as Record<string, unknown>)
        .find((entry) => entry.event === "watch_pr.webhook_admission");
      expect(admission).toMatchObject({
        github_event: "pull_request",
        outcome: "admission_error",
      });

      const retry = await hub.fetch(new Request("https://watch-pr.test/webhooks/github", {
        method: "POST",
        headers,
        body,
      }));
      expect(retry.status).toBe(202);
      await Promise.all(pending.splice(0));

      const stored = await readStoredWatchState(
        storage as unknown as DurableObjectStorage,
        watchStorageKey(userId, repository, number),
      );
      expect(stored.events).toHaveLength(1);
    } finally {
      vi.unstubAllGlobals();
      log.mockRestore();
    }
  });


  it("does not persist terminal webhook deliveries that publish nothing", async () => {
    const { hub, pending, storage } = hubFixture();
    const closed = snapshot({ state: "closed", fetchedAt: "2026-09-10T12:03:00.000Z" });
    await storeMonitor(storage, { snapshot: closed, events: [event("event-closed", closed, { action: "closed" })] });
    const deliveryId = "closed-watch-delivery";
    const body = JSON.stringify({
      action: "synchronize",
      repository: { full_name: repository },
      pull_request: { number },
    });
    const headers = {
      "x-github-delivery": deliveryId,
      "x-github-event": "pull_request",
      "x-hub-signature-256": `sha256=${await hmacSha256Hex("webhook-secret", body)}`,
    };

    const first = await hub.fetch(new Request("https://watch-pr.test/webhooks/github", {
      method: "POST",
      headers,
      body,
    }));
    expect(first.status).toBe(202);
    await Promise.all(pending.splice(0));
    await expect(storage.get<number>(`delivery:${deliveryId}`)).resolves.toBeUndefined();

    const retry = await hub.fetch(new Request("https://watch-pr.test/webhooks/github", {
      method: "POST",
      headers,
      body,
    }));
    await expect(retry.json()).resolves.toMatchObject({ accepted: true, deliveryId });
    await Promise.all(pending.splice(0));
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
        headRepository: repository,
        base: "main",
        sha: "sha-730",
      },
      {
        number: 733,
        head: "review-hobby-shop-tolerances",
        headRepository: repository,
        base: "recreate-pinion-handle",
        sha: "sha-733",
      },
      {
        number: 734,
        head: "review-machinist-prompt-eval",
        headRepository: "contributor/repo",
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
        headRepository: pullRequest.headRepository,
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
      await (hub as unknown as HubInternals).processWebhook("push", "delivery-730", {
        repository: { full_name: repository },
        ref: "refs/heads/recreate-pinion-handle",
      });
      const duplicate730 = await Promise.all(stack.map((pullRequest) =>
        readStoredWatchState(
          storage as unknown as DurableObjectStorage,
          watchStorageKey(userId, repository, pullRequest.number),
        )
      ));
      expect(duplicate730.map((state) => state.events.map((storedEvent) => storedEvent.deliveryId))).toEqual([
        ["delivery-730"],
        ["delivery-730"],
        [],
      ]);
      expect(fetchMock).not.toHaveBeenCalled();

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

      fetchMock.mockClear();
      await (hub as unknown as HubInternals).processWebhook("push", "delivery-base-collision", {
        repository: { full_name: repository },
        ref: "refs/heads/review-machinist-prompt-eval",
      });
      const afterBaseCollision = await readStoredWatchState(
        storage as unknown as DurableObjectStorage,
        watchStorageKey(userId, repository, 734),
      );
      expect(afterBaseCollision.events).toHaveLength(1);
      expect(fetchMock.mock.calls.some(([input]) => String(input).includes("/pulls/734"))).toBe(false);

      await (hub as unknown as HubInternals).processWebhook("push", "delivery-fork-head", {
        repository: { full_name: "contributor/repo" },
        ref: "refs/heads/review-machinist-prompt-eval",
      });
      const afterForkHead = await readStoredWatchState(
        storage as unknown as DurableObjectStorage,
        watchStorageKey(userId, repository, 734),
      );
      expect(afterForkHead.events.map((storedEvent) => storedEvent.deliveryId)).toEqual([
        "delivery-733",
        "delivery-fork-head",
      ]);
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
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-10T12:05:00.000Z"));
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

      // The watch now owns a sidecar, so the merge has to arrive the way production
      // delivers it: as a published event, not as a raw predecessor-record overwrite.
      const merged = snapshot({
        state: "closed",
        merged: true,
        mergedAt: "2026-09-10T12:04:00.000Z",
        fetchedAt: new Date(Date.now() + 60_000).toISOString(),
      });
      await internals.publishEvent(
        userId,
        watch,
        event("event-merged", merged, { action: "closed", changes: ["lifecycle"] }),
        { snapshot: merged },
      );
      fetchMock.mockClear();
      const mergedRegistration = await internals.watch(active, repository, number);
      expect(mergedRegistration.refreshScheduled).toBe(false);
      expect(pending).toHaveLength(0);
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
      vi.useRealTimers();
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

  it("mints a GET-only monitor capability with a strict twelve-hour lifetime", async () => {
    vi.useFakeTimers();
    const now = new Date("2026-09-19T12:00:00.000Z");
    vi.setSystemTime(now);
    const { hub, storage } = hubFixture();
    const record = sessionRecord({ expiresAt: now.getTime() + 30 * 24 * 60 * 60 * 1000 });
    await storage.put(sessionStorageKey(sessionToken), record);
    await writeStoredWatchState(
      storage as unknown as DurableObjectStorage,
      watchStorageKey(userId, repository, number),
      { snapshot: snapshot(), events: [] },
    );
    const internals = hub as unknown as HubInternals;
    const active = internals.newActiveSession(sessionToken, record, "stateful");

    try {
      const registration = await internals.openMonitor(active, repository, number);
      const capabilityName = new URL(registration.monitorUrl).pathname.split("/").at(-1);
      expect(capabilityName).toBeTruthy();
      const stored = await storage.get<MonitorCapabilityRecord>(
        monitorCapabilityStorageKey(capabilityName!),
      ) as MonitorCapabilityRecord;
      expect(stored.createdAt).toBe(now.getTime());
      expect(stored.expiresAt).toBe(now.getTime() + 12 * 60 * 60 * 1000);

      const writeAttempt = await hub.fetch(new Request(registration.monitorUrl, { method: "POST" }));
      expect(writeAttempt.status).toBe(405);
      await expect(storage.get(monitorCapabilityStorageKey(capabilityName!))).resolves.toBeDefined();

      vi.setSystemTime(now.getTime() + 12 * 60 * 60 * 1000 + 1);
      const expired = await hub.fetch(new Request(registration.monitorUrl));
      expect(expired.status).toBe(404);
      await expect(storage.get(monitorCapabilityStorageKey(capabilityName!))).resolves.toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it("closes and revokes an active feed when its twelve-hour lifetime ends", async () => {
    vi.useFakeTimers();
    const now = new Date("2026-09-19T12:00:00.000Z");
    vi.setSystemTime(now);
    const { hub, storage, pending } = hubFixture();
    const record = sessionRecord({ expiresAt: now.getTime() + 30 * 24 * 60 * 60 * 1000 });
    await storeMonitor(storage, { snapshot: snapshot(), events: [] }, record);
    await storage.put(monitorCapabilityStorageKey(capability), {
      sessionToken,
      userId,
      repository,
      pullRequestNumber: number,
      createdAt: now.getTime() - 12 * 60 * 60 * 1000 + 10,
      expiresAt: record.expiresAt,
    } satisfies MonitorCapabilityRecord);

    try {
      const response = await hub.fetch(new Request(`https://watch-pr.test/monitor/${capability}`));
      expect(response.status).toBe(200);
      const reader = response.body!.getReader();
      await reader.read();

      await vi.advanceTimersByTimeAsync(11);
      await Promise.all(pending);

      await expect(reader.read()).resolves.toMatchObject({ done: true });
      await expect(storage.get(monitorCapabilityStorageKey(capability))).resolves.toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it("reaps expired capabilities that were never opened", async () => {
    vi.useFakeTimers();
    const now = new Date("2026-09-19T12:00:00.000Z");
    vi.setSystemTime(now);
    const { hub, storage, pending } = hubFixture();
    const record = sessionRecord({ expiresAt: now.getTime() + 30 * 24 * 60 * 60 * 1000 });
    await storeMonitor(storage, {
      snapshot: snapshot({ state: "closed", merged: true, mergedAt: now.toISOString() }),
      events: [],
    }, record);
    await storage.put(monitorCapabilityStorageKey(capability), {
      sessionToken,
      userId,
      repository,
      pullRequestNumber: number,
      createdAt: now.getTime() - 12 * 60 * 60 * 1000 - 1,
      expiresAt: record.expiresAt,
    } satisfies MonitorCapabilityRecord);

    try {
      const response = await hub.fetch(new Request("https://watch-pr.test/internal/poll", { method: "POST" }));
      expect(response.status).toBe(202);
      await Promise.all(pending);
      await expect(storage.get(monitorCapabilityStorageKey(capability))).resolves.toBeUndefined();
      await expect(storage.get(
        monitorScopeStorageKey(sessionToken, repository, number),
      )).resolves.toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
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

  it("hydrates full payloads and order across indexed predecessor and sidecar events", async () => {
    const { hub, storage } = hubFixture();
    const record = sessionRecord();
    const legacy = event("event-legacy", snapshot(), { payload: { legacy: "x".repeat(20_000) } });
    await storeMonitor(storage, { snapshot: legacy.snapshot, events: [legacy] }, record);
    const internals = hub as unknown as HubInternals;
    const active = internals.newActiveSession(sessionToken, record, "stateful");
    const appendedSnapshot = snapshot({ headSha: "appended", fetchedAt: "2026-09-10T12:05:00.000Z" });
    const appended = event("event-appended", appendedSnapshot, { payload: { appended: true } });
    await internals.publishEvent(userId, watch, appended, { snapshot: appendedSnapshot });

    const storageKey = watchStorageKey(userId, repository, number);
    const storedIndex = await storage.get<unknown>(watchSidecarIndexKey(storageKey));
    expect(storedIndex).toBeDefined();
    expect(JSON.stringify(storedIndex)).not.toContain("\"details\"");
    const state = await internals.readWatch(active, repository, number);
    expect(state.snapshot).toMatchObject({ headSha: "appended" });
    // The predecessor payload is still served from the untouched root record, and only the
    // newest event carries the snapshot, exactly as the single-record layout did.
    expect(state.events).toEqual([
      { ...legacy, snapshot: null },
      { ...appended, details: ["mergeability: head -> feature@appended"] },
    ]);
  });

  it("hydrates monitor replay while keeping other hot paths off sidecar payload rows", async () => {
    const { hub, pending, storage } = hubFixture();
    const record = sessionRecord();
    const seeded = event("event-seeded", snapshot(), { payload: { seeded: "x".repeat(20_000) } });
    await storeMonitor(storage, { snapshot: seeded.snapshot, events: [seeded] }, record);
    const internals = hub as unknown as HubInternals;
    const active = internals.newActiveSession(sessionToken, record, "stateful");
    internals.activeSessions.set("mcp-session", active);
    const appendedSnapshot = snapshot({ headSha: "appended", fetchedAt: "2026-09-10T12:05:00.000Z" });
    await internals.publishEvent(
      userId,
      watch,
      event("event-appended", appendedSnapshot, { payload: { appended: true } }),
      { snapshot: appendedSnapshot },
    );

    const storageKey = watchStorageKey(userId, repository, number);
    const fetchMock = openPullRequestFetch();
    vi.stubGlobal("fetch", fetchMock);
    try {
      storage.getKeys.length = 0;

      const registration = await internals.openMonitor(active, repository, number);
      expect(registration.cursor).toBe("event-appended");
      storage.getKeys.length = 0;
      const idleFeed = feedReader(await hub.fetch(new Request(
        `https://watch-pr.test/monitor/${capability}?cursor=event-appended`,
      )));
      await idleFeed.reader.cancel();
      expect(storage.getKeys).not.toContain(watchSidecarEventKey(storageKey, 0));
      expect(storage.getKeys).not.toContain(storageKey);
      storage.getKeys.length = 0;
      const feed = feedReader(await hub.fetch(new Request(
        `https://watch-pr.test/monitor/${capability}?cursor=event-seeded`,
      )));
      await expect(nextMonitorEvent(feed)).resolves.toMatchObject({ id: "event-appended" });
      await feed.reader.cancel();
      expect(storage.getKeys).toContain(watchSidecarEventKey(storageKey, 0));
      storage.getKeys.length = 0;

      await expect(internals.listWatches(active)).resolves.toMatchObject([{ key: watch }]);

      await internals.processWebhook("pull_request", "delivery-event-appended", {
        action: "synchronize",
        repository: { full_name: repository },
        pull_request: { number },
      });

      const poll = await hub.fetch(new Request("https://watch-pr.test/internal/poll", { method: "POST" }));
      expect(poll.status).toBe(202);
      await Promise.all(pending.splice(0));
    } finally {
      vi.unstubAllGlobals();
    }

    expect(storage.getKeys).toContain(watchSidecarIndexKey(storageKey));
    expect(storage.getKeys.some((key) => key.startsWith(`${storageKey}:sidecar:snapshot:`))).toBe(true);
    const payloadKeys = [0, 1, 2, 3].map((sequence) => watchSidecarEventKey(storageKey, sequence));
    expect(storage.getKeys.filter((key) => payloadKeys.includes(key))).toEqual([]);
    expect(storage.getKeys).not.toContain(storageKey);
  });

  it("buffers live terminal events published while replay payloads hydrate", async () => {
    const { hub, storage } = hubFixture();
    const record = sessionRecord();
    const seeded = event("event-seeded", snapshot(), { payload: { seeded: "x".repeat(20_000) } });
    await storeMonitor(storage, { snapshot: seeded.snapshot, events: [seeded] }, record);
    const internals = hub as unknown as HubInternals;
    const appendedSnapshot = snapshot({
      headSha: "appended",
      fetchedAt: "2026-09-10T12:05:00.000Z",
    });
    await internals.publishEvent(
      userId,
      watch,
      event("event-appended", appendedSnapshot, { payload: { appended: true } }),
      { snapshot: appendedSnapshot },
    );

    let hydrationStartedResolve!: () => void;
    let releaseHydration!: () => void;
    const hydrationStarted = new Promise<void>((resolve) => {
      hydrationStartedResolve = resolve;
    });
    const hydrationGate = new Promise<void>((resolve) => {
      releaseHydration = resolve;
    });
    const payloadKey = watchSidecarEventKey(
      watchStorageKey(userId, repository, number),
      0,
    );
    storage.afterGet = async (key) => {
      if (key !== payloadKey) return;
      storage.afterGet = undefined;
      hydrationStartedResolve();
      await hydrationGate;
    };

    const responsePromise = hub.fetch(new Request(
      `https://watch-pr.test/monitor/${capability}?cursor=event-seeded`,
    ));
    await hydrationStarted;
    const mergedSnapshot = snapshot({
      state: "closed",
      merged: true,
      mergedAt: "2026-09-10T12:06:00.000Z",
      fetchedAt: "2026-09-10T12:06:00.000Z",
    });
    await internals.publishEvent(
      userId,
      watch,
      event("event-merged", mergedSnapshot, { action: "closed" }),
      { snapshot: mergedSnapshot },
    );
    releaseHydration();

    const feed = feedReader(await responsePromise);
    await expect(nextMonitorEvent(feed)).resolves.toMatchObject({
      id: "event-appended",
      terminalState: "watching",
    });
    await expect(nextMonitorEvent(feed)).resolves.toMatchObject({
      id: "event-merged",
      terminalState: "merged",
    });
    await expect(feed.reader.read()).resolves.toMatchObject({ done: true });
    expect(internals.activeMonitorFeeds.size).toBe(0);
  });

  it("stores distinct deliveries that carry no snapshot change", async () => {
    const { hub, storage } = hubFixture();
    await storeMonitor(storage, { snapshot: snapshot({ headSha: "reopened" }), events: [] });
    const internals = hub as unknown as HubInternals;
    const payload = {
      action: "synchronize",
      repository: { full_name: repository },
      pull_request: { number },
    };
    const fetchMock = openPullRequestFetch();
    vi.stubGlobal("fetch", fetchMock);
    try {
      await internals.processWebhook("pull_request", "delivery-first", payload);
      await internals.processWebhook("pull_request", "delivery-second", payload);
    } finally {
      vi.unstubAllGlobals();
    }

    const stored = await readStoredWatchState(
      storage as unknown as DurableObjectStorage,
      watchStorageKey(userId, repository, number),
    );
    expect(stored.events.map((storedEvent) => storedEvent.deliveryId)).toEqual(["delivery-first", "delivery-second"]);
    expect(stored.events.map((storedEvent) => storedEvent.changes)).toEqual([[], []]);
  });

  it("writes nothing when a polled refresh finds no snapshot change", async () => {
    const { hub, pending, storage } = hubFixture();
    const unchanged = snapshot({ headSha: "reopened" });
    await storeMonitor(storage, { snapshot: unchanged, events: [event("event-1", unchanged)] });
    const storageKey = watchStorageKey(userId, repository, number);
    const fetchMock = openPullRequestFetch();
    vi.stubGlobal("fetch", fetchMock);
    try {
      storage.putKeys.length = 0;
      storage.deleteKeys.length = 0;
      const poll = await hub.fetch(new Request("https://watch-pr.test/internal/poll", { method: "POST" }));
      expect(poll.status).toBe(202);
      await Promise.all(pending.splice(0));
      expect(fetchMock).toHaveBeenCalled();
      expect(storage.putKeys).toEqual([]);
      expect(storage.deleteKeys).toEqual([]);
    } finally {
      vi.unstubAllGlobals();
    }

    await expect(storage.get(watchSidecarIndexKey(storageKey))).resolves.toBeUndefined();
    const stored = await readStoredWatchState(storage as unknown as DurableObjectStorage, storageKey);
    expect(stored.events.map((storedEvent) => storedEvent.id)).toEqual(["event-1"]);
  });
});
