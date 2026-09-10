import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { constantTimeEqual, parseBearerToken, randomToken, sha256Base64Url, verifyGithubSignature } from "./crypto";
import { createWatchEvent, eventPullRequestNumbers, isSupportedGithubEvent, parseWatchKey, resourceUri, snapshotChanges, watchKey } from "./events";
import { exchangeGithubCode, GithubApiError, githubUser, pullRequestSnapshot, refreshGithubToken } from "./github";
import { createMcpServer, type McpSessionContext, type WatchRegistration } from "./mcp";
import type {
  GithubUser,
  MonitorCapabilityRecord,
  MonitorTerminalState,
  OAuthClientRecord,
  OAuthCodeRecord,
  OAuthRequestRecord,
  PrMonitorEvent,
  PrMonitorRegistration,
  PullRequestSnapshot,
  SessionRecord,
  StoredWatchState,
  WatchEvent,
} from "./types";
import {
  legacyWatchStorageKey,
  monitorCapabilityStorageKey,
  monitorScopeStorageKey,
  sessionStorageKey,
  watchStorageKey,
} from "./types";

export interface Env {
  HUB: DurableObjectNamespace;
  GITHUB_CLIENT_ID: string;
  GITHUB_CLIENT_SECRET?: string;
  GITHUB_WEBHOOK_SECRET?: string;
  PUBLIC_BASE_URL: string;
  SESSION_TTL_SECONDS?: string;
}

interface ActiveSession {
  token: string;
  record: SessionRecord;
  watches: Set<string>;
  subscriptions: Set<string>;
  kind: "stateful" | "recovered-stream";
  transport?: WebStandardStreamableHTTPServerTransport;
  server?: McpServer;
  sessionId?: string;
}

interface ActiveMonitorFeed {
  capability: string;
  sessionToken: string;
  userId: number;
  key: string;
  controller: ReadableStreamDefaultController<Uint8Array>;
  heartbeat: number;
  closed: boolean;
}
const SESSION_TTL_SECONDS = 30 * 24 * 60 * 60;
const OAUTH_TTL_SECONDS = 10 * 60;
const MAX_EVENTS = 100;
const MAX_CLOSED_MCP_SESSIONS = 64;
const MONITOR_HEARTBEAT_MS = 15_000;
const MAX_MONITOR_CURSOR_LENGTH = 256;

const MAX_STORAGE_BATCH_KEYS = 128;
const MAX_WATCH_STATE_BYTES = 64 * 1024;
const MAX_WATCH_CHUNK_CHARACTERS = 16_000;

interface WatchStateIndex {
  chunkCount: number;
}

export type WatchStorage = Pick<DurableObjectStorage, "get" | "put" | "delete">;

function emptyWatchState(): StoredWatchState {
  return { snapshot: null, events: [] };
}

function isStoredWatchState(value: unknown): value is StoredWatchState {
  return Boolean(
    value &&
    typeof value === "object" &&
    "snapshot" in value &&
    Array.isArray((value as Record<string, unknown>).events),
  );
}

function isWatchStateIndex(value: unknown): value is WatchStateIndex {
  return Boolean(
    value &&
    typeof value === "object" &&
    Number.isInteger((value as Record<string, unknown>).chunkCount) &&
    Number((value as Record<string, unknown>).chunkCount) > 0,
  );
}

function watchChunkKey(storageKey: string, index: number): string {
  return `${storageKey}:chunk:${index}`;
}

function storageBatches<T>(values: readonly T[]): T[][] {
  const batches: T[][] = [];
  for (let index = 0; index < values.length; index += MAX_STORAGE_BATCH_KEYS) {
    batches.push(values.slice(index, index + MAX_STORAGE_BATCH_KEYS));
  }
  return batches;
}

async function getStorageEntries<T>(storage: WatchStorage, keys: readonly string[]): Promise<Map<string, T>> {
  const entries = new Map<string, T>();
  for (const batch of storageBatches(keys)) {
    const values = await storage.get<T>(batch);
    for (const [key, value] of values) entries.set(key, value);
  }
  return entries;
}

async function putStorageEntries(storage: WatchStorage, entries: Record<string, unknown>): Promise<void> {
  const values = Object.entries(entries);
  for (const batch of storageBatches(values)) {
    await storage.put(Object.fromEntries(batch));
  }
}

async function deleteStorageKeys(storage: WatchStorage, keys: readonly string[]): Promise<void> {
  for (const batch of storageBatches(keys)) await storage.delete(batch);
}

export async function readStoredWatchState(storage: WatchStorage, storageKey: string): Promise<StoredWatchState> {
  const stored = await storage.get<unknown>(storageKey);
  if (isStoredWatchState(stored)) return stored;
  if (!isWatchStateIndex(stored)) return emptyWatchState();

  const keys = Array.from({ length: stored.chunkCount }, (_, index) => watchChunkKey(storageKey, index));
  const chunks = await getStorageEntries<string>(storage, keys);
  let encoded = "";
  for (const key of keys) {
    const chunk = chunks.get(key);
    if (typeof chunk !== "string") return emptyWatchState();
    encoded += chunk;
  }
  try {
    const state: unknown = JSON.parse(encoded);
    return isStoredWatchState(state) ? state : emptyWatchState();
  } catch {
    return emptyWatchState();
  }
}

export async function writeStoredWatchState(storage: WatchStorage, storageKey: string, state: StoredWatchState): Promise<void> {
  const encoded = JSON.stringify(state);
  const previous = await storage.get<unknown>(storageKey);
  const previousChunkCount = isWatchStateIndex(previous) ? previous.chunkCount : 0;
  const encodedBytes = new TextEncoder().encode(encoded).byteLength;
  if (encodedBytes <= MAX_WATCH_STATE_BYTES) {
    await storage.put(storageKey, state);
    if (previousChunkCount > 0) {
      await deleteStorageKeys(
        storage,
        Array.from({ length: previousChunkCount }, (_, index) => watchChunkKey(storageKey, index)),
      );
    }
    return;
  }

  const chunkCount = Math.ceil(encoded.length / MAX_WATCH_CHUNK_CHARACTERS);
  const chunks: Record<string, string> = {};
  for (let index = 0; index < chunkCount; index += 1) {
    chunks[watchChunkKey(storageKey, index)] = encoded.slice(
      index * MAX_WATCH_CHUNK_CHARACTERS,
      (index + 1) * MAX_WATCH_CHUNK_CHARACTERS,
    );
  }
  await putStorageEntries(storage, chunks);
  await storage.put(storageKey, { chunkCount } satisfies WatchStateIndex);
  if (previousChunkCount > chunkCount) {
    await deleteStorageKeys(
      storage,
      Array.from({ length: previousChunkCount - chunkCount }, (_, index) => watchChunkKey(storageKey, chunkCount + index)),
    );
  }
}

const monitorEncoder = new TextEncoder();

function terminalState(snapshot: PullRequestSnapshot | null): MonitorTerminalState {
  if (snapshot?.merged) return "merged";
  return snapshot?.state.toLowerCase() === "closed" ? "closed" : "watching";
}

