import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { constantTimeEqual, parseBearerToken, randomToken, sha256Base64Url, verifyGithubSignature } from "./crypto";
import { createWatchEvent, eventPullRequestNumbers, isSupportedGithubEvent, parseWatchKey, resourceUri, snapshotChanges, watchKey } from "./events";
import { exchangeGithubCode, githubUser, pullRequestSnapshot, refreshGithubToken } from "./github";
import { createMcpServer, type McpSessionContext, type WatchRegistration } from "./mcp";
import type { GithubUser, OAuthClientRecord, OAuthCodeRecord, OAuthRequestRecord, SessionRecord, StoredWatchState, WatchEvent } from "./types";
import { sessionStorageKey, watchStorageKey } from "./types";

export interface Env {
  HUB: DurableObjectNamespace;
  GITHUB_CLIENT_ID: string;
  GITHUB_CLIENT_SECRET: string;
  GITHUB_WEBHOOK_SECRET: string;
  PUBLIC_BASE_URL: string;
  SESSION_TTL_SECONDS?: string;
}

interface ActiveSession {
  token: string;
  record: SessionRecord;
  watches: Set<string>;
  subscriptions: Set<string>;
  transport?: WebStandardStreamableHTTPServerTransport;
  server?: McpServer;
  sessionId?: string;
}
const SESSION_TTL_SECONDS = 30 * 24 * 60 * 60;
const OAUTH_TTL_SECONDS = 10 * 60;
const MAX_EVENTS = 100;

export class WatchPrHub {
  private readonly activeSessions = new Map<string, ActiveSession>();
  private readonly refreshes = new Set<string>();

