// Allowlist sanitizer for Cloudflare's native OTLP/JSON export.
//
// Cloudflare attaches request headers, user agents, geography, ASN, full URLs, and
// storage keys to the spans and logs it exports. None of that may reach Azure. Every
// attribute on every surface (resource, scope, log record, span, event, link) is dropped
// unless its key is in ATTRIBUTE_LIMITS and its value is a bounded primitive; log bodies
// survive only as a `watch_pr.*` event marker with the record's bounded diagnostic fields.
// The input object is never mutated.

type Json = Record<string, unknown>;

const MAX_NAME_LENGTH = 128;
const MAX_URL_PATH_LENGTH = 256;
const MAX_DIAGNOSTIC_STRING_LENGTH = 128;
const MAX_DIAGNOSTIC_FIELDS = 32;

const DIAGNOSTIC_EVENTS = new Set([
  "watch_pr.do_storage",
  "watch_pr.webhook_fanout",
  "watch_pr.webhook_failure",
  "watch_pr.poll",
  "watch_pr.telemetry_gateway_invalid_payload",
  "watch_pr.telemetry_gateway_payload_too_large",
  "watch_pr.telemetry_gateway_token_failure",
  "watch_pr.telemetry_gateway_upstream_failure",
]);
const DIAGNOSTIC_FIELDS = new Set([
  "schema_version",
  "sample_rate",
  "sample_reason",
  "source",
  "github_event",
  "github_action",
  "storage_key_puts",
  "storage_key_deletes",
  "storage_key_writes",
  "encoded_state_bytes",
  "state_chunk_count",
  "state_format",
  "windowed_events",
  "predecessor_payload_references",
  "candidate_watches",
  "routed_watches",
  "duplicate_watches",
  "published_watches",
  "delivery_dedupe_puts",
  "compact_writes",
  "chunked_writes",
  "largest_state_bytes",
  "largest_state_chunk_count",
  "delivery_fingerprint",
  "error_kind",
  "error_name",
  "github_status",
  "active_sessions",
  "scheduled_watches",
  "refreshes_started",
  "signal",
  "status",
]);
const EXCEPTION_EVENT = "exception";
// Exact routes this deployment serves (src/index.ts, src/hub.ts, src/oidc-issuer.ts, the gateway
// itself). Any other path, including /monitor/<capability>, forwards only as its route template.
const STATIC_ROUTES: Record<string, true> = {
  "/": true,
  "/health": true,
  "/mcp": true,
  "/webhooks/github": true,
  "/oauth/register": true,
  "/oauth/authorize": true,
  "/oauth/callback": true,
  "/oauth/token": true,
  "/internal/poll": true,
  "/.well-known/oauth-protected-resource": true,
  "/.well-known/oauth-authorization-server": true,
  "/.well-known/openid-configuration": true,
  "/.well-known/jwks.json": true,
  "/v1/logs": true,
  "/v1/traces": true,
  "/v1/metrics": true,
};
const MONITOR_ROUTE_TEMPLATE = "/monitor/{capability}";
const UNKNOWN_ROUTE_TEMPLATE = "/{unknown}";
const MONITOR_ROUTE = /^\/monitor\/[A-Za-z0-9_-]+$/u;
const HTTP_METHODS = new Set(["CONNECT", "DELETE", "GET", "HEAD", "OPTIONS", "PATCH", "POST", "PUT", "TRACE"]);

