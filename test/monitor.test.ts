import { describe, expect, it, vi, type Mock } from "vitest";
import { hmacSha256Hex, sha256Base64Url } from "../src/crypto";
import {
  WatchPrHub,
  openWatchStateMutation,
  readStoredWatchState,
  writeStoredWatchState,
  type Env,
} from "../src/hub";
import type {
  CoverageIndex,
  MonitorCapabilityRecord,
  PollSchedule,
  PrMonitorEvent,
  PullRequestSnapshot,
  SessionRecord,
  StoredWatchState,
  WatchEvent,
  WatchReadState,
} from "../src/types";
import {
  monitorCapabilityStorageKey,
  monitorScopeStorageKey,
  POLL_SCHEDULE_KEY,
  pollScheduleId,
  sessionStorageKey,
  WEBHOOK_COVERAGE_KEY,
  watchSidecarEventKey,
  watchSidecarIndexKey,
  watchPolledKey,
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
    bodyReactionDetails: [],
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

function hubFixture(envOverrides: Partial<Env> = {}): {
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
    ...envOverrides,
  };
  return { hub: new WatchPrHub(state, env), storage, pending, restart: () => new WatchPrHub(state, env) };
}

/** Keys written besides the poll time, which every successful read may advance. */
function snapshotWrites(keys: readonly string[]): string[] {
  return keys.filter((key) => key !== watchPolledKey(watchStorageKey(userId, repository, number)));
}

/**
 * Serves `base` with an ETag per URL and answers 304 to a matching `If-None-Match`, counting
 * what each poll spent. Bumping `generation` reissues every ETag for unchanged bodies.
 */
function conditionalFetch(base: (input: RequestInfo | URL) => Promise<Response>) {
  const github = { generation: 1, fetched: 0, notModified: 0, graphql: 0 };
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith("/graphql")) {
      github.graphql += 1;
      return base(input);
    }
    const etag = `"${github.generation}:${url}"`;
    if (new Headers(init?.headers).get("if-none-match") === etag) {
      github.notModified += 1;
      return new Response(null, { status: 304, headers: { etag } });
    }
    github.fetched += 1;
    const response = await base(input);
    const headers = new Headers(response.headers);
    headers.set("etag", etag);
    return new Response(response.body, { status: response.status, headers });
  });
  return { github, fetchMock };
}

