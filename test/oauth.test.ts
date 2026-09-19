import { describe, expect, it, vi } from "vitest";
import { hmacSha256Hex, sha256Base64Url } from "../src/crypto";
import {
  WatchPrHub,
  openWatchStateMutation,
  readStoredWatchState,
  readWatchStateMetadata,
  writeStoredWatchState,
  type Env,
  type WatchStorage,
} from "../src/hub";
import { GithubApiError } from "../src/github";
import type { OAuthCodeRecord, PullRequestSnapshot, SessionRecord, StoredWatchState, WatchEvent } from "../src/types";
import {
  legacyWatchStorageKey,
  sessionStorageKey,
  watchSidecarCleanupKey,
  watchSidecarEventKey,
  watchSidecarIndexKey,
  watchSidecarSnapshotKey,
  watchStorageKey,
} from "../src/types";

class MemoryStorage {
  private readonly values = new Map<string, unknown>();
  readonly batchSizes: number[] = [];
  readonly putKeys: string[] = [];
  readonly deleteKeys: string[] = [];
  readonly getKeys: string[] = [];

  listError?: unknown;



  async get<T>(key: string | string[]): Promise<T | undefined | Map<string, T>> {
    if (Array.isArray(key)) {
      this.getKeys.push(...key);
      this.batchSizes.push(key.length);
      return new Map(key.flatMap((entry) => {
        const value = this.values.get(entry);
        return value === undefined ? [] : [[entry, value as T]];
      }));
    }
    this.getKeys.push(key);
    return this.values.get(key) as T | undefined;
  }

  async put<T>(key: string | Record<string, T>, value?: T): Promise<void> {
    if (typeof key === "string") {
      this.putKeys.push(key);
      this.values.set(key, value);
      return;
    }
    this.batchSizes.push(Object.keys(key).length);
    this.putKeys.push(...Object.keys(key));
    for (const [entry, entryValue] of Object.entries(key)) this.values.set(entry, entryValue);
  }

  async delete(key: string | string[]): Promise<boolean> {
    if (Array.isArray(key)) {
      this.batchSizes.push(key.length);
      this.deleteKeys.push(...key);
      let deleted = false;
      for (const entry of key) deleted = this.values.delete(entry) || deleted;
      return deleted;
    }
    this.deleteKeys.push(key);
    return this.values.delete(key);
  }

  async list<T>(options: { prefix?: string } = {}): Promise<Map<string, T>> {
    if (this.listError !== undefined) throw this.listError;
    return new Map([...this.values.entries()]
      .filter(([key]) => !options.prefix || key.startsWith(options.prefix))
      .map(([key, value]) => [key, value as T]));
  }

  async transaction<T>(callback: (storage: MemoryStorage) => Promise<T>): Promise<T> {
    return callback(this);
  }
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
    PUBLIC_BASE_URL: "https://watch-pr.vza.net",
  };
  return {
    hub: new WatchPrHub(state, env),
    storage,
    pending,
    restart: () => new WatchPrHub(state, env),
  };
}

function watchEvent(index: number, payload: unknown): WatchEvent {
  return {
    id: `event-${index}`,
    deliveryId: `delivery-${index}`,
    receivedAt: new Date(index).toISOString(),
    githubEvent: "pull_request",
    action: "opened",
    repository: "owner/repo",
    pullRequestNumber: 7,
    resourceUri: "pr://owner/repo/7",
    payload,
    snapshot: null,
    changes: [],
  };
}

function pullRequestSnapshot(body: string, fetchedAt: string): PullRequestSnapshot {
  return {
    repository: "owner/repo",
    number: 7,
    url: "https://github.com/owner/repo/pull/7",
    title: "Watch sidecar",
    body,
    state: "open",
    draft: false,
    merged: false,
    mergedAt: null,
    mergeable: true,
    mergeableState: "clean",
    baseRefName: "main",
    headRefName: "sidecar",
    headRepository: "owner/repo",
    headSha: "abc123",
    author: "owner",
    fetchedAt,
    bodyReactions: {},
    bodyReactionDetails: [],
    comments: [],
    reviews: [],
    reviewComments: [],
    checks: [],
    threads: [],
  };
}

type TestActiveSession = {
  token: string;
  record: SessionRecord;
  watches: Set<string>;
  subscriptions: Set<string>;
  kind: "stateful" | "recovered-stream";
  server?: { close(): Promise<void> };
  transport?: { close(): Promise<void> };
};

type HubSessionInternals = {
  activeSessions: Map<string, TestActiveSession>;
  newActiveSession(token: string, record: SessionRecord, kind: TestActiveSession["kind"]): TestActiveSession;
  subscribe(active: TestActiveSession, repository: string, number: number): Promise<void>;
  invalidateSession(token: string, expectedGithubToken?: string): Promise<number>;
  sessionForToken(token: string): Promise<{ token: string; record: SessionRecord } | null>;
};

function sessionRecord(overrides: Partial<SessionRecord> = {}): SessionRecord {
  return {
    githubAccessToken: "github-token",
    user: { login: "pedropaulovc", id: 42, name: "Pedro", avatarUrl: null, htmlUrl: "https://github.com/pedropaulovc" },
    createdAt: Date.now(),
    expiresAt: Date.now() + 60_000,
    watches: [],
    watchStorageVersion: 1,
    ...overrides,
  };
}


async function register(hub: WatchPrHub, redirectUri = "http://127.0.0.1:43123/callback"): Promise<string> {
  const response = await hub.fetch(new Request("https://watch-pr.vza.net/oauth/register", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ redirect_uris: [redirectUri] }),
  }));
  expect(response.status).toBe(201);
  const body = await response.json() as { client_id: string };
  return body.client_id;
}

