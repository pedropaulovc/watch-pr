import { describe, expect, it, vi } from "vitest";
import { sha256Base64Url } from "../src/crypto";
import { WatchPrHub, readStoredWatchState, type Env, type WatchStorage, writeStoredWatchState } from "../src/hub";
import type { OAuthCodeRecord, SessionRecord, StoredWatchState, WatchEvent } from "../src/types";
import { legacyWatchStorageKey, sessionStorageKey, watchStorageKey } from "../src/types";

class MemoryStorage {
  private readonly values = new Map<string, unknown>();
  readonly batchSizes: number[] = [];

  async get<T>(key: string | string[]): Promise<T | undefined | Map<string, T>> {
    if (Array.isArray(key)) {
      this.batchSizes.push(key.length);
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
    this.batchSizes.push(Object.keys(key).length);
    for (const [entry, entryValue] of Object.entries(key)) this.values.set(entry, entryValue);
  }

  async delete(key: string | string[]): Promise<boolean> {
    if (Array.isArray(key)) {
      this.batchSizes.push(key.length);
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
  invalidateSession(token: string, expectedGithubToken?: string): Promise<void>;
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

    const compact = { snapshot: null, events: [watchEvent(101, { compact: true })] };
    await writeStoredWatchState(storage as unknown as WatchStorage, storageKey, compact);
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
