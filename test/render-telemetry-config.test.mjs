import { Buffer } from "node:buffer";
import { describe, expect, it } from "vitest";
import { renderTelemetryConfigs } from "../scripts/render-telemetry-config.mjs";

function rsaModulus(byteLength, leadingByte = 0x80) {
  const bytes = Buffer.alloc(byteLength, 1);
  bytes[0] = leadingByte;
  return bytes.toString("base64url");
}

const currentJwk = {
  kty: "RSA",
  kid: "production-current-key",
  n: rsaModulus(256),
  e: "AQAB",
  alg: "RS256",
  use: "sig",
};
const previousJwk = {
  ...currentJwk,
  kid: "production-previous-key",
  n: rsaModulus(256),
};

const source = {
  CLOUDFLARE_ACCOUNT_ID: "a".repeat(32),
  WORKERS_DEV_SUBDOMAIN: "watch-pr-vza-net-prod",
  TELEMETRY_AZURE_TENANT_ID: "6f10d2eb-7cce-444c-bf11-d6fe61d7b8f8",
  TELEMETRY_AZURE_APP_CLIENT_ID: "7576b821-7127-4190-bd54-cca37a6d8088",
  TELEMETRY_OTLP_TRACES_ENDPOINT: "https://example.monitor.azure.com/otlp/v1/traces",
  TELEMETRY_OTLP_LOGS_ENDPOINT: "https://example.monitor.azure.com/otlp/v1/logs",
  TELEMETRY_OIDC_ISSUER_URL: "https://watch-pr-oidc-issuer.watch-pr-vza-net-prod.workers.dev",
  TELEMETRY_GATEWAY_ORIGIN: "https://watch-pr-telemetry-gateway.watch-pr-vza-net-prod.workers.dev",
  TELEMETRY_OIDC_SIGNING_KID: currentJwk.kid,
  TELEMETRY_OIDC_PUBLIC_JWK: JSON.stringify(currentJwk),
  TELEMETRY_OIDC_PREVIOUS_PUBLIC_JWK: JSON.stringify(previousJwk),
};

describe("telemetry configuration rendering", () => {
  it("keeps the previous issuer key while bootstrapping the gateway with it", () => {
    const configs = renderTelemetryConfigs("production", source);

    expect(configs["wrangler.oidc-issuer.json"].vars).toMatchObject({
      OIDC_PUBLIC_JWK: JSON.stringify(currentJwk),
      OIDC_PREVIOUS_PUBLIC_JWK: JSON.stringify(previousJwk),
    });
    expect(configs["wrangler.telemetry-gateway-bootstrap.json"].vars.OIDC_SIGNING_KID).toBe(previousJwk.kid);
    expect(configs["wrangler.telemetry-gateway.json"].vars.OIDC_SIGNING_KID).toBe(currentJwk.kid);
    expect(configs["wrangler.telemetry-gateway.json"].vars).not.toHaveProperty("OTLP_METRICS_ENDPOINT");
  });

  it("rejects a previous JWK that repeats the current signing kid", () => {
    expect(() => renderTelemetryConfigs("production", {
      ...source,
      TELEMETRY_OIDC_PREVIOUS_PUBLIC_JWK: JSON.stringify(currentJwk),
    })).toThrow("different signing kid");
  });

  it("rejects a decoded RSA modulus below 2048 bits", () => {
    expect(() => renderTelemetryConfigs("production", {
      ...source,
      TELEMETRY_OIDC_PUBLIC_JWK: JSON.stringify({
        ...currentJwk,
        n: rsaModulus(192),
      }),
    })).toThrow("RS256 public key");
  });
});
