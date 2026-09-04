import { describe, expect, it } from "vitest";
import { sha256Base64Url } from "../src/crypto";
import { WatchPrHub, type Env } from "../src/hub";
import type { OAuthCodeRecord, SessionRecord } from "../src/types";
import { sessionStorageKey } from "../src/types";

class MemoryStorage {
  private readonly values = new Map<string, unknown>();

  async get<T>(key: string): Promise<T | undefined> {
    return this.values.get(key) as T | undefined;
  }

  async put<T>(key: string, value: T): Promise<void> {
    this.values.set(key, value);
  }

  async delete(key: string): Promise<boolean> {
    return this.values.delete(key);
  }

  async list<T>(options: { prefix?: string } = {}): Promise<Map<string, T>> {
    return new Map([...this.values.entries()]
      .filter(([key]) => !options.prefix || key.startsWith(options.prefix))
      .map(([key, value]) => [key, value as T]));
  }
}

function hubFixture(): { hub: WatchPrHub; storage: MemoryStorage } {
  const storage = new MemoryStorage();
  const state = {
    storage,
    waitUntil(promise: Promise<unknown>) {
      void promise;
    },
  } as unknown as DurableObjectState;
  const env: Env = {
    HUB: {} as DurableObjectNamespace,
    GITHUB_CLIENT_ID: "github-client-id",
    GITHUB_CLIENT_SECRET: "github-client-secret",
    GITHUB_WEBHOOK_SECRET: "webhook-secret",
    PUBLIC_BASE_URL: "https://watch-pr.vza.net",
  };
  return { hub: new WatchPrHub(state, env), storage };
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
});
