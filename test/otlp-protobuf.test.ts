import { describe, expect, it } from "vitest";
import { encodeLogsRequest, encodeTraceRequest } from "../src/otlp-protobuf";

interface Field {
  field: number;
  wire: number;
  value: bigint | Uint8Array;
}

function readVarint(buffer: Uint8Array, position: number): [bigint, number] {
  let result = 0n;
  let shift = 0n;
  for (;;) {
    const byte = buffer[position++];
    result |= BigInt(byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) break;
    shift += 7n;
  }
  return [result, position];
}

function decode(buffer: Uint8Array): Field[] {
  const fields: Field[] = [];
  let position = 0;
  while (position < buffer.length) {
    const [tag, next] = readVarint(buffer, position);
    position = next;
    const field = Number(tag >> 3n);
    const wire = Number(tag & 0x7n);
    if (wire === 0) {
      const [value, nextPosition] = readVarint(buffer, position);
      position = nextPosition;
      fields.push({ field, wire, value });
      continue;
    }
    if (wire === 1) {
      fields.push({ field, wire, value: buffer.slice(position, position + 8) });
      position += 8;
      continue;
    }
    if (wire === 2) {
      const [length, nextPosition] = readVarint(buffer, position);
      position = nextPosition;
      const size = Number(length);
      fields.push({ field, wire, value: buffer.slice(position, position + size) });
      position += size;
      continue;
    }
    if (wire === 5) {
      fields.push({ field, wire, value: buffer.slice(position, position + 4) });
      position += 4;
      continue;
    }
    throw new Error(`unsupported wire type ${wire}`);
  }
  return fields;
}

function bytes(field: Field): Uint8Array {
  return field.value as Uint8Array;
}

function string(field: Field): string {
  return new TextDecoder().decode(field.value as Uint8Array);
}

function number(field: Field): bigint {
  return field.value as bigint;
}

function fixed64le(field: Field): bigint {
  const value = field.value as Uint8Array;
  let result = 0n;
  for (let index = 7; index >= 0; index -= 1) result = (result << 8n) | BigInt(value[index]);
  return result;
}

