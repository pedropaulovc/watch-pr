import { describe, expect, it } from "vitest";
import { encodeTraceRequest } from "../src/otlp-protobuf";
import { sanitizeLogsRequest, sanitizeTraceRequest } from "../src/otlp-sanitize";

type Json = Record<string, unknown>;

const str = (value: string) => ({ stringValue: value });

/** Walks `path` through nested OTLP JSON, taking the first element of every array. */
function first(root: Json, ...path: string[]): Json {
  let node: Json = root;
  for (const key of path) node = (node[key] as Json[])[0]!;
  return node;
}

function spanAttributes(attributes: Json[]): Json[] {
  const sanitized = sanitizeTraceRequest({ resourceSpans: [{ scopeSpans: [{ spans: [{ attributes }] }] }] });
  return (first(sanitized, "resourceSpans", "scopeSpans", "spans").attributes as Json[] | undefined) ?? [];
}

describe("OTLP sanitizer", () => {
  it("forwards url.path only as an exact static route or its template", () => {
    const paths = [
      "/oauth/callback",
      "/.well-known/oauth-protected-resource",
      "/monitor/AbC123-_xyz",
      "/monitor/alice-smith",
      "/monitor/",
      "/monitor/a/b",
      "/monitor/a%2Fb",
      "/health",
      "/",
      "/arbitrary-sensitive-label",
      "/health/",
      "/oauth/callback/../monitor/x",
    ];
    const attributes = spanAttributes(paths.map((path) => ({ key: "url.path", value: str(path) })));

    expect(attributes.map((attribute) => attribute.value)).toEqual([
      str("/oauth/callback"),
      str("/.well-known/oauth-protected-resource"),
      str("/monitor/{capability}"),
      str("/monitor/{capability}"),
      str("/{unknown}"),
      str("/{unknown}"),
      str("/{unknown}"),
      str("/health"),
      str("/"),
      str("/{unknown}"),
      str("/{unknown}"),
      str("/{unknown}"),
    ]);
  });

  it("derives span names from sanitized HTTP semantics and drops inherited keys", () => {
    const sanitized = sanitizeTraceRequest({
      resourceSpans: [{ scopeSpans: [{ spans: [
        {
          name: "PRIVATE-SPAN-NAME",
          attributes: [
            { key: "http.request.method", value: str("GET") },
            { key: "url.path", value: str("/monitor/private-capability") },
            { key: "constructor", value: { boolValue: true } },
          ],
        },
        {
          name: "PRIVATE-SPAN-NAME-2",
          attributes: [
            { key: "http.request.method", value: str("PRIVATE-METHOD") },
            { key: "url.path", value: str("/private-route") },
            { key: "toString", value: { intValue: 1 } },
            { key: "__proto__", value: { doubleValue: 1 } },
          ],
        },
      ] }] }],
    });
    const spans = first(sanitized, "resourceSpans", "scopeSpans").spans as Json[];

    expect(spans.map((span) => span.name)).toEqual(["GET /monitor/{capability}", "worker"]);
    expect(spans[0]!.attributes).toEqual([
      { key: "http.request.method", value: str("GET") },
      { key: "url.path", value: str("/monitor/{capability}") },
    ]);
    expect(spans[1]!.attributes).toEqual([{ key: "url.path", value: str("/{unknown}") }]);
    expect(JSON.stringify(sanitized)).not.toContain("PRIVATE-SPAN-NAME");
    expect(JSON.stringify(sanitized)).not.toContain("PRIVATE-METHOD");
  });

  it("drops nested, binary, and overlong values even under allowlisted keys, and counts them as dropped", () => {
    const sanitized = sanitizeTraceRequest({
      resourceSpans: [{
        resource: {
          droppedAttributesCount: 2,
          attributes: [
            { key: "service.name", value: { arrayValue: { values: [str("watch-pr")] } } },
            { key: "service.name", value: { kvlistValue: { values: [{ key: "x", value: str("y") }] } } },
            { key: "service.name", value: { bytesValue: "d2F0Y2gtcHI=" } },
            { key: "service.name", value: str("x".repeat(129)) },
            { key: "service.version", value: str("2026.09.12") },
          ],
        },
        scopeSpans: [],
      }],
    });
    const resource = first(sanitized, "resourceSpans").resource as Json;

    expect(resource.attributes).toEqual([{ key: "service.version", value: str("2026.09.12") }]);
    expect(resource.droppedAttributesCount).toBe(6);
  });

  it("keeps named exception events without raw messages", () => {
    const sanitized = sanitizeTraceRequest({
      resourceSpans: [{ scopeSpans: [{ spans: [{
        events: [
          { name: "exception", attributes: [
            { key: "exception.type", value: str("GithubApiError") },
            { key: "exception.message", value: str("private/repository/path") },
          ] },
          { name: "PRIVATE-EVENT" },
        ],
      }] }] }],
    });
    const span = first(sanitized, "resourceSpans", "scopeSpans", "spans");

    expect(span.events).toEqual([{
      name: "exception",
      attributes: [{ key: "exception.type", value: str("GithubApiError") }],
      droppedAttributesCount: 1,
    }]);
    expect(span.droppedEventsCount).toBe(1);
  });

  it("lifts only enumerated hub fields and drops raw log bodies", () => {
    const sanitized = sanitizeLogsRequest({
      resourceLogs: [{
        scopeLogs: [{
          logRecords: [
            { body: { kvlistValue: { values: [
              { key: "event", value: str("watch_pr.poll") },
              { key: "active_sessions", value: { intValue: "3" } },
              { key: "repository", value: str("private-repository") },
              { key: "email", value: str("owner@example.test") },
              { key: "api_key", value: str("secret-key") },
            ] } } },
            { body: str(JSON.stringify({
              event: "watch_pr.do_storage",
              sample_rate: 0.01,
              state_format: "sidecar",
              windowed_events: 100,
              predecessor_payload_references: 99,
              chunked: true,
              repository: "private-repository",
              api_key: "secret-key",
            })) },
            { body: str(JSON.stringify({
              event: "watch_pr.webhook_admission",
              github_event: "pull_request",
              outcome: "accepted",
              delivery_id: "private-delivery-id",
              repository: "private-repository",
            })) },
            { body: str("watch_pr.poll ") },
            { body: str(JSON.stringify({ event: "not_ours", request_headers: { cookie: "sid" } })) },
            { body: str("plain console output with https://watch-pr.vza.net/monitor/cap") },
          ],
        }],
      }],
    });
    const records = first(sanitized, "resourceLogs", "scopeLogs").logRecords as Json[];

    expect(records[0]).toEqual({
      body: str("watch_pr.poll"),
      attributes: [{ key: "watch_pr.active_sessions", value: { intValue: 3 } }],
    });
    expect(records[1]).toEqual({
      body: str("watch_pr.do_storage"),
      attributes: [
        { key: "watch_pr.sample_rate", value: { doubleValue: 0.01 } },
        { key: "watch_pr.state_format", value: str("sidecar") },
        { key: "watch_pr.windowed_events", value: { intValue: 100 } },
        { key: "watch_pr.predecessor_payload_references", value: { intValue: 99 } },
      ],
    });
    expect(records[2]).toEqual({
      body: str("watch_pr.webhook_admission"),
      attributes: [
        { key: "watch_pr.github_event", value: str("pull_request") },
        { key: "watch_pr.outcome", value: str("accepted") },
      ],
    });
    expect(records[3]).toEqual({ body: str("watch_pr.poll") });
    expect(records[4]).toEqual({});
    expect(records[5]).toEqual({});
  });

  it("does not mutate the parsed payload", () => {
    const input = {
      resourceSpans: [{
        resource: { attributes: [{ key: "user_agent.original", value: str("Mozilla/5.0") }] },
        scopeSpans: [{ spans: [{ name: "GET", attributes: [{ key: "url.full", value: str("https://x/?a=b") }] }] }],
      }],
    };
    const snapshot = JSON.stringify(input);

    sanitizeTraceRequest(input);

    expect(JSON.stringify(input)).toBe(snapshot);
  });

  it("preserves strict identifier validation downstream", () => {
    const sanitized = sanitizeTraceRequest({
      resourceSpans: [{ scopeSpans: [{ spans: [{ traceId: "0".repeat(32), spanId: "1112131415161718" }] }] }],
    });

    expect(() => encodeTraceRequest(sanitized)).toThrow("Invalid 16-byte OTLP identifier");
    expect(() => sanitizeTraceRequest(null)).toThrow();
    expect(() => sanitizeLogsRequest([])).toThrow();
  });
});