function resumesClosedWatch(event: WatchEvent, snapshot: PullRequestSnapshot | null): boolean {
  if (terminalState(snapshot) !== "watching") return false;
  return (
    (event.githubEvent === "pull_request" && event.action === "reopened") ||
    (event.githubEvent === "snapshot" && event.action === "watch")
  );
}

function compactMonitorEvent(event: WatchEvent, state = terminalState(event.snapshot)): PrMonitorEvent {
  return {
    id: event.id,
    repository: event.repository,
    pullRequestNumber: event.pullRequestNumber,
    githubEvent: event.githubEvent,
    action: event.action,
    receivedAt: event.receivedAt,
    changes: event.changes,
    terminalState: state,
  };
}

function reconciliationMonitorEvent(
  state: StoredWatchState,
  action: "cursor_miss" | "terminal_snapshot",
  repository: string,
  pullRequestNumber: number,
): PrMonitorEvent {
  const latest = state.events.at(-1);
  const snapshot = state.snapshot;
  return {
    id: latest?.id ?? `snapshot-${snapshot?.fetchedAt ?? "unavailable"}`,
    repository,
    pullRequestNumber,
    githubEvent: "reconciliation",
    action,
    receivedAt: snapshot?.fetchedAt ?? latest?.receivedAt ?? new Date().toISOString(),
    changes: action === "cursor_miss" ? ["reconciled"] : [],
    terminalState: terminalState(snapshot),
  };
}

function monitorFrame(event: PrMonitorEvent): Uint8Array {
  const id = event.id.replace(/[\r\n]/gu, "");
  return monitorEncoder.encode(`id: ${id}\nevent: pr\ndata: ${JSON.stringify(event)}\n\n`);
}



export class WatchPrHub {
  private readonly activeSessions = new Map<string, ActiveSession>();
  private readonly activeMonitorFeeds = new Map<string, Set<ActiveMonitorFeed>>();
  private readonly refreshes = new Set<string>();
  private readonly sessionOperations = new Map<string, Promise<void>>();