function hex(field: Field): string {
  return Array.from(field.value as Uint8Array)
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function only(fields: Field[], field: number): Field {
  const matches = fields.filter((entry) => entry.field === field);
  expect(matches).toHaveLength(1);
  return matches[0]!;
}

describe("encodeLogsRequest", () => {
  it("round-trips a log record's attributes, body, severity, timestamp, and IDs", () => {
    const encoded = encodeLogsRequest({
      resourceLogs: [{
        resource: { attributes: [{ key: "service.name", value: { stringValue: "watch-pr" } }] },
        scopeLogs: [{
          scope: { name: "cloudflare" },
          logRecords: [{
            timeUnixNano: "1782964800855000000",
            severityNumber: 9,
            severityText: "INFO",
            body: { stringValue: "safe structured telemetry" },
            attributes: [{ key: "http.status", value: { intValue: "200" } }],
            traceId: "0102030405060708090a0b0c0d0e0f10",
            spanId: "1112131415161718",
          }],
        }],
      }],
    });

    const request = decode(encoded);
    const resourceLogs = decode(bytes(only(request, 1)));
    const resource = decode(bytes(only(resourceLogs, 1)));
    const resourceAttribute = decode(bytes(only(resource, 1)));
    expect(string(only(resourceAttribute, 1))).toBe("service.name");
    expect(string(only(decode(bytes(only(resourceAttribute, 2))), 1))).toBe("watch-pr");

    const scopeLogs = decode(bytes(only(resourceLogs, 2)));
    expect(string(only(decode(bytes(only(scopeLogs, 1))), 1))).toBe("cloudflare");
    const record = decode(bytes(only(scopeLogs, 2)));
    expect(fixed64le(only(record, 1))).toBe(1782964800855000000n);
    expect(number(only(record, 2))).toBe(9n);
    expect(string(only(record, 3))).toBe("INFO");
    expect(string(only(decode(bytes(only(record, 5))), 1))).toBe("safe structured telemetry");

    const attribute = decode(bytes(only(record, 6)));
    expect(string(only(attribute, 1))).toBe("http.status");
    expect(number(only(decode(bytes(only(attribute, 2))), 3))).toBe(200n);
    expect(hex(only(record, 9))).toBe("0102030405060708090a0b0c0d0e0f10");
    expect(hex(only(record, 10))).toBe("1112131415161718");
  });

  it("returns empty bytes for empty requests", () => {
    expect(encodeLogsRequest({})).toHaveLength(0);
    expect(encodeLogsRequest({ resourceLogs: [] })).toHaveLength(0);
  });
  it("rejects malformed log correlation identifiers", () => {
    expect(() => encodeLogsRequest({
      resourceLogs: [{ scopeLogs: [{ logRecords: [{ traceId: "f".repeat(31) }] }] }],
    })).toThrow("Invalid 16-byte OTLP identifier");
    expect(() => encodeLogsRequest({
      resourceLogs: [{ scopeLogs: [{ logRecords: [{ spanId: "g".repeat(16) }] }] }],
    })).toThrow("Invalid 8-byte OTLP identifier");
  });
});


function traceRequest(span: Record<string, unknown>) {
  return { resourceSpans: [{ scopeSpans: [{ spans: [span] }] }] };
}

describe("encodeTraceRequest", () => {
  it("round-trips span identifiers, timing, kind, and status", () => {
    const encoded = encodeTraceRequest({
      resourceSpans: [{
        resource: { attributes: [{ key: "service.name", value: { stringValue: "watch-pr" } }] },
        scopeSpans: [{
          scope: { name: "cloudflare" },
          spans: [{
            traceId: "0102030405060708090a0b0c0d0e0f10",
            spanId: "1112131415161718",
            parentSpanId: "2122232425262728",
            name: "fetch",
            kind: 2,
            startTimeUnixNano: "1782964800000000000",
            endTimeUnixNano: "1782964800500000000",
            status: { code: 2, message: "error" },
          }],
        }],
      }],
    });

    const resourceSpans = decode(bytes(only(decode(encoded), 1)));
    const scopeSpans = decode(bytes(only(resourceSpans, 2)));
    const span = decode(bytes(only(scopeSpans, 2)));
    expect(hex(only(span, 1))).toBe("0102030405060708090a0b0c0d0e0f10");
    expect(hex(only(span, 2))).toBe("1112131415161718");
    expect(hex(only(span, 4))).toBe("2122232425262728");
    expect(string(only(span, 5))).toBe("fetch");
    expect(number(only(span, 6))).toBe(2n);
    expect(fixed64le(only(span, 7))).toBe(1782964800000000000n);
    expect(fixed64le(only(span, 8))).toBe(1782964800500000000n);

    const status = decode(bytes(only(span, 15)));
    expect(string(only(status, 2))).toBe("error");
    expect(number(only(status, 3))).toBe(2n);
  });

  it("accepts named OTLP enums", () => {
    const encoded = encodeTraceRequest({
      resourceSpans: [{
        scopeSpans: [{
          spans: [{ name: "client", kind: "SPAN_KIND_CLIENT", status: { code: "STATUS_CODE_OK" } }],
        }],
      }],
    });
    const resourceSpans = decode(bytes(only(decode(encoded), 1)));
    const scopeSpans = decode(bytes(only(resourceSpans, 2)));
    const span = decode(bytes(only(scopeSpans, 2)));
    expect(number(only(span, 6))).toBe(3n);
    expect(number(only(decode(bytes(only(span, 15))), 3))).toBe(1n);
  });

  it("rejects malformed span and link identifiers", () => {
    expect(() => encodeTraceRequest(traceRequest({ traceId: "0".repeat(32) }))).toThrow("Invalid 16-byte OTLP identifier");
    expect(() => encodeTraceRequest(traceRequest({ spanId: "a".repeat(15) }))).toThrow("Invalid 8-byte OTLP identifier");
    expect(() => encodeTraceRequest(traceRequest({ parentSpanId: "0".repeat(16) }))).toThrow("Invalid 8-byte OTLP identifier");
    expect(() => encodeTraceRequest(traceRequest({ links: [{ traceId: "z".repeat(32) }] }))).toThrow("Invalid 16-byte OTLP identifier");
    expect(() => encodeTraceRequest(traceRequest({ links: [{ spanId: "b".repeat(15) }] }))).toThrow("Invalid 8-byte OTLP identifier");
  });
});