/** Allowed attribute keys with their maximum string length. Anything absent is dropped. */
const ATTRIBUTE_LIMITS: Record<string, number> = {
  "service.name": 128,
  "service.version": 128,
  "service.namespace": 128,
  "service.instance.id": 128,
  "cloud.provider": 64,
  "cloud.platform": 64,
  "cloud.region": 64,
  "telemetry.sdk.name": 64,
  "telemetry.sdk.language": 64,
  "telemetry.sdk.version": 64,
  "faas.name": 128,
  "faas.version": 128,
  "faas.invocation_id": 128,
  "faas.invoked_region": 64,
  "faas.trigger": 32,
  "faas.cron": 64,
  "cloudflare.colo": 16,
  "cloudflare.script_name": 128,
  "cloudflare.script_version.id": 128,
  "cloudflare.invocation.sequence.number": 32,
  "cloudflare.ray_id": 64,
  "cloudflare.handler_type": 32,
  "cloudflare.entrypoint": 128,
  "cloudflare.execution_model": 32,
  "cloudflare.outcome": 32,
  "cloudflare.cpu_time_ms": 32,
  "cloudflare.wall_time_ms": 32,
  "cloudflare.scheduled_time": 64,
  "cloudflare.response.time_to_first_byte_ms": 32,
  "cloudflare.binding.type": 64,
  "cloudflare.binding.name": 128,
  "cloudflare.jsrpc.method": 128,
  "cloudflare.durable_object.response.rows_read": 32,
  "cloudflare.durable_object.response.rows_written": 32,
  "cloudflare.durable_object.response.db_size": 32,
  "cloudflare.durable_object.kv.query.keys.count": 32,
  "cloudflare.durable_object.kv.query.limit": 32,
  "cloudflare.durable_object.kv.query.reverse": 8,
  "cloudflare.durable_object.kv.response.deleted_count": 32,
  "db.system.name": 64,
  "db.operation.name": 64,
  "http.request.method": 16,
  "http.response.status_code": 8,
  "http.request.body.size": 32,
  "http.response.body.size": 32,
  "url.scheme": 8,
  "url.path": MAX_URL_PATH_LENGTH,
  "network.protocol.name": 16,
  "network.protocol.version": 16,
  "exception.type": MAX_NAME_LENGTH,

};
function isObject(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asArray(value: unknown): Json[] {
  return Array.isArray(value) ? value.filter(isObject) : [];
}

function boundedString(value: unknown, maximumLength: number): string | undefined {
  return typeof value === "string" && value.length > 0 && value.length <= maximumLength ? value : undefined;
}


function templatedPath(value: string): string {
  if (Object.hasOwn(STATIC_ROUTES, value)) return value;
  return MONITOR_ROUTE.test(value) ? MONITOR_ROUTE_TEMPLATE : UNKNOWN_ROUTE_TEMPLATE;
}

function isIntegerLike(value: unknown): boolean {
  if (typeof value === "number") return Number.isSafeInteger(value);
  return typeof value === "string" && /^-?\d{1,19}$/u.test(value);
}

function isDoubleLike(value: unknown): boolean {
  if (typeof value === "number") return Number.isFinite(value);
  return typeof value === "string" && value.length <= 32 && Number.isFinite(Number(value)) && value.trim() !== "";
}

function safeAnyValue(value: unknown, maximumLength: number): Json | undefined {
  if (!isObject(value)) return undefined;
  if (typeof value.stringValue === "string") {
    if (value.stringValue.length <= maximumLength) return { stringValue: value.stringValue };
    return undefined;
  }
  if (typeof value.boolValue === "boolean") return { boolValue: value.boolValue };
  if (isIntegerLike(value.intValue)) return { intValue: value.intValue };
  if (isDoubleLike(value.doubleValue)) return { doubleValue: value.doubleValue };
  return undefined;
}

function safeAttribute(attribute: Json): Json | undefined {
  const key = attribute.key;
  if (typeof key !== "string") return undefined;
  if (!Object.hasOwn(ATTRIBUTE_LIMITS, key)) return undefined;
  const limit = ATTRIBUTE_LIMITS[key];
  const value = safeAnyValue(attribute.value, limit);
  if (!value) return undefined;
  if (key === "http.request.method") {
    if (typeof value.stringValue !== "string" || !HTTP_METHODS.has(value.stringValue)) return undefined;
  }
  if (key === "url.path" && typeof value.stringValue === "string") {
    return { key, value: { stringValue: templatedPath(value.stringValue) } };
  }
  return { key, value };
}

interface Attributes {
  attributes: Json[];
  dropped: number;
}

function sanitizeAttributes(value: unknown): Attributes {
  const attributes: Json[] = [];
  let dropped = 0;
  for (const attribute of asArray(value)) {
    const safe = safeAttribute(attribute);
    if (safe) attributes.push(safe);
    else dropped += 1;
  }
  return { attributes, dropped };
}

function droppedCount(original: unknown, dropped: number): number {
  const count = isIntegerLike(original) ? Number(original) : 0;
  return (count > 0 ? count : 0) + dropped;
}

function withAttributes(out: Json, source: Json, extra: Json[] = []): Json {
  const { attributes, dropped } = sanitizeAttributes(source.attributes);
  const merged = extra.concat(attributes);
  if (merged.length > 0) out.attributes = merged;
  const count = droppedCount(source.droppedAttributesCount, dropped);
  if (count > 0) out.droppedAttributesCount = count;
  return out;
}

function copyIfDefined(out: Json, source: Json, key: string): void {
  if (source[key] !== undefined) out[key] = source[key];
}

function copyIfNumeric(out: Json, source: Json, key: string): void {
  const value = source[key];
  if (typeof value === "number" || typeof value === "string") out[key] = value;
}

function copyEnum(out: Json, source: Json, key: string): void {
  const value = source[key];
  if (typeof value === "number" || (typeof value === "string" && value.length <= 64)) out[key] = value;
}

function diagnosticAttributes(fields: Iterable<[string, unknown]>): Json[] {
  const attributes: Json[] = [];
  for (const [field, raw] of fields) {
    if (field === "event" || !DIAGNOSTIC_FIELDS.has(field)) continue;
    let value: Json | undefined;
    if (typeof raw === "string") value = raw.length <= MAX_DIAGNOSTIC_STRING_LENGTH ? { stringValue: raw } : undefined;
    else if (typeof raw === "boolean") value = { boolValue: raw };
    else if (typeof raw === "number" && Number.isFinite(raw)) {
      value = Number.isSafeInteger(raw) ? { intValue: raw } : { doubleValue: raw };
    }
    if (!value) continue;
    attributes.push({ key: `watch_pr.${field}`, value });
    if (attributes.length === MAX_DIAGNOSTIC_FIELDS) break;
  }
  return attributes;
}

function primitiveOf(value: unknown): unknown {
  if (!isObject(value)) return undefined;
  if (typeof value.stringValue === "string") return value.stringValue;
  if (typeof value.boolValue === "boolean") return value.boolValue;
  if (isIntegerLike(value.intValue)) return Number(value.intValue);
  if (isDoubleLike(value.doubleValue)) return Number(value.doubleValue);
  return undefined;
}

interface Body {
  marker: string;
  fields: Json[];
}

/** Recovers the `watch_pr.*` marker and bounded fields from a structured hub log; anything else is discarded. */
function diagnosticBody(body: unknown): Body | undefined {
  if (!isObject(body)) return undefined;
  if (typeof body.stringValue === "string") {
    const text = body.stringValue.trim();
    if (DIAGNOSTIC_EVENTS.has(text)) return { marker: text, fields: [] };
    if (!text.startsWith("{") || text.length > 4096) return undefined;
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return undefined;
    }
    if (!isObject(parsed) || typeof parsed.event !== "string" || !DIAGNOSTIC_EVENTS.has(parsed.event)) return undefined;
    return { marker: parsed.event, fields: diagnosticAttributes(Object.entries(parsed)) };
  }
  if (isObject(body.kvlistValue)) {
    const entries: [string, unknown][] = [];
    for (const item of asArray(body.kvlistValue.values)) {
      if (typeof item.key === "string") entries.push([item.key, primitiveOf(item.value)]);
    }
    const marker = entries.find(([key]) => key === "event")?.[1];
    if (typeof marker !== "string" || !DIAGNOSTIC_EVENTS.has(marker)) return undefined;
    return { marker, fields: diagnosticAttributes(entries) };
  }
  return undefined;
}