  constructor(
    private readonly state: DurableObjectState,
    private readonly env: Env,
  ) { }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/mcp") return this.handleMcp(request);
    if (url.pathname.startsWith("/monitor/")) return this.handleMonitorFeed(request);
    if (url.pathname === "/webhooks/github") return this.handleGithubWebhook(request);
    if (url.pathname === "/oauth/register") return this.handleOAuthRegister(request);
    if (url.pathname === "/oauth/authorize") return this.handleOAuthAuthorize(request);
    if (url.pathname === "/oauth/callback") return this.handleOAuthCallback(request);
    if (url.pathname === "/oauth/token") return this.handleOAuthToken(request);
    if (url.pathname === "/internal/poll") return this.handlePoll(request);
    return new Response("Not found", { status: 404 });
  }

  private async handleMonitorFeed(request: Request): Promise<Response> {
    if (request.method !== "GET") return this.monitorError(405, "method_not_allowed", "monitor feeds require GET");
    const url = new URL(request.url);
    const match = /^\/monitor\/([A-Za-z0-9_-]+)$/u.exec(url.pathname);
    if (!match) return this.monitorError(404, "monitor_not_found", "monitor capability is invalid or revoked");
    const capability = match[1];
    const capabilityKey = monitorCapabilityStorageKey(capability);
    const record = await this.state.storage.get<MonitorCapabilityRecord>(capabilityKey);
    if (!record) return this.monitorError(404, "monitor_not_found", "monitor capability is invalid or revoked");

    const session = await this.state.storage.get<SessionRecord>(sessionStorageKey(record.sessionToken));
    const key = watchKey(record.repository, record.pullRequestNumber);
    if (
      record.expiresAt <= Date.now() ||
      !session ||
      session.expiresAt <= Date.now() ||
      session.user.id !== record.userId ||
      !session.watches.includes(key)
    ) {
      await this.revokeMonitorCapability(capability, record);
      return this.monitorError(404, "monitor_not_found", "monitor capability is invalid or revoked");
    }

    const headerCursor = request.headers.get("last-event-id")?.trim();
    const queryCursor = url.searchParams.get("cursor")?.trim();
    const cursor = headerCursor || queryCursor || null;
    if (cursor && cursor.length > MAX_MONITOR_CURSOR_LENGTH) {
      return this.monitorError(400, "invalid_cursor", `monitor cursor must not exceed ${MAX_MONITOR_CURSOR_LENGTH} characters`);
    }

    const watchState = await this.watchState(record.userId, key);
    const currentTerminalState = terminalState(watchState.snapshot);
    let events: PrMonitorEvent[];
    if (!cursor) {
      events = watchState.events.map((event) => compactMonitorEvent(event));
    } else {
      const cursorIndex = watchState.events.findIndex((event) => event.id === cursor);
      events = cursorIndex >= 0
        ? watchState.events.slice(cursorIndex + 1).map((event) => compactMonitorEvent(event))
        : [reconciliationMonitorEvent(watchState, "cursor_miss", record.repository, record.pullRequestNumber)];
    }
    if (currentTerminalState !== "watching" && events.length === 0) {
      const latest = watchState.events.at(-1);
      events = [latest
        ? compactMonitorEvent(latest, currentTerminalState)
        : reconciliationMonitorEvent(watchState, "terminal_snapshot", record.repository, record.pullRequestNumber)];
    }

    let activeFeed: ActiveMonitorFeed | undefined;
    const body = new ReadableStream<Uint8Array>({
      start: (controller) => {
        controller.enqueue(monitorEncoder.encode(": connected\n\n"));
        for (const event of events) controller.enqueue(monitorFrame(event));
        if (currentTerminalState !== "watching") {
          controller.close();
          return;
        }
        const heartbeat = setInterval(() => {
          if (!activeFeed || activeFeed.closed) return;
          try {
            controller.enqueue(monitorEncoder.encode(": heartbeat\n\n"));
          } catch {
            this.closeMonitorFeed(activeFeed);
          }
        }, MONITOR_HEARTBEAT_MS);
        for (const feed of [...(this.activeMonitorFeeds.get(capability) ?? [])]) this.closeMonitorFeed(feed);
        activeFeed = {
          capability,
          userId: record.userId,
          sessionToken: record.sessionToken,
          key,
          controller,
          heartbeat,
          closed: false,
        };
        const feeds = this.activeMonitorFeeds.get(capability) ?? new Set<ActiveMonitorFeed>();
        feeds.add(activeFeed);
        this.activeMonitorFeeds.set(capability, feeds);
      },
      cancel: () => {
        if (activeFeed) this.closeMonitorFeed(activeFeed, false);
      },
    });
    const confirmed = await this.state.storage.get<MonitorCapabilityRecord>(capabilityKey);
    if (
      !confirmed ||
      confirmed.sessionToken !== record.sessionToken ||
      confirmed.userId !== record.userId ||
      confirmed.repository !== record.repository ||
      confirmed.pullRequestNumber !== record.pullRequestNumber ||
      confirmed.expiresAt !== record.expiresAt
    ) {
      if (activeFeed) this.closeMonitorFeed(activeFeed);
      return this.monitorError(404, "monitor_not_found", "monitor capability is invalid or revoked");
    }
    return new Response(body, {
      headers: {
        "cache-control": "no-cache, no-transform",
        "content-type": "text/event-stream; charset=utf-8",
        connection: "keep-alive",
        "x-accel-buffering": "no",
      },
    });
  }

  private closeMonitorFeed(feed: ActiveMonitorFeed, closeController = true): void {
    if (feed.closed) return;
    feed.closed = true;
    clearInterval(feed.heartbeat);
    const feeds = this.activeMonitorFeeds.get(feed.capability);
    feeds?.delete(feed);
    if (feeds?.size === 0) this.activeMonitorFeeds.delete(feed.capability);
    if (!closeController) return;
    try {
      feed.controller.close();
    } catch {
      // The response can be canceled while an event is being delivered.
    }
  }

  private publishMonitorEvent(userId: number, key: string, event: PrMonitorEvent): void {
    for (const feeds of this.activeMonitorFeeds.values()) {
      for (const feed of [...feeds]) {
        if (feed.userId !== userId || feed.key !== key || feed.closed) continue;
        try {
          feed.controller.enqueue(monitorFrame(event));
        } catch {
          this.closeMonitorFeed(feed);
          continue;
        }
        if (event.terminalState !== "watching") this.closeMonitorFeed(feed);
      }
    }
  }

  private monitorError(status: number, error: string, description: string): Response {
    return this.json({ error, error_description: description }, status, {
      "cache-control": "no-store",
    });
  }

  private async handleMcp(request: Request): Promise<Response> {
    const bearer = parseBearerToken(request);
    if (!bearer) return this.unauthorized(request);
    const session = await this.sessionForToken(bearer);
    if (!session) return this.unauthorized(request);

    const sessionId = request.headers.get("mcp-session-id");
    if (sessionId) {
      if (await this.isClosedMcpSession(bearer, sessionId)) return this.mcpSessionNotFound();
      const existing = this.activeSessions.get(sessionId);
      if (existing && existing.token !== bearer) return this.mcpSessionNotFound();
      if (request.method === "DELETE") {
        await this.rememberClosedMcpSession(bearer, sessionId);
        if (existing) await this.closeActiveSession(sessionId, existing);
        return this.withMcpSessionId(new Response(null, { status: 200 }), sessionId);
      }
      if (existing) {
        existing.record = session.record;
        this.syncActiveSession(existing, session.record);
        if (existing.kind === "stateful") {
          return existing.transport ? existing.transport.handleRequest(request) : this.mcpSessionNotFound();
        }
        if (request.method === "GET") {
          await this.closeActiveSession(sessionId, existing);
          return this.openRecoveredMcpStream(request, existing, sessionId);
        }
        return this.handleRecoveredMcpRequest(request, existing, sessionId);
      }
      const recovered = this.newActiveSession(bearer, session.record, "recovered-stream");
      if (request.method === "GET") return this.openRecoveredMcpStream(request, recovered, sessionId);
      return this.handleRecoveredMcpRequest(request, recovered, sessionId);
    }

    let body: unknown;
    try {
      body = await request.clone().json();
    } catch {
      body = null;
    }
    if (!isInitializeMessage(body)) {
      return new Response(JSON.stringify({ error: "MCP initialization is required" }), {
        status: 400,
        headers: { "content-type": "application/json" },
      });
    }

    const active = this.newActiveSession(bearer, session.record, "stateful");
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: () => randomToken(24),
      onsessioninitialized: (id) => {
        active.sessionId = id;
        active.transport = transport;
        active.server = server;
        this.activeSessions.set(id, active);
      },
      onsessionclosed: (id) => {
        this.activeSessions.delete(id);
      },
      keepAliveMs: 15_000,
    });
    const server = createMcpServer(this.mcpContext(active));
    active.transport = transport;
    active.server = server;
    await server.connect(transport);
    return transport.handleRequest(request);
  }

  private newActiveSession(
    token: string,
    record: SessionRecord,
    kind: ActiveSession["kind"],
  ): ActiveSession {
    return {
      token,
      record,
      kind,
      watches: new Set(record.watches),
      subscriptions: new Set(record.subscriptions ?? []),
    };
  }

  private async openRecoveredMcpStream(
    request: Request,
    active: ActiveSession,
    sessionId: string,
  ): Promise<Response> {
    const transport = new WebStandardStreamableHTTPServerTransport({ keepAliveMs: 15_000 });
    const server = createMcpServer(this.mcpContext(active));
    await server.connect(transport);
    const response = await transport.handleRequest(request);
    if (!response.ok) {
      await server.close();
      return this.withMcpSessionId(response, sessionId);
    }
    active.sessionId = sessionId;
    active.transport = transport;
    active.server = server;
    this.activeSessions.set(sessionId, active);
    await this.notifySubscribedResources(active);
    return this.withMcpSessionId(response, sessionId);
  }

  private async handleRecoveredMcpRequest(
    request: Request,
    active: ActiveSession,
    sessionId: string,
  ): Promise<Response> {
    const transport = new WebStandardStreamableHTTPServerTransport({
      enableJsonResponse: true,
      keepAliveMs: 15_000,
    });
    const server = createMcpServer(this.mcpContext(active));
    await server.connect(transport);
    try {
      const response = await transport.handleRequest(request);
      return this.withMcpSessionId(response, sessionId);
    } finally {
      await Promise.allSettled([server.close(), transport.close()]);
    }
  }

  private withMcpSessionId(response: Response, sessionId: string): Response {
    const headers = new Headers(response.headers);
    headers.set("mcp-session-id", sessionId);
    return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
  }

  private mcpSessionNotFound(): Response {
    return new Response(JSON.stringify({ error: "MCP session not found" }), {
      status: 404,
      headers: { "content-type": "application/json" },
    });
  }

  private async isClosedMcpSession(token: string, sessionId: string): Promise<boolean> {
    return this.withSessionLock(token, async () => {
      const closed = await this.state.storage.get<string[]>(`closed-mcp-sessions:${token}`);
      return closed?.includes(sessionId) ?? false;
    });
  }

  private async rememberClosedMcpSession(token: string, sessionId: string): Promise<void> {
    await this.withSessionLock(token, async () => {
      const key = `closed-mcp-sessions:${token}`;
      await this.state.storage.transaction(async (storage) => {
        const closed = await storage.get<string[]>(key) ?? [];
        if (closed.includes(sessionId)) return;
        await storage.put(key, [...closed, sessionId].slice(-MAX_CLOSED_MCP_SESSIONS));
      });
    });
  }

  private mcpContext(active: ActiveSession): McpSessionContext {
    return {
      user: active.record.user,
      watches: active.watches,
      watch: async (repository, number) => this.watch(active, repository, number),
      unwatch: async (repository, number) => this.unwatch(active, repository, number),
      listWatches: async () => this.listWatches(active),
      openMonitor: async (repository, number) => this.openMonitor(active, repository, number),
      readWatch: async (repository, number) => this.readWatch(active, repository, number),
      subscribe: async (repository, number) => this.subscribe(active, repository, number),
      unsubscribe: async (repository, number) => this.unsubscribe(active, repository, number),
    };
  }

  private syncActiveSession(active: ActiveSession, record: SessionRecord): void {
    active.watches.clear();
    for (const key of record.watches) active.watches.add(key);
    active.subscriptions.clear();
    for (const key of record.subscriptions ?? []) {
      if (active.watches.has(key)) active.subscriptions.add(key);
    }
  }

  private async watch(active: ActiveSession, repository: string, number: number): Promise<WatchRegistration> {
    const key = watchKey(repository, number);
    const wasWatched = await this.updateSession(active, (watches, subscriptions) => {
      const existed = watches.has(key);
      watches.add(key);
      subscriptions.add(key);
      return existed;
    });
    const state = await this.watchState(active.record.user.id, key);
    const refreshScheduled = terminalState(state.snapshot) !== "merged";
    if (refreshScheduled) this.scheduleRefresh(active.record.user.id, key, active.record.githubAccessToken, active.token, "watch");
    if (!wasWatched) await this.notifyResourceListChanged(active);
    return {
      key,
      repository: parseWatchKey(key).repository,
      number,
      resourceUri: resourceUri(repository, number),
      snapshot: state.snapshot,
      refreshScheduled,
    };
  }

  private async unwatch(active: ActiveSession, repository: string, number: number): Promise<boolean> {
    const key = watchKey(repository, number);
    const removed = await this.updateSession(active, (watches, subscriptions) => {
      subscriptions.delete(key);
      return watches.delete(key);
    });
    await this.revokeMonitorScope(active.token, key);
    if (removed) await this.notifyResourceListChanged(active);
    return removed;
  }

  private async openMonitor(
    active: ActiveSession,
    repository: string,
    number: number,
  ): Promise<PrMonitorRegistration> {
    const key = watchKey(repository, number);
    if (!active.watches.has(key)) throw new Error("pull request is not watched by this session");
    const parsed = parseWatchKey(key);
    const scopeKey = monitorScopeStorageKey(active.token, parsed.repository, parsed.number);
    let capability = await this.state.storage.get<string>(scopeKey);
    let record = capability
      ? await this.state.storage.get<MonitorCapabilityRecord>(monitorCapabilityStorageKey(capability))
      : undefined;
    if (
      !capability ||
      !record ||
      record.sessionToken !== active.token ||
      record.userId !== active.record.user.id ||
      record.repository !== parsed.repository ||
      record.pullRequestNumber !== parsed.number ||
      record.expiresAt <= Date.now()
    ) {
      if (capability) await this.revokeMonitorCapability(capability, record);
      capability = randomToken(32);
      record = {
        sessionToken: active.token,
        userId: active.record.user.id,
        repository: parsed.repository,
        pullRequestNumber: parsed.number,
        createdAt: Date.now(),
        expiresAt: active.record.expiresAt,
      };
      await putStorageEntries(this.state.storage, {
        [scopeKey]: capability,
        [monitorCapabilityStorageKey(capability)]: record,
      });
    }

    const state = await this.watchState(record.userId, key);
    const cursor = state.events.at(-1)?.id ?? null;
    const monitorUrl = new URL(`${this.baseUrl()}/monitor/${capability}`);
    if (cursor) monitorUrl.searchParams.set("cursor", cursor);
    return {
      monitorUrl: monitorUrl.toString(),
      cursor,
      terminalState: terminalState(state.snapshot),
    };
  }

  private async revokeMonitorScope(sessionToken: string, key: string): Promise<void> {
    const parsed = parseWatchKey(key);
    const scopeKey = monitorScopeStorageKey(sessionToken, parsed.repository, parsed.number);
    const capability = await this.state.storage.get<string>(scopeKey);
    if (!capability) {
      await this.state.storage.delete(scopeKey);
      return;
    }
    const record = await this.state.storage.get<MonitorCapabilityRecord>(monitorCapabilityStorageKey(capability));
    await this.revokeMonitorCapability(capability, record);
  }

  private async revokeMonitorCapability(
    capability: string,
    record?: MonitorCapabilityRecord,
  ): Promise<void> {
    const keys = [monitorCapabilityStorageKey(capability)];
    if (record) {
      const scopeKey = monitorScopeStorageKey(record.sessionToken, record.repository, record.pullRequestNumber);
      const current = await this.state.storage.get<string>(scopeKey);
      if (current === capability) keys.push(scopeKey);
    }
    await this.state.storage.delete(keys);
    for (const feed of [...(this.activeMonitorFeeds.get(capability) ?? [])]) this.closeMonitorFeed(feed);
  }

  private async revokeSessionMonitors(sessionToken: string, watchKeys: Iterable<string>): Promise<void> {
    for (const key of watchKeys) {
      try {
        await this.revokeMonitorScope(sessionToken, key);
      } catch {
        // Ignore malformed persisted watch keys while revoking the rest of the session.
      }
    }
    this.closeMonitorFeedsForSession(sessionToken);
  }

  private closeMonitorFeedsForSession(sessionToken: string): void {
    for (const feeds of this.activeMonitorFeeds.values()) {
      for (const feed of [...feeds]) {
        if (feed.sessionToken === sessionToken) this.closeMonitorFeed(feed);
      }
    }
  }

  private async listWatches(active: ActiveSession): Promise<WatchRegistration[]> {
    const registrations: WatchRegistration[] = [];
    for (const key of [...active.watches].sort()) {
      const parsed = parseWatchKey(key);
      const state = await this.watchState(active.record.user.id, key);
      registrations.push({
        key,
        repository: parsed.repository,
        number: parsed.number,
        resourceUri: resourceUri(parsed.repository, parsed.number),
        snapshot: state.snapshot,
        refreshScheduled: state.snapshot === null,
      });
    }
    return registrations;
  }

  private async readWatch(active: ActiveSession, repository: string, number: number): Promise<StoredWatchState> {
    const key = watchKey(repository, number);
    if (!active.watches.has(key)) throw new Error("pull request is not watched by this session");
    const state = await this.watchState(active.record.user.id, key);
    if (!state.snapshot) this.scheduleRefresh(active.record.user.id, key, active.record.githubAccessToken, active.token, "read");
    return state;
  }

  private async subscribe(active: ActiveSession, repository: string, number: number): Promise<void> {
    const key = watchKey(repository, number);
    await this.updateSession(active, (watches, subscriptions) => {
      if (!watches.has(key)) throw new Error("watch the pull request before subscribing to its resource");
      subscriptions.add(key);
    });
  }

  private async unsubscribe(active: ActiveSession, repository: string, number: number): Promise<void> {
    const key = watchKey(repository, number);
    await this.updateSession(active, (_watches, subscriptions) => {
      subscriptions.delete(key);
    });
  }

  private async updateSession<T>(
    active: ActiveSession,
    mutate: (watches: Set<string>, subscriptions: Set<string>) => T,
  ): Promise<T> {
    return this.withSessionLock(active.token, async () => {
      const key = sessionStorageKey(active.token);
      const updated = await this.state.storage.transaction(async (storage) => {
        const current = await storage.get<SessionRecord>(key);
        if (!current || current.expiresAt <= Date.now()) {
          if (current) await storage.delete(key);
          return null;
        }
        const watches = new Set(current.watches);
        const subscriptions = new Set(current.subscriptions ?? []);
        const result = mutate(watches, subscriptions);
        const record: SessionRecord = {
          ...current,
          watches: [...watches].sort(),
          subscriptions: [...subscriptions].filter((entry) => watches.has(entry)).sort(),
        };
        await storage.put(key, record);
        return { record, result };
      });
      if (!updated) {
        await this.revokeSessionMonitors(active.token, active.watches);
        await this.closeActiveSessionsForToken(active.token);
        throw new Error("session is no longer active");
      }
      this.syncActiveSessions(active.token, updated.record);
      return updated.result;
    });
  }

  private async withSessionLock<T>(token: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.sessionOperations.get(token) ?? Promise.resolve();
    let release = (): void => { };
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.sessionOperations.set(token, current);
    await previous;
    try {
      return await operation();
    } finally {
      release();
      if (this.sessionOperations.get(token) === current) this.sessionOperations.delete(token);
    }
  }

  private async sessionForToken(token: string): Promise<{ token: string; record: SessionRecord } | null> {
    return this.withSessionLock(token, () => this.sessionForTokenUnlocked(token));
  }

  private async sessionForTokenUnlocked(token: string): Promise<{ token: string; record: SessionRecord } | null> {

    const key = sessionStorageKey(token);
    const record = await this.state.storage.get<SessionRecord>(key);
    if (!record) {
      await this.state.storage.delete(`closed-mcp-sessions:${token}`);
      this.closeMonitorFeedsForSession(token);
      await this.closeActiveSessionsForToken(token);
      return null;
    }
    const now = Date.now();
    if (record.expiresAt <= now) {
      await this.revokeSessionMonitors(token, record.watches);
      await this.state.storage.delete([key, `closed-mcp-sessions:${token}`]);
      await this.closeActiveSessionsForToken(token);
      return null;
    }
    await this.migrateLegacyWatchStates(record);
    if (record.watchStorageVersion !== 1) {
      record.watchStorageVersion = 1;
      await this.state.storage.put(key, record);
    }

    const needsRefresh = Boolean(record.githubTokenExpiresAt && record.githubTokenExpiresAt <= now + 60_000);
    const canRefresh = Boolean(
      needsRefresh &&
      record.githubRefreshToken &&
      this.env.GITHUB_CLIENT_SECRET &&
      (!record.githubRefreshTokenExpiresAt || record.githubRefreshTokenExpiresAt > now),
    );
    if (canRefresh) {
      try {
        const refreshed = await refreshGithubToken(this.env.GITHUB_CLIENT_ID, this.env.GITHUB_CLIENT_SECRET!, record.githubRefreshToken!);
        record.githubAccessToken = refreshed.accessToken;
        record.githubRefreshToken = refreshed.refreshToken ?? record.githubRefreshToken;
        record.githubTokenExpiresAt = refreshed.expiresIn ? now + refreshed.expiresIn * 1000 : undefined;
        record.githubRefreshTokenExpiresAt = refreshed.refreshTokenExpiresIn
          ? now + refreshed.refreshTokenExpiresIn * 1000
          : record.githubRefreshTokenExpiresAt;
        await this.state.storage.put(key, record);
      } catch (error) {
        if (isGithubAuthorizationError(error) || (record.githubTokenExpiresAt && record.githubTokenExpiresAt <= now)) {
          await this.revokeSessionMonitors(token, record.watches);
          await this.state.storage.delete([key, `closed-mcp-sessions:${token}`]);
          await this.closeActiveSessionsForToken(token);
          return null;
        }
      }
    }
    if (record.githubTokenExpiresAt && record.githubTokenExpiresAt <= now) {
      await this.revokeSessionMonitors(token, record.watches);
      await this.state.storage.delete([key, `closed-mcp-sessions:${token}`]);
      await this.closeActiveSessionsForToken(token);
      return null;
    }
    return { token, record };
  }
  private async migrateLegacyWatchStates(record: SessionRecord): Promise<void> {
    if (record.watchStorageVersion === 1) return;
    for (const key of record.watches) {
      let parsed;
      try {
        parsed = parseWatchKey(key);
      } catch {
        continue;
      }
      const legacyKey = legacyWatchStorageKey(parsed.repository, parsed.number);
      const legacyStored = await this.state.storage.get<unknown>(legacyKey);
      if (legacyStored === undefined) continue;
      const scopedKey = watchStorageKey(record.user.id, parsed.repository, parsed.number);
      const legacyState = await readStoredWatchState(this.state.storage, legacyKey);
      await this.state.storage.transaction(async (storage) => {
        if ((await storage.get<unknown>(scopedKey)) !== undefined) return;
        await writeStoredWatchState(storage, scopedKey, legacyState);
      });
    }
  }

  private async handleGithubWebhook(request: Request): Promise<Response> {
    if (request.method !== "POST") return new Response("Method not allowed", { status: 405 });
    const body = await request.text();
    const valid = await verifyGithubSignature(body, request.headers.get("x-hub-signature-256"), this.env.GITHUB_WEBHOOK_SECRET);
    if (!valid) return new Response("Invalid webhook signature", { status: 401 });
    const eventName = request.headers.get("x-github-event")?.trim() ?? "";
    const deliveryId = request.headers.get("x-github-delivery")?.trim() || randomToken(12);
    if (!isSupportedGithubEvent(eventName)) return this.accepted({ accepted: true, ignored: true, event: eventName });

    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(body) as Record<string, unknown>;
    } catch {
      return new Response("Invalid JSON", { status: 400 });
    }
    const deliveryKey = `delivery:${deliveryId}`;
    const previousDelivery = await this.state.storage.get<number>(deliveryKey);
    if (previousDelivery && Date.now() - previousDelivery < 7 * 24 * 60 * 60 * 1000) return this.accepted({ accepted: true, duplicate: true });
    await this.state.storage.put(deliveryKey, Date.now());
    this.state.waitUntil(this.processWebhook(eventName, deliveryId, payload));
    return this.accepted({ accepted: true, deliveryId, event: eventName });
  }

  private async reconcileActiveSessions(): Promise<void> {
    for (const active of [...this.activeSessions.values()]) {
      const session = await this.sessionForToken(active.token);
      if (!session) continue;
      this.syncActiveSessions(active.token, session.record);
    }
  }

  private async invalidateSession(token: string, expectedGithubToken?: string): Promise<void> {
    await this.withSessionLock(token, async () => {
      const key = sessionStorageKey(token);
      const current = await this.state.storage.get<SessionRecord>(key);
      if (!current) {
        this.closeMonitorFeedsForSession(token);
        await this.closeActiveSessionsForToken(token);
        return;
      }
      if (expectedGithubToken && current.githubAccessToken !== expectedGithubToken) return;
      await this.revokeSessionMonitors(token, current.watches);
      await this.state.storage.delete([key, `closed-mcp-sessions:${token}`]);
      await this.closeActiveSessionsForToken(token);
    });
  }

  private async processWebhook(eventName: string, deliveryId: string, payload: Record<string, unknown>): Promise<void> {
    await this.reconcileActiveSessions();
    const sessions = await this.sessionRecords();
    const watchers = new Map<string, { userId: number; key: string; githubToken: string; sessionToken: string }>();
    const invalidSessionTokens = new Set<string>();
    const addWatchers = (sessionToken: string, record: SessionRecord): void => {
      for (const key of record.watches) {
        watchers.set(`${record.user.id}:${key}`, {
          userId: record.user.id,
          key,
          githubToken: record.githubAccessToken,
          sessionToken,
        });
      }
    };
    for (const [sessionToken, record] of sessions) addWatchers(sessionToken, record);
    for (const active of this.activeSessions.values()) addWatchers(active.token, active.record);

    const repository = repositoryFromPayload(payload);
    if (!repository) return;
    const webhookAction = actionFromPayload(payload);
    for (const watcher of watchers.values()) {
      if (invalidSessionTokens.has(watcher.sessionToken)) continue;
      let parsed;
      try {
        parsed = parseWatchKey(watcher.key);
      } catch {
        continue;
      }
      if (parsed.repository !== repository) continue;
      const targetNumbers = eventPullRequestNumbers(eventName, payload, [watcher.key]);
      if (!targetNumbers.includes(parsed.number)) continue;

      const previous = await this.watchState(watcher.userId, watcher.key);
      const previousTerminalState = terminalState(previous.snapshot);
      if (previousTerminalState === "merged") continue;
      if (previousTerminalState === "closed" && (eventName !== "pull_request" || webhookAction !== "reopened")) continue;
      let snapshot = previous.snapshot;
      try {
        snapshot = await pullRequestSnapshot(watcher.githubToken, parsed.repository, parsed.number);
      } catch (error) {
        if (isGithubAuthorizationError(error)) {
          invalidSessionTokens.add(watcher.sessionToken);
          await this.invalidateSession(watcher.sessionToken, watcher.githubToken);
          continue;
        }
        snapshot = previous.snapshot;
      }
      const changes = snapshot && previous.snapshot ? snapshotChanges(previous.snapshot, snapshot) : snapshot ? ["initial_snapshot"] : [];
      const event = createWatchEvent({
        deliveryId,
        githubEvent: eventName,
        action: webhookAction,
        repository: parsed.repository,
        pullRequestNumber: parsed.number,
        payload,
        snapshot,
        changes,
      });
      await this.publishEvent(watcher.userId, watcher.key, event, { snapshot });
    }
  }

  private scheduleRefresh(userId: number, key: string, githubToken: string, sessionToken: string, reason: string): void {
    const refreshKey = `${userId}:${key}`;
    if (this.refreshes.has(refreshKey)) return;
    this.refreshes.add(refreshKey);
    this.state.waitUntil(
      this.refreshAndPublish(userId, key, githubToken, sessionToken, reason).finally(() => {
        this.refreshes.delete(refreshKey);
      }),
    );
  }

  private async refreshAndPublish(
    userId: number,
    key: string,
    githubToken: string,
    sessionToken: string,
    reason: string,
  ): Promise<void> {
    const initialState = await this.watchState(userId, key);
    const initialTerminalState = terminalState(initialState.snapshot);
    if (initialTerminalState === "merged" || (initialTerminalState === "closed" && reason !== "watch")) return;
    const parsed = parseWatchKey(key);
    let snapshot;
    try {
      snapshot = await pullRequestSnapshot(githubToken, parsed.repository, parsed.number);
    } catch (error) {
      if (isGithubAuthorizationError(error)) await this.invalidateSession(sessionToken, githubToken);
      return;
    }
    const current = await this.watchState(userId, key);
    const currentTerminalState = terminalState(current.snapshot);
    if (currentTerminalState === "merged" || (currentTerminalState === "closed" && reason !== "watch")) return;
    const changes = snapshotChanges(current.snapshot, snapshot);
    if (current.snapshot && changes.length === 0) return;
    const event = createWatchEvent({
      deliveryId: `snapshot-${randomToken(12)}`,
      githubEvent: "snapshot",
      action: reason,
      repository: parsed.repository,
      pullRequestNumber: parsed.number,
      payload: { reason },
      snapshot,
      changes,
    });
    await this.publishEvent(userId, key, event, { snapshot });
  }

  private async handlePoll(request: Request): Promise<Response> {
    if (request.method !== "POST") return new Response("Method not allowed", { status: 405 });
    await this.reconcileActiveSessions();
    const sessions = await this.sessionRecords();
    let scheduled = 0;
    for (const [sessionToken, record] of sessions) {
      for (const key of record.watches) {
        const state = await this.watchState(record.user.id, key);
        if (terminalState(state.snapshot) !== "watching") continue;
        this.scheduleRefresh(record.user.id, key, record.githubAccessToken, sessionToken, "poll");
        scheduled += 1;
      }
    }
    return this.accepted({ accepted: true, scheduled });
  }

  private async publishEvent(
    userId: number,
    key: string,
    event: WatchEvent,
    state: Pick<StoredWatchState, "snapshot">,
  ): Promise<void> {
    const storageKey = watchStorageKey(userId, event.repository, event.pullRequestNumber);
    let deliveredEvent = event;
    let published = false;
    await this.state.storage.transaction(async (storage) => {
      const current = await readStoredWatchState(storage, storageKey);
      const currentTerminalState = terminalState(current.snapshot);
      if (currentTerminalState === "merged") return;
      let snapshot = state.snapshot;
      let changes = event.changes;
      if (!snapshot) {
        snapshot = current.snapshot;
        changes = [];
      } else if (current.snapshot) {
        const currentTime = Date.parse(current.snapshot.fetchedAt);
        const incomingTime = Date.parse(snapshot.fetchedAt);
        if (Number.isFinite(currentTime) && Number.isFinite(incomingTime) && currentTime > incomingTime) {
          snapshot = current.snapshot;
          changes = [];
        } else {
          changes = snapshotChanges(current.snapshot, snapshot);
        }
      }
      if (currentTerminalState === "closed" && !resumesClosedWatch(event, snapshot)) return;
      deliveredEvent = { ...event, snapshot, changes };
      const events = [...current.events, deliveredEvent].slice(-MAX_EVENTS);
      const storedEvents = events.map((entry, index) => (
        index === events.length - 1 ? entry : { ...entry, snapshot: null }
      ));
      await writeStoredWatchState(storage, storageKey, { snapshot, events: storedEvents });
      published = true;
    });
    if (!published) return;
    this.publishMonitorEvent(userId, key, compactMonitorEvent(deliveredEvent));

    const active = [...this.activeSessions.values()].filter(
      (session) =>
        session.record.expiresAt > Date.now() &&
        session.record.user.id === userId &&
        session.watches.has(key) &&
        session.subscriptions.has(key),
    );
    await Promise.all(active.map(async (session) => {
      if (!session.server) return;
      try {
        await session.server.server.sendResourceUpdated({ uri: deliveredEvent.resourceUri });
      } catch {
        // A client can close its SSE stream between webhook fanout and delivery.
      }
      try {
        await session.server.server.notification({
          method: "notifications/message",
          params: {
            level: "info",
            logger: "watch-pr",
            data: {
              resourceUri: deliveredEvent.resourceUri,
              githubEvent: deliveredEvent.githubEvent,
              action: deliveredEvent.action,
              receivedAt: deliveredEvent.receivedAt,
              changes: deliveredEvent.changes,
            },
          },
        } as never);
      } catch {
        // Resource updates remain the interoperable push channel.
      }
    }));
  }

  private syncActiveSessions(token: string, record: SessionRecord): void {
    for (const active of this.activeSessions.values()) {
      if (active.token !== token) continue;
      active.record = record;
      this.syncActiveSession(active, record);
    }
  }

  private async closeActiveSession(sessionId: string, active: ActiveSession): Promise<void> {
    try {
      await active.server?.close();
    } catch {
      // Continue closing the underlying transport and forget the unusable session.
    }
    try {
      await active.transport?.close();
    } catch {
      // Closing is best effort after the bearer session is no longer valid.
    }
    if (this.activeSessions.get(sessionId) === active) this.activeSessions.delete(sessionId);
  }

  private async closeActiveSessionsForToken(token: string): Promise<void> {
    const sessions = [...this.activeSessions.entries()].filter(([, active]) => active.token === token);
    await Promise.all(sessions.map(([sessionId, active]) => this.closeActiveSession(sessionId, active)));
  }

  private async notifySubscribedResources(active: ActiveSession): Promise<void> {
    if (!active.server) return;
    for (const key of active.subscriptions) {
      try {
        const parsed = parseWatchKey(key);
        await active.server.server.sendResourceUpdated({ uri: resourceUri(parsed.repository, parsed.number) });
      } catch {
        // A recovered stream may close while catch-up notifications are queued.
      }
    }
  }

  private async notifyResourceListChanged(active: ActiveSession): Promise<void> {
    if (!active.server) return;
    try {
      await active.server.server.sendResourceListChanged();
    } catch {
      // Resource list notifications are advisory; list_resources remains authoritative.
    }
  }

  private async watchState(userId: number, key: string): Promise<StoredWatchState> {
    const parsed = parseWatchKey(key);
    return readStoredWatchState(this.state.storage, watchStorageKey(userId, parsed.repository, parsed.number));
  }

  private async sessionRecords(): Promise<Map<string, SessionRecord>> {
    const records = await this.state.storage.list<SessionRecord>({ prefix: "session:" });
    const valid = new Map<string, SessionRecord>();
    for (const [key] of records) {
      const token = key.slice("session:".length);
      const session = await this.sessionForToken(token);
      if (session) valid.set(token, session.record);
    }
    return valid;
  }

  private async handleOAuthRegister(request: Request): Promise<Response> {
    if (request.method !== "POST") return new Response("Method not allowed", { status: 405 });
    let body: Record<string, unknown>;
    try {
      body = await request.json() as Record<string, unknown>;
    } catch {
      return this.oauthError("invalid_client_metadata", "registration body must be JSON");
    }
    const redirectUris = body.redirect_uris;
    if (
      !Array.isArray(redirectUris) ||
      redirectUris.length === 0 ||
      redirectUris.length > 10 ||
      redirectUris.some((uri) => typeof uri !== "string" || !isAllowedRedirectUri(uri))
    ) {
      return this.oauthError("invalid_client_metadata", "redirect_uris must contain one to ten HTTPS or loopback HTTP URLs");
    }
    const uniqueRedirectUris = [...new Set(redirectUris as string[])];
    if (uniqueRedirectUris.length !== redirectUris.length) {
      return this.oauthError("invalid_client_metadata", "redirect_uris must not contain duplicates");
    }
    const clientId = randomToken(24);
    const record: OAuthClientRecord = { clientId, redirectUris: uniqueRedirectUris, createdAt: Date.now() };
    await this.state.storage.put(`oauth-client:${clientId}`, record);
    return this.json({
      client_id: clientId,
      client_id_issued_at: Math.floor(record.createdAt / 1000),
      redirect_uris: record.redirectUris,
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code"],
      response_types: ["code"],
      scope: "watch-pr",
    }, 201, { "access-control-allow-origin": "*" });
  }

  private async handleOAuthAuthorize(request: Request): Promise<Response> {
    if (request.method !== "GET") return new Response("Method not allowed", { status: 405 });
    const url = new URL(request.url);
    const clientId = url.searchParams.get("client_id");
    const redirectUri = url.searchParams.get("redirect_uri");
    const clientState = url.searchParams.get("state");
    const responseType = url.searchParams.get("response_type");
    const codeChallenge = url.searchParams.get("code_challenge");
    const method = url.searchParams.get("code_challenge_method");
    if (!clientId || !redirectUri || !clientState || responseType !== "code" || !codeChallenge || method !== "S256") {
      return new Response("OAuth authorization requires code, state, and S256 PKCE", { status: 400 });
    }
    const client = await this.state.storage.get<OAuthClientRecord>(`oauth-client:${clientId}`);
    if (!client) return this.oauthError("invalid_client", "client_id is not registered");
    if (!client.redirectUris.some((registered) => redirectUriMatches(redirectUri, registered))) {
      return this.oauthError("invalid_request", "redirect_uri is not registered for client_id");
    }
    const internalState = randomToken(24);
    const record: OAuthRequestRecord = { clientId, redirectUri, clientState, codeChallenge, codeChallengeMethod: "S256", createdAt: Date.now() };
    await this.state.storage.put(`oauth-request:${internalState}`, record);
    const github = new URL("https://github.com/login/oauth/authorize");
    github.searchParams.set("client_id", this.env.GITHUB_CLIENT_ID);
    github.searchParams.set("redirect_uri", `${this.baseUrl()}/oauth/callback`);
    github.searchParams.set("state", internalState);
    return Response.redirect(github.toString(), 302);
  }

  private async handleOAuthCallback(request: Request): Promise<Response> {
    if (request.method !== "GET") return new Response("Method not allowed", { status: 405 });
    const url = new URL(request.url);
    const internalState = url.searchParams.get("state");
    if (!internalState) return new Response("Missing OAuth state", { status: 400 });
    const requestRecord = await this.state.storage.get<OAuthRequestRecord>(`oauth-request:${internalState}`);
    await this.state.storage.delete(`oauth-request:${internalState}`);
    if (!requestRecord || Date.now() - requestRecord.createdAt > OAUTH_TTL_SECONDS * 1000) return new Response("Expired OAuth state", { status: 400 });
    if (url.searchParams.get("error")) return this.oauthRedirect(requestRecord, { error: "access_denied" });

    const code = url.searchParams.get("code");
    if (!code) return this.oauthRedirect(requestRecord, { error: "invalid_request" });
    if (!this.env.GITHUB_CLIENT_SECRET) return this.oauthRedirect(requestRecord, { error: "server_error" });
    try {
      const exchange = await exchangeGithubCode(this.env.GITHUB_CLIENT_ID, this.env.GITHUB_CLIENT_SECRET, code, `${this.baseUrl()}/oauth/callback`);
      const user = await githubUser(exchange.accessToken);
      const brokerCode = randomToken(32);
      const record: OAuthCodeRecord = {
        ...requestRecord,
        githubAccessToken: exchange.accessToken,
        githubRefreshToken: exchange.refreshToken,
        githubTokenExpiresAt: exchange.expiresIn ? Date.now() + exchange.expiresIn * 1000 : undefined,
        githubRefreshTokenExpiresAt: exchange.refreshTokenExpiresIn ? Date.now() + exchange.refreshTokenExpiresIn * 1000 : undefined,
        user,
      };
      await this.state.storage.put(`oauth-code:${brokerCode}`, record);
      return this.oauthRedirect(requestRecord, { code: brokerCode });
    } catch {
      return this.oauthRedirect(requestRecord, { error: "server_error" });
    }
  }

  private async handleOAuthToken(request: Request): Promise<Response> {
    if (request.method !== "POST") return new Response("Method not allowed", { status: 405 });
    const form = await request.formData();
    const grantType = form.get("grant_type");
    const code = form.get("code");
    const verifier = form.get("code_verifier");
    const clientId = form.get("client_id");
    const redirectUri = form.get("redirect_uri");
    if (grantType !== "authorization_code" || typeof code !== "string" || typeof verifier !== "string" || typeof clientId !== "string" || typeof redirectUri !== "string") {
      return this.oauthError("invalid_request", "authorization_code with PKCE is required");
    }
    const record = await this.state.storage.get<OAuthCodeRecord>(`oauth-code:${code}`);
    await this.state.storage.delete(`oauth-code:${code}`);
    if (
      !record ||
      Date.now() - record.createdAt > OAUTH_TTL_SECONDS * 1000 ||
      record.clientId !== clientId ||
      record.redirectUri !== redirectUri
    ) return this.oauthError("invalid_grant", "authorization code is invalid or expired");
    const challenge = await sha256Base64Url(verifier);
    if (!(await constantTimeEqual(challenge, record.codeChallenge))) return this.oauthError("invalid_grant", "PKCE verification failed");

    const sessionToken = randomToken(32);
    const ttl = Number(this.env.SESSION_TTL_SECONDS ?? SESSION_TTL_SECONDS);
    const sessionTtl = Number.isFinite(ttl) && ttl > 0 ? ttl : SESSION_TTL_SECONDS;
    const session: SessionRecord = {
      githubAccessToken: record.githubAccessToken,
      githubRefreshToken: record.githubRefreshToken,
      githubTokenExpiresAt: record.githubTokenExpiresAt,
      githubRefreshTokenExpiresAt: record.githubRefreshTokenExpiresAt,
      user: record.user,
      createdAt: Date.now(),
      expiresAt: Date.now() + sessionTtl * 1000,
      watches: [],
      watchStorageVersion: 1,
    };
    await this.state.storage.put(sessionStorageKey(sessionToken), session);
    return this.json({ access_token: sessionToken, token_type: "Bearer", expires_in: sessionTtl, scope: "watch-pr" }, 200, { "access-control-allow-origin": "*" });
  }

  private oauthRedirect(record: OAuthRequestRecord, values: Record<string, string>): Response {
    const redirect = new URL(record.redirectUri);
    for (const [key, value] of Object.entries(values)) redirect.searchParams.set(key, value);
    redirect.searchParams.set("state", record.clientState);
    return Response.redirect(redirect.toString(), 302);
  }

  private unauthorized(request: Request): Response {
    const resource = `${this.baseUrl()}/.well-known/oauth-protected-resource`;
    return new Response(JSON.stringify({ error: "unauthorized", error_description: "Bearer token required" }), {
      status: 401,
      headers: {
        "content-type": "application/json",
        "www-authenticate": `Bearer resource_metadata="${resource}"`,
        "access-control-allow-origin": request.headers.get("origin") ?? "*",
      },
    });
  }

  private oauthError(error: string, description: string): Response {
    return this.json({ error, error_description: description }, 400, { "access-control-allow-origin": "*" });
  }

  private accepted(value: unknown): Response {
    return this.json(value, 202);
  }

  private json(value: unknown, status = 200, headers: Record<string, string> = {}): Response {
    return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json", ...headers } });
  }

  private baseUrl(): string {
    return (this.env.PUBLIC_BASE_URL || "https://watch-pr.vza.net").replace(/\/+$/u, "");
  }
}

