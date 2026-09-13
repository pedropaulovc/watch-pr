import { describe, expect, it } from "vitest";
import issuer from "../src/oidc-issuer";

const publicJwk = {
  kty: "RSA",
  kid: "production-key12345",
  n: "a".repeat(342),
  e: "AQAB",
  alg: "RS256",
  use: "sig",
};
const previousPublicJwk = {
  ...publicJwk,
  kid: "production-previous-key",
  n: "b".repeat(342),
};

const env = {
  DEPLOYMENT_ENVIRONMENT: "production" as const,
  ISSUER_URL: "https://watch-pr-oidc-issuer.watch-pr-vza-net-prod.workers.dev",
  OIDC_SIGNING_KID: publicJwk.kid,
  OIDC_PUBLIC_JWK: JSON.stringify(publicJwk),
};

describe("OIDC issuer environment contract", () => {
  it("publishes only the configured public JWK", async () => {
    const response = await issuer.fetch(
      new Request(`${env.ISSUER_URL}/.well-known/jwks.json`),
      env,
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ keys: [publicJwk] });
  });

  it("keeps a previous public key available during signing-key rotation", async () => {
    const response = await issuer.fetch(
      new Request(`${env.ISSUER_URL}/.well-known/jwks.json`),
      { ...env, OIDC_PREVIOUS_PUBLIC_JWK: JSON.stringify(previousPublicJwk) },
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ keys: [publicJwk, previousPublicJwk] });
  });

  it("publishes discovery URLs from the configured origin", async () => {
    const response = await issuer.fetch(
      new Request(`${env.ISSUER_URL}/.well-known/openid-configuration`),
      env,
    );

    expect(await response.json()).toMatchObject({
      issuer: env.ISSUER_URL,
      jwks_uri: `${env.ISSUER_URL}/.well-known/jwks.json`,
      id_token_signing_alg_values_supported: ["RS256"],
    });
  });

  it("rejects a public JWK whose kid differs from the signing contract", async () => {
    await expect(
      issuer.fetch(new Request(`${env.ISSUER_URL}/.well-known/jwks.json`), {
        ...env,
        OIDC_SIGNING_KID: "production-other-key",
      }),
    ).rejects.toThrow("does not match");
  });

  it("rejects an issuer URL that is not this worker's workers.dev origin", async () => {
    await expect(
      issuer.fetch(new Request(`${env.ISSUER_URL}/.well-known/jwks.json`), {
        ...env,
        ISSUER_URL: "https://example.com",
      }),
    ).rejects.toThrow("workers.dev HTTPS origin");
  });
});