function sanitizeScope(value: Json): Json {
  return withAttributes({}, value);
}

function sanitizeLogRecord(value: Json): Json {
  const out: Json = {};
  copyIfNumeric(out, value, "timeUnixNano");
  copyIfNumeric(out, value, "observedTimeUnixNano");
  copyEnum(out, value, "severityNumber");
  // severityNumber preserves the operational level; native severity text is arbitrary text.
  const body = diagnosticBody(value.body);
  if (body) out.body = { stringValue: body.marker };
  withAttributes(out, value, body?.fields);
  copyIfNumeric(out, value, "flags");
  copyIfDefined(out, value, "traceId");
  copyIfDefined(out, value, "spanId");
  return out;
}

function sanitizeScopeLogs(value: Json): Json {
  const out: Json = {};
  if (isObject(value.scope)) out.scope = sanitizeScope(value.scope);
  out.logRecords = asArray(value.logRecords).map(sanitizeLogRecord);
  return out;
}

function sanitizeResourceLogs(value: Json): Json {
  const out: Json = {};
  if (isObject(value.resource)) out.resource = withAttributes({}, value.resource);
  out.scopeLogs = asArray(value.scopeLogs).map(sanitizeScopeLogs);
  return out;
}

function sanitizeStatus(value: Json): Json {
  const out: Json = {};
  copyEnum(out, value, "code");
  return out;
}