describe("OAuth broker", () => {
  it("registers clients and only authorizes registered redirect URIs", async () => {
    const { hub } = hubFixture();
    const clientId = await register(hub);
    const valid = new URL("https://watch-pr.vza.net/oauth/authorize");
    valid.search = new URLSearchParams({
      client_id: clientId,
      redirect_uri: "http://127.0.0.1:43123/callback",
      response_type: "code",
      state: "client-state",
      code_challenge: "challenge",
      code_challenge_method: "S256",
    }).toString();
    const authorized = await hub.fetch(new Request(valid));
    expect(authorized.status).toBe(302);
    expect(new URL(authorized.headers.get("location")!).hostname).toBe("github.com");

    const invalid = new URL(valid);
    invalid.searchParams.set("redirect_uri", "https://attacker.example/callback");
    await expect(hub.fetch(new Request(invalid))).resolves.toMatchObject({ status: 400 });
  });

  it("exchanges a broker code once after PKCE verification", async () => {
    const { hub, storage } = hubFixture();
    const clientId = await register(hub, "https://client.example/callback");
    const verifier = "test-verifier-that-is-long-enough-for-pkce";
    const code = "broker-code";
    const record: OAuthCodeRecord = {
      clientId,
      redirectUri: "https://client.example/callback",
      clientState: "state",
      codeChallenge: await sha256Base64Url(verifier),
      codeChallengeMethod: "S256",
      createdAt: Date.now(),
      githubAccessToken: "github-access-token",
      user: { login: "pedropaulovc", id: 42, name: "Pedro", avatarUrl: null, htmlUrl: "https://github.com/pedropaulovc" },
    };
    await storage.put(`oauth-code:${code}`, record);

    const body = new URLSearchParams({
      grant_type: "authorization_code",
      code,
      client_id: clientId,
      redirect_uri: record.redirectUri,
      code_verifier: verifier,
    });
    const tokenResponse = await hub.fetch(new Request("https://watch-pr.vza.net/oauth/token", { method: "POST", body }));
    expect(tokenResponse.status).toBe(200);
    const tokenBody = await tokenResponse.json() as { access_token: string; token_type: string };
    expect(tokenBody.token_type).toBe("Bearer");
    await expect(storage.get<SessionRecord>(sessionStorageKey(tokenBody.access_token))).resolves.toMatchObject({
      githubAccessToken: "github-access-token",
      user: { login: "pedropaulovc" },
      watches: [],
      watchStorageVersion: 1,
    });

    const replay = await hub.fetch(new Request("https://watch-pr.vza.net/oauth/token", { method: "POST", body }));
    expect(replay.status).toBe(400);
    await expect(replay.json()).resolves.toMatchObject({ error: "invalid_grant" });
  });

  it("exposes the webhook route and rejects unsigned deliveries", async () => {
    const { hub } = hubFixture();
    const method = await hub.fetch(new Request("https://watch-pr.vza.net/webhooks/github"));
    expect(method.status).toBe(405);
    const unsigned = await hub.fetch(new Request("https://watch-pr.vza.net/webhooks/github", {
      method: "POST",
      body: "{}",
    }));
    expect(unsigned.status).toBe(401);
  });
  it("does not write a Durable Object row for unmatched webhook deliveries", async () => {
    const { hub, pending, storage } = hubFixture();
    const deliveryId = "unmatched-delivery";
    const body = JSON.stringify({
      action: "opened",
      repository: { full_name: "owner/unwatched" },
      pull_request: { number: 7 },
    });
    const signature = `sha256=${await hmacSha256Hex("webhook-secret", body)}`;
    const headers = {
      "x-github-delivery": deliveryId,
      "x-github-event": "pull_request",
      "x-hub-signature-256": signature,
    };

    await expect(hub.fetch(new Request("https://watch-pr.vza.net/webhooks/github", {
      method: "POST",
      headers,
      body,
    }))).resolves.toMatchObject({ status: 202 });
    await Promise.all(pending.splice(0));
    expect(storage.putKeys).not.toContain(`delivery:${deliveryId}`);
    expect(storage.getKeys).toContain(`delivery:${deliveryId}`);


    const redelivery = await hub.fetch(new Request("https://watch-pr.vza.net/webhooks/github", {
      method: "POST",
      headers,
      body,
    }));
    await expect(redelivery.json()).resolves.toMatchObject({ accepted: true, deliveryId });
    await Promise.all(pending.splice(0));
    expect(storage.putKeys).not.toContain(`delivery:${deliveryId}`);
  });

  it("logs a safe failure classification for a rejected webhook fanout", async () => {
    const { hub, pending, storage } = hubFixture();
    storage.listError = new GithubApiError(503, "sensitive upstream response", "/repos/private/repo");
    const body = JSON.stringify({
      action: "opened",
      repository: { full_name: "owner/repo" },
      pull_request: { number: 7 },
    });
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      const response = await hub.fetch(new Request("https://watch-pr.vza.net/webhooks/github", {
        method: "POST",
        headers: {
          "x-github-delivery": "failed-delivery",
          "x-github-event": "pull_request",
          "x-hub-signature-256": `sha256=${await hmacSha256Hex("webhook-secret", body)}`,
        },
        body,
      }));
      expect(response.status).toBe(202);
      await Promise.all(pending.splice(0));
      const failure = log.mock.calls
        .map(([value]) => JSON.parse(String(value)) as Record<string, unknown>)
        .find((entry) => entry.event === "watch_pr.webhook_failure");
      expect(failure).toMatchObject({
        event: "watch_pr.webhook_failure",
        error_kind: "github_api",
        error_name: "GithubApiError",
        github_status: 503,
      });
      expect(JSON.stringify(failure)).not.toContain("private/repo");
      expect(JSON.stringify(failure)).not.toContain("sensitive upstream response");
      storage.listError = undefined;
      const retry = await hub.fetch(new Request("https://watch-pr.vza.net/webhooks/github", {
        method: "POST",
        headers: {
          "x-github-delivery": "failed-delivery",
          "x-github-event": "pull_request",
          "x-hub-signature-256": `sha256=${await hmacSha256Hex("webhook-secret", body)}`,
        },
        body,
      }));
      await expect(retry.json()).resolves.toMatchObject({ accepted: true, deliveryId: "failed-delivery" });
      await Promise.all(pending.splice(0));
    } finally {
      log.mockRestore();
    }
  });

  it("batches oversized watch state and removes stale chunks", async () => {
    const storage = new MemoryStorage();
    const storageKey = watchStorageKey(42, "owner/repo", 7);
    const state: StoredWatchState = {
      snapshot: null,
      events: Array.from({ length: 100 }, (_, index) => watchEvent(index, "x".repeat(23_000))),
    };
    await writeStoredWatchState(storage as unknown as WatchStorage, storageKey, state);
    expect(Math.max(...storage.batchSizes)).toBeLessThanOrEqual(128);
    expect(storage.batchSizes).toContain(128);
    const indexValue = await storage.get<{ chunkCount: number }>(storageKey);
    if (
      !indexValue ||
      indexValue instanceof Map ||
      typeof indexValue !== "object" ||
      !("chunkCount" in indexValue) ||
      typeof indexValue.chunkCount !== "number"
    ) {
      throw new Error("watch state index was not stored");
    }
    const chunkCount = indexValue.chunkCount;
    expect(chunkCount).toBeGreaterThan(128);
    await expect(readStoredWatchState(storage as unknown as WatchStorage, storageKey)).resolves.toEqual(state);

    const updated: StoredWatchState = {
      ...state,
      events: state.events.map((entry, index) => (
        index === 0 ? { ...entry, payload: "y".repeat(23_000) } : entry
      )),
    };
    storage.putKeys.length = 0;
    const write = await writeStoredWatchState(storage as unknown as WatchStorage, storageKey, updated);
    expect(write).toMatchObject({ puts: chunkCount, chunkCount, format: "chunked" });
    expect(storage.putKeys).toHaveLength(chunkCount);
    expect(storage.putKeys).not.toContain(storageKey);
    await expect(readStoredWatchState(storage as unknown as WatchStorage, storageKey)).resolves.toEqual(updated);

    const compact = { snapshot: null, events: [watchEvent(101, { compact: true })] };
    const compactWrite = await writeStoredWatchState(storage as unknown as WatchStorage, storageKey, compact);
    expect(compactWrite).toMatchObject({ puts: 1, chunkCount: 0, format: "compact" });
    await expect(readStoredWatchState(storage as unknown as WatchStorage, storageKey)).resolves.toEqual(compact);
    await expect(storage.get(`${storageKey}:chunk:${chunkCount - 1}`)).resolves.toBeUndefined();
  });

  it("maps predecessor watch state to the owning user during session migration", async () => {
    const { hub, storage } = hubFixture();
    const repository = "owner/repo";
    const number = 7;
    const key = `${repository}#${number}`;
    const legacyKey = legacyWatchStorageKey(repository, number);
    const legacyState: StoredWatchState = { snapshot: null, events: [watchEvent(1, { legacy: true })] };
    await storage.put(legacyKey, legacyState);
    const sessionToken = "session-token";
    await storage.put(sessionStorageKey(sessionToken), {
      githubAccessToken: "github-token",
      user: { login: "pedropaulovc", id: 42, name: "Pedro", avatarUrl: null, htmlUrl: "https://github.com/pedropaulovc" },
      createdAt: Date.now(),
      expiresAt: Date.now() + 60_000,
      watches: [key],
    } satisfies SessionRecord);

    type HubSessionApi = {
      sessionForToken(token: string): Promise<{ token: string; record: SessionRecord } | null>;
    };
    const internals = hub as unknown as HubSessionApi;
    const result = await internals.sessionForToken(sessionToken);

    expect(result?.record.watchStorageVersion).toBe(1);
    await expect(storage.get(watchStorageKey(42, repository, number))).resolves.toEqual(legacyState);
    await expect(storage.get(legacyKey)).resolves.toEqual(legacyState);
  });

  it("invalidates the bearer session when GitHub API access is unauthorized", async () => {
    const { hub, storage, pending } = hubFixture();
    const sessionToken = "session-token";
    const key = "owner/repo#7";
    await storage.put(sessionStorageKey(sessionToken), {
      githubAccessToken: "github-token",
      user: { login: "pedropaulovc", id: 42, name: "Pedro", avatarUrl: null, htmlUrl: "https://github.com/pedropaulovc" },
      createdAt: Date.now(),
      expiresAt: Date.now() + 60_000,
      watches: [key],
      watchStorageVersion: 1,
    } satisfies SessionRecord);
    const originalFetch = globalThis.fetch;
    vi.stubGlobal("fetch", async () => new Response("revoked", { status: 401 }));
    try {
      type HubRefreshApi = {
        scheduleRefresh(userId: number, key: string, githubToken: string, sessionToken: string, reason: string): void;
      };
      const internals = hub as unknown as HubRefreshApi;
      internals.scheduleRefresh(42, key, "github-token", sessionToken, "test");
      await Promise.all(pending);
    } finally {
      vi.stubGlobal("fetch", originalFetch);
    }
    await expect(storage.get(sessionStorageKey(sessionToken))).resolves.toBeUndefined();
  });

  it("invalidates the bearer session when GitHub refresh is unauthorized", async () => {
    const { hub, storage } = hubFixture();
    const sessionToken = "session-token";
    await storage.put(sessionStorageKey(sessionToken), {
      githubAccessToken: "expired-access-token",
      githubRefreshToken: "revoked-refresh-token",
      githubTokenExpiresAt: Date.now() - 1_000,
      user: { login: "pedropaulovc", id: 42, name: "Pedro", avatarUrl: null, htmlUrl: "https://github.com/pedropaulovc" },
      createdAt: Date.now(),
      expiresAt: Date.now() + 60_000,
      watches: [],
      watchStorageVersion: 1,
    } satisfies SessionRecord);
    const originalFetch = globalThis.fetch;
    const fetchMock = vi.fn(async () => new Response("revoked refresh", { status: 401 }));
    vi.stubGlobal("fetch", fetchMock);
    try {
      type HubSessionApi = {
        sessionForToken(token: string): Promise<{ token: string; record: SessionRecord } | null>;
      };
      const internals = hub as unknown as HubSessionApi;
      await expect(internals.sessionForToken(sessionToken)).resolves.toBeNull();
    } finally {
      vi.stubGlobal("fetch", originalFetch);
    }
    expect(fetchMock).toHaveBeenCalledWith(
      "https://github.com/login/oauth/access_token",
      expect.objectContaining({ method: "POST" }),
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await expect(storage.get(sessionStorageKey(sessionToken))).resolves.toBeUndefined();
  });

  it("merges concurrent sibling subscriptions and synchronizes both active sessions", async () => {
    const { hub, storage } = hubFixture();
    const sessionToken = "shared-session-token";
    const firstKey = "owner/repo#7";
    const secondKey = "owner/repo#8";
    const record = sessionRecord({ watches: [firstKey, secondKey], subscriptions: [] });
    await storage.put(sessionStorageKey(sessionToken), record);
    const internals = hub as unknown as HubSessionInternals;
    const first = internals.newActiveSession(sessionToken, structuredClone(record), "stateful");
    const second = internals.newActiveSession(sessionToken, structuredClone(record), "stateful");
    internals.activeSessions.set("first-mcp-session", first);
    internals.activeSessions.set("second-mcp-session", second);

    await Promise.all([
      internals.subscribe(first, "owner/repo", 7),
      internals.subscribe(second, "owner/repo", 8),
    ]);

    await expect(storage.get<SessionRecord>(sessionStorageKey(sessionToken))).resolves.toMatchObject({
      subscriptions: [firstKey, secondKey],
    });
    expect([...first.subscriptions].sort()).toEqual([firstKey, secondKey]);
    expect([...second.subscriptions].sort()).toEqual([firstKey, secondKey]);
  });

  it("does not rewrite an unchanged subscription", async () => {
    const { hub, storage } = hubFixture();
    const sessionToken = "idempotent-subscription-token";
    const key = "owner/repo#7";
    const record = sessionRecord({ watches: [key], subscriptions: [key] });
    await storage.put(sessionStorageKey(sessionToken), record);
    storage.putKeys.length = 0;
    const internals = hub as unknown as HubSessionInternals;
    const active = internals.newActiveSession(sessionToken, structuredClone(record), "stateful");
    internals.activeSessions.set("idempotent-mcp-session", active);

    await internals.subscribe(active, "owner/repo", 7);

    expect(storage.putKeys).toEqual([]);
    expect([...active.subscriptions]).toEqual([key]);
  });

  it("does not invalidate credentials rotated after an unauthorized request started", async () => {
    const { hub, storage } = hubFixture();
    const sessionToken = "rotated-session-token";
    const rotated = sessionRecord({ githubAccessToken: "rotated-github-token" });
    await storage.put(sessionStorageKey(sessionToken), rotated);
    const internals = hub as unknown as HubSessionInternals;

    await internals.invalidateSession(sessionToken, "stale-github-token");

    await expect(storage.get<SessionRecord>(sessionStorageKey(sessionToken))).resolves.toEqual(rotated);
  });

  it.each(["missing", "expired"] as const)("closes server and transport before removing a %s active bearer", async (state) => {
    const { hub, storage } = hubFixture();
    const sessionToken = `${state}-session-token`;
    if (state === "expired") {
      await storage.put(sessionStorageKey(sessionToken), sessionRecord({ expiresAt: Date.now() - 1 }));
    }
    const internals = hub as unknown as HubSessionInternals;
    const serverClose = vi.fn(async () => {
      expect(internals.activeSessions.has("active-mcp-session")).toBe(true);
    });
    const transportClose = vi.fn(async () => {
      expect(internals.activeSessions.has("active-mcp-session")).toBe(true);
    });
    const active: TestActiveSession = {
      token: sessionToken,
      record: sessionRecord(),
      kind: "stateful",
      watches: new Set(),
      subscriptions: new Set(),
      server: { close: serverClose },
      transport: { close: transportClose },
    };
    internals.activeSessions.set("active-mcp-session", active);

    await expect(internals.sessionForToken(sessionToken)).resolves.toBeNull();

    expect(serverClose).toHaveBeenCalledOnce();
    expect(transportClose).toHaveBeenCalledOnce();
    expect(internals.activeSessions.has("active-mcp-session")).toBe(false);
  });

  it("replaces a recovered GET stream and catches up persisted subscriptions", async () => {
    const { hub, storage } = hubFixture();
    const sessionToken = "catch-up-session-token";
    const mcpSessionId = "catch-up-mcp-session";
    const key = "owner/repo#7";
    await storage.put(sessionStorageKey(sessionToken), sessionRecord({ watches: [key], subscriptions: [key] }));
    const headers = {
      authorization: `Bearer ${sessionToken}`,
      accept: "text/event-stream",
      "mcp-session-id": mcpSessionId,
      "mcp-protocol-version": "2025-06-18",
    };

    const original = await hub.fetch(new Request("https://watch-pr.vza.net/mcp", { headers }));
    const originalReader = original.body!.getReader();
    const originalCatchUp = await originalReader.read();
    expect(new TextDecoder().decode(originalCatchUp.value)).toContain(
      `"method":"notifications/resources/updated","params":{"uri":"watch-pr://owner/repo/pull/7"}`,
    );

    const replacement = await hub.fetch(new Request("https://watch-pr.vza.net/mcp", { headers }));
    expect(replacement.status).toBe(200);
    await expect(originalReader.read()).resolves.toMatchObject({ done: true });
    const replacementCatchUp = await replacement.body!.getReader().read();
    expect(new TextDecoder().decode(replacementCatchUp.value)).toContain("watch-pr://owner/repo/pull/7");
    await hub.fetch(new Request("https://watch-pr.vza.net/mcp", { method: "DELETE", headers }));
  });

  it("handles a recovered POST with the live stream's ActiveSession context", async () => {
    const { hub, storage } = hubFixture();
    const sessionToken = "recovered-post-token";
    const mcpSessionId = "recovered-post-session";
    const key = "owner/repo#7";
    await storage.put(sessionStorageKey(sessionToken), sessionRecord({ watches: [key], subscriptions: [] }));
    const streamHeaders = {
      authorization: `Bearer ${sessionToken}`,
      accept: "text/event-stream",
      "mcp-session-id": mcpSessionId,
      "mcp-protocol-version": "2025-06-18",
    };
    const stream = await hub.fetch(new Request("https://watch-pr.vza.net/mcp", { headers: streamHeaders }));
    expect(stream.status).toBe(200);

    const post = await hub.fetch(new Request("https://watch-pr.vza.net/mcp", {
      method: "POST",
      headers: {
        ...streamHeaders,
        accept: "application/json, text/event-stream",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "resources/subscribe",
        params: { uri: "watch-pr://owner/repo/pull/7" },
      }),
    }));

    expect(post.status).toBe(200);
    await expect(storage.get<SessionRecord>(sessionStorageKey(sessionToken))).resolves.toMatchObject({
      subscriptions: [key],
    });
    const active = (hub as unknown as HubSessionInternals).activeSessions.get(mcpSessionId);
    expect(active?.subscriptions.has(key)).toBe(true);
    await hub.fetch(new Request("https://watch-pr.vza.net/mcp", { method: "DELETE", headers: streamHeaders }));
  });

  it("does not recover an MCP session after DELETE closes its recovered stream", async () => {
    const { hub, storage, restart } = hubFixture();
    const sessionToken = "delete-session-token";
    const mcpSessionId = "recovered-mcp-session";
    await storage.put(sessionStorageKey(sessionToken), sessionRecord());
    const headers = {
      authorization: `Bearer ${sessionToken}`,
      accept: "text/event-stream",
      "mcp-session-id": mcpSessionId,
      "mcp-protocol-version": "2025-06-18",
    };
    const recovered = await hub.fetch(new Request("https://watch-pr.vza.net/mcp", { headers }));
    expect(recovered.status).toBe(200);

    const deleted = await hub.fetch(new Request("https://watch-pr.vza.net/mcp", { method: "DELETE", headers }));
    expect(deleted.status).toBe(200);

    const replay = await restart().fetch(new Request("https://watch-pr.vza.net/mcp", { headers }));
    expect(replay.status).toBe(404);
  });
});

