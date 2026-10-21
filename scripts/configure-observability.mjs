import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";

const DESTINATIONS = [
  { name: "watch-pr-azure-logs", dataset: "opentelemetry-logs", path: "/v1/logs" },
  { name: "watch-pr-azure-traces", dataset: "opentelemetry-traces", path: "/v1/traces" },
];

const DESTINATIONS_PER_PAGE = 50;
const MAX_DESTINATION_PAGES = 1_000;
// Keep this one byte above telemetry-gateway.ts's MAX_COMPRESSED_OTLP_BYTES.
const AUTH_PROBE_BYTES = 1024 * 1024 + 1;
const AUTH_PROBE_TIMEOUT_MS = 10_000;

function requireValue(source, name) {
  const value = source[name];
  if (!value) throw new Error(`Required environment variable ${name} is not set`);
  return value;
}

function isObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireBearer(value, name) {
  if (typeof value !== "string" || !/^[\x21-\x7e]{1,4096}$/u.test(value)) {
    throw new Error(`${name} must be a nonempty, bounded HTTP bearer value`);
  }
  return value;
}

function gatewayOrigin(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error("TELEMETRY_GATEWAY_ORIGIN must be an HTTPS origin");
  }
  if (url.protocol !== "https:" || url.origin !== value || url.username || url.password || url.port) {
    throw new Error("TELEMETRY_GATEWAY_ORIGIN must be an HTTPS origin without credentials, a path, query, fragment, or port");
  }
  return url.origin;
}

function destinationBearer(destination) {
  const headers = destination.configuration.headers;
  if (!isObject(headers) || Object.values(headers).some((value) => value !== null && typeof value !== "string")) {
    throw new Error(`${destination.name} has malformed gateway authorization`);
  }
  const keys = Object.keys(headers).filter((key) => key.toLowerCase() === "authorization");
  if (keys.length !== 1) throw new Error(`${destination.name} has missing or ambiguous gateway authorization`);
  const authorization = headers[keys[0]];
  if (authorization === null) return null;
  if (typeof authorization !== "string" || !authorization.startsWith("Bearer ")) {
    throw new Error(`${destination.name} has malformed gateway authorization`);
  }
  const bearer = authorization.slice("Bearer ".length);
  requireBearer(bearer, `${destination.name} authorization`);
  return bearer;
}

function validateDestinations(destinations, origin, acceptedBearers, requireAll = false) {
  const accepted = new Set(acceptedBearers);
  if (destinations.some((item) => !isObject(item) || typeof item.name !== "string" || !item.name)) {
    throw new Error("Cloudflare destination listing is malformed");
  }
  const slugs = new Set();
  return DESTINATIONS.map((destination) => {
    const matches = destinations.filter((item) => item.name === destination.name);
    if (matches.length > 1) throw new Error(`Cloudflare returned duplicate ${destination.name} destinations`);
    const existing = matches[0];
    if (!existing) {
      if (requireAll) throw new Error(`${destination.name} is missing after configuration`);
      return { destination };
    }
    const configuration = existing.configuration;
    if (
      !isObject(configuration) ||
      configuration.type !== "logpush" ||
      configuration.logpushDataset !== destination.dataset ||
      configuration.url !== `${origin}${destination.path}` ||
      typeof existing.enabled !== "boolean" ||
      (requireAll && !existing.enabled) ||
      typeof existing.slug !== "string" ||
      !/^[A-Za-z0-9_-]+$/u.test(existing.slug)
    ) {
      throw new Error(`${destination.name} has a mismatched configuration or invalid slug`);
    }
    if (slugs.has(existing.slug)) throw new Error("Cloudflare returned duplicate observability destination slugs");
    slugs.add(existing.slug);
    const bearer = destinationBearer(existing);
    if (bearer !== null && !accepted.has(bearer)) {
      throw new Error(`${destination.name} has a bearer absent from the gateway's accepted set`);
    }
    return { destination, existing, bearer };
  });
}