/** One poll tick run to completion, with the write log and request counters reset first. */
function pollOnce(
  hub: WatchPrHub,
  pending: Promise<unknown>[],
  storage: MemoryStorage,
  github: { fetched: number; notModified: number; graphql: number },
): () => Promise<void> {
  return async () => {
    storage.putKeys.length = 0;
    storage.deleteKeys.length = 0;
    github.fetched = 0;
    github.notModified = 0;
    github.graphql = 0;
    const response = await hub.fetch(new Request("https://watch-pr.test/internal/poll", { method: "POST" }));
    expect(response.status).toBe(202);
    await Promise.all(pending.splice(0));
  };
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
    if (url.endsWith("/commits/reopened/check-suites?per_page=100")) return Response.json({ check_suites: [] });
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
    if (url.pathname.endsWith("/check-suites")) return Response.json({ check_suites: [] });
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
  // An indexed watch in steady state: its hourly reconcile is not due, and unknown coverage polls it every tick.
  await storage.put(POLL_SCHEDULE_KEY, {
    [pollScheduleId(userId, watch)]: { state: "active", dueAt: Date.now() + 60 * 60 * 1000 },
  } satisfies PollSchedule);
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
  readWatch(active: TestActiveSession, repository: string, number: number): Promise<WatchReadState>;
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
    const connected = await feed.reader.read();
    expect(connected.done).toBe(false);
    expect(feed.decoder.decode(connected.value)).toContain("retry: 60000\n: connected\n\n");
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

  it("stops terminal reconnects and preserves older-cursor replay", async () => {
    const { hub, storage } = hubFixture();
    const initial = event("event-1");
    await storeMonitor(storage, { snapshot: initial.snapshot, events: [initial] });
    const url = `https://watch-pr.test/monitor/${capability}?cursor=event-1`;
    const response = await hub.fetch(new Request(url));
    expect(response.status).toBe(200);
    const feed = feedReader(response);
    const connected = await feed.reader.read();
    expect(connected.done).toBe(false);
    expect(feed.decoder.decode(connected.value)).toContain("retry: 60000\n: connected\n\n");

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
    const completedReconnect = await hub.fetch(new Request(url, {
      headers: { "last-event-id": "event-terminal" },
    }));
    expect(completedReconnect.status).toBe(204);
    expect(completedReconnect.body).toBeNull();
    expect(completedReconnect.headers.get("cache-control")).toBe("no-store");
    // The URL cursor alone is not an acknowledgement: a newly issued monitor URL may already be terminal.
    const firstTerminalRead = await hub.fetch(new Request(`https://watch-pr.test/monitor/${capability}?cursor=event-terminal`));
    expect(firstTerminalRead.status).toBe(200);
    const firstTerminalFeed = feedReader(firstTerminalRead);
    await expect(nextMonitorEvent(firstTerminalFeed)).resolves.toMatchObject({
      id: "event-terminal",
      terminalState: "merged",
    });
    await expect(firstTerminalFeed.reader.read()).resolves.toMatchObject({ done: true });

    const replayResponse = await hub.fetch(new Request(url));
    expect(replayResponse.status).toBe(200);
    const replay = feedReader(replayResponse);
    const replayPrelude = await replay.reader.read();
    expect(replayPrelude.done).toBe(false);
    expect(replay.decoder.decode(replayPrelude.value)).toContain("retry: 60000\n: connected\n\n");
    await expect(nextMonitorEvent(replay)).resolves.toMatchObject({
      id: "event-terminal",
      terminalState: "merged",
    });
    await expect(replay.reader.read()).resolves.toMatchObject({ done: true });

    const olderHeaderResponse = await hub.fetch(new Request(
      `https://watch-pr.test/monitor/${capability}?cursor=event-terminal`,
      { headers: { "last-event-id": "event-1" } },
    ));
    expect(olderHeaderResponse.status).toBe(200);
    const olderHeaderFeed = feedReader(olderHeaderResponse);
    await expect(nextMonitorEvent(olderHeaderFeed)).resolves.toMatchObject({
      id: "event-terminal",
      terminalState: "merged",
    });
    await expect(olderHeaderFeed.reader.read()).resolves.toMatchObject({ done: true });
  });

  it("keeps watching when Last-Event-ID acknowledges the latest nonterminal event", async () => {
    const { hub, storage } = hubFixture();
    const current = snapshot();
    await storeMonitor(storage, { snapshot: current, events: [event("event-1", current)] });
    const response = await hub.fetch(new Request(`https://watch-pr.test/monitor/${capability}`, {
      headers: { "last-event-id": "event-1" },
    }));
    expect(response.status).toBe(200);
    const feed = feedReader(response);
    const connected = await feed.reader.read();
    expect(connected.done).toBe(false);
    expect(feed.decoder.decode(connected.value)).toContain(": connected\n\n");
    await feed.reader.cancel();
  });

  it("stops an acknowledged synthetic terminal snapshot after an empty event log", async () => {
    const { hub, storage } = hubFixture();
    const mergedSnapshot = snapshot({ state: "closed", merged: true, mergedAt: "2026-09-10T12:02:00.000Z" });
    await storeMonitor(storage, { snapshot: mergedSnapshot, events: [] });
    const url = `https://watch-pr.test/monitor/${capability}`;
    const first = feedReader(await hub.fetch(new Request(url)));
    await expect(nextMonitorEvent(first)).resolves.toMatchObject({
      id: `snapshot-${mergedSnapshot.fetchedAt}`,
      action: "terminal_snapshot",
      terminalState: "merged",
    });
    await expect(first.reader.read()).resolves.toMatchObject({ done: true });
    const acknowledged = await hub.fetch(new Request(url, {
      headers: { "last-event-id": `snapshot-${mergedSnapshot.fetchedAt}` },
    }));
    expect(acknowledged.status).toBe(204);
    expect(acknowledged.body).toBeNull();
  });

  it("reports the reaction counts a merge could not attribute instead of restoring the stored ones", async () => {
    const { hub, storage } = hubFixture();
    const read = snapshot({
      bodyReactions: { heart: 1, total_count: 1 },
      bodyReactionDetails: [{ id: 901, content: "heart", author: "alice", authorId: 11, createdAt: "2026-09-10T11:59:00.000Z" }],
      bodyReactionDetailsReadAt: "2026-09-10T12:00:00.000Z",
    });
    await storeMonitor(storage, { snapshot: read, events: [event("event-1", read)] });
    const response = await hub.fetch(new Request(`https://watch-pr.test/monitor/${capability}?cursor=event-1`));
    const feed = feedReader(response);

    // The refresh that saw the merge also saw two more hearts, and its detail read failed.
    const mergedSnapshot = snapshot({
      state: "closed",
      merged: true,
      mergedAt: "2026-09-10T12:02:00.000Z",
      fetchedAt: "2026-09-10T12:02:00.000Z",
      bodyReactions: { heart: 3, total_count: 3 },
      bodyReactionDetails: undefined,
    });
    const internals = hub as unknown as HubInternals;
    await internals.publishEvent(
      userId,
      watch,
      event("event-merged", mergedSnapshot, { action: "closed", changes: ["lifecycle", "reactions"] }),
      { snapshot: mergedSnapshot },
    );

    const delivered = await nextMonitorEvent(feed);
    expect(delivered).toMatchObject({ id: "event-merged", terminalState: "merged" });
    expect(delivered.details.filter((line) => line.startsWith("reaction"))).toEqual([
      "reaction counts: HEART 1 -> 3 on PR #7 @author https://github.com/owner/repo/pull/7 (attribution unavailable)",
    ]);
    await expect(feed.reader.read()).resolves.toMatchObject({ done: true });

    // Nothing will read this PR again, so the terminal snapshot keeps the counts it saw
    // rather than the complete-looking pair it could no longer confirm.
    const stored = await readStoredWatchState(storage as unknown as DurableObjectStorage, watchStorageKey(userId, repository, number));
    expect(stored.snapshot).toMatchObject({ merged: true, bodyReactions: { heart: 3, total_count: 3 } });
    expect(stored.snapshot?.bodyReactionDetails).toBeUndefined();
    expect(stored.events.map((storedEvent) => storedEvent.id)).toEqual(["event-1", "event-merged"]);
  });

  it("reports an unfinished reaction cursor on closure and drops the cursor nothing will resume", async () => {
    const { hub, storage } = hubFixture();
    const comment = {
      id: 11,
      author: "commenter",
      body: "please review",
      createdAt: "2026-09-10T11:00:00.000Z",
      updatedAt: "2026-09-10T11:00:00.000Z",
      htmlUrl: "https://github.com/owner/repo/pull/7#issuecomment-11",
      reactions: { rocket: 1, total_count: 1 },
    };
    // A second target neither snapshot ever read: unchanged counts have nothing to report,
    // so closure must not turn every unknown target into a line.
    const unread = {
      id: 12,
      author: "reviewer",
      body: "nit",
      createdAt: "2026-09-10T11:10:00.000Z",
      updatedAt: "2026-09-10T11:10:00.000Z",
      htmlUrl: "https://github.com/owner/repo/pull/7#discussion_r12",
      reactions: { "+1": 2, total_count: 2 },
    };
    const read = snapshot({
      comments: [{
        ...comment,
        reactionDetails: [{ id: 902, content: "rocket", author: "bob", authorId: 12, createdAt: "2026-09-10T11:30:00.000Z" }],
        reactionDetailsReadAt: "2026-09-10T12:00:00.000Z",
      }],
      reviewComments: [unread],
    });
    await storeMonitor(storage, { snapshot: read, events: [event("event-1", read)] });
    const response = await hub.fetch(new Request(`https://watch-pr.test/monitor/${capability}?cursor=event-1`));
    const feed = feedReader(response);

    // This refresh ran out of reaction request budget one page in, and then the PR closed.
    const closedSnapshot = snapshot({
      state: "closed",
      fetchedAt: "2026-09-10T12:02:00.000Z",
      comments: [{
        ...comment,
        reactions: { rocket: 4, total_count: 4 },
        reactionProgress: {
          records: [{ id: 902, content: "rocket", author: "bob", authorId: 12, createdAt: "2026-09-10T11:30:00.000Z" }],
          nextUrl: "https://api.github.com/repos/owner/repo/issues/comments/11/reactions?per_page=100&page=2",
        },
        reactionDetailsReadAt: "2026-09-10T12:01:00.000Z",
      }],
      reviewComments: [unread],
    });
    const internals = hub as unknown as HubInternals;
    await internals.publishEvent(
      userId,
      watch,
      event("event-closed", closedSnapshot, { action: "closed", changes: ["lifecycle", "reactions"] }),
      { snapshot: closedSnapshot },
    );

    const delivered = await nextMonitorEvent(feed);
    expect(delivered).toMatchObject({ id: "event-closed", terminalState: "closed" });
    expect(delivered.details.filter((line) => line.startsWith("reaction"))).toEqual([
      "reaction counts: ROCKET 1 -> 4 on comment #11 @commenter https://github.com/owner/repo/pull/7#issuecomment-11 (attribution unavailable)",
    ]);
    await expect(feed.reader.read()).resolves.toMatchObject({ done: true });

    const stored = await readStoredWatchState(storage as unknown as DurableObjectStorage, watchStorageKey(userId, repository, number));
    expect(stored.snapshot?.comments[0]).toMatchObject({ reactions: { rocket: 4, total_count: 4 } });
    expect(stored.snapshot?.comments[0]?.reactionDetails).toBeUndefined();
    expect(stored.snapshot?.comments[0]?.reactionProgress).toBeUndefined();
    expect(stored.events.map((storedEvent) => storedEvent.id)).toEqual(["event-1", "event-closed"]);
  });

  it("keeps the counts a merge observed last when its borrowed details descend from a concurrent state", async () => {
    const { hub, storage } = hubFixture();
    const alice = { id: 901, content: "heart", author: "alice", authorId: 11, createdAt: "2026-09-10T11:30:00.000Z" };
    const bob = { id: 902, content: "heart", author: "bob", authorId: 12, createdAt: "2026-09-10T12:00:30.000Z" };
    // A concurrent refresh read and committed the moment bob's reaction existed.
    const committed = snapshot({
      fetchedAt: "2026-09-10T12:01:00.000Z",
      bodyReactions: { heart: 2, total_count: 2 },
      bodyReactionsObservedAt: "2026-09-10T12:01:00.000Z",
      bodyReactionDetails: [alice, bob],
      bodyReactionDetailsReadAt: "2026-09-10T12:01:00.000Z",
    });
    await storeMonitor(storage, { snapshot: committed, events: [event("event-1", committed)] });
    const response = await hub.fetch(new Request(`https://watch-pr.test/monitor/${capability}?cursor=event-1`));
    const feed = feedReader(response);

    // The merging refresh saw bob's reaction gone: its counts match the single-heart
    // snapshot it started from, so it borrowed those details instead of reading again.
    const mergedSnapshot = snapshot({
      state: "closed",
      merged: true,
      mergedAt: "2026-09-10T12:02:00.000Z",
      fetchedAt: "2026-09-10T12:02:00.000Z",
      bodyReactions: { heart: 1, total_count: 1 },
      bodyReactionsObservedAt: "2026-09-10T12:02:00.000Z",
      bodyReactionDetails: [alice],
      bodyReactionDetailsState: "borrowed",
      bodyReactionDetailsReadAt: "2026-09-10T11:31:00.000Z",
    });
    const internals = hub as unknown as HubInternals;
    await internals.publishEvent(
      userId,
      watch,
      event("event-merged", mergedSnapshot, { action: "closed", changes: ["lifecycle", "reactions"] }),
      { snapshot: mergedSnapshot },
    );

    const delivered = await nextMonitorEvent(feed);
    expect(delivered).toMatchObject({ id: "event-merged", terminalState: "merged" });
    // The borrow is not a read, so it cannot pass for the deletion's attribution; the counts
    // this refresh observed last are reported instead, once.
    expect(delivered.details.filter((line) => line.startsWith("reaction"))).toEqual([
      "reaction counts: HEART 2 -> 1 on PR #7 @author https://github.com/owner/repo/pull/7 (attribution unavailable)",
    ]);
    await expect(feed.reader.read()).resolves.toMatchObject({ done: true });

    const stored = await readStoredWatchState(storage as unknown as DurableObjectStorage, watchStorageKey(userId, repository, number));
    expect(stored.snapshot).toMatchObject({ merged: true, bodyReactions: { heart: 1, total_count: 1 } });
    expect(stored.snapshot?.bodyReactionDetails).toBeUndefined();
    expect(stored.snapshot?.bodyReactionDetailsState).toBeUndefined();
    expect(stored.events.map((storedEvent) => storedEvent.id)).toEqual(["event-1", "event-merged"]);
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
          // Event, snapshot, index, poll time, the first delivery's coverage proof, and the
          // delivery marker. The mergeability follow-up is held in memory and writes nothing.
          storage_key_puts: 6,
          storage_key_deletes: 1,
          storage_key_writes: 7,
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
        // The first delivery for the repository records its coverage proof. Four targets
        // complete each event, snapshot, index, and root retirement, then record their poll
        // time. The fifth persists its event and snapshot and retires the root before its
        // index write fails, so its poll time and the follow-ups are never recorded.
        storage_key_puts: 19,
        storage_key_deletes: 5,
        storage_key_writes: 24,
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
        // The coverage proof and the delivery marker; the invalidated session gets no follow-up.
        storage_key_puts: 2,
        storage_key_deletes: 3,
        storage_key_writes: 5,
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
    expect(new URL(registration.monitorUrl).searchParams.has("cursor")).toBe(false);
    const firstRead = await hub.fetch(new Request(registration.monitorUrl));
    expect(firstRead.status).toBe(200);
    const terminalFeed = feedReader(firstRead);
    await expect(nextMonitorEvent(terminalFeed)).resolves.toMatchObject({
      id: "event-closed",
      terminalState: "closed",
    });
    await expect(terminalFeed.reader.read()).resolves.toMatchObject({ done: true });

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

  it("replays the terminal event when a client sends the issued URL cursor as its first header", async () => {
    const { hub, storage } = hubFixture();
    const initial = event("event-initial");
    const terminalSnapshot = snapshot({ state: "closed", merged: true, mergedAt: "2026-09-10T12:03:00.000Z" });
    const terminal = event("event-merged", terminalSnapshot, { action: "closed", changes: ["lifecycle"] });
    const record = sessionRecord();
    await storeMonitor(storage, { snapshot: terminalSnapshot, events: [initial, terminal] }, record);
    const internals = hub as unknown as HubInternals;
    const active = internals.newActiveSession(sessionToken, record, "stateful");
    const registration = await internals.openMonitor(active, repository, number);
    expect(registration.cursor).toBe("event-merged");
    const firstUrl = new URL(registration.monitorUrl);
    const initialCursor = firstUrl.searchParams.get("cursor");
    expect(initialCursor).toBe("event-initial");
    firstUrl.searchParams.delete("cursor");

    const firstRead = await hub.fetch(new Request(firstUrl, {
      headers: { "last-event-id": initialCursor! },
    }));
    expect(firstRead.status).toBe(200);
    const feed = feedReader(firstRead);
    await expect(nextMonitorEvent(feed)).resolves.toMatchObject({
      id: "event-merged",
      terminalState: "merged",
    });
    await expect(feed.reader.read()).resolves.toMatchObject({ done: true });
    const acknowledged = await hub.fetch(new Request(firstUrl, {
      headers: { "last-event-id": "event-merged" },
    }));
    expect(acknowledged.status).toBe(204);
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

  it("buffers a reopen that arrives while a terminal replay hydrates", async () => {
    const { hub, storage } = hubFixture();
    const record = sessionRecord();
    const seeded = event("event-seeded", snapshot(), { payload: { seeded: "x".repeat(20_000) } });
    await storeMonitor(storage, { snapshot: seeded.snapshot, events: [seeded] }, record);
    const internals = hub as unknown as HubInternals;
    const closedSnapshot = snapshot({
      state: "closed",
      fetchedAt: "2026-09-10T12:05:00.000Z",
    });
    await internals.publishEvent(
      userId,
      watch,
      event("event-closed", closedSnapshot, { action: "closed" }),
      { snapshot: closedSnapshot },
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
    const reopenedSnapshot = snapshot({
      headSha: "reopened",
      fetchedAt: "2026-09-10T12:06:00.000Z",
    });
    await internals.publishEvent(
      userId,
      watch,
      event("event-reopened", reopenedSnapshot, { action: "reopened" }),
      { snapshot: reopenedSnapshot },
    );
    releaseHydration();

    const feed = feedReader(await responsePromise);
    await expect(nextMonitorEvent(feed)).resolves.toMatchObject({
      id: "event-reopened",
      action: "reopened",
      terminalState: "watching",
    });
    expect(internals.activeMonitorFeeds.size).toBe(1);
    await feed.reader.cancel();
    expect(internals.activeMonitorFeeds.size).toBe(0);
  });

  it("cleans up a pending feed when replay hydration fails", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-09-19T12:00:00.000Z"));
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
      const payloadKey = watchSidecarEventKey(
        watchStorageKey(userId, repository, number),
        0,
      );
      storage.afterGet = (key) => {
        if (key === payloadKey) throw new Error("replay hydration failed");
      };

      await expect(hub.fetch(new Request(
        `https://watch-pr.test/monitor/${capability}?cursor=event-seeded`,
      ))).rejects.toThrow("replay hydration failed");
      expect(internals.activeMonitorFeeds.size).toBe(0);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
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

  it("stores a webhook delivery emptied by concurrent reconciliation", async () => {
    const { hub, storage } = hubFixture();
    const current = snapshot({ headSha: "concurrently-stored" });
    await storeMonitor(storage, { snapshot: current, events: [] });
    const internals = hub as unknown as HubInternals;
    await internals.publishEvent(
      userId,
      watch,
      event("event-webhook-reconciled", current, {
        deliveryId: "delivery-webhook-reconciled",
        changes: ["mergeability"],
      }),
      { snapshot: current },
    );

    const stored = await readStoredWatchState(
      storage as unknown as DurableObjectStorage,
      watchStorageKey(userId, repository, number),
    );
    expect(stored.events).toHaveLength(1);
    expect(stored.events[0].deliveryId).toBe("delivery-webhook-reconciled");
    expect(stored.events[0].changes).toEqual([]);
  });

  it("drops a comment-reaction event emptied by transactional fallback", async () => {
    const { hub, storage } = hubFixture();
    const reactedComment = {
      id: 11,
      author: "bob",
      body: "note",
      createdAt: "2026-09-10T12:00:00.000Z",
      updatedAt: "2026-09-10T12:00:00.000Z",
      reactions: { heart: 1, total_count: 1 },
      reactionDetails: [{
        id: 901,
        content: "heart",
        author: "alice",
        authorId: 11,
        createdAt: "2026-09-10T12:00:00.000Z",
      }],
    };
    const storedSnapshot = snapshot({ comments: [reactedComment] });
    await storeMonitor(storage, { snapshot: storedSnapshot, events: [] });
    const unknownIncoming = snapshot({
      fetchedAt: "2026-09-10T12:05:00.000Z",
      comments: [{
        ...reactedComment,
        reactions: { heart: 1, rocket: 1, total_count: 2 },
        reactionDetails: undefined,
      }],
    });
    const internals = hub as unknown as HubInternals;
    await internals.publishEvent(
      userId,
      watch,
      event("event-reaction-fallback", unknownIncoming, {
        deliveryId: "delivery-reaction-fallback",
        githubEvent: "snapshot",
        changes: ["comments"],
      }),
      { snapshot: unknownIncoming },
    );
    const stored = await readStoredWatchState(
      storage as unknown as DurableObjectStorage,
      watchStorageKey(userId, repository, number),
    );
    expect(stored.events).toEqual([]);
    expect(stored.snapshot?.comments[0].reactionDetails).toEqual(reactedComment.reactionDetails);
  });

  it("writes only the poll time when a polled refresh finds no snapshot change", async () => {
    const { hub, pending, storage } = hubFixture();
    // A recent threads read: storing a newer one would buy the next refresh nothing.
    const unchanged = snapshot({ headSha: "reopened", threadsReadAt: new Date().toISOString() });
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
      expect(storage.putKeys).toEqual([watchPolledKey(storageKey)]);
      expect(storage.deleteKeys).toEqual([]);
    } finally {
      vi.unstubAllGlobals();
    }

    await expect(storage.get(watchSidecarIndexKey(storageKey))).resolves.toBeUndefined();
    const stored = await readStoredWatchState(storage as unknown as DurableObjectStorage, storageKey);
    expect(stored.events.map((storedEvent) => storedEvent.id)).toEqual(["event-1"]);
  });

  it("spends no rate limit re-polling an unchanged pull request", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime("2026-09-10T12:01:00.000Z");
    const { hub, pending, storage } = hubFixture();
    const unchanged = snapshot({ headSha: "reopened" });
    await storeMonitor(storage, { snapshot: unchanged, events: [event("event-1", unchanged)] });
    const storageKey = watchStorageKey(userId, repository, number);
    const { github, fetchMock } = conditionalFetch(openPullRequestFetch());
    vi.stubGlobal("fetch", fetchMock);
    const poll = pollOnce(hub, pending, storage, github);
    try {
      await poll();
      // Nothing to send yet: the first read pays for every response, and keeps their ETags.
      expect(github).toMatchObject({ fetched: 8, notModified: 0, graphql: 1 });
      const primed = await readStoredWatchState(storage as unknown as DurableObjectStorage, storageKey);
      expect(Object.keys(primed.snapshot?.githubValidators ?? {})).toHaveLength(8);
      expect(primed.snapshot?.fetchedAt).toBe(unchanged.fetchedAt);

      vi.setSystemTime("2026-09-10T12:01:20.000Z");
      await poll();
      expect(github).toMatchObject({ fetched: 0, notModified: 8, graphql: 0 });
      expect(snapshotWrites(storage.putKeys)).toEqual([]);
      const stored = await readStoredWatchState(storage as unknown as DurableObjectStorage, storageKey);
      expect(stored.events.map((storedEvent) => storedEvent.id)).toEqual(["event-1"]);
    } finally {
      vi.unstubAllGlobals();
      vi.useRealTimers();
    }
  });

  it("stores a new ETag for unchanged content silently once, then revalidates it", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime("2026-09-10T12:01:00.000Z");
    const { hub, pending, storage } = hubFixture();
    const unchanged = snapshot({ headSha: "reopened" });
    await storeMonitor(storage, { snapshot: unchanged, events: [event("event-1", unchanged)] });
    const storageKey = watchStorageKey(userId, repository, number);
    const pullUrl = "https://api.github.com/repos/owner/repo/pulls/7";
    const { github, fetchMock } = conditionalFetch(openPullRequestFetch());
    vi.stubGlobal("fetch", fetchMock);
    const poll = pollOnce(hub, pending, storage, github);
    try {
      await poll();
      // GitHub reissues every ETag for the same bodies, as a deploy on its side can.
      github.generation = 2;
      vi.setSystemTime("2026-09-10T12:01:20.000Z");
      await poll();
      expect(github).toMatchObject({ fetched: 8, notModified: 0, graphql: 1 });
      const reissued = await readStoredWatchState(storage as unknown as DurableObjectStorage, storageKey);
      expect(reissued.snapshot?.githubValidators?.[pullUrl]).toBe(`"2:${pullUrl}"`);
      expect(reissued.snapshot?.fetchedAt).toBe(unchanged.fetchedAt);
      expect(reissued.events.map((storedEvent) => storedEvent.id)).toEqual(["event-1"]);

      vi.setSystemTime("2026-09-10T12:01:40.000Z");
      await poll();
      expect(github).toMatchObject({ fetched: 0, notModified: 8, graphql: 0 });
      expect(snapshotWrites(storage.putKeys)).toEqual([]);
    } finally {
      vi.unstubAllGlobals();
      vi.useRealTimers();
    }
  });

  it("advances polledAt on every poll while fetchedAt keeps the last change, and get_pr shows both", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime("2026-09-10T12:01:00.000Z");
    const { hub, pending, storage } = hubFixture();
    const unchanged = snapshot({ headSha: "reopened" });
    await storeMonitor(storage, { snapshot: unchanged, events: [event("event-1", unchanged)] });
    const polledKey = watchPolledKey(watchStorageKey(userId, repository, number));
    const { github, fetchMock } = conditionalFetch(openPullRequestFetch());
    vi.stubGlobal("fetch", fetchMock);
    const poll = pollOnce(hub, pending, storage, github);
    try {
      await poll();
      await expect(storage.get(polledKey)).resolves.toBe("2026-09-10T12:01:00.000Z");
      vi.setSystemTime("2026-09-10T12:01:20.000Z");
      await poll();
      await expect(storage.get(polledKey)).resolves.toBe("2026-09-10T12:01:20.000Z");

      const response = await hub.fetch(new Request("https://watch-pr.test/mcp", {
        method: "POST",
        headers: {
          authorization: `Bearer ${sessionToken}`,
          accept: "application/json, text/event-stream",
          "content-type": "application/json",
          "mcp-session-id": "polled-at-session",
          "mcp-protocol-version": "2025-06-18",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name: "get_pr", arguments: { repository, number } },
        }),
      }));
      await Promise.all(pending.splice(0));
      const body = await response.json() as { result: { content: [{ text: string }] } };
      const result = JSON.parse(body.result.content[0].text) as Record<string, unknown>;
      expect(result).toMatchObject({ fetchedAt: unchanged.fetchedAt, polledAt: "2026-09-10T12:01:20.000Z" });
      expect(result).not.toHaveProperty("githubValidators");
    } finally {
      vi.unstubAllGlobals();
      vi.useRealTimers();
    }
  });

  it("stores a refresh that only learned unknown reactions, then stops re-reading them", async () => {
    const { hub, pending, storage } = hubFixture();
    // Persisted before individual reactions: the count says one heart, nothing says whose.
    const unknownReactions = snapshot({
      headSha: "reopened",
      bodyReactions: { heart: 1, total_count: 1 },
      bodyReactionDetails: undefined,
    });
    await storeMonitor(storage, { snapshot: unknownReactions, events: [event("event-1", unknownReactions)] });
    const storageKey = watchStorageKey(userId, repository, number);
    const base = openPullRequestFetch();
    let reactionReads = 0;
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/issues/7")) return Response.json({ reactions: { heart: 1, total_count: 1 } });
      if (url.endsWith("/issues/7/reactions?per_page=100")) {
        reactionReads += 1;
        return Response.json([{ id: 901, content: "heart", user: { login: "alice", id: 11 }, created_at: "2026-09-10T12:00:00.000Z" }]);
      }
      return base(input);
    });
    const poll = async () => {
      storage.putKeys.length = 0;
      storage.deleteKeys.length = 0;
      const response = await hub.fetch(new Request("https://watch-pr.test/internal/poll", { method: "POST" }));
      expect(response.status).toBe(202);
      await Promise.all(pending.splice(0));
    };

    vi.stubGlobal("fetch", fetchMock);
    try {
      await poll();
      // The learned baseline is worth storing even though it announces nothing.
      expect(reactionReads).toBe(1);
      expect(storage.putKeys.length).toBeGreaterThan(0);
      const enriched = await readStoredWatchState(storage as unknown as DurableObjectStorage, storageKey);
      expect(enriched.snapshot?.bodyReactionDetails).toEqual([
        { id: 901, content: "heart", author: "alice", authorId: 11, createdAt: "2026-09-10T12:00:00.000Z" },
      ]);
      // Silent: no event was appended, so no monitor frame and no resource notification.
      expect(enriched.events.map((storedEvent) => storedEvent.id)).toEqual(["event-1"]);

      await poll();
      // The stored details now answer the unchanged summary, so the target costs nothing.
      expect(reactionReads).toBe(1);
      expect(snapshotWrites(storage.putKeys)).toEqual([]);
      expect(storage.deleteKeys).toEqual([]);
      const settled = await readStoredWatchState(storage as unknown as DurableObjectStorage, storageKey);
      expect(settled.events.map((storedEvent) => storedEvent.id)).toEqual(["event-1"]);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("stores the removal of a reaction cursor a refresh disproved, so the next poll starts at page one", async () => {
    const { hub, pending, storage } = hubFixture();
    const secondPage = "https://api.github.com/repos/owner/repo/issues/7/reactions?per_page=100&page=2";
    // A previous refresh stopped one page in; the cursor and its prefix are committed.
    const resumable = snapshot({
      headSha: "reopened",
      bodyReactions: { heart: 2, total_count: 2 },
      bodyReactionDetails: undefined,
      bodyReactionDetailsReadAt: "2026-09-10T11:00:00.000Z",
      bodyReactionProgress: {
        records: [{ id: 901, content: "heart", author: "alice", authorId: 11, createdAt: "2026-09-10T11:00:00.000Z" }],
        nextUrl: secondPage,
      },
    });
    await storeMonitor(storage, { snapshot: resumable, events: [event("event-1", resumable)] });
    const storageKey = watchStorageKey(userId, repository, number);
    const base = openPullRequestFetch();
    const reactionRequests: string[] = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/issues/7")) return Response.json({ reactions: { heart: 2, total_count: 2 } });
      if (url.includes("/issues/7/reactions")) {
        reactionRequests.push(url);
        // The suffix answers with a reaction the counts cannot contain: a heart was swapped
        // for a rocket while the read was suspended, so the stored prefix is unusable.
        if (url.includes("page=2")) {
          return Response.json([{ id: 902, content: "rocket", user: { login: "bob", id: 12 }, created_at: "2026-09-10T12:00:00.000Z" }]);
        }
        return Response.json([
          { id: 901, content: "heart", user: { login: "alice", id: 11 }, created_at: "2026-09-10T11:00:00.000Z" },
          { id: 903, content: "heart", user: { login: "carol", id: 13 }, created_at: "2026-09-10T12:00:00.000Z" },
        ]);
      }
      return base(input);
    });
    const poll = async () => {
      storage.putKeys.length = 0;
      storage.deleteKeys.length = 0;
      reactionRequests.length = 0;
      const response = await hub.fetch(new Request("https://watch-pr.test/internal/poll", { method: "POST" }));
      expect(response.status).toBe(202);
      await Promise.all(pending.splice(0));
    };

    vi.stubGlobal("fetch", fetchMock);
    try {
      await poll();
      expect(reactionRequests).toEqual([secondPage]);
      // Nothing to announce - the counts never moved - but the write still has to happen, or
      // the durable cursor is inherited and disproved again on every later poll.
      expect(storage.putKeys.length).toBeGreaterThan(0);
      const cleared = await readStoredWatchState(storage as unknown as DurableObjectStorage, storageKey);
      expect(cleared.snapshot?.bodyReactionProgress).toBeUndefined();
      expect(cleared.snapshot?.bodyReactionDetails).toBeUndefined();
      expect(cleared.snapshot?.bodyReactionDetailsState).toBeUndefined();
      expect(cleared.snapshot?.bodyReactions).toEqual({ heart: 2, total_count: 2 });
      expect(cleared.events.map((storedEvent) => storedEvent.id)).toEqual(["event-1"]);

      await poll();
      // Page one, not the cursor: the target is read again from the start and completed.
      expect(reactionRequests).toEqual(["https://api.github.com/repos/owner/repo/issues/7/reactions?per_page=100"]);
      const settled = await readStoredWatchState(storage as unknown as DurableObjectStorage, storageKey);
      expect(settled.snapshot?.bodyReactionDetails).toEqual([
        { id: 901, content: "heart", author: "alice", authorId: 11, createdAt: "2026-09-10T11:00:00.000Z" },
        { id: 903, content: "heart", author: "carol", authorId: 13, createdAt: "2026-09-10T12:00:00.000Z" },
      ]);
      expect(settled.events.map((storedEvent) => storedEvent.id)).toEqual(["event-1"]);

      await poll();
      // Known details against unchanged counts: the target costs nothing from here on.
      expect(reactionRequests).toEqual([]);
      expect(snapshotWrites(storage.putKeys)).toEqual([]);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("drops a learned-reaction refresh that lost the race to a newer stored snapshot", async () => {
    const { hub, pending, storage } = hubFixture();
    // Stored while this refresh was in flight: newer than anything the refresh can carry.
    const newer = snapshot({
      headSha: "reopened",
      fetchedAt: "2099-01-01T00:00:00.000Z",
      bodyReactions: { heart: 1, total_count: 1 },
      bodyReactionDetails: undefined,
    });
    await storeMonitor(storage, { snapshot: newer, events: [event("event-1", newer)] });
    const storageKey = watchStorageKey(userId, repository, number);
    const base = openPullRequestFetch();
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/issues/7")) return Response.json({ reactions: { heart: 1, total_count: 1 } });
      if (url.endsWith("/issues/7/reactions?per_page=100")) {
        return Response.json([{ id: 901, content: "heart", user: { login: "alice", id: 11 }, created_at: "2026-09-10T12:00:00.000Z" }]);
      }
      return base(input);
    });
    vi.stubGlobal("fetch", fetchMock);
    try {
      storage.putKeys.length = 0;
      storage.deleteKeys.length = 0;
      const response = await hub.fetch(new Request("https://watch-pr.test/internal/poll", { method: "POST" }));
      expect(response.status).toBe(202);
      await Promise.all(pending.splice(0));
      expect(snapshotWrites(storage.putKeys)).toEqual([]);
      expect(storage.deleteKeys).toEqual([]);
    } finally {
      vi.unstubAllGlobals();
    }

    const stored = await readStoredWatchState(storage as unknown as DurableObjectStorage, storageKey);
    expect(stored.snapshot?.fetchedAt).toBe("2099-01-01T00:00:00.000Z");
  });

  // Two refreshes overlap: one learns the PR body while the other's comment read fails, and
  // the comment the second one learned is already stored by the time the first one writes.
  function partialEnrichmentFixture(storage: MemoryStorage, storageKey: string) {
    const comment = (
      reactionDetails?: { id: number; content: string; author: string; authorId: number; createdAt: string }[],
    ) => {
      const base = {
        id: 11,
        author: "bob",
        body: "comment body",
        createdAt: "2026-09-09T00:00:00.000Z",
        updatedAt: "2026-09-09T00:00:00.000Z",
        reactions: { "+1": 1, total_count: 1 },
        path: undefined,
        line: null,
        startLine: null,
        diffHunk: undefined,
        inReplyToId: null,
        htmlUrl: "https://github.com/owner/repo/pull/7#issuecomment-11",
      };
      return reactionDetails ? { ...base, reactionDetails } : base;
    };
    const commentReaction = {
      id: 501,
      content: "+1",
      author: "carol",
      authorId: 12,
      createdAt: "2026-09-09T01:00:00.000Z",
    };
    const bodyReaction = {
      id: 901,
      content: "heart",
      author: "alice",
      authorId: 11,
      createdAt: "2026-09-09T02:00:00.000Z",
    };
    const reads = { body: 0, comment: 0 };
    let concurrentWrite: (() => Promise<void>) | null = null;
    const base = openPullRequestFetch();
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/issues/7")) return Response.json({ reactions: { heart: 1, total_count: 1 } });
      if (url.endsWith("/issues/7/comments?per_page=100")) {
        return Response.json([{
          id: 11,
          user: { login: "bob" },
          body: "comment body",
          created_at: "2026-09-09T00:00:00.000Z",
          updated_at: "2026-09-09T00:00:00.000Z",
          html_url: "https://github.com/owner/repo/pull/7#issuecomment-11",
          reactions: { "+1": 1, total_count: 1 },
        }]);
      }
      if (url.endsWith("/issues/7/reactions?per_page=100")) {
        reads.body += 1;
        return Response.json([{
          id: 901,
          content: "heart",
          user: { login: "alice", id: 11 },
          created_at: "2026-09-09T02:00:00.000Z",
        }]);
      }
      if (url.endsWith("/issues/comments/11/reactions?per_page=100")) {
        reads.comment += 1;
        // The overlapping refresh stores the comment details this one is about to fail on.
        const pendingWrite = concurrentWrite;
        concurrentWrite = null;
        await pendingWrite?.();
        return new Response("boom", { status: 500 });
      }
      return base(input);
    });
    const storeConcurrentComment = (stored: PullRequestSnapshot) => {
      concurrentWrite = async () => {
        const mutation = await openWatchStateMutation(storage as unknown as DurableObjectStorage, storageKey);
        await mutation.replaceSnapshot({ ...stored, comments: [comment([commentReaction])] } as PullRequestSnapshot);
      };
    };
    return { comment, commentReaction, bodyReaction, reads, fetchMock, storeConcurrentComment };
  }

  it("merges a concurrently stored reaction read into a silent enrichment", async () => {
    const { hub, pending, storage } = hubFixture();
    const storageKey = watchStorageKey(userId, repository, number);
    const fixture = partialEnrichmentFixture(storage, storageKey);
    const unknown = snapshot({
      headSha: "reopened",
      bodyReactions: { heart: 1, total_count: 1 },
      bodyReactionDetails: undefined,
      comments: [fixture.comment() as PullRequestSnapshot["comments"][number]],
    });
    await storeMonitor(storage, { snapshot: unknown, events: [event("event-1", unknown)] });
    fixture.storeConcurrentComment(unknown);

    vi.stubGlobal("fetch", fixture.fetchMock);
    try {
      const first = await hub.fetch(new Request("https://watch-pr.test/internal/poll", { method: "POST" }));
      expect(first.status).toBe(202);
      await Promise.all(pending.splice(0));
      expect(fixture.reads).toEqual({ body: 1, comment: 1 });

      // The failed comment read must not erase what the overlapping refresh proved.
      const merged = await readStoredWatchState(storage as unknown as DurableObjectStorage, storageKey);
      expect(merged.snapshot?.bodyReactionDetails).toEqual([fixture.bodyReaction]);
      expect(merged.snapshot?.comments[0]?.reactionDetails).toEqual([fixture.commentReaction]);
      expect(merged.events.map((storedEvent) => storedEvent.id)).toEqual(["event-1"]);

      storage.putKeys.length = 0;
      storage.deleteKeys.length = 0;
      const second = await hub.fetch(new Request("https://watch-pr.test/internal/poll", { method: "POST" }));
      expect(second.status).toBe(202);
      await Promise.all(pending.splice(0));
      // Both targets are known with unchanged counts, so neither costs a request.
      expect(fixture.reads).toEqual({ body: 1, comment: 1 });
      expect(snapshotWrites(storage.putKeys)).toEqual([]);
      expect(storage.deleteKeys).toEqual([]);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("reports GitHub usage and failed refreshes on the next poll tick", async () => {
    const { hub, pending, storage } = hubFixture();
    const current = snapshot({ headSha: "reopened" });
    await storeMonitor(storage, { snapshot: current, events: [event("event-1", current)] });
    const upstream = openPullRequestFetch();
    let pullStatus = 200;
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/pulls/7") && pullStatus !== 200) {
        return new Response("bad gateway", { status: pullStatus, headers: { "x-ratelimit-resource": "core", "x-ratelimit-remaining": "3999" } });
      }
      const response = await upstream(input);
      const headers = new Headers(response.headers);
      if (url.endsWith("/graphql")) {
        // GraphQL draws on its own budget; its remaining count must not lower the core minimum.
        headers.set("x-ratelimit-resource", "graphql");
        headers.set("x-ratelimit-remaining", "10");
      } else {
        headers.set("x-ratelimit-resource", "core");
        headers.set("x-ratelimit-remaining", url.endsWith("/pulls/7") ? "4000" : "4990");
      }
      return new Response(response.body, { status: response.status, headers });
    });
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.stubGlobal("fetch", fetchMock);
    const poll = async () => {
      expect((await hub.fetch(new Request("https://watch-pr.test/internal/poll", { method: "POST" }))).status).toBe(202);
      await Promise.all(pending.splice(0));
    };
    try {
      await poll();
      const storedAfterSuccess = (await readStoredWatchState(
        storage as unknown as DurableObjectStorage,
        watchStorageKey(userId, repository, number),
      )).snapshot?.fetchedAt;
      pullStatus = 502;
      await poll();
      await poll();

      const records = log.mock.calls.map(([line]) => JSON.parse(String(line)) as Record<string, unknown>);
      const [first, second, third] = records.filter((entry) => entry.event === "watch_pr.poll");
      // A tick reports refreshes that finished since the previous tick, not the ones it starts.
      expect(first).toMatchObject({ refreshes_started: 1, refreshes_completed: 0, refresh_failures: 0, github_rest_requests: 0 });
      expect(first).not.toHaveProperty("github_core_remaining_min");
      expect(second).toMatchObject({
        refreshes_completed: 1,
        refresh_failures: 0,
        github_rest_requests: 8,
        github_not_modified: 0,
        github_graphql_requests: 1,
        github_core_remaining_min: 4000,
      });
      // The failed pull read still spent its request, and the issue read in the same wave ran too.
      expect(third).toMatchObject({
        refreshes_completed: 0,
        refresh_failures: 1,
        github_rest_requests: 2,
        github_core_remaining_min: 3999,
      });
      // The second and third ticks each started a refresh that failed on the pull read.
      const failure = {
        event: "watch_pr.snapshot_failure",
        schema_version: 1,
        sample_rate: 1,
        sample_reason: "all",
        source: "poll",
        error_kind: "github_api",
        error_name: "GithubApiError",
        github_status: 502,
      };
      expect(records.filter((entry) => entry.event === "watch_pr.snapshot_failure")).toEqual([failure, failure]);
      // Failed refreshes leave the snapshot the successful one stored.
      const stored = await readStoredWatchState(storage as unknown as DurableObjectStorage, watchStorageKey(userId, repository, number));
      expect(stored.snapshot?.fetchedAt).toBe(storedAfterSuccess);
    } finally {
      vi.unstubAllGlobals();
      log.mockRestore();
    }
  });

  it("merges a concurrently stored reaction read into an ordinary published event", async () => {
    const { hub, pending, storage } = hubFixture();
    const storageKey = watchStorageKey(userId, repository, number);
    const fixture = partialEnrichmentFixture(storage, storageKey);
    // headSha still "abc", so the refresh this webhook drives carries a real change.
    const unknown = snapshot({
      bodyReactions: { heart: 1, total_count: 1 },
      bodyReactionDetails: undefined,
      comments: [fixture.comment() as PullRequestSnapshot["comments"][number]],
    });
    await storeMonitor(storage, { snapshot: unknown, events: [event("event-1", unknown)] });
    fixture.storeConcurrentComment(unknown);
    const internals = hub as unknown as HubInternals;

    vi.stubGlobal("fetch", fixture.fetchMock);
    try {
      await internals.processWebhook("pull_request", "delivery-merge", {
        action: "synchronize",
        repository: { full_name: repository },
        pull_request: { number },
      });
      await Promise.all(pending.splice(0));

      const published = await readStoredWatchState(storage as unknown as DurableObjectStorage, storageKey);
      expect(published.events.map((storedEvent) => storedEvent.id)).toHaveLength(2);
      expect(published.snapshot?.headSha).toBe("reopened");
      expect(published.snapshot?.bodyReactionDetails).toEqual([fixture.bodyReaction]);
      expect(published.snapshot?.comments[0]?.reactionDetails).toEqual([fixture.commentReaction]);

      storage.putKeys.length = 0;
      const poll = await hub.fetch(new Request("https://watch-pr.test/internal/poll", { method: "POST" }));
      expect(poll.status).toBe(202);
      await Promise.all(pending.splice(0));
      expect(fixture.reads).toEqual({ body: 1, comment: 1 });
      expect(snapshotWrites(storage.putKeys)).toEqual([]);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("adds learned reactions to the stored snapshot without reverting a concurrent change", async () => {
    const { hub, pending, storage } = hubFixture();
    const storageKey = watchStorageKey(userId, repository, number);
    const unknown = snapshot({
      headSha: "reopened",
      bodyReactions: { heart: 1, total_count: 1 },
      bodyReactionDetails: undefined,
    });
    await storeMonitor(storage, { snapshot: unknown, events: [event("event-1", unknown)] });
    // What another writer stored after this refresh compared snapshots and before it opened
    // its own transaction: a title, a head revision and a check this refresh never saw.
    const concurrent = snapshot({
      title: "renamed while a refresh was in flight",
      headSha: "pushed",
      checks: [{
        id: 1,
        name: "CI",
        status: "completed",
        conclusion: "failure",
        completedAt: "2026-09-10T12:20:00.000Z",
        startedAt: "2026-09-10T12:10:00.000Z",
        url: null,
        kind: "check_run",
      }],
      fetchedAt: "2026-09-10T12:30:00.000Z",
      bodyReactions: { heart: 1, total_count: 1 },
      bodyReactionDetails: undefined,
    });
    let stateReads = 0;
    let writing = false;
    storage.afterGet = async (key) => {
      if (writing || key !== storageKey) return;
      stateReads += 1;
      // Read one happens before the refresh fetches (the cron itself reads no watch record);
      // two is the comparison it makes against stored state, so writing here lands in the
      // window before its own transaction opens.
      if (stateReads !== 2) return;
      writing = true;
      const mutation = await openWatchStateMutation(storage as unknown as DurableObjectStorage, storageKey);
      await mutation.replaceSnapshot(concurrent);
      writing = false;
    };

    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/issues/7")) return Response.json({ reactions: { heart: 1, total_count: 1 } });
      if (url.endsWith("/issues/7/reactions?per_page=100")) {
        return Response.json([{
          id: 901,
          content: "heart",
          user: { login: "alice", id: 11 },
          created_at: "2026-09-10T12:00:00.000Z",
        }]);
      }
      return openPullRequestFetch()(input);
    });
    vi.stubGlobal("fetch", fetchMock);
    try {
      const poll = await hub.fetch(new Request("https://watch-pr.test/internal/poll", { method: "POST" }));
      expect(poll.status).toBe(202);
      await Promise.all(pending.splice(0));
    } finally {
      vi.unstubAllGlobals();
      storage.afterGet = undefined;
    }

    const stored = await readStoredWatchState(storage as unknown as DurableObjectStorage, storageKey);
    // The silent write adds the reactions it read and nothing else.
    expect(stored.snapshot?.bodyReactionDetails).toEqual([
      { id: 901, content: "heart", author: "alice", authorId: 11, createdAt: "2026-09-10T12:00:00.000Z" },
    ]);
    expect(stored.snapshot?.title).toBe("renamed while a refresh was in flight");
    expect(stored.snapshot?.headSha).toBe("pushed");
    expect(stored.snapshot?.checks).toEqual(concurrent.checks);
    expect(stored.snapshot?.fetchedAt).toBe("2026-09-10T12:30:00.000Z");
    expect(stored.events.map((storedEvent) => storedEvent.id)).toEqual(["event-1"]);
  });
});

