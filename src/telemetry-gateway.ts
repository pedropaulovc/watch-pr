import { signAssertion } from "./oidc-sign";
import { encodeLogsRequest, encodeTraceRequest } from "./otlp-protobuf";
import { sanitizeLogsRequest, sanitizeTraceRequest } from "./otlp-sanitize";

interface Env {
  TENANT_ID: string;
  APP_CLIENT_ID: string;
  OTLP_TRACES_ENDPOINT: string;
  OTLP_LOGS_ENDPOINT: string;
  OIDC_ISSUER_URL: string;
  OIDC_SIGNING_KID: string;
  OIDC_SIGNING_KEYS: string;
  GATEWAY_FEDERATION_SUBJECT: string;
  INGEST_BEARERS: string;
}

let tokenCache: { token: string; expiresAt: number } | undefined;
let tokenRefresh: Promise<string> | undefined;

const MAX_COMPRESSED_OTLP_BYTES = 1024 * 1024;
const MAX_DECOMPRESSED_OTLP_BYTES = 4 * 1024 * 1024;
const ENTRA_TOKEN_TIMEOUT_MS = 10_000;
const AZURE_FORWARD_TIMEOUT_MS = 15_000;

function configuredSigningKey(env: Env): string | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(env.OIDC_SIGNING_KEYS);
  } catch {
    return undefined;
  }
  if (!Array.isArray(parsed) || parsed.length === 0 || parsed.length > 2) return undefined;

  const seenKids = new Set<string>();
  let selected: string | undefined;
  for (const candidate of parsed) {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return undefined;
    const key = candidate as { kid?: unknown; privateKeyPem?: unknown };
    if (typeof key.kid !== "string" || !key.kid || typeof key.privateKeyPem !== "string" || !key.privateKeyPem) {
      return undefined;
    }
    if (seenKids.has(key.kid)) return undefined;
    seenKids.add(key.kid);
    if (key.kid === env.OIDC_SIGNING_KID) selected = key.privateKeyPem;
  }
  return selected;
}

function configuredIngestBearers(env: Env): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(env.INGEST_BEARERS);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed) || parsed.length === 0 || parsed.length > 2) return [];

  const bearers: string[] = [];
  for (const candidate of parsed) {
    if (typeof candidate !== "string" || !candidate || bearers.includes(candidate)) return [];
    bearers.push(candidate);
  }
  return bearers;
}

function isAuthorized(request: Request, env: Env): boolean {
  const authorization = request.headers.get("Authorization");
  return configuredIngestBearers(env).some((bearer) => authorization === `Bearer ${bearer}`);
}