function isInitializeMessage(value: unknown): boolean {
  return Boolean(value && typeof value === "object" && (value as Record<string, unknown>).method === "initialize");
}

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

function isAllowedRedirectUri(value: string): boolean {
  try {
    const target = new URL(value);
    if (target.hash || target.username || target.password) return false;
    if (target.protocol === "https:") return true;
    return target.protocol === "http:" && LOOPBACK_HOSTS.has(target.hostname);
  } catch {
    return false;
  }
}

function redirectUriMatches(requested: string, registered: string): boolean {
  if (!isAllowedRedirectUri(requested) || !isAllowedRedirectUri(registered)) return false;
  const requestedUrl = new URL(requested);
  const registeredUrl = new URL(registered);
  if (requestedUrl.protocol !== registeredUrl.protocol) return false;
  if (requestedUrl.protocol === "https:") return requested === registered;
  return (
    requestedUrl.hostname === registeredUrl.hostname &&
    requestedUrl.pathname === registeredUrl.pathname &&
    requestedUrl.search === registeredUrl.search
  );
}

function actionFromPayload(payload: Record<string, unknown>): string | null {
  const action = payload.action;
  return typeof action === "string" ? action : null;
}

function repositoryFromPayload(payload: Record<string, unknown>): string | null {
  const repository = payload.repository;
  if (!repository || typeof repository !== "object") return null;
  const fullName = (repository as Record<string, unknown>).full_name;
  if (typeof fullName !== "string") return null;
  try {
    return fullName.trim().toLowerCase();
  } catch {
    return null;
  }
}

function isGithubAuthorizationError(error: unknown): boolean {
  return error instanceof GithubApiError && error.status === 401;
}
