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

function hubFixture(): { hub: WatchPrHub; storage: MemoryStorage; pending: Promise<unknown>[] } {
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
  return { hub: new WatchPrHub(state, env), storage, pending };
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

  it("invalidates the bearer session when GitHub refresh is unauthorized", async () => {
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
});
