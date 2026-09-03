import { WatchPrHub, type Env } from "./hub";

const MCP_PATH = "/mcp";
const WEBHOOK_PATH = "/webhooks/github";
const OAUTH_PATHS = new Set(["/oauth/register", "/oauth/authorize", "/oauth/callback", "/oauth/token"]);

function baseUrl(request: Request, env: Env): string {
  return (env.PUBLIC_BASE_URL || new URL(request.url).origin).replace(/\/+$/u, "");
}

function corsHeaders(request: Request): Headers {
  const headers = new Headers();
  headers.set("access-control-allow-origin", request.headers.get("origin") ?? "*");
  headers.set("access-control-allow-methods", "GET,POST,DELETE,OPTIONS");
  headers.set("access-control-allow-headers", "authorization,content-type,mcp-session-id,mcp-protocol-version,last-event-id");
  headers.set("access-control-expose-headers", "mcp-session-id,mcp-protocol-version,last-event-id");
  headers.set("access-control-max-age", "86400");
  return headers;
}

function addCors(response: Response, request: Request): Response {
  const headers = new Headers(response.headers);
  for (const [name, value] of corsHeaders(request)) headers.set(name, value);
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
}

function oauthProtectedResource(request: Request, env: Env): Response {
  const origin = baseUrl(request, env);
  return json({
    resource: `${origin}${MCP_PATH}`,
    authorization_servers: [origin],
    scopes_supported: ["watch-pr"],
  });
}

function oauthAuthorizationServer(request: Request, env: Env): Response {
  const origin = baseUrl(request, env);
  return json({
    issuer: origin,
    authorization_endpoint: `${origin}/oauth/authorize`,
    registration_endpoint: `${origin}/oauth/register`,
    token_endpoint: `${origin}/oauth/token`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none"],
    scopes_supported: ["watch-pr"],
  });
}

async function dispatch(request: Request, env: Env): Promise<Response> {
  const id = env.HUB.idFromName("global");
  return env.HUB.get(id).fetch(request);
}

const worker = {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders(request) });
    if (url.pathname === "/health") return addCors(json({ status: "ok", service: "watch-pr", protocol: "mcp", mcp: MCP_PATH }), request);
    if (url.pathname === "/") {
      return addCors(json({
        service: "watch-pr",
        mcp: `${baseUrl(request, env)}${MCP_PATH}`,
        webhook: `${baseUrl(request, env)}${WEBHOOK_PATH}`,
        oauth: `${baseUrl(request, env)}/.well-known/oauth-authorization-server`,
      }), request);
    }
    if (url.pathname === "/.well-known/oauth-protected-resource") return addCors(oauthProtectedResource(request, env), request);
    if (url.pathname === "/.well-known/oauth-authorization-server") return addCors(oauthAuthorizationServer(request, env), request);
    if (url.pathname === MCP_PATH || url.pathname === WEBHOOK_PATH || OAUTH_PATHS.has(url.pathname)) {
      return addCors(await dispatch(request, env), request);
    }
    return new Response("Not found", { status: 404 });
  },

  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(dispatch(new Request("https://watch-pr.internal/internal/poll", { method: "POST" }), env));
  },
};

export default worker;
export { WatchPrHub };
