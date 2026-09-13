import { afterEach, describe, expect, it, vi } from "vitest";
import gateway from "../src/telemetry-gateway";

function base64(buffer: ArrayBuffer): string {
  let binary = "";
  for (const byte of new Uint8Array(buffer)) binary += String.fromCharCode(byte);
  return btoa(binary);
}

async function gzip(text: string): Promise<ArrayBuffer> {
  const stream = new CompressionStream("gzip");
  const writer = stream.writable.getWriter();
  await writer.write(new TextEncoder().encode(text));
  await writer.close();
  return new Response(stream.readable).arrayBuffer();
}

const keyPair = await crypto.subtle.generateKey(
  { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
  true,
  ["sign", "verify"],
) as CryptoKeyPair;
const privateKey = [
  "-----BEGIN PRIVATE KEY-----",
  base64(await crypto.subtle.exportKey("pkcs8", keyPair.privateKey)),
  "-----END PRIVATE KEY-----",
  "",
].join("\n");

const currentBearer = "test-ingest-bearer";
const previousBearer = "previous-test-ingest-bearer";
const env = {
  TENANT_ID: "6f10d2eb-7cce-444c-bf11-d6fe61d7b8f8",
  APP_CLIENT_ID: "7576b821-7127-4190-bd54-cca37a6d8088",
  OTLP_TRACES_ENDPOINT: "https://otlp.example.test/traces",
  OTLP_LOGS_ENDPOINT: "https://otlp.example.test/logs",
  OIDC_ISSUER_URL: "https://watch-pr-oidc-issuer.watch-pr-vza-net-prod.workers.dev",
  OIDC_SIGNING_KID: "production-test-key",
  OIDC_SIGNING_KEYS: JSON.stringify([{ kid: "production-test-key", privateKeyPem: privateKey }]),
  GATEWAY_FEDERATION_SUBJECT: "cf-worker:watch-pr-telemetry-gateway",
  INGEST_BEARERS: JSON.stringify([currentBearer, previousBearer]),
};

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("telemetry gateway", () => {
  it("acknowledges requests without the destination bearer without fetching credentials or Azure", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const response = await gateway.fetch(
      new Request("https://gateway.example.test/v1/logs", { method: "POST", body: "{}" }),
      env,
    );

    expect(response.status).toBe(200);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does not treat Bearer undefined as authorized before gateway secrets are configured", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const response = await gateway.fetch(
      new Request("https://gateway.example.test/v1/logs", {
        method: "POST",
        headers: { Authorization: "Bearer undefined" },
        body: "{}",
      }),
      { ...env, INGEST_BEARERS: "" },
    );

    expect(response.status).toBe(200);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects metrics because Cloudflare cannot export them to this gateway", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const response = await gateway.fetch(
      new Request("https://gateway.example.test/v1/metrics", {
        method: "POST",
        headers: { Authorization: `Bearer ${currentBearer}` },
        body: "{}",
      }),
      env,
    );

    expect(response.status).toBe(404);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("acknowledges malformed authorized OTLP without retrying it", async () => {
    const fetchMock = vi.fn();
    const consoleLog = vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.stubGlobal("fetch", fetchMock);

    const response = await gateway.fetch(
      new Request("https://gateway.example.test/v1/logs", {
        method: "POST",
        headers: { Authorization: `Bearer ${currentBearer}` },
        body: "{",
      }),
      env,
    );

    expect(response.status).toBe(200);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(consoleLog).toHaveBeenCalledWith(JSON.stringify({
      event: "watch_pr.telemetry_gateway_invalid_payload",
      signal: "logs",
    }));
  });

  it("acknowledges a malformed authorized gzip payload without retrying it", async () => {
    const fetchMock = vi.fn();
    const consoleLog = vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.stubGlobal("fetch", fetchMock);

    const response = await gateway.fetch(
      new Request("https://gateway.example.test/v1/logs", {
        method: "POST",
        headers: { Authorization: `Bearer ${currentBearer}` },
        body: new Uint8Array([0x1f, 0x8b, 0]),
      }),
      env,
    );

    expect(response.status).toBe(200);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(consoleLog).toHaveBeenCalledWith(JSON.stringify({
      event: "watch_pr.telemetry_gateway_invalid_payload",
      signal: "logs",
    }));
  });

  it("rejects an authorized payload whose streamed compressed size exceeds the gateway bound", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const request = new Request("https://gateway.example.test/v1/logs", {
      method: "POST",
      headers: { Authorization: `Bearer ${currentBearer}` },
      body: new Uint8Array(1024 * 1024 + 1),
    });
    request.headers.delete("Content-Length");

    const response = await gateway.fetch(request, env);

    expect(response.status).toBe(413);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("coalesces a cold token exchange across overlapping bearer rotation", async () => {
    let azureRequest: Request | undefined;
    let releaseToken: () => void;
    const tokenReady = new Promise<void>((resolve) => {
      releaseToken = resolve;
    });
    const tokenStarted = vi.fn();
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : input.toString();
      if (url.startsWith("https://login.microsoftonline.com/")) {
        tokenStarted();
        expect(init?.method).toBe("POST");
        expect(init?.body?.toString()).toContain("client_assertion=");
        await tokenReady;
        return Response.json({ access_token: "azure-access-token", expires_in: 3600 });
      }
      azureRequest = new Request(input, init);
      return new Response(null, { status: 204 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const compressed = await gzip(JSON.stringify({
      resourceLogs: [{
        scopeLogs: [{
          logRecords: [{ body: { stringValue: "watch_pr.poll" } }],
        }],
      }],
    }));
    const requests = [
      gateway.fetch(
        new Request("https://gateway.example.test/v1/logs", {
          method: "POST",
          headers: { Authorization: `Bearer ${currentBearer}` },
          body: compressed.slice(0),
        }),
        env,
      ),
      gateway.fetch(
        new Request("https://gateway.example.test/v1/logs", {
          method: "POST",
          headers: { Authorization: `Bearer ${previousBearer}` },
          body: compressed.slice(0),
        }),
        env,
      ),
    ];
    await vi.waitFor(() => expect(tokenStarted).toHaveBeenCalledTimes(1));
    releaseToken!();
    const responses = await Promise.all(requests);

    expect(responses.map((response) => response.status)).toEqual([204, 204]);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(azureRequest?.url).toBe(env.OTLP_LOGS_ENDPOINT);
    expect(azureRequest?.headers.get("Authorization")).toBe("Bearer azure-access-token");
    expect(azureRequest?.headers.get("Content-Type")).toBe("application/x-protobuf");
    expect((await azureRequest?.arrayBuffer())?.byteLength).toBeGreaterThan(0);
  });

  it("forwards only allowlisted telemetry and strips native Cloudflare request, client, and geo data", async () => {
    let azureBody: Uint8Array | undefined;
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : input.toString();
      if (url.startsWith("https://login.microsoftonline.com/")) {
        return Response.json({ access_token: "azure-access-token", expires_in: 3600 });
      }
      azureBody = new Uint8Array(await new Request(input, init).arrayBuffer());
      return new Response(null, { status: 204 });
    }));
    const str = (value: string) => ({ stringValue: value });
    const sensitive = {
      resource: [{ key: "http.request.header.accept", value: str("text/html,RESOURCE-HEADER") }],
      scope: [{ key: "user_agent.original", value: str("Mozilla/5.0 SCOPE-UA") }],
      span: [
        { key: "url.full", value: str("https://watch-pr.vza.net/monitor/CAPABILITY-IN-URL?code=QUERY") },
        { key: "user_agent.original", value: str("Mozilla/5.0 SPAN-UA") },
        { key: "geo.locality.name", value: str("GEO-CITY") },
        { key: "geo.country.code", value: str("GEO-COUNTRY") },
        { key: "geo.timezone", value: str("GEO-TIMEZONE") },
        { key: "cloudflare.asn", value: { intValue: "13335" } },
        { key: "http.request.header.cookie", value: str("sid=SPAN-COOKIE") },
        { key: "cloudflare.durable_object.kv.query.keys", value: { arrayValue: { values: [str("watch:42:STORAGE-KEY")] } } },
        { key: "watch_pr.user_name", value: str("RAW-WATCH-USER") },
      ],
      event: [{ key: "exception.stacktrace", value: str("EVENT-STACKTRACE") }],
      link: [{ key: "http.request.header.authorization", value: str("Bearer LINK-TOKEN") }],
    };

    const response = await gateway.fetch(
      new Request("https://gateway.example.test/v1/traces", {
        method: "POST",
        headers: { Authorization: `Bearer ${currentBearer}` },
        body: JSON.stringify({
          resourceSpans: [{
            schemaUrl: "https://opentelemetry.io/schemas/SCHEMA-URL",
            resource: { attributes: [{ key: "service.name", value: str("watch-pr-vza-net-prod") }, ...sensitive.resource] },
            scopeSpans: [{
              scope: {
                name: "SCOPE-NAME-LEAK",
                version: "SCOPE-VERSION-LEAK",
                attributes: sensitive.scope,
              },
              spans: [{
                traceId: "0102030405060708090a0b0c0d0e0f10",
                spanId: "1112131415161718",
                traceState: "vendor=TRACE-STATE",
                name: "SPAN-NAME-LEAK",
                kind: 2,
                startTimeUnixNano: "1782964800000000000",
                endTimeUnixNano: "1782964800500000000",
                attributes: [
                  { key: "url.path", value: str("/monitor/CAPABILITY-IN-PATH") },
                  { key: "cloudflare.ray_id", value: str("9a1b2c3d4e5f6a7b-GRU") },
                  { key: "http.request.method", value: str("GET") },
                  { key: "http.response.status_code", value: { intValue: 200 } },
                  ...sensitive.span,
                  { key: "http.request.method", value: str("METHOD-LEAK") },
                ],
                events: [{ timeUnixNano: "1782964800100000000", name: "exception", attributes: [
                  { key: "exception.type", value: str("GithubApiError") },
                  { key: "exception.message", value: str("PRIVATE-EXCEPTION-MESSAGE") },
                  ...sensitive.event,
                ] }],
                links: [{ traceId: "2122232425262728292a2b2c2d2e2f30", spanId: "3132333435363738", attributes: [
                  { key: "faas.trigger", value: str("http") },
                  ...sensitive.link,
                ] }],
                status: { code: 2, message: "STATUS-MESSAGE-LEAK" },
              }],
            }],
          }],
        }),
      }),
      env,
    );

    expect(response.status).toBe(204);
    expect(azureBody).toBeDefined();
    const wire = new TextDecoder().decode(azureBody);
    for (const kept of [
      "service.name", "watch-pr-vza-net-prod", "GET", "/monitor/{capability}", "GET /monitor/{capability}",
      "9a1b2c3d4e5f6a7b-GRU", "http.request.method", "http.response.status_code",
      "exception", "exception.type", "GithubApiError", "faas.trigger",
    ]) {
      expect(wire).toContain(kept);
    }
    const leaked = Object.values(sensitive).flat().map((attribute) => attribute.key).concat([
      "RESOURCE-HEADER", "SCOPE-UA", "SPAN-UA", "CAPABILITY-IN-URL", "CAPABILITY-IN-PATH", "QUERY",
      "GEO-CITY", "GEO-COUNTRY", "GEO-TIMEZONE", "13335", "SPAN-COOKIE", "STORAGE-KEY",
      "EVENT-STACKTRACE", "LINK-TOKEN", "SCHEMA-URL", "TRACE-STATE", "SCOPE-NAME-LEAK",
      "SCOPE-VERSION-LEAK", "SPAN-NAME-LEAK", "STATUS-MESSAGE-LEAK", "RAW-WATCH-USER",
      "PRIVATE-EXCEPTION-MESSAGE", "METHOD-LEAK",
    ]);
    for (const secret of leaked) expect(wire).not.toContain(secret);
  });

  it("forwards hub diagnostics as a watch_pr marker with bounded fields and drops raw log bodies", async () => {
    let azureBody: Uint8Array | undefined;
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : input.toString();
      if (url.startsWith("https://login.microsoftonline.com/")) {
        return Response.json({ access_token: "azure-access-token", expires_in: 3600 });
      }
      azureBody = new Uint8Array(await new Request(input, init).arrayBuffer());
      return new Response(null, { status: 204 });
    }));

    const response = await gateway.fetch(
      new Request("https://gateway.example.test/v1/logs", {
        method: "POST",
        headers: { Authorization: `Bearer ${currentBearer}` },
        body: JSON.stringify({
          resourceLogs: [{
            scopeLogs: [{
              logRecords: [
                {
                  timeUnixNano: "1782964800855000000",
                  severityNumber: 9,
                  severityText: "SEVERITY-TEXT-LEAK",
                  body: { stringValue: JSON.stringify({
                    event: "watch_pr.webhook_failure",
                    github_event: "pull_request",
                    github_status: 502,
                    session_token: "FIELD-TOKEN",
                  }) },
                  attributes: [{ key: "user_agent.original", value: { stringValue: "Mozilla/5.0 LOG-UA" } }],
                },
                { body: { stringValue: "GET https://watch-pr.vza.net/monitor/RAW-BODY 200" } },
              ],
            }],
          }],
        }),
      }),
      env,
    );

    expect(response.status).toBe(204);
    const wire = new TextDecoder().decode(azureBody);
    expect(wire).toContain("watch_pr.webhook_failure");
    expect(wire).toContain("watch_pr.github_event");
    expect(wire).toContain("pull_request");
    expect(wire).toContain("watch_pr.github_status");
    for (const secret of ["FIELD-TOKEN", "session_token", "LOG-UA", "user_agent", "RAW-BODY", "watch-pr.vza.net", "SEVERITY-TEXT-LEAK"]) {
      expect(wire).not.toContain(secret);
    }
  });
});
