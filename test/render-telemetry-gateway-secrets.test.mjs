import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repository = fileURLToPath(new URL("..", import.meta.url));

function render(kind, environment) {
  const output = execFileSync(process.execPath, ["scripts/render-telemetry-gateway-secrets.mjs", kind], {
    cwd: repository,
    encoding: "utf8",
    env: { ...process.env, ...environment },
  });
  return JSON.parse(output);
}

describe("render-telemetry-gateway-secrets", () => {
  it("renders an overlapping signing key ring without exposing it", () => {
    const keys = render("signing-keys", {
      TELEMETRY_OIDC_SIGNING_KID: "ppe-current-key",
      TELEMETRY_OIDC_SIGNING_KEY: "current-private-key",
      TELEMETRY_OIDC_PREVIOUS_SIGNING_KEY: "previous-private-key",
      TELEMETRY_OIDC_PREVIOUS_PUBLIC_JWK: JSON.stringify({ kid: "ppe-previous-key" }),
    });

    expect(keys).toEqual([
      { kid: "ppe-current-key", privateKeyPem: "current-private-key" },
      { kid: "ppe-previous-key", privateKeyPem: "previous-private-key" },
    ]);
  });

  it("renders the current and previous ingest bearer during transition", () => {
    expect(render("ingest-bearers", {
      TELEMETRY_GATEWAY_INGEST_BEARER: "current-bearer",
      TELEMETRY_GATEWAY_PREVIOUS_INGEST_BEARER: "previous-bearer",
    })).toEqual(["current-bearer", "previous-bearer"]);
  });
});
