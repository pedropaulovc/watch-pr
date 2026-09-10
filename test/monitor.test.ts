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

  async get<T>(key: string | string[]): Promise<T | undefined | Map<string, T>> {
    if (Array.isArray(key)) {
      return new Map(key.flatMap((entry) => {
        const value = this.values.get(entry);
        return value === undefined ? [] : [[entry, value as T]];
      }));
    }
    return this.values.get(key) as T | undefined;
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
  newActiveSession(token: string, record: SessionRecord, kind: "stateful"): TestActiveSession;
  openMonitor(active: TestActiveSession, repository: string, number: number): Promise<{
    monitorUrl: string;
    cursor: string | null;
    terminalState: string;
  }>;
  unwatch(active: TestActiveSession, repository: string, number: number): Promise<boolean>;
  publishEvent(
    userId: number,
    key: string,
    event: WatchEvent,
    state: Pick<StoredWatchState, "snapshot">,
  ): Promise<void>;
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