function sanitizeEvent(value: Json): Json | undefined {
  if (value.name !== EXCEPTION_EVENT) return undefined;
  const out: Json = { name: EXCEPTION_EVENT };
  copyIfNumeric(out, value, "timeUnixNano");
  return withAttributes(out, value);
}

function attributeString(attributes: unknown, key: string): string | undefined {
  for (const attribute of asArray(attributes)) {
    if (attribute.key !== key || !isObject(attribute.value)) continue;
    if (typeof attribute.value.stringValue === "string") return attribute.value.stringValue;
  }
  return undefined;
}

function spanName(attributes: unknown): string {
  const method = attributeString(attributes, "http.request.method");
  const path = attributeString(attributes, "url.path");
  if (method !== undefined && path !== undefined) return `${method} ${path}`;
  if (method !== undefined) return method;
  return "worker";
}

function sanitizeLink(value: Json): Json {
  const out: Json = {};
  copyIfDefined(out, value, "traceId");
  copyIfDefined(out, value, "spanId");
  withAttributes(out, value);
  copyIfNumeric(out, value, "flags");
  return out;
}

function sanitizeSpan(value: Json): Json {
  const out: Json = {};
  copyIfDefined(out, value, "traceId");
  copyIfDefined(out, value, "spanId");
  copyIfDefined(out, value, "parentSpanId");
  copyEnum(out, value, "kind");
  copyIfNumeric(out, value, "startTimeUnixNano");
  copyIfNumeric(out, value, "endTimeUnixNano");
  withAttributes(out, value);
  out.name = spanName(out.attributes);
  const events = asArray(value.events);
  const sanitizedEvents = events
    .map(sanitizeEvent)
    .filter((event): event is Json => event !== undefined);
  if (sanitizedEvents.length > 0) out.events = sanitizedEvents;
  const droppedEvents = droppedCount(value.droppedEventsCount, events.length - sanitizedEvents.length);
  if (droppedEvents > 0) out.droppedEventsCount = droppedEvents;
  const links = asArray(value.links);
  if (links.length > 0) out.links = links.map(sanitizeLink);
  copyIfNumeric(out, value, "droppedLinksCount");
  if (isObject(value.status)) out.status = sanitizeStatus(value.status);
  copyIfNumeric(out, value, "flags");
  return out;
}

function sanitizeScopeSpans(value: Json): Json {
  const out: Json = {};
  if (isObject(value.scope)) out.scope = sanitizeScope(value.scope);
  out.spans = asArray(value.spans).map(sanitizeSpan);
  return out;
}

function sanitizeResourceSpans(value: Json): Json {
  const out: Json = {};
  if (isObject(value.resource)) out.resource = withAttributes({}, value.resource);
  out.scopeSpans = asArray(value.scopeSpans).map(sanitizeScopeSpans);
  return out;
}

function requireRequest(json: unknown): Json {
  if (!isObject(json)) throw new Error("OTLP request must be a JSON object");
  return json;
}

export function sanitizeLogsRequest(json: unknown): Json {
  return { resourceLogs: asArray(requireRequest(json).resourceLogs).map(sanitizeResourceLogs) };
}

export function sanitizeTraceRequest(json: unknown): Json {
  return { resourceSpans: asArray(requireRequest(json).resourceSpans).map(sanitizeResourceSpans) };
}