describe("webhook reducers", () => {
  const reviewComment = {
    id: 21,
    author: "carol",
    body: "please rename",
    createdAt: "2026-09-10T11:00:00.000Z",
    updatedAt: "2026-09-10T11:00:00.000Z",
    reactions: {},
    reactionDetails: [],
    path: "src/a.ts",
    line: 1,
    startLine: null,
    inReplyToId: null,
  };
  const stored = snapshot({
    updatedAt: "2026-09-10T12:00:00.000Z",
    reviewComments: [reviewComment],
    threads: [{ id: "PRRT_1", isResolved: false, commentIds: [21] }],
  });

  const githubRefused = () => vi.fn(async (input: RequestInfo | URL) => {
    throw new Error(`unexpected GitHub request ${String(input)}`);
  });

  async function deliver(
    eventName: string,
    payload: Record<string, unknown>,
    fetchMock: Mock<typeof fetch> = githubRefused(),
  ) {
    const fixture = hubFixture();
    await storeMonitor(fixture.storage, { snapshot: stored, events: [event("event-seeded", stored)] });
    // A repository that already proved its deliveries arrive: a delivery adds no coverage write.
    await fixture.storage.put(WEBHOOK_COVERAGE_KEY, {
      accounts: {},
      repositories: { [repository]: { coverage: "webhook", evidence: "delivery", at: "2026-09-10T11:00:00.000Z" } },
    } satisfies CoverageIndex);
    fixture.storage.putKeys.length = 0;
    vi.stubGlobal("fetch", fetchMock);
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      const internals = fixture.hub as unknown as { processWebhook: (...args: unknown[]) => Promise<{ reducerOutcomes: Record<string, number>; publishedWatches: number }> };
      const stats = await internals.processWebhook(eventName, "delivery-reduced", { repository: { full_name: repository }, ...payload });
      const state = await readStoredWatchState(
        fixture.storage as unknown as DurableObjectStorage,
        watchStorageKey(userId, repository, number),
      );
      return { ...fixture, stats, state, fetchMock };
    } finally {
      log.mockRestore();
      vi.unstubAllGlobals();
    }
  }

  const cases: {
    name: string;
    eventName: string;
    payload: Record<string, unknown>;
    expected: Partial<PullRequestSnapshot>;
    changes: string[];
    details: string[];
  }[] = [
    {
      name: "pull_request",
      eventName: "pull_request",
      payload: {
        action: "edited",
        pull_request: {
          number,
          html_url: "https://github.com/owner/repo/pull/7",
          title: "Renamed",
          body: "body",
          state: "open",
          draft: false,
          merged: false,
          merged_at: null,
          mergeable: null,
          mergeable_state: "unknown",
          updated_at: "2026-09-10T12:30:00.000Z",
          user: { login: "author" },
          head: { ref: "feature", sha: "abc", repo: { full_name: repository } },
          base: { ref: "main" },
        },
      },
      expected: { title: "Renamed", mergeable: true, mergeableState: "clean", updatedAt: "2026-09-10T12:30:00.000Z" },
      changes: ["description"],
      details: [],
    },
    {
      name: "pull_request_review",
      eventName: "pull_request_review",
      payload: {
        action: "submitted",
        pull_request: { number },
        review: { id: 31, user: { login: "carol" }, state: "approved", body: "LGTM", submitted_at: "2026-09-10T12:30:00.000Z" },
      },
      expected: { reviews: [{ id: 31, author: "carol", state: "APPROVED", body: "LGTM", submittedAt: "2026-09-10T12:30:00.000Z", htmlUrl: undefined }] },
      changes: ["reviews"],
      details: ["review #31 @carol APPROVED: LGTM"],
    },
    {
      name: "pull_request_review_comment",
      eventName: "pull_request_review_comment",
      payload: {
        action: "created",
        pull_request: { number },
        comment: {
          id: 22,
          user: { login: "dave" },
          body: "nit",
          path: "src/a.ts",
          line: 3,
          created_at: "2026-09-10T12:30:00.000Z",
          updated_at: "2026-09-10T12:30:00.000Z",
          reactions: { total_count: 0 },
        },
      },
      expected: { reviewComments: [reviewComment, expect.objectContaining({ id: 22, body: "nit", reactionDetails: [] })] },
      changes: ["review_comments"],
      details: ["active comments: +1, now 2", "feedback [-] #22 src/a.ts:3 @dave: nit"],
    },
    {
      name: "pull_request_review_thread",
      eventName: "pull_request_review_thread",
      payload: { action: "resolved", pull_request: { number }, thread: { node_id: "PRRT_1", comments: [{ id: 21 }] } },
      expected: { threads: [{ id: "PRRT_1", isResolved: true, commentIds: [21] }] },
      changes: ["review_threads"],
      details: ["active comments: -1, now 0", "thread PRRT_1: resolved"],
    },
    {
      name: "issue_comment",
      eventName: "issue_comment",
      payload: {
        action: "created",
        issue: { number, pull_request: {} },
        comment: {
          id: 12,
          user: { login: "erin" },
          body: "hello",
          created_at: "2026-09-10T12:30:00.000Z",
          updated_at: "2026-09-10T12:30:00.000Z",
          reactions: { total_count: 0 },
        },
      },
      expected: { comments: [expect.objectContaining({ id: 12, author: "erin", body: "hello" })] },
      changes: ["comments"],
      details: ["comment #12 @erin: hello"],
    },
    {
      name: "check_run",
      eventName: "check_run",
      payload: {
        action: "completed",
        check_run: {
          id: 41,
          name: "test",
          head_sha: "abc",
          status: "completed",
          conclusion: "failure",
          started_at: "2026-09-10T12:20:00.000Z",
          completed_at: "2026-09-10T12:30:00.000Z",
          html_url: "https://github.com/owner/repo/runs/41",
          pull_requests: [{ number }],
        },
      },
      expected: { checks: [expect.objectContaining({ id: 41, kind: "check_run", conclusion: "failure" })] },
      changes: ["checks"],
      details: ["checks: test -> fail https://github.com/owner/repo/runs/41"],
    },
    {
      name: "check_suite",
      eventName: "check_suite",
      payload: {
        action: "completed",
        check_suite: {
          id: 61,
          head_sha: "abc",
          status: "completed",
          conclusion: "action_required",
          latest_check_runs_count: 0,
          app: { name: "GitHub Actions" },
          created_at: "2026-09-10T12:30:00.000Z",
          updated_at: "2026-09-10T12:30:00.000Z",
          pull_requests: [{ number }],
        },
      },
      expected: { checks: [expect.objectContaining({ id: 61, kind: "check_suite", conclusion: "action_required" })] },
      changes: ["checks"],
      details: ["checks: GitHub Actions -> action_required https://github.com/owner/repo/pull/7/checks"],
    },
    {
      name: "status",
      eventName: "status",
      payload: {
        id: 51,
        sha: "abc",
        context: "ci/lint",
        state: "failure",
        target_url: "https://ci.example/51",
        created_at: "2026-09-10T12:30:00.000Z",
        updated_at: "2026-09-10T12:30:00.000Z",
      },
      expected: { checks: [expect.objectContaining({ id: 51, kind: "commit_status", name: "ci/lint", conclusion: "failure" })] },
      changes: ["checks"],
      details: ["checks: ci/lint -> fail https://ci.example/51"],
    },
  ];

  for (const { name, eventName, payload, expected, changes, details } of cases) {
    it(`applies a ${name} delivery and publishes its event without reading GitHub`, async () => {
      const { hub, state, stats, fetchMock } = await deliver(eventName, payload);

      expect(fetchMock).not.toHaveBeenCalled();
      expect(stats.reducerOutcomes).toMatchObject({ applied: 1, refetch: 0 });
      expect(state.snapshot).toMatchObject(expected);
      expect(state.events.at(-1)).toMatchObject({ deliveryId: "delivery-reduced", githubEvent: eventName, changes });
      const feed = feedReader(await hub.fetch(new Request(
        `https://watch-pr.test/monitor/${capability}?cursor=event-seeded`,
      )));
      await expect(nextMonitorEvent(feed)).resolves.toMatchObject({ githubEvent: eventName, changes, details });
      await feed.reader.cancel();
    });
  }

  it("ignores checks for another head revision without writing or reading GitHub", async () => {
    const { state, stats, storage, fetchMock } = await deliver("check_run", {
      action: "completed",
      check_run: { id: 41, name: "test", head_sha: "previous-head", status: "completed", conclusion: "failure", pull_requests: [{ number }] },
    });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(stats.reducerOutcomes).toMatchObject({ ignored: 1, applied: 0, refetch: 0 });
    expect(storage.putKeys).toEqual(["delivery:delivery-reduced"]);
    expect(state.snapshot).toEqual(stored);
    expect(state.events.map((storedEvent) => storedEvent.id)).toEqual(["event-seeded"]);
  });

  it("stores a change no event announces silently", async () => {
    const { state, stats, fetchMock } = await deliver("pull_request", {
      action: "labeled",
      pull_request: {
        number,
        html_url: "https://github.com/owner/repo/pull/7",
        title: "Monitor feed",
        body: "body",
        state: "open",
        draft: false,
        merged: false,
        merged_at: null,
        mergeable: null,
        updated_at: "2026-09-10T12:40:00.000Z",
        user: { login: "author" },
        head: { ref: "feature", sha: "abc", repo: { full_name: repository } },
        base: { ref: "main" },
      },
    });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(stats).toMatchObject({ reducerOutcomes: { applied: 1 }, publishedWatches: 0 });
    expect(state.snapshot?.updatedAt).toBe("2026-09-10T12:40:00.000Z");
    expect(state.events.map((storedEvent) => storedEvent.id)).toEqual(["event-seeded"]);
  });

  it("reads GitHub for a thread the snapshot does not know", async () => {
    const { state, stats, fetchMock } = await deliver("pull_request_review_thread", {
      action: "resolved",
      pull_request: { number },
      thread: { node_id: "PRRT_unknown", comments: [{ id: 99 }] },
    }, openPullRequestFetch());

    expect(stats.reducerOutcomes).toMatchObject({ refetch: 1, applied: 0 });
    expect(fetchMock.mock.calls.map(([input]) => String(input))).toContain("https://api.github.com/graphql");
    expect(state.snapshot?.headSha).toBe("reopened");
    expect(state.events.at(-1)?.deliveryId).toBe("delivery-reduced");
  });

  it("reports reducer outcomes and zero GitHub requests in the fanout record", async () => {
    const { hub, storage, pending } = hubFixture();
    await storeMonitor(storage, { snapshot: stored, events: [] });
    const body = JSON.stringify({
      action: "synchronize",
      repository: { full_name: repository },
      pull_request: {
        number,
        html_url: "https://github.com/owner/repo/pull/7",
        title: "Monitor feed",
        body: "body",
        state: "open",
        draft: false,
        merged: false,
        merged_at: null,
        mergeable: null,
        updated_at: "2026-09-10T12:30:00.000Z",
        user: { login: "author" },
        head: { ref: "feature", sha: "def", repo: { full_name: repository } },
        base: { ref: "main" },
      },
    });
    const fetchMock = githubRefused();
    vi.stubGlobal("fetch", fetchMock);
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      const response = await hub.fetch(new Request("https://watch-pr.test/webhooks/github", {
        method: "POST",
        headers: {
          "x-github-delivery": "delivery-synchronize",
          "x-github-event": "pull_request",
          "x-hub-signature-256": `sha256=${await hmacSha256Hex("webhook-secret", body)}`,
        },
        body,
      }));
      expect(response.status).toBe(202);
      await Promise.all(pending.splice(0));
      const records = log.mock.calls.map(([value]) => JSON.parse(String(value)) as Record<string, unknown>);
      expect(records.find((record) => record.event === "watch_pr.webhook_fanout")).toMatchObject({
        outcome: "completed",
        published_watches: 1,
        reducer_applied: 0,
        reducer_applied_mergeability_unknown: 1,
        reducer_refetch: 0,
        reducer_ignored: 0,
        github_rest_requests: 0,
        github_graphql_requests: 0,
      });
    } finally {
      log.mockRestore();
      vi.unstubAllGlobals();
    }
    expect(fetchMock).not.toHaveBeenCalled();
    const state = await readStoredWatchState(storage as unknown as DurableObjectStorage, watchStorageKey(userId, repository, number));
    expect(state.snapshot).toMatchObject({ headSha: "def", mergeable: null, mergeableState: "unknown" });
    expect(state.events.at(-1)?.changes).toEqual(["mergeability"]);
  });
});

