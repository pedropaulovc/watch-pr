import { Buffer } from "node:buffer";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const ENVIRONMENTS = new Set(["production", "ppe"]);
const ACCOUNT_ID_PATTERN = /^[a-f0-9]{32}$/u;
const UUID_PATTERN = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/iu;

function requireValue(source, name) {
  const value = source[name]?.trim();
  if (!value) throw new Error(`Required environment variable ${name} is not set`);
  return value;
}

function requireUuid(source, name) {
  const value = requireValue(source, name);
  if (!UUID_PATTERN.test(value)) throw new Error(`${name} must be a UUID`);
  return value;
}

function requireHttpsOrigin(source, name, expectedHost) {
  const value = requireValue(source, name);
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${name} must be an HTTPS URL`);
  }
  if (url.protocol !== "https:" || url.origin !== value || url.hostname !== expectedHost) {
    throw new Error(`${name} must be https://${expectedHost}`);
  }
  return value;
}

function requireOtlpEndpoint(source, name, suffix) {
  const value = requireValue(source, name);
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${name} must be an HTTPS URL`);
  }
  if (
    url.protocol !== "https:" ||
    !url.hostname.endsWith(".monitor.azure.com") ||
    !url.pathname.endsWith(suffix) ||
    url.search ||
    url.hash
  ) {
    throw new Error(`${name} must be an Azure Monitor ${suffix} endpoint`);
  }
  return value;
}

function hasAtLeast2048BitRsaModulus(value) {
  if (!/^[A-Za-z0-9_-]+$/u.test(value) || value.length % 4 === 1) return false;
  const modulus = Buffer.from(value, "base64url");
  if (modulus.length < 256) return false;
  const firstNonzero = modulus.findIndex((byte) => byte !== 0);
  if (firstNonzero === -1) return false;
  const bitLength = (modulus.length - firstNonzero - 1) * 8 + 32 - Math.clz32(modulus[firstNonzero]);
  return bitLength >= 2048;
}

function parsePublicJwk(value, name, environment, expectedKid) {
  let jwk;
  try {
    jwk = JSON.parse(value);
  } catch {
    throw new Error(`${name} must be valid JSON`);
  }
  if (
    !jwk ||
    typeof jwk !== "object" ||
    Array.isArray(jwk) ||
    jwk.kty !== "RSA" ||
    typeof jwk.kid !== "string" ||
    !jwk.kid.startsWith(`${environment}-`) ||
    (expectedKid !== undefined && jwk.kid !== expectedKid) ||
    jwk.alg !== "RS256" ||
    jwk.use !== "sig" ||
    typeof jwk.n !== "string" ||
    !hasAtLeast2048BitRsaModulus(jwk.n) ||
    typeof jwk.e !== "string" ||
    jwk.e.length === 0
  ) {
    throw new Error(`${name} must be an RS256 public key scoped to ${environment}`);
  }
  return { source: value, kid: jwk.kid };
}

function requirePublicJwk(source, name, environment, expectedKid) {
  return parsePublicJwk(requireValue(source, name), name, environment, expectedKid);
}

function optionalPublicJwk(source, name, environment) {
  const value = source[name]?.trim();
  if (!value) return undefined;
  return parsePublicJwk(value, name, environment);
}

function selectedEnvironment(arguments_) {
  if (arguments_.length !== 2 || arguments_[0] !== "--environment" || !ENVIRONMENTS.has(arguments_[1])) {
    throw new Error("Usage: node scripts/render-telemetry-config.mjs --environment production|ppe");
  }
  return arguments_[1];
}

export function telemetryEnvironment(environment, source = process.env) {
  if (!ENVIRONMENTS.has(environment)) throw new Error("Invalid deployment environment");
  const accountId = requireValue(source, "CLOUDFLARE_ACCOUNT_ID");
  if (!ACCOUNT_ID_PATTERN.test(accountId)) throw new Error("CLOUDFLARE_ACCOUNT_ID must be a Cloudflare account ID");
  const workersDevSubdomain = requireValue(source, "WORKERS_DEV_SUBDOMAIN");
  if (!/^[a-z0-9-]+$/u.test(workersDevSubdomain)) {
    throw new Error("WORKERS_DEV_SUBDOMAIN must be a workers.dev subdomain");
  }
  const issuerHost = `watch-pr-oidc-issuer.${workersDevSubdomain}.workers.dev`;
  const gatewayHost = `watch-pr-telemetry-gateway.${workersDevSubdomain}.workers.dev`;
  const signingKid = requireValue(source, "TELEMETRY_OIDC_SIGNING_KID");
  const publicJwk = requirePublicJwk(
    source,
    "TELEMETRY_OIDC_PUBLIC_JWK",
    environment,
    signingKid,
  );
  const previousPublicJwk = optionalPublicJwk(
    source,
    "TELEMETRY_OIDC_PREVIOUS_PUBLIC_JWK",
    environment,
  );
  if (previousPublicJwk?.kid === signingKid) {
    throw new Error("TELEMETRY_OIDC_PREVIOUS_PUBLIC_JWK must use a different signing kid");
  }
  const issuerUrl = requireHttpsOrigin(source, "TELEMETRY_OIDC_ISSUER_URL", issuerHost);
  const gatewayOrigin = requireHttpsOrigin(source, "TELEMETRY_GATEWAY_ORIGIN", gatewayHost);
  return {
    accountId,
    environment,
    azureTenantId: requireUuid(source, "TELEMETRY_AZURE_TENANT_ID"),
    azureAppClientId: requireUuid(source, "TELEMETRY_AZURE_APP_CLIENT_ID"),
    otlpTracesEndpoint: requireOtlpEndpoint(source, "TELEMETRY_OTLP_TRACES_ENDPOINT", "/otlp/v1/traces"),
    otlpLogsEndpoint: requireOtlpEndpoint(source, "TELEMETRY_OTLP_LOGS_ENDPOINT", "/otlp/v1/logs"),
    issuerUrl,
    gatewayOrigin,
    signingKid,
    publicJwk: publicJwk.source,
    previousPublicJwk: previousPublicJwk?.source,
    bootstrapSigningKid: previousPublicJwk?.kid ?? signingKid,
  };
}

export function renderTelemetryConfigs(environment, source = process.env) {
  const selected = telemetryEnvironment(environment, source);
  const shared = {
    account_id: selected.accountId,
    compatibility_date: "2026-09-03",
    workers_dev: true,
    upload_source_maps: true,
  };
  const gatewayVars = {
    TENANT_ID: selected.azureTenantId,
    APP_CLIENT_ID: selected.azureAppClientId,
    OTLP_TRACES_ENDPOINT: selected.otlpTracesEndpoint,
    OTLP_LOGS_ENDPOINT: selected.otlpLogsEndpoint,
    OIDC_ISSUER_URL: selected.issuerUrl,
    GATEWAY_FEDERATION_SUBJECT: "cf-worker:watch-pr-telemetry-gateway",
    OIDC_SIGNING_KID: selected.signingKid,
  };
  return {
    "wrangler.oidc-issuer.json": {
      $schema: "../../../node_modules/wrangler/config-schema.json",
      ...shared,
      name: "watch-pr-oidc-issuer",
      main: "../../../src/oidc-issuer.ts",
      vars: {
        DEPLOYMENT_ENVIRONMENT: selected.environment,
        ISSUER_URL: selected.issuerUrl,
        OIDC_PUBLIC_JWK: selected.publicJwk,
        ...(
          selected.previousPublicJwk
            ? { OIDC_PREVIOUS_PUBLIC_JWK: selected.previousPublicJwk }
            : {}
        ),
        OIDC_SIGNING_KID: selected.signingKid,
      },
    },
    "wrangler.telemetry-gateway-bootstrap.json": {
      $schema: "../../../node_modules/wrangler/config-schema.json",
      ...shared,
      name: "watch-pr-telemetry-gateway",
      main: "../../../src/telemetry-gateway.ts",
      vars: {
        ...gatewayVars,
        OIDC_SIGNING_KID: selected.bootstrapSigningKid,
      },
    },
    "wrangler.telemetry-gateway.json": {
      $schema: "../../../node_modules/wrangler/config-schema.json",
      ...shared,
      name: "watch-pr-telemetry-gateway",
      main: "../../../src/telemetry-gateway.ts",
      vars: gatewayVars,
    },
  };
}

async function main() {
  const environment = selectedEnvironment(process.argv.slice(2));
  const configs = renderTelemetryConfigs(environment);
  const directory = resolve(".wrangler", "telemetry", environment);
  await mkdir(directory, { recursive: true });
  await Promise.all(Object.entries(configs).map(([name, config]) => (
    writeFile(resolve(directory, name), `${JSON.stringify(config, null, 2)}\n`)
  )));
  process.stdout.write(`${directory}\n`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : "Could not render telemetry configs");
    process.exitCode = 1;
  });
}
