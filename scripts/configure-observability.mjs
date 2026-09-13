import { pathToFileURL } from "node:url";

const DESTINATIONS = [
  { name: "watch-pr-azure-logs", dataset: "opentelemetry-logs", path: "/v1/logs" },
  { name: "watch-pr-azure-traces", dataset: "opentelemetry-traces", path: "/v1/traces" },
];

const DESTINATIONS_PER_PAGE = 50;
const MAX_DESTINATION_PAGES = 1_000;

function requireValue(source, name) {
  const value = source[name];
  if (!value) throw new Error(`Required environment variable ${name} is not set`);
  return value;
}

function isObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function destinationBearer(destination) {
  if (!isObject(destination) || !isObject(destination.configuration) || !isObject(destination.configuration.headers)) {
    return undefined;
  }
  const authorization = destination.configuration.headers.Authorization;
  if (typeof authorization !== "string" || !authorization.startsWith("Bearer ")) return undefined;
  return authorization.slice("Bearer ".length);
}

export function verifyExistingBearerRotation(destinations, acceptedBearers) {
  const accepted = new Set(acceptedBearers);
  for (const destination of DESTINATIONS) {
    const matches = destinations.filter((item) => isObject(item) && item.name === destination.name);
    if (matches.length === 0) continue;
    if (matches.length > 1) throw new Error(`Cloudflare returned duplicate ${destination.name} destinations`);
    if (!accepted.has(destinationBearer(matches[0]))) {
      throw new Error(`${destination.name} has a bearer absent from the gateway's accepted set`);
    }
  }
}

export function verifyConfiguredDestinationBearers(destinations, expectedBearer) {
  for (const destination of DESTINATIONS) {
    const matches = destinations.filter((item) => isObject(item) && item.name === destination.name);
    if (matches.length !== 1 || destinationBearer(matches[0]) !== expectedBearer) {
      throw new Error(`${destination.name} did not retain the requested gateway bearer`);
    }
  }
}

async function cloudflareRequest(accountId, token, path, init = {}) {
  const response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${accountId}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(init.body ? { "Content-Type": "application/json" } : {}),
      ...init.headers,
    },
    signal: AbortSignal.timeout(30_000),
  });
  let payload;
  try {
    payload = await response.json();
  } catch {
    throw new Error(`Cloudflare observability API returned non-JSON HTTP ${response.status}`);
  }
  if (!response.ok || !isObject(payload) || payload.success !== true) {
    if (response.status === 403) {
      throw new Error("Cloudflare observability API rejected the token: grant account-level Workers Observability Write");
    }
    throw new Error(`Cloudflare observability API failed with HTTP ${response.status}`);
  }
  return payload;
}

async function listDestinations(accountId, token, endpoint) {
  const destinations = [];
  for (let page = 1; page <= MAX_DESTINATION_PAGES; page += 1) {
    const listing = await cloudflareRequest(
      accountId,
      token,
      `${endpoint}?page=${page}&perPage=${DESTINATIONS_PER_PAGE}`,
    );
    if (!Array.isArray(listing.result) || listing.result.length > DESTINATIONS_PER_PAGE) {
      throw new Error("Cloudflare destination listing is malformed");
    }
    destinations.push(...listing.result);
    if (listing.result.length < DESTINATIONS_PER_PAGE) return destinations;
  }
  throw new Error("Cloudflare destination listing exceeded the supported page limit");
}

function command(arguments_) {
  if (arguments_.length === 0) return "configure";
  if (arguments_.length === 1 && arguments_[0] === "--verify-bearer-rotation") return "verify-bearer-rotation";
  throw new Error("Usage: node scripts/configure-observability.mjs [--verify-bearer-rotation]");
}

export function destinationPayload(destination, gatewayOrigin, bearer, operation) {
  const configuration = {
    type: "logpush",
    url: `${gatewayOrigin}${destination.path}`,
    headers: { Authorization: `Bearer ${bearer}` },
  };
  if (operation === "update") return { enabled: true, configuration };
  if (operation === "create") {
    return {
      name: destination.name,
      enabled: true,
      configuration: { ...configuration, logpushDataset: destination.dataset },
    };
  }
  throw new Error("Unsupported destination operation");
}

async function main() {
  const selectedCommand = command(process.argv.slice(2));
  const accountId = requireValue(process.env, "CLOUDFLARE_ACCOUNT_ID");
  const token = requireValue(process.env, "CLOUDFLARE_API_TOKEN");
  const bearer = requireValue(process.env, "TELEMETRY_GATEWAY_INGEST_BEARER");
  const previousBearer = process.env.TELEMETRY_GATEWAY_PREVIOUS_INGEST_BEARER || undefined;
  if (previousBearer === bearer) throw new Error("Telemetry gateway ingest bearers must differ");
  const gatewayOrigin = requireValue(process.env, "TELEMETRY_GATEWAY_ORIGIN").replace(/\/+$/u, "");
  const endpoint = "/workers/observability/destinations";
  const existingDestinations = await listDestinations(accountId, token, endpoint);
  verifyExistingBearerRotation(
    existingDestinations,
    previousBearer ? [bearer, previousBearer] : [bearer],
  );
  if (selectedCommand === "verify-bearer-rotation") {
    process.stdout.write("Existing destination bearers are accepted by the gateway rotation set\n");
    return;
  }

  for (const destination of DESTINATIONS) {
    const matches = existingDestinations.filter((item) => isObject(item) && item.name === destination.name);
    if (matches.length > 1) throw new Error(`Cloudflare returned duplicate ${destination.name} destinations`);
    const operation = matches.length === 1 ? "update" : "create";
    const payload = destinationPayload(destination, gatewayOrigin, bearer, operation);
    if (matches.length === 1) {
      const existing = matches[0];
      if (!isObject(existing.configuration) || existing.configuration.logpushDataset !== destination.dataset || typeof existing.slug !== "string") {
        throw new Error(`${destination.name} exists with a mismatched dataset or invalid slug`);
      }
      await cloudflareRequest(accountId, token, `${endpoint}/${encodeURIComponent(existing.slug)}`, {
        method: "PATCH",
        body: JSON.stringify(payload),
      });
      process.stdout.write(`Updated ${destination.name}\n`);
      continue;
    }
    await cloudflareRequest(accountId, token, endpoint, {
      method: "POST",
        body: JSON.stringify(payload),
    });
    process.stdout.write(`Created ${destination.name}\n`);
  }
  const configuredDestinations = await listDestinations(accountId, token, endpoint);
  verifyConfiguredDestinationBearers(configuredDestinations, bearer);
  process.stdout.write("Verified observability destinations use the current gateway bearer\n");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : "Could not configure observability destinations");
    process.exitCode = 1;
  });
}