async function cloudflareRequest(accountId, token, path, init, fetchImpl) {
  let response;
  try {
    response = await fetchImpl(`https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(accountId)}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(init.body ? { "Content-Type": "application/json" } : {}),
      },
      redirect: "error",
      signal: AbortSignal.timeout(30_000),
    });
  } catch {
    throw new Error("Cloudflare observability API request failed");
  }
  if (response.redirected) throw new Error("Cloudflare observability API returned a redirect");
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

async function listDestinations(accountId, token, endpoint, fetchImpl) {
  const destinations = [];
  for (let page = 1; page <= MAX_DESTINATION_PAGES; page += 1) {
    const listing = await cloudflareRequest(
      accountId,
      token,
      `${endpoint}?page=${page}&perPage=${DESTINATIONS_PER_PAGE}`,
      {},
      fetchImpl,
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
  if (arguments_.length === 1 && arguments_[0] === "--prepare-bearer-rotation") return "prepare";
  throw new Error("Usage: node scripts/configure-observability.mjs [--prepare-bearer-rotation]");
}

async function probeGatewayBearer(origin, bearer, invalidBearer, fetchImpl) {
  // A valid bearer and signing-key configuration reach the size guard, before
  // JSON parsing or Entra/Azure traffic. Empty or malformed JSON also returns 200.
  const body = new Uint8Array(AUTH_PROBE_BYTES);
  async function status(path, candidate) {
    let response;
    try {
      response = await fetchImpl(`${origin}${path}`, {
        method: "POST",
        headers: { Authorization: `Bearer ${candidate}`, "Content-Type": "application/json" },
        body,
        redirect: "error",
        signal: AbortSignal.timeout(AUTH_PROBE_TIMEOUT_MS),
      });
    } catch {
      throw new Error("Telemetry gateway authorization probe request failed");
    }
    if (response.redirected) throw new Error("Telemetry gateway authorization probe returned a redirect");
    // Never read or report an untrusted response body, URL, or bearer.
    void response.body?.cancel().catch(() => {});
    return response.status;
  }
  for (const destination of DESTINATIONS) {
    if (await status(destination.path, invalidBearer) !== 200) {
      throw new Error("Telemetry gateway authorization probe control was ambiguous");
    }
  }
  const statuses = [];
  for (const destination of DESTINATIONS) statuses.push(await status(destination.path, bearer));
  if (statuses.every((status) => status === 413)) return true;
  if (statuses.every((status) => status === 200)) return false;
  throw new Error("Telemetry gateway authorization probe was ambiguous");
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

export async function configureObservability({
  command: selectedCommand = "configure",
  source = process.env,
  fetchImpl = fetch,
  write = (text) => process.stdout.write(text),
} = {}) {
  if (selectedCommand !== "prepare" && selectedCommand !== "configure") throw new Error("Unsupported observability command");
  const accountId = requireValue(source, "CLOUDFLARE_ACCOUNT_ID");
  const token = requireValue(source, "CLOUDFLARE_API_TOKEN");
  const bearer = requireBearer(requireValue(source, "TELEMETRY_GATEWAY_INGEST_BEARER"), "TELEMETRY_GATEWAY_INGEST_BEARER");
  const previousBearer = source.TELEMETRY_GATEWAY_PREVIOUS_INGEST_BEARER || undefined;
  if (previousBearer !== undefined) requireBearer(previousBearer, "TELEMETRY_GATEWAY_PREVIOUS_INGEST_BEARER");
  if (previousBearer === bearer) throw new Error("Telemetry gateway ingest bearers must differ");
  const origin = gatewayOrigin(requireValue(source, "TELEMETRY_GATEWAY_ORIGIN"));
  const acceptedBearers = previousBearer ? [bearer, previousBearer] : [bearer];
  const endpoint = "/workers/observability/destinations";
  const existingDestinations = await listDestinations(accountId, token, endpoint, fetchImpl);
  // Complete every shape and readable-bearer guard before any probe or write.
  const validated = validateDestinations(existingDestinations, origin, acceptedBearers);
  if (selectedCommand === "prepare" && validated.every(({ existing }) => !existing)) {
    write("No existing observability destinations require gateway rotation preparation\n");
    return;
  }

  let invalidBearer;
  do {
    invalidBearer = `watch-pr-invalid-probe-${randomUUID()}`;
  } while (acceptedBearers.includes(invalidBearer));
  let stagingBearer = bearer;
  if (!await probeGatewayBearer(origin, bearer, invalidBearer, fetchImpl)) {
    if (
      selectedCommand !== "prepare" ||
      !previousBearer ||
      !await probeGatewayBearer(origin, previousBearer, invalidBearer, fetchImpl)
    ) {
      throw new Error("Telemetry gateway rejected the required ingest bearer; no destinations were changed");
    }
    stagingBearer = previousBearer;
  }

  const changes = selectedCommand === "prepare"
    ? validated.filter(({ existing, bearer: existingBearer }) => existing && existingBearer === null)
    : validated;
  for (const { destination, existing } of changes) {
    const operation = existing ? "update" : "create";
    await cloudflareRequest(
      accountId,
      token,
      existing ? `${endpoint}/${encodeURIComponent(existing.slug)}` : endpoint,
      {
        method: existing ? "PATCH" : "POST",
        body: JSON.stringify(destinationPayload(destination, origin, stagingBearer, operation)),
      },
      fetchImpl,
    );
    write(`${existing ? "Updated" : "Created"} ${destination.name}\n`);
  }

  if (changes.length > 0) {
    const configuredDestinations = await listDestinations(accountId, token, endpoint, fetchImpl);
    const configured = validateDestinations(
      configuredDestinations,
      origin,
      selectedCommand === "configure" ? [bearer] : acceptedBearers,
      selectedCommand === "configure",
    );
    for (const { destination } of changes) {
      const retained = configured.find((item) => item.destination.name === destination.name);
      if (!retained.existing || !retained.existing.enabled || (retained.bearer !== null && retained.bearer !== stagingBearer)) {
        throw new Error(`${destination.name} did not retain the requested gateway configuration`);
      }
    }
    if (!await probeGatewayBearer(origin, stagingBearer, invalidBearer, fetchImpl)) {
      throw new Error("Telemetry gateway rejected the configured destination bearer");
    }
  }
  write(selectedCommand === "prepare"
    ? "Prepared existing observability destinations with a runtime-proven gateway bearer\n"
    : "Verified observability destination configuration and current gateway bearer acceptance\n");
}

async function main() {
  await configureObservability({ command: command(process.argv.slice(2)) });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : "Could not configure observability destinations");
    process.exitCode = 1;
  });
}