async function refreshEntraToken(
  env: Env,
  privateKeyPem: string,
): Promise<{ token: string; expiresAt: number }> {
  const assertion = await signAssertion({
    issuer: env.OIDC_ISSUER_URL,
    subject: env.GATEWAY_FEDERATION_SUBJECT,
    audience: "api://AzureADTokenExchange",
    kid: env.OIDC_SIGNING_KID,
    privateKeyPem,
  });
  const body = new URLSearchParams({
    client_id: env.APP_CLIENT_ID,
    grant_type: "client_credentials",
    scope: "https://monitor.azure.com/.default",
    client_assertion_type: "urn:ietf:params:oauth:client-assertion-type:jwt-bearer",
    client_assertion: assertion,
  });
  const response = await fetch(`https://login.microsoftonline.com/${env.TENANT_ID}/oauth2/v2.0/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
    signal: AbortSignal.timeout(ENTRA_TOKEN_TIMEOUT_MS),
  });
  const data = await response.json() as { access_token?: string; expires_in?: number };
  const expiresIn = Number(data.expires_in);
  if (!response.ok || !data.access_token || !Number.isFinite(expiresIn) || expiresIn <= 0) {
    throw new Error("Entra token exchange failed");
  }
  return {
    token: data.access_token,
    expiresAt: Date.now() + Math.max(0, expiresIn - 60) * 1000,
  };
}

export function getEntraToken(env: Env, privateKeyPem: string): Promise<string> {
  if (tokenCache && Date.now() < tokenCache.expiresAt) return Promise.resolve(tokenCache.token);
  if (!tokenRefresh) {
    tokenRefresh = refreshEntraToken(env, privateKeyPem)
      .then((next) => {
        tokenCache = next;
        return next.token;
      })
      .finally(() => {
        tokenRefresh = undefined;
      });
  }
  return tokenRefresh;
}

type OtlpSanitizer = (json: unknown) => Record<string, unknown>;
type OtlpEncoder = (json: Record<string, unknown>) => Uint8Array;
type Signal = "logs" | "traces";

class OtlpPayloadTooLargeError extends Error {}

async function readAtMost(stream: ReadableStream<Uint8Array> | null, maximumBytes: number): Promise<Uint8Array> {
  if (!stream) return new Uint8Array();
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > maximumBytes) {
        await reader.cancel();
        throw new OtlpPayloadTooLargeError();
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  if (chunks.length === 1) return chunks[0]!;
  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

async function decompressGzip(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new DecompressionStream("gzip");
  const decoded = readAtMost(stream.readable, MAX_DECOMPRESSED_OTLP_BYTES);
  const writer = stream.writable.getWriter();
  try {
    await writer.write(bytes as Uint8Array<ArrayBuffer>);
    await writer.close();
    return await decoded;
  } catch (error) {
    await writer.abort(error).catch(() => undefined);
    await decoded.catch(() => undefined);
    throw error;
  }
}

function invalidPayloadResponse(signal: Signal): Response {
  console.log(JSON.stringify({ event: "watch_pr.telemetry_gateway_invalid_payload", signal }));
  return new Response("OK", { status: 200 });
}

function payloadTooLargeResponse(signal: Signal): Response {
  console.log(JSON.stringify({ event: "watch_pr.telemetry_gateway_payload_too_large", signal }));
  return new Response(null, { status: 413 });
}

async function forwardOtlp(
  request: Request,
  env: Env,
  signal: Signal,
  endpoint: string,
  sanitize: OtlpSanitizer,
  encode: OtlpEncoder,
): Promise<Response> {
  if (!isAuthorized(request, env)) return new Response("OK", { status: 200 });
  const privateKeyPem = configuredSigningKey(env);
  if (!privateKeyPem) return new Response("OK", { status: 200 });

  const contentLength = Number(request.headers.get("Content-Length"));
  if (Number.isSafeInteger(contentLength) && contentLength > MAX_COMPRESSED_OTLP_BYTES) {
    return payloadTooLargeResponse(signal);
  }

  let rawBytes: Uint8Array;
  try {
    rawBytes = await readAtMost(request.body, MAX_COMPRESSED_OTLP_BYTES);
  } catch (error) {
    if (error instanceof OtlpPayloadTooLargeError) return payloadTooLargeResponse(signal);
    return invalidPayloadResponse(signal);
  }
  if (rawBytes.byteLength === 0) return new Response("OK", { status: 200 });

  let jsonText: string;
  try {
    const decoded = rawBytes[0] === 0x1f && rawBytes[1] === 0x8b
      ? await decompressGzip(rawBytes)
      : rawBytes;
    jsonText = new TextDecoder().decode(decoded);
  } catch (error) {
    if (error instanceof OtlpPayloadTooLargeError) return payloadTooLargeResponse(signal);
    return invalidPayloadResponse(signal);
  }
  if (jsonText.length === 0) return new Response("OK", { status: 200 });

  // Cloudflare's export carries headers, user agents, geography, and full URLs; only the
  // sanitized allowlist may reach Azure.
  let payload: Uint8Array;
  try {
    payload = encode(sanitize(JSON.parse(jsonText)));
  } catch {
    return invalidPayloadResponse(signal);
  }
  if (payload.byteLength === 0) return new Response("OK", { status: 200 });
  if (payload.byteLength > MAX_DECOMPRESSED_OTLP_BYTES) return payloadTooLargeResponse(signal);

  let token: string;
  try {
    token = await getEntraToken(env, privateKeyPem);
  } catch {
    console.log(JSON.stringify({ event: "watch_pr.telemetry_gateway_token_failure", signal }));
    return new Response(null, { status: 503 });
  }

  let upstream: Response;
  try {
    upstream = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-protobuf",
        Authorization: `Bearer ${token}`,
      },
      body: payload.buffer as ArrayBuffer,
      signal: AbortSignal.timeout(AZURE_FORWARD_TIMEOUT_MS),
    });
  } catch {
    console.log(JSON.stringify({
      event: "watch_pr.telemetry_gateway_upstream_failure",
      signal,
      status: 503,
    }));
    return new Response(null, { status: 503 });
  }
  if (!upstream.ok) {
    console.log(JSON.stringify({
      event: "watch_pr.telemetry_gateway_upstream_failure",
      signal,
      status: upstream.status,
    }));
  }
  return new Response(null, { status: upstream.status });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const path = new URL(request.url).pathname;
    if (request.method === "POST" && path === "/v1/traces") {
      return forwardOtlp(request, env, "traces", env.OTLP_TRACES_ENDPOINT, sanitizeTraceRequest, encodeTraceRequest);
    }
    if (request.method === "POST" && path === "/v1/logs") {
      return forwardOtlp(request, env, "logs", env.OTLP_LOGS_ENDPOINT, sanitizeLogsRequest, encodeLogsRequest);
    }
    if (request.method === "POST" && path === "/v1/metrics") {
      return new Response("Metrics export is not supported", { status: 404 });
    }
    return new Response("Not Found", { status: 404 });
  },
};
