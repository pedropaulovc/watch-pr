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
});