  constructor(
    private readonly state: DurableObjectState,
    private readonly env: Env,
  ) {}

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/mcp") return this.handleMcp(request);
    if (url.pathname === "/oauth/register") return this.handleOAuthRegister(request);
    if (url.pathname === "/oauth/authorize") return this.handleOAuthAuthorize(request);
    if (url.pathname === "/oauth/callback") return this.handleOAuthCallback(request);
    if (url.pathname === "/oauth/token") return this.handleOAuthToken(request);
    if (url.pathname === "/internal/poll") return this.handlePoll(request);
    return new Response("Not found", { status: 404 });
  }

  private async handleMcp(request: Request): Promise<Response> {
    const bearer = parseBearerToken(request);
    if (!bearer) return this.unauthorized(request);
    const session = await this.sessionForToken(bearer);
    if (!session) return this.unauthorized(request);

    const sessionId = request.headers.get("mcp-session-id");
    if (sessionId) {
      const existing = this.activeSessions.get(sessionId);
      if (!existing || existing.token !== bearer || !existing.transport) {
        return new Response(JSON.stringify({ error: "MCP session not found" }), {
          status: 404,
          headers: { "content-type": "application/json" },
        });
      }
      existing.record = session.record;
      return existing.transport.handleRequest(request);
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

    const active: ActiveSession = {
      token: bearer,
      record: session.record,
      watches: new Set(session.record.watches),
      subscriptions: new Set(),
    };
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

  private mcpContext(active: ActiveSession): McpSessionContext {
    return {
      user: active.record.user,
      watches: active.watches,
      watch: async (repository, number) => this.watch(active, repository, number),
      unwatch: async (repository, number) => this.unwatch(active, repository, number),
      listWatches: async () => this.listWatches(active),
      readWatch: async (repository, number) => this.readWatch(active, repository, number),
      subscribe: async (repository, number) => this.subscribe(active, repository, number),
      unsubscribe: async (repository, number) => this.unsubscribe(active, repository, number),
    };
  }

  private async watch(active: ActiveSession, repository: string, number: number): Promise<WatchRegistration> {
    const key = watchKey(repository, number);
    active.watches.add(key);
    await this.persistSession(active);
    const state = await this.watchState(key);
    this.scheduleRefresh(key, active.record.githubAccessToken, "watch");
    return {
      key,
      repository: parseWatchKey(key).repository,
      number,
      resourceUri: resourceUri(repository, number),
      snapshot: state.snapshot,
      refreshScheduled: true,
    };
  }

  private async unwatch(active: ActiveSession, repository: string, number: number): Promise<boolean> {
    const key = watchKey(repository, number);
    const removed = active.watches.delete(key);
    active.subscriptions.delete(key);
    if (removed) await this.persistSession(active);
    return removed;
  }

  private async listWatches(active: ActiveSession): Promise<WatchRegistration[]> {
    const registrations: WatchRegistration[] = [];
    for (const key of [...active.watches].sort()) {
      const parsed = parseWatchKey(key);
      const state = await this.watchState(key);
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
    const state = await this.watchState(key);
    if (!state.snapshot) this.scheduleRefresh(key, active.record.githubAccessToken, "read");
    return state;
  }

  private async subscribe(active: ActiveSession, repository: string, number: number): Promise<void> {
    const key = watchKey(repository, number);
    if (!active.watches.has(key)) throw new Error("watch the pull request before subscribing to its resource");
    active.subscriptions.add(key);
  }

  private async unsubscribe(active: ActiveSession, repository: string, number: number): Promise<void> {
    active.subscriptions.delete(watchKey(repository, number));
  }

  private async persistSession(active: ActiveSession): Promise<void> {
    active.record.watches = [...active.watches].sort();
    await this.state.storage.put(sessionStorageKey(active.token), active.record);
  }

  private async sessionForToken(token: string): Promise<{ token: string; record: SessionRecord } | null> {
    const record = await this.state.storage.get<SessionRecord>(sessionStorageKey(token));
    if (!record) return null;
    const now = Date.now();
    if (record.expiresAt <= now || (record.githubRefreshTokenExpiresAt && record.githubRefreshTokenExpiresAt <= now)) {
      await this.state.storage.delete(sessionStorageKey(token));
      return null;
    }

    if (record.githubTokenExpiresAt && record.githubTokenExpiresAt <= now + 60_000 && record.githubRefreshToken) {
      try {
        const refreshed = await refreshGithubToken(this.env.GITHUB_CLIENT_ID, this.env.GITHUB_CLIENT_SECRET, record.githubRefreshToken);
        record.githubAccessToken = refreshed.accessToken;
        record.githubRefreshToken = refreshed.refreshToken ?? record.githubRefreshToken;
        record.githubTokenExpiresAt = refreshed.expiresIn ? now + refreshed.expiresIn * 1000 : undefined;
        record.githubRefreshTokenExpiresAt = refreshed.refreshTokenExpiresIn
          ? now + refreshed.refreshTokenExpiresIn * 1000
          : record.githubRefreshTokenExpiresAt;
        await this.state.storage.put(sessionStorageKey(token), record);
      } catch {
        if (record.githubTokenExpiresAt && record.githubTokenExpiresAt <= now) return null;
      }
    }
    return { token, record };
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

  private async processWebhook(eventName: string, deliveryId: string, payload: Record<string, unknown>): Promise<void> {
    const sessions = await this.sessionRecords();
    const keys = new Set<string>();
    const tokenByKey = new Map<string, string>();
    for (const [token, record] of sessions) {
      for (const key of record.watches) {
        keys.add(key);
        if (!tokenByKey.has(key)) tokenByKey.set(key, record.githubAccessToken);
      }
    }
    for (const active of this.activeSessions.values()) {
      for (const key of active.watches) {
        keys.add(key);
        if (!tokenByKey.has(key)) tokenByKey.set(key, active.record.githubAccessToken);
      }
    }

    const targetNumbers = eventPullRequestNumbers(eventName, payload, keys);
    const repository = repositoryFromPayload(payload);
    if (!repository) return;
    const targets = targetNumbers.map((number) => `${repository}#${number}`).filter((key) => keys.has(key));
    for (const key of [...new Set(targets)]) {
      const parsed = parseWatchKey(key);
      const previous = await this.watchState(key);
      let snapshot = previous.snapshot;
      const token = tokenByKey.get(key);
      if (token) {
        try {
          snapshot = await pullRequestSnapshot(token, parsed.repository, parsed.number);
        } catch {
          snapshot = previous.snapshot;
        }
      }
      const changes = snapshot && previous.snapshot ? snapshotChanges(previous.snapshot, snapshot) : snapshot ? ["initial_snapshot"] : [];
      const event = createWatchEvent({
        deliveryId,
        githubEvent: eventName,
        action: actionFromPayload(payload),
        repository: parsed.repository,
        pullRequestNumber: parsed.number,
        payload,
        snapshot,
        changes,
      });
      await this.publishEvent(key, event, { snapshot, events: previous.events });
    }
  }

  private scheduleRefresh(key: string, token: string, reason: string): void {
    if (this.refreshes.has(key)) return;
    this.refreshes.add(key);
    this.state.waitUntil(
      this.refreshAndPublish(key, token, reason).finally(() => {
        this.refreshes.delete(key);
      }),
    );
  }

  private async refreshAndPublish(key: string, token: string, reason: string): Promise<void> {
    const parsed = parseWatchKey(key);
    let snapshot;
    try {
      snapshot = await pullRequestSnapshot(token, parsed.repository, parsed.number);
    } catch {
      return;
    }
    const previous = await this.watchState(key);
    const changes = snapshotChanges(previous.snapshot, snapshot);
    if (previous.snapshot && changes.length === 0) return;
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
    await this.publishEvent(key, event, { snapshot, events: previous.events });
  }

  private async handlePoll(request: Request): Promise<Response> {
    if (request.method !== "POST") return new Response("Method not allowed", { status: 405 });
    const sessions = await this.sessionRecords();
    for (const record of sessions.values()) {
      for (const key of record.watches) this.scheduleRefresh(key, record.githubAccessToken, "poll");
    }
    return this.accepted({ accepted: true, scheduled: true });
  }

  private async publishEvent(key: string, event: WatchEvent, state: { snapshot: StoredWatchState["snapshot"]; events: WatchEvent[] }): Promise<void> {
    const events = [...state.events, event].slice(-MAX_EVENTS);
    await this.state.storage.put(watchStorageKey(event.repository, event.pullRequestNumber), {
      snapshot: state.snapshot,
      events,
    } satisfies StoredWatchState);
    const active = [...this.activeSessions.values()].filter((session) => session.watches.has(key));
    await Promise.all(active.map(async (session) => {
      if (!session.server) return;
      try {
        await session.server.server.sendResourceUpdated({ uri: event.resourceUri });
      } catch {
        // A client can close its SSE stream between webhook fanout and delivery.
      }
      try {
        await session.server.server.notification({
          method: "notifications/message",
          params: { level: "info", logger: "watch-pr", data: event },
        } as never);
      } catch {
        // Resource updates remain the interoperable push channel.
      }
    }));
  }

  private async watchState(key: string): Promise<StoredWatchState> {
    const parsed = parseWatchKey(key);
    return (await this.state.storage.get<StoredWatchState>(watchStorageKey(parsed.repository, parsed.number))) ?? {
      snapshot: null,
      events: [],
    };
  }

  private async sessionRecords(): Promise<Map<string, SessionRecord>> {
    const records = await this.state.storage.list<SessionRecord>({ prefix: "session:" });
    return new Map(records);
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
    };
    await this.state.storage.put(sessionStorageKey(sessionToken), session);
    return this.json({ access_token: sessionToken, token_type: "Bearer", expires_in: sessionTtl, scope: "watch-pr" }, 200, { "access-control-allow-origin": "*" });
  }

  private oauthRedirect(record: OAuthRequestRecord, values: Record<string, string>): Response {
    const redirect = new URL(record.redirectUri);
    for (const [key, value] of Object.entries(values)) redirect.searchParams.set(key, value);
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
