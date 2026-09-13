import { createVerify, generateKeyPairSync } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { exchangeToken, signAssertion } from "../scripts/verify-entra-federation.mjs";

function decode(segment) {
  return JSON.parse(Buffer.from(segment, "base64url").toString("utf8"));
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("verify-entra-federation", () => {
  it("signs the workload federation assertion required by Azure Monitor", () => {
    const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const assertion = signAssertion({
      issuer: "https://issuer.example.test",
      subject: "cf-worker:watch-pr-telemetry-gateway",
      kid: "rotation-test-key",
      privateKeyPem: privateKey.export({ type: "pkcs8", format: "pem" }),
    });
    const [header, payload, signature] = assertion.split(".");
    const verifier = createVerify("RSA-SHA256");
    verifier.update(`${header}.${payload}`);
    verifier.end();

    expect(decode(header)).toEqual({ alg: "RS256", typ: "JWT", kid: "rotation-test-key" });
    expect(decode(payload)).toMatchObject({
      iss: "https://issuer.example.test",
      sub: "cf-worker:watch-pr-telemetry-gateway",
      aud: "api://AzureADTokenExchange",
    });
    expect(verifier.verify(publicKey, Buffer.from(signature, "base64url"))).toBe(true);
  });

  it("reports only Entra's safe status and error code", async () => {
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({
      error: "invalid_client",
      error_description: "private configuration details",
    }, { status: 400 })));

    const result = await exchangeToken({
      tenantId: "tenant",
      clientId: "client",
      issuer: "https://issuer.example.test",
      subject: "cf-worker:watch-pr-telemetry-gateway",
      kid: "rotation-test-key",
      privateKeyPem: privateKey.export({ type: "pkcs8", format: "pem" }),
    });

    expect(result).toEqual({
      accepted: false,
      retry: true,
      failure: "Entra token request returned HTTP 400 (invalid_client)",
    });
  });

  it("fails immediately when the configured signing key cannot sign", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const result = await exchangeToken({
      tenantId: "tenant",
      clientId: "client",
      issuer: "https://issuer.example.test",
      subject: "cf-worker:watch-pr-telemetry-gateway",
      kid: "rotation-test-key",
      privateKeyPem: "not-a-private-key",
    });

    expect(result).toMatchObject({
      accepted: false,
      retry: false,
      failure: expect.stringMatching(/^Could not sign the federation assertion:/u),
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