describe("watch state sidecar storage", () => {
  const storageKey = watchStorageKey(42, "owner/repo", 7);

  function predecessorState(count: number, payloadSize: number): StoredWatchState {
    return {
      snapshot: null,
      events: Array.from({ length: count }, (_, index) => watchEvent(index, "x".repeat(payloadSize))),
    };
  }

  it("projects predecessor compact and chunked state while no sidecar exists", async () => {
    const storage = new MemoryStorage();
    const compact = predecessorState(2, 10);
    await writeStoredWatchState(storage as unknown as WatchStorage, storageKey, compact);
    await expect(readStoredWatchState(storage as unknown as WatchStorage, storageKey)).resolves.toEqual(compact);
    const compactMetadata = await readWatchStateMetadata(storage as unknown as WatchStorage, storageKey);
    expect(compactMetadata.events.map((entry) => entry.id)).toEqual(["event-0", "event-1"]);
    expect(compactMetadata.events[0]).not.toHaveProperty("payload");

    const chunked = predecessorState(100, 23_000);
    await writeStoredWatchState(storage as unknown as WatchStorage, storageKey, chunked);
    await expect(readStoredWatchState(storage as unknown as WatchStorage, storageKey)).resolves.toEqual(chunked);
    const chunkedMetadata = await readWatchStateMetadata(storage as unknown as WatchStorage, storageKey);
    expect(chunkedMetadata.snapshot).toBeNull();
    expect(chunkedMetadata.events).toHaveLength(100);
    expect(storage.putKeys.filter((key) => key.includes(":sidecar"))).toEqual([]);
  });

  it("indexes predecessor events on the first append instead of copying their payloads", async () => {
    const storage = new MemoryStorage();
    const predecessor = predecessorState(100, 23_000);
    await writeStoredWatchState(storage as unknown as WatchStorage, storageKey, predecessor);
    const rootRecord = await storage.get(storageKey);
    storage.putKeys.length = 0;
    storage.deleteKeys.length = 0;

    const mutation = await openWatchStateMutation(storage as unknown as WatchStorage, storageKey);
    expect(mutation.metadata.events).toHaveLength(100);
    const appended = watchEvent(100, { appended: true });
    const write = await mutation.append(appended, null);

    expect(write).toMatchObject({ puts: 3, deletes: 0, windowEvents: 100, rootReferences: 99 });
    expect(storage.putKeys).toEqual([
      watchSidecarEventKey(storageKey, 0),
      watchSidecarSnapshotKey(storageKey, 0),
      watchSidecarIndexKey(storageKey),
    ]);
    expect(storage.deleteKeys).toEqual([]);
    // The predecessor record and every chunk it owns stay exactly as they were.
    await expect(storage.get(storageKey)).resolves.toEqual(rootRecord);

    const hydrated = await readStoredWatchState(storage as unknown as WatchStorage, storageKey);
    expect(hydrated.events).toHaveLength(100);
    expect(hydrated.events.slice(0, 99)).toEqual(predecessor.events.slice(1));
    expect(hydrated.events.at(-1)).toEqual(appended);
  });

  it("hydrates predecessor snapshots that predate head repository persistence", async () => {
    const storage = new MemoryStorage();
    const { headRepository: _headRepository, ...legacySnapshot } = pullRequestSnapshot(
      "legacy snapshot",
      "2026-09-12T00:00:00.000Z",
    );
    const migratedSnapshot = { ...legacySnapshot, headRepository: null };
    const legacyEvent = { ...watchEvent(0, { legacy: true }), snapshot: legacySnapshot };
    await writeStoredWatchState(
      storage as unknown as WatchStorage,
      storageKey,
      { snapshot: legacySnapshot, events: [legacyEvent] } as StoredWatchState,
    );

    const mutation = await openWatchStateMutation(storage as unknown as WatchStorage, storageKey);
    await mutation.append(
      { ...watchEvent(1, { appended: true }), snapshot: legacySnapshot } as WatchEvent,
      legacySnapshot as PullRequestSnapshot,
    );

    await expect(readWatchStateMetadata(storage as unknown as WatchStorage, storageKey)).resolves.toMatchObject({
      snapshot: migratedSnapshot,
      events: [{ id: "event-0" }, { id: "event-1" }],
    });
    await expect(readStoredWatchState(storage as unknown as WatchStorage, storageKey)).resolves.toMatchObject({
      snapshot: migratedSnapshot,
      events: [
        { id: "event-0", snapshot: null },
        { id: "event-1", snapshot: migratedSnapshot },
      ],
    });
  });

  it("keeps steady append writes bounded regardless of stored payload size", async () => {
    const large = new MemoryStorage();
    const small = new MemoryStorage();
    await writeStoredWatchState(large as unknown as WatchStorage, storageKey, predecessorState(100, 23_000));
    await writeStoredWatchState(small as unknown as WatchStorage, storageKey, predecessorState(100, 10));

    const writes: number[][] = [];
    for (const storage of [large, small]) {
      const perAppend: number[] = [];
      for (let index = 0; index < 4; index += 1) {
        const mutation = await openWatchStateMutation(storage as unknown as WatchStorage, storageKey);
        const write = await mutation.append(watchEvent(100 + index, { appended: index }), null);
        perAppend.push(write.puts + write.deletes);
      }
      writes.push(perAppend);
    }

    expect(writes[0]).toEqual(writes[1]);
    expect(Math.max(...writes[0]!)).toBeLessThanOrEqual(4);
    await expect(readStoredWatchState(large as unknown as WatchStorage, storageKey)).resolves.toMatchObject({
      events: expect.arrayContaining([expect.objectContaining({ id: "event-103" })]),
    });
  });

  it("retires an evicted compact payload in the appending transaction", async () => {
    const storage = new MemoryStorage();
    for (let index = 0; index < 100; index += 1) {
      const mutation = await openWatchStateMutation(storage as unknown as WatchStorage, storageKey);
      await mutation.append(watchEvent(index, { sequence: index }), null);
    }

    await expect(storage.get(watchSidecarEventKey(storageKey, 0))).resolves.toMatchObject({ id: "event-0" });
    storage.deleteKeys.length = 0;
    const mutation = await openWatchStateMutation(storage as unknown as WatchStorage, storageKey);
    await mutation.append(watchEvent(100, { sequence: 100 }), null);

    expect(storage.deleteKeys).toEqual([watchSidecarEventKey(storageKey, 0)]);
    await expect(storage.get(watchSidecarEventKey(storageKey, 0))).resolves.toBeUndefined();
    await expect(storage.get(watchSidecarCleanupKey(storageKey, 0))).resolves.toBeUndefined();

    const hydrated = await readStoredWatchState(storage as unknown as WatchStorage, storageKey);
    expect(hydrated.events).toHaveLength(100);
    expect(hydrated.events[0]).toMatchObject({ id: "event-1", payload: { sequence: 1 } });
    expect(hydrated.events.at(-1)).toMatchObject({ id: "event-100", payload: { sequence: 100 } });
  });

  it("retires compact snapshot and event records without cleanup rows", async () => {
    const storage = new MemoryStorage();
    for (let index = 0; index < 120; index += 1) {
      const mutation = await openWatchStateMutation(storage as unknown as WatchStorage, storageKey);
      await mutation.append(
        watchEvent(index, { sequence: index }),
        pullRequestSnapshot(`snapshot-${index}`, new Date(index).toISOString()),
      );
    }

    const cleanupRows = await storage.list({ prefix: `${storageKey}:sidecar:cleanup:` });
    expect(cleanupRows.size).toBe(0);
    await expect(readStoredWatchState(storage as unknown as WatchStorage, storageKey)).resolves.toMatchObject({
      snapshot: { body: "snapshot-119" },
    });
  });

  it("drains repeated large event and snapshot retirements at the incoming write rate", async () => {
    const storage = new MemoryStorage();
    const eventPayload = "event".repeat(25_000);
    const snapshotBody = "snapshot".repeat(20_000);
    for (let index = 0; index < 102; index += 1) {
      const mutation = await openWatchStateMutation(storage as unknown as WatchStorage, storageKey);
      await mutation.append(
        watchEvent(index, eventPayload),
        pullRequestSnapshot(snapshotBody, new Date(index).toISOString()),
      );
    }

    const cleanupRows = await storage.list({ prefix: `${storageKey}:sidecar:cleanup:` });
    // Four partially retired records cover the two snapshot/event replacements in flight.
    expect(cleanupRows.size).toBe(4);
  });

  it("limits predecessor retirement to a fixed cleanup batch", async () => {
    const storage = new MemoryStorage();
    await writeStoredWatchState(
      storage as unknown as WatchStorage,
      storageKey,
      predecessorState(100, 23_000),
    );
    for (let index = 0; index < 100; index += 1) {
      const mutation = await openWatchStateMutation(storage as unknown as WatchStorage, storageKey);
      await mutation.append(watchEvent(100 + index, { replacement: index }), null);
    }
    await expect(storage.get(watchSidecarCleanupKey(storageKey, 0))).resolves.toMatchObject({
      recordKey: storageKey,
    });
    storage.deleteKeys.length = 0;

    const mutation = await openWatchStateMutation(storage as unknown as WatchStorage, storageKey);
    const write = await mutation.append(watchEvent(200, "replacement".repeat(16_000)), null);

    const predecessorDeletes = storage.deleteKeys.filter(
      (key) => key === storageKey || key.startsWith(`${storageKey}:chunk:`),
    );
    expect(predecessorDeletes).toHaveLength(8);
    expect(write.deletes).toBe(10);
    await expect(storage.get(watchSidecarCleanupKey(storageKey, 1))).resolves.toMatchObject({ nextRow: 8 });
  });

  it("retires replaced snapshots without deleting the current snapshot chunks", async () => {
    const storage = new MemoryStorage();
    const initial = pullRequestSnapshot("x".repeat(80_000), "2026-09-13T00:00:00.000Z");
    const replacement = pullRequestSnapshot("replacement", "2026-09-13T00:01:00.000Z");

    const first = await openWatchStateMutation(storage as unknown as WatchStorage, storageKey);
    await first.append(watchEvent(0, { stored: true }), initial);
    const second = await openWatchStateMutation(storage as unknown as WatchStorage, storageKey);
    await second.append(watchEvent(1, { stored: true }), replacement);

    await expect(readStoredWatchState(storage as unknown as WatchStorage, storageKey))
      .resolves.toMatchObject({ snapshot: replacement });
    await expect(storage.get(watchSidecarSnapshotKey(storageKey, 0))).resolves.toBeDefined();

    const third = await openWatchStateMutation(storage as unknown as WatchStorage, storageKey);
    await third.append(watchEvent(2, { stored: true }), replacement);

    await expect(storage.get(watchSidecarSnapshotKey(storageKey, 0))).resolves.toBeUndefined();
    await expect(readStoredWatchState(storage as unknown as WatchStorage, storageKey))
      .resolves.toMatchObject({ snapshot: replacement });
  });

  it("keeps a chunked retirement reachable when a snapshot is replaced without an event", async () => {
    const storage = new MemoryStorage();
    const chunked = pullRequestSnapshot("x".repeat(80_000), "2026-09-13T00:00:00.000Z");
    const learned = pullRequestSnapshot("learned", "2026-09-13T00:01:00.000Z");
    const first = await openWatchStateMutation(storage as unknown as WatchStorage, storageKey);
    await first.append(watchEvent(0, { stored: true }), chunked);
    const retiredKey = watchSidecarSnapshotKey(storageKey, 0);

    const silent = await openWatchStateMutation(storage as unknown as WatchStorage, storageKey);
    await silent.replaceSnapshot(learned);

    // The enqueued job is only reachable through the queue pointer the index carries.
    await expect(storage.get(watchSidecarCleanupKey(storageKey, 0))).resolves.toMatchObject({
      recordKey: retiredKey,
    });
    await expect(storage.get(watchSidecarIndexKey(storageKey))).resolves.toMatchObject({
      cleanup: { cursor: 0, next: 1 },
    });
    await expect(readStoredWatchState(storage as unknown as WatchStorage, storageKey))
      .resolves.toMatchObject({ snapshot: learned });

    for (let index = 1; index <= 4; index += 1) {
      const mutation = await openWatchStateMutation(storage as unknown as WatchStorage, storageKey);
      await mutation.append(watchEvent(index, { stored: true }), learned);
    }

    // Ordinary appends drain the queue, so the replaced snapshot's chunks are reclaimed.
    await expect(storage.list({ prefix: `${retiredKey}:chunk:` })).resolves.toMatchObject({ size: 0 });
    await expect(storage.list({ prefix: `${storageKey}:sidecar:cleanup:` })).resolves.toMatchObject({ size: 0 });
    await expect(storage.get(retiredKey)).resolves.toBeUndefined();
  });

  it("retires an event-less predecessor record when a snapshot is replaced without an event", async () => {
    const compactStorage = new MemoryStorage();
    const legacy = pullRequestSnapshot("legacy", "2026-09-13T00:00:00.000Z");
    const learned = pullRequestSnapshot("learned", "2026-09-13T00:01:00.000Z");
    // A record written before individual reactions existed: a snapshot and nothing else.
    await writeStoredWatchState(compactStorage as unknown as WatchStorage, storageKey, {
      snapshot: legacy,
      events: [],
    });

    const compact = await openWatchStateMutation(compactStorage as unknown as WatchStorage, storageKey);
    await compact.replaceSnapshot(learned);

    // Nothing references the predecessor once its snapshot moves into the sidecar.
    await expect(compactStorage.get(watchSidecarIndexKey(storageKey))).resolves.toMatchObject({
      root: null,
      events: [],
    });
    await expect(compactStorage.get(storageKey)).resolves.toBeUndefined();
    await expect(readWatchStateMetadata(compactStorage as unknown as WatchStorage, storageKey))
      .resolves.toMatchObject({ snapshot: learned, events: [] });
    await expect(readStoredWatchState(compactStorage as unknown as WatchStorage, storageKey))
      .resolves.toMatchObject({ snapshot: learned, events: [] });

    const chunkedStorage = new MemoryStorage();
    await writeStoredWatchState(chunkedStorage as unknown as WatchStorage, storageKey, {
      snapshot: pullRequestSnapshot("x".repeat(80_000), "2026-09-13T00:00:00.000Z"),
      events: [],
    });
    const chunked = await openWatchStateMutation(chunkedStorage as unknown as WatchStorage, storageKey);
    await chunked.replaceSnapshot(learned);

    // A chunked predecessor goes through the deferred queue, with the pointer in the index.
    await expect(chunkedStorage.get(watchSidecarCleanupKey(storageKey, 0))).resolves.toMatchObject({
      recordKey: storageKey,
    });
    await expect(chunkedStorage.get(watchSidecarIndexKey(storageKey))).resolves.toMatchObject({
      root: null,
      cleanup: { cursor: 0, next: 1 },
    });
    await expect(readStoredWatchState(chunkedStorage as unknown as WatchStorage, storageKey))
      .resolves.toMatchObject({ snapshot: learned, events: [] });

    for (let index = 0; index < 4; index += 1) {
      const mutation = await openWatchStateMutation(chunkedStorage as unknown as WatchStorage, storageKey);
      await mutation.append(watchEvent(index, { stored: true }), learned);
    }
    await expect(chunkedStorage.list({ prefix: `${storageKey}:chunk:` })).resolves.toMatchObject({ size: 0 });
    await expect(chunkedStorage.get(storageKey)).resolves.toBeUndefined();
  });

  it("fails closed for a present but unreadable sidecar index", async () => {
    const storage = new MemoryStorage();
    const mutation = await openWatchStateMutation(storage as unknown as WatchStorage, storageKey);
    await mutation.append(watchEvent(0, { stored: true }), null);
    await storage.put(watchSidecarIndexKey(storageKey), { version: 999 });

    await expect(readWatchStateMetadata(storage as unknown as WatchStorage, storageKey))
      .rejects.toThrow("watch sidecar storage is corrupt");
    await expect(openWatchStateMutation(storage as unknown as WatchStorage, storageKey))
      .rejects.toThrow("watch sidecar storage is corrupt");
  });

  it("fails closed for missing or malformed sidecar snapshots and payloads", async () => {
    const snapshotStorage = new MemoryStorage();
    const snapshotMutation = await openWatchStateMutation(snapshotStorage as unknown as WatchStorage, storageKey);
    await snapshotMutation.append(watchEvent(0, { stored: true }), null);
    await snapshotStorage.delete(watchSidecarSnapshotKey(storageKey, 0));

    await expect(readWatchStateMetadata(snapshotStorage as unknown as WatchStorage, storageKey))
      .rejects.toThrow("watch sidecar storage is corrupt");
    await expect(openWatchStateMutation(snapshotStorage as unknown as WatchStorage, storageKey))
      .rejects.toThrow("watch sidecar storage is corrupt");

    const malformedSnapshotStorage = new MemoryStorage();
    const malformedSnapshotMutation = await openWatchStateMutation(
      malformedSnapshotStorage as unknown as WatchStorage,
      storageKey,
    );
    await malformedSnapshotMutation.append(watchEvent(0, { stored: true }), null);
    await malformedSnapshotStorage.put(watchSidecarSnapshotKey(storageKey, 0), { snapshot: [] });

    await expect(readWatchStateMetadata(malformedSnapshotStorage as unknown as WatchStorage, storageKey))
      .rejects.toThrow("watch sidecar storage is corrupt");

    const nestedSnapshotStorage = new MemoryStorage();
    const nestedSnapshot = pullRequestSnapshot("valid", "2026-09-13T00:00:00.000Z");
    const nestedSnapshotMutation = await openWatchStateMutation(
      nestedSnapshotStorage as unknown as WatchStorage,
      storageKey,
    );
    await nestedSnapshotMutation.append(watchEvent(0, { stored: true }), nestedSnapshot);
    await nestedSnapshotStorage.put(watchSidecarSnapshotKey(storageKey, 0), {
      snapshot: { ...nestedSnapshot, comments: [null] },
    });

    await expect(readWatchStateMetadata(nestedSnapshotStorage as unknown as WatchStorage, storageKey))
      .rejects.toThrow("watch sidecar storage is corrupt");

    const protectedTargetStorage = new MemoryStorage();
    const firstProtectedSnapshot = pullRequestSnapshot("first".repeat(20_000), "2026-09-13T00:00:00.000Z");
    const currentProtectedSnapshot = pullRequestSnapshot("current", "2026-09-13T00:01:00.000Z");
    const firstProtectedMutation = await openWatchStateMutation(
      protectedTargetStorage as unknown as WatchStorage,
      storageKey,
    );
    await firstProtectedMutation.append(watchEvent(0, { stored: true }), firstProtectedSnapshot);
    const secondProtectedMutation = await openWatchStateMutation(
      protectedTargetStorage as unknown as WatchStorage,
      storageKey,
    );
    await secondProtectedMutation.append(watchEvent(1, { stored: true }), currentProtectedSnapshot);
    await protectedTargetStorage.put(watchSidecarCleanupKey(storageKey, 0), {
      recordKey: watchSidecarSnapshotKey(storageKey, 1),
      chunkCount: 0,
      nextRow: 0,
    });

    const protectedTargetMutation = await openWatchStateMutation(
      protectedTargetStorage as unknown as WatchStorage,
      storageKey,
    );
    await expect(protectedTargetMutation.append(watchEvent(2, { stored: true }), currentProtectedSnapshot))
      .rejects.toThrow("watch sidecar storage is corrupt");

    const unrelatedTargetStorage = new MemoryStorage();
    const firstUnrelatedMutation = await openWatchStateMutation(
      unrelatedTargetStorage as unknown as WatchStorage,
      storageKey,
    );
    await firstUnrelatedMutation.append(watchEvent(0, { stored: true }), firstProtectedSnapshot);
    const secondUnrelatedMutation = await openWatchStateMutation(
      unrelatedTargetStorage as unknown as WatchStorage,
      storageKey,
    );
    await secondUnrelatedMutation.append(watchEvent(1, { stored: true }), currentProtectedSnapshot);
    const unrelatedKey = sessionStorageKey("unrelated");
    await unrelatedTargetStorage.put(unrelatedKey, { preserved: true });
    await unrelatedTargetStorage.put(watchSidecarCleanupKey(storageKey, 0), {
      recordKey: unrelatedKey,
      chunkCount: 0,
      nextRow: 0,
    });

    const unrelatedTargetMutation = await openWatchStateMutation(
      unrelatedTargetStorage as unknown as WatchStorage,
      storageKey,
    );
    await expect(unrelatedTargetMutation.append(watchEvent(2, { stored: true }), currentProtectedSnapshot))
      .rejects.toThrow("watch sidecar storage is corrupt");
    await expect(unrelatedTargetStorage.get(unrelatedKey)).resolves.toEqual({ preserved: true });

    const payloadStorage = new MemoryStorage();
    const payloadMutation = await openWatchStateMutation(payloadStorage as unknown as WatchStorage, storageKey);
    await payloadMutation.append(watchEvent(0, { stored: true }), null);
    await payloadStorage.delete(watchSidecarEventKey(storageKey, 0));

    await expect(readStoredWatchState(payloadStorage as unknown as WatchStorage, storageKey))
      .rejects.toThrow("watch sidecar storage is corrupt");

    const chunkedPayloadStorage = new MemoryStorage();
    const chunkedPayloadMutation = await openWatchStateMutation(
      chunkedPayloadStorage as unknown as WatchStorage,
      storageKey,
    );
    await chunkedPayloadMutation.append(watchEvent(0, "x".repeat(80_000)), null);
    await chunkedPayloadStorage.put(watchSidecarEventKey(storageKey, 0), { chunkCount: 1 });

    await expect(readStoredWatchState(chunkedPayloadStorage as unknown as WatchStorage, storageKey))
      .rejects.toThrow("watch sidecar storage is corrupt");

    const summaryOnlyStorage = new MemoryStorage();
    const summaryOnlyEvent = watchEvent(0, { stored: true });
    const summaryOnlyMutation = await openWatchStateMutation(summaryOnlyStorage as unknown as WatchStorage, storageKey);
    await summaryOnlyMutation.append(summaryOnlyEvent, null);
    const { payload: _payload, snapshot: _snapshot, ...summaryOnlyRecord } = summaryOnlyEvent;
    await summaryOnlyStorage.put(watchSidecarEventKey(storageKey, 0), summaryOnlyRecord);

    await expect(readStoredWatchState(summaryOnlyStorage as unknown as WatchStorage, storageKey))
      .rejects.toThrow("watch sidecar storage is corrupt");

    const rootStorage = new MemoryStorage();
    await writeStoredWatchState(rootStorage as unknown as WatchStorage, storageKey, predecessorState(1, 10));
    const rootMutation = await openWatchStateMutation(rootStorage as unknown as WatchStorage, storageKey);
    await rootMutation.append(watchEvent(1, { stored: true }), null);
    await rootStorage.delete(storageKey);

    await expect(readStoredWatchState(rootStorage as unknown as WatchStorage, storageKey))
      .rejects.toThrow("watch sidecar storage is corrupt");
  });

  it("reads snapshot and event metadata without touching payload rows", async () => {
    const storage = new MemoryStorage();
    await writeStoredWatchState(storage as unknown as WatchStorage, storageKey, predecessorState(100, 23_000));
    const mutation = await openWatchStateMutation(storage as unknown as WatchStorage, storageKey);
    await mutation.append(watchEvent(100, { appended: true }), null);
    storage.getKeys.length = 0;

    const metadata = await readWatchStateMetadata(storage as unknown as WatchStorage, storageKey);
    expect(metadata.events).toHaveLength(100);
    expect(metadata.events.at(-1)).toMatchObject({ id: "event-100", terminalState: "watching" });
    expect(storage.getKeys).toEqual([
      watchSidecarIndexKey(storageKey),
      watchSidecarSnapshotKey(storageKey, 0),
    ]);
  });
});