describe("poll cadence", () => {
  const start = Date.parse("2026-09-10T12:00:00.000Z");
  const MINUTE = 60_000;
  const ownerCovered: CoverageIndex = {
    accounts: { owner: { coverage: "webhook", evidence: "installation_created", at: "2026-09-01T00:00:00.000Z" } },
    repositories: {},
  };

  /** Serves every pull request of every repository, logging each pull read as `owner/repo#n`. */
  function pullsGithub(mergeableState: () => string = () => "clean") {
    const reads: string[] = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("/graphql")) {
        return Response.json({ data: { repository: { pullRequest: { reviewThreads: {
          nodes: [],
          pageInfo: { hasNextPage: false, endCursor: null },
        } } } } });
      }
      const pull = /^\/repos\/([^/]+\/[^/]+)\/pulls\/([0-9]+)$/u.exec(url.pathname);
      if (pull) {
        reads.push(`${pull[1]}#${pull[2]}`);
        const state = mergeableState();
        return Response.json({
          number: Number(pull[2]),
          html_url: `https://github.com/${pull[1]}/pull/${pull[2]}`,
          title: "Monitor feed",
          body: "body",
          state: "open",
          draft: false,
          merged: false,
          merged_at: null,
          mergeable: state === "unknown" ? null : true,
          mergeable_state: state,
          user: { login: "author" },
          head: { ref: "feature", sha: "abc", repo: { full_name: pull[1] } },
          base: { ref: "main" },
        });
      }
      if (/\/issues\/[0-9]+$/u.test(url.pathname)) return Response.json({ reactions: {} });
      if (url.pathname.endsWith("/check-runs")) return Response.json({ check_runs: [] });
      if (url.pathname.endsWith("/check-suites")) return Response.json({ check_suites: [] });
      if (/\/(comments|reviews|statuses)$/u.test(url.pathname)) return Response.json([]);
      throw new Error(`unexpected GitHub URL ${url}`);
    });
    return { reads, fetchMock };
  }

  async function tick(hub: WatchPrHub, pending: Promise<unknown>[]): Promise<Record<string, unknown>> {
    const response = await hub.fetch(new Request("https://watch-pr.test/internal/poll", { method: "POST" }));
    expect(response.status).toBe(202);
    await Promise.all(pending.splice(0));
    return response.json();
  }

  async function signedDelivery(hub: WatchPrHub, eventName: string, deliveryId: string, payload: Record<string, unknown>) {
    const body = JSON.stringify(payload);
    return hub.fetch(new Request("https://watch-pr.test/webhooks/github", {
      method: "POST",
      headers: {
        "x-github-delivery": deliveryId,
        "x-github-event": eventName,
        "x-hub-signature-256": `sha256=${await hmacSha256Hex("webhook-secret", body)}`,
      },
      body,
    }));
  }

  it("reads idle webhook-covered watches once an hour and polling watches on every tick, without reading idle watch records", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(start);
    const { hub, pending, storage } = hubFixture();
    const covered = Array.from({ length: 20 }, (_, index) => `owner/repo#${index + 1}`);
    const polled = ["other/repo#1", "other/repo#2"];
    await storage.put(sessionStorageKey(sessionToken), sessionRecord({
      watches: [...covered, ...polled],
      expiresAt: start + 3 * 60 * MINUTE,
    }));
    await storage.put(WEBHOOK_COVERAGE_KEY, ownerCovered);
    const github = pullsGithub();
    vi.stubGlobal("fetch", github.fetchMock);
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      for (let minute = 0; minute < 60; minute += 1) {
        storage.getKeys.length = 0;
        await tick(hub, pending);
        if (minute > 0) {
          // An idle tick reads the session, the coverage record and the due index; only the
          // polling watches it refreshes read their own records.
          expect(storage.getKeys.filter((key) => !key.startsWith("watch:42:other/repo:")))
            .toEqual([sessionStorageKey(sessionToken), WEBHOOK_COVERAGE_KEY, POLL_SCHEDULE_KEY]);
        }
        vi.setSystemTime(start + (minute + 1) * MINUTE);
      }
      const readsOf = (key: string) => github.reads.filter((read) => read === key).length;
      expect(covered.map(readsOf)).toEqual(covered.map(() => 1));
      expect(polled.map(readsOf)).toEqual([60, 60]);

      // The hour is up: every covered watch reconciles once.
      await tick(hub, pending);
      expect(covered.map(readsOf)).toEqual(covered.map(() => 2));

      const polls = log.mock.calls
        .map(([line]) => JSON.parse(String(line)) as Record<string, unknown>)
        .filter((entry) => entry.event === "watch_pr.poll");
      expect(polls[1]).toMatchObject({ scheduled_watches: 22, due_watches: 2, coverage_webhook: 20, coverage_polling: 2 });
      expect(polls.at(-1)).toMatchObject({ due_watches: 22 });
    } finally {
      log.mockRestore();
      vi.unstubAllGlobals();
      vi.useRealTimers();
    }
  });

  it("reads a pushed pull request again after 1, 3 and 7 minutes while mergeability stays unknown", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(start);
    const { hub, pending, storage } = hubFixture();
    const record = sessionRecord({ expiresAt: start + 3 * 60 * MINUTE });
    const stored = snapshot({ updatedAt: "2026-09-10T11:00:00.000Z" });
    await storeMonitor(storage, { snapshot: stored, events: [] }, record);
    await storage.put(WEBHOOK_COVERAGE_KEY, ownerCovered);
    storage.putKeys.length = 0;
    const github = pullsGithub(() => "unknown");
    vi.stubGlobal("fetch", github.fetchMock);
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      const pushed = await signedDelivery(hub, "pull_request", "delivery-push", {
        action: "synchronize",
        repository: { full_name: repository },
        pull_request: {
          number,
          html_url: "https://github.com/owner/repo/pull/7",
          title: "Monitor feed",
          body: "body",
          state: "open",
          draft: false,
          merged: false,
          merged_at: null,
          mergeable: null,
          updated_at: "2026-09-10T12:00:00.000Z",
          user: { login: "author" },
          head: { ref: "feature", sha: "def", repo: { full_name: repository } },
          base: { ref: "main" },
        },
      });
      expect(pushed.status).toBe(202);
      await Promise.all(pending.splice(0));
      // The payload was applied as it arrived; GitHub has not been read yet.
      expect(github.reads).toEqual([]);

      const readMinutes: number[] = [];
      for (let minute = 1; minute <= 20; minute += 1) {
        vi.setSystemTime(start + minute * MINUTE);
        const before = github.reads.length;
        await tick(hub, pending);
        if (github.reads.length > before) readMinutes.push(minute);
      }
      expect(readMinutes).toEqual([1, 3, 7]);
      // Three reads spent. Follow-ups never wrote the due index: the hourly reconcile stands.
      expect(storage.putKeys).not.toContain(POLL_SCHEDULE_KEY);
      await expect(storage.get(POLL_SCHEDULE_KEY)).resolves.toEqual({
        [pollScheduleId(userId, watch)]: { state: "active", dueAt: start + 60 * MINUTE },
      });
    } finally {
      log.mockRestore();
      vi.unstubAllGlobals();
      vi.useRealTimers();
    }
  });

  it("resumes a closed watch a delivery reopens and stops the follow-up once GitHub has computed mergeability", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(start);
    const { hub, pending, storage } = hubFixture();
    const closed = snapshot({ state: "closed" });
    await storeMonitor(storage, { snapshot: closed, events: [] }, sessionRecord({ expiresAt: start + 3 * 60 * MINUTE }));
    await storage.put(POLL_SCHEDULE_KEY, { [pollScheduleId(userId, watch)]: { state: "stopped" } } satisfies PollSchedule);
    await storage.put(WEBHOOK_COVERAGE_KEY, ownerCovered);
    const answers = ["unknown", "unknown", "clean"];
    const github = pullsGithub(() => answers.shift() ?? "clean");
    vi.stubGlobal("fetch", github.fetchMock);
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      // A minimal payload the reducer cannot apply: the delivery reads GitHub, which has not
      // finished computing mergeability yet.
      await signedDelivery(hub, "pull_request", "delivery-reopened", {
        action: "reopened",
        repository: { full_name: repository },
        pull_request: { number },
      });
      await Promise.all(pending.splice(0));
      expect(github.reads).toHaveLength(1);
      await expect(storage.get(POLL_SCHEDULE_KEY)).resolves.toEqual({
        [pollScheduleId(userId, watch)]: { state: "active", dueAt: start + 60 * MINUTE },
      });

      const readMinutes: number[] = [];
      for (let minute = 1; minute <= 20; minute += 1) {
        vi.setSystemTime(start + minute * MINUTE);
        const before = github.reads.length;
        await tick(hub, pending);
        if (github.reads.length > before) readMinutes.push(minute);
      }
      expect(readMinutes).toEqual([1, 3]);
      const state = await readStoredWatchState(storage as unknown as DurableObjectStorage, watchStorageKey(userId, repository, number));
      expect(state.snapshot?.mergeableState).toBe("clean");
    } finally {
      log.mockRestore();
      vi.unstubAllGlobals();
      vi.useRealTimers();
    }
  });

  it("follows installation webhooks: covered watches wait for their reconcile, uninstalled ones poll", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(start);
    const { hub, pending, storage } = hubFixture();
    const record = sessionRecord({ expiresAt: start + 3 * 60 * MINUTE });
    await storeMonitor(storage, { snapshot: snapshot(), events: [] }, record);
    const github = pullsGithub();
    vi.stubGlobal("fetch", github.fetchMock);
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const internals = hub as unknown as HubInternals;
    const active = internals.newActiveSession(sessionToken, record, "stateful");
    const installation = { id: 9, account: { login: "Owner" }, repository_selection: "selected" };
    const coverage = async () => (await internals.readWatch(active, repository, number)).coverage;
    try {
      // Nothing is known about the repository: it is polled every minute.
      expect(await coverage()).toBe("polling");
      await tick(hub, pending);
      expect(github.reads).toHaveLength(1);

      const installed = await signedDelivery(hub, "installation", "delivery-installed", {
        action: "created",
        installation,
        repositories: [{ full_name: repository }],
      });
      expect(installed.status).toBe(202);
      expect(await coverage()).toBe("webhook");
      vi.setSystemTime(start + MINUTE);
      await tick(hub, pending);
      expect(github.reads).toHaveLength(1);

      const removed = await signedDelivery(hub, "installation_repositories", "delivery-removed", {
        action: "removed",
        installation,
        repository_selection: "selected",
        repositories_added: [],
        repositories_removed: [{ full_name: repository }],
      });
      expect(removed.status).toBe(202);
      expect(await coverage()).toBe("polling");
      vi.setSystemTime(start + 2 * MINUTE);
      await tick(hub, pending);
      expect(github.reads).toHaveLength(2);

      await signedDelivery(hub, "installation_repositories", "delivery-added", {
        action: "added",
        installation,
        repository_selection: "selected",
        repositories_added: [{ full_name: repository }],
        repositories_removed: [],
      });
      expect(await coverage()).toBe("webhook");
      await signedDelivery(hub, "installation", "delivery-deleted", { action: "deleted", installation });
      expect(await coverage()).toBe("polling");
    } finally {
      log.mockRestore();
      vi.unstubAllGlobals();
      vi.useRealTimers();
    }
  });

  it("seeds coverage at watch time from the user's installations, conditionally, and polls when the lookup fails", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(start);
    const installationsRequests: Array<{ path: string; status: number }> = [];
    let installationsStatus = 200;
    const github = pullsGithub();
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      if (!url.pathname.startsWith("/user/installations")) return github.fetchMock(input);
      const path = `${url.pathname}${url.search}`;
      const etag = `"${path}"`;
      const status = installationsStatus !== 200
        ? installationsStatus
        : new Headers(init?.headers).get("if-none-match") === etag ? 304 : 200;
      installationsRequests.push({ path, status });
      if (status === 304) return new Response(null, { status, headers: { etag } });
      if (status !== 200) return Response.json({ message: "unavailable" }, { status });
      if (url.pathname === "/user/installations") {
        return Response.json({ installations: [{ id: 9, account: { login: "Owner" }, repository_selection: "selected", suspended_at: null }] }, { headers: { etag } });
      }
      return Response.json({ repositories: [{ full_name: repository }] }, { headers: { etag } });
    });
    vi.stubGlobal("fetch", fetchMock);
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      const { hub, pending, storage } = hubFixture();
      const record = sessionRecord({ watches: [], expiresAt: start + 3 * 60 * MINUTE });
      await storage.put(sessionStorageKey(sessionToken), record);
      const internals = hub as unknown as HubInternals;
      const active = internals.newActiveSession(sessionToken, record, "stateful");
      const coverage = async () => (await internals.readWatch(active, repository, number)).coverage;

      await internals.watch(active, repository, number);
      await Promise.all(pending.splice(0));
      expect(await coverage()).toBe("webhook");
      expect(installationsRequests.map(({ status }) => status)).toEqual([200, 200]);

      // Watching again consults the installations again, as two 304s that write nothing.
      storage.putKeys.length = 0;
      await internals.watch(active, repository, number);
      await Promise.all(pending.splice(0));
      expect(installationsRequests.slice(2).map(({ status }) => status)).toEqual([304, 304]);
      expect(storage.putKeys.filter((key) => key.startsWith("installation-lookup:") || key === WEBHOOK_COVERAGE_KEY)).toEqual([]);

      // Registration was the read; the covered watch is not polled until its reconcile.
      vi.setSystemTime(start + MINUTE);
      await tick(hub, pending);
      expect(github.reads).toHaveLength(2);

      const failed = hubFixture();
      await failed.storage.put(sessionStorageKey(sessionToken), record);
      const failedInternals = failed.hub as unknown as HubInternals;
      const failedActive = failedInternals.newActiveSession(sessionToken, record, "stateful");
      installationsStatus = 500;
      await failedInternals.watch(failedActive, repository, number);
      await Promise.all(failed.pending.splice(0));
      const failedCoverage = (await failedInternals.readWatch(failedActive, repository, number)).coverage;
      expect(failedCoverage).toBe("polling");
      const lookups = log.mock.calls
        .map(([line]) => JSON.parse(String(line)) as Record<string, unknown>)
        .filter((entry) => entry.event === "watch_pr.coverage_lookup");
      expect(lookups.map((entry) => entry.outcome)).toEqual(["repository", "repository", "failed"]);

      // A deployment that accepts no delivery (PPE) never asks: every watch there polls.
      installationsStatus = 200;
      const requestsBefore = installationsRequests.length;
      const unsigned = hubFixture({ GITHUB_WEBHOOK_SECRET: undefined });
      await unsigned.storage.put(sessionStorageKey(sessionToken), record);
      const unsignedInternals = unsigned.hub as unknown as HubInternals;
      const unsignedActive = unsignedInternals.newActiveSession(sessionToken, record, "stateful");
      await unsignedInternals.watch(unsignedActive, repository, number);
      await Promise.all(unsigned.pending.splice(0));
      expect(installationsRequests).toHaveLength(requestsBefore);
      expect((await unsignedInternals.readWatch(unsignedActive, repository, number)).coverage).toBe("polling");
    } finally {
      log.mockRestore();
      vi.unstubAllGlobals();
      vi.useRealTimers();
    }
  });
});
