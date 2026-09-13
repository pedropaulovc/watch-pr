const WIRE_VARINT = 0;
const WIRE_FIXED64 = 1;
const WIRE_LEN = 2;
const WIRE_FIXED32 = 5;

const encoder = new TextEncoder();

function pushTag(out: number[], field: number, wire: number): void {
  pushVarint(out, (field << 3) | wire);
}

function pushVarint(out: number[], value: number): void {
  let current = value >>> 0;
  while (current > 0x7f) {
    out.push((current & 0x7f) | 0x80);
    current >>>= 7;
  }
  out.push(current);
}

function pushVarintBig(out: number[], value: bigint): void {
  let current = value < 0n ? value + (1n << 64n) : value;
  while (current > 0x7fn) {
    out.push(Number((current & 0x7fn) | 0x80n));
    current >>= 7n;
  }
  out.push(Number(current));
}

function pushFixed64(out: number[], value: bigint): void {
  let current = value < 0n ? value + (1n << 64n) : value;
  for (let index = 0; index < 8; index += 1) {
    out.push(Number(current & 0xffn));
    current >>= 8n;
  }
}

function pushFixed32(out: number[], value: number): void {
  let current = value >>> 0;
  for (let index = 0; index < 4; index += 1) {
    out.push(current & 0xff);
    current >>>= 8;
  }
}

function pushDouble(out: number[], value: number): void {
  const buffer = new Uint8Array(8);
  new DataView(buffer.buffer).setFloat64(0, value, true);
  for (const byte of buffer) out.push(byte);
}

function pushLenField(out: number[], field: number, bytes: ArrayLike<number>): void {
  pushTag(out, field, WIRE_LEN);
  pushVarint(out, bytes.length);
  for (let index = 0; index < bytes.length; index += 1) out.push(bytes[index]);
}

function pushStringField(out: number[], field: number, value: string): void {
  pushLenField(out, field, encoder.encode(value));
}

function pushMessageField(out: number[], field: number, message: number[]): void {
  pushLenField(out, field, message);
}

function pushVarintField(out: number[], field: number, value: number): void {
  pushTag(out, field, WIRE_VARINT);
  pushVarint(out, value);
}

function pushFixed64Field(out: number[], field: number, value: bigint): void {
  pushTag(out, field, WIRE_FIXED64);
  pushFixed64(out, value);
}

function hexToBytes(hex: string, byteLength: number): Uint8Array {
  if (
    hex.length !== byteLength * 2 ||
    !/^[0-9a-f]+$/iu.test(hex) ||
    /^0+$/u.test(hex)
  ) {
    throw new Error(`Invalid ${byteLength}-byte OTLP identifier`);
  }
  const bytes = new Uint8Array(byteLength);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
}

function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

type Json = Record<string, unknown>;

const SEVERITY_NUMBER: Record<string, number> = {
  SEVERITY_NUMBER_UNSPECIFIED: 0, SEVERITY_NUMBER_TRACE: 1, SEVERITY_NUMBER_TRACE2: 2,
  SEVERITY_NUMBER_TRACE3: 3, SEVERITY_NUMBER_TRACE4: 4, SEVERITY_NUMBER_DEBUG: 5,
  SEVERITY_NUMBER_DEBUG2: 6, SEVERITY_NUMBER_DEBUG3: 7, SEVERITY_NUMBER_DEBUG4: 8,
  SEVERITY_NUMBER_INFO: 9, SEVERITY_NUMBER_INFO2: 10, SEVERITY_NUMBER_INFO3: 11,
  SEVERITY_NUMBER_INFO4: 12, SEVERITY_NUMBER_WARN: 13, SEVERITY_NUMBER_WARN2: 14,
  SEVERITY_NUMBER_WARN3: 15, SEVERITY_NUMBER_WARN4: 16, SEVERITY_NUMBER_ERROR: 17,
  SEVERITY_NUMBER_ERROR2: 18, SEVERITY_NUMBER_ERROR3: 19, SEVERITY_NUMBER_ERROR4: 20,
  SEVERITY_NUMBER_FATAL: 21, SEVERITY_NUMBER_FATAL2: 22, SEVERITY_NUMBER_FATAL3: 23,
  SEVERITY_NUMBER_FATAL4: 24,
};

const SPAN_KIND: Record<string, number> = {
  SPAN_KIND_UNSPECIFIED: 0, SPAN_KIND_INTERNAL: 1, SPAN_KIND_SERVER: 2,
  SPAN_KIND_CLIENT: 3, SPAN_KIND_PRODUCER: 4, SPAN_KIND_CONSUMER: 5,
};

const STATUS_CODE: Record<string, number> = {
  STATUS_CODE_UNSET: 0, STATUS_CODE_OK: 1, STATUS_CODE_ERROR: 2,
};

function enumInt(value: unknown, names: Record<string, number>): number {
  if (typeof value === "number") return value;
  if (typeof value === "string") {
    if (value in names) return names[value];
    const numeric = Number(value);
    if (!Number.isNaN(numeric)) return numeric;
  }
  return 0;
}

function encodeAnyValue(value: Json): number[] {
  const out: number[] = [];
  if (value.stringValue !== undefined) pushStringField(out, 1, String(value.stringValue));
  else if (value.boolValue !== undefined) pushVarintField(out, 2, value.boolValue ? 1 : 0);
  else if (value.intValue !== undefined) {
    pushTag(out, 3, WIRE_VARINT);
    pushVarintBig(out, BigInt(value.intValue as string | number));
  } else if (value.doubleValue !== undefined) {
    pushTag(out, 4, WIRE_FIXED64);
    pushDouble(out, Number(value.doubleValue));
  } else if (value.arrayValue !== undefined) {
    pushMessageField(out, 5, encodeArrayValue(value.arrayValue as Json));
  } else if (value.kvlistValue !== undefined) {
    pushMessageField(out, 6, encodeKvList(value.kvlistValue as Json));
  } else if (value.bytesValue !== undefined) {
    pushLenField(out, 7, base64ToBytes(String(value.bytesValue)));
  }
  return out;
}

function encodeArrayValue(value: Json): number[] {
  const out: number[] = [];
  for (const item of (value.values as Json[]) ?? []) pushMessageField(out, 1, encodeAnyValue(item));
  return out;
}

function encodeKvList(value: Json): number[] {
  const out: number[] = [];
  for (const item of (value.values as Json[]) ?? []) pushMessageField(out, 1, encodeKeyValue(item));
  return out;
}

function encodeKeyValue(value: Json): number[] {
  const out: number[] = [];
  if (value.key !== undefined) pushStringField(out, 1, String(value.key));
  if (value.value !== undefined) pushMessageField(out, 2, encodeAnyValue(value.value as Json));
  return out;
}

function encodeAttributes(out: number[], field: number, attributes: unknown): void {
  for (const attribute of (attributes as Json[]) ?? []) pushMessageField(out, field, encodeKeyValue(attribute));
}

function encodeResource(value: Json): number[] {
  const out: number[] = [];
  encodeAttributes(out, 1, value.attributes);
  if (value.droppedAttributesCount) pushVarintField(out, 2, Number(value.droppedAttributesCount));
  return out;
}

function encodeScope(value: Json): number[] {
  const out: number[] = [];
  if (value.name) pushStringField(out, 1, String(value.name));
  if (value.version) pushStringField(out, 2, String(value.version));
  encodeAttributes(out, 3, value.attributes);
  if (value.droppedAttributesCount) pushVarintField(out, 4, Number(value.droppedAttributesCount));
  return out;
}

function encodeLogRecord(value: Json): number[] {
  const out: number[] = [];
  if (value.timeUnixNano) pushFixed64Field(out, 1, BigInt(value.timeUnixNano as string));
  if (value.severityNumber !== undefined) pushVarintField(out, 2, enumInt(value.severityNumber, SEVERITY_NUMBER));
  if (value.severityText) pushStringField(out, 3, String(value.severityText));
  if (value.body !== undefined) pushMessageField(out, 5, encodeAnyValue(value.body as Json));
  encodeAttributes(out, 6, value.attributes);
  if (value.droppedAttributesCount) pushVarintField(out, 7, Number(value.droppedAttributesCount));
  if (value.flags) {
    pushTag(out, 8, WIRE_FIXED32);
    pushFixed32(out, Number(value.flags));
  }
  if (value.traceId !== undefined) pushLenField(out, 9, hexToBytes(String(value.traceId), 16));
  if (value.spanId !== undefined) pushLenField(out, 10, hexToBytes(String(value.spanId), 8));
  if (value.observedTimeUnixNano) pushFixed64Field(out, 11, BigInt(value.observedTimeUnixNano as string));
  return out;
}

function encodeScopeLogs(value: Json): number[] {
  const out: number[] = [];
  if (value.scope) pushMessageField(out, 1, encodeScope(value.scope as Json));
  for (const record of (value.logRecords as Json[]) ?? []) pushMessageField(out, 2, encodeLogRecord(record));
  if (value.schemaUrl) pushStringField(out, 3, String(value.schemaUrl));
  return out;
}

function encodeResourceLogs(value: Json): number[] {
  const out: number[] = [];
  if (value.resource) pushMessageField(out, 1, encodeResource(value.resource as Json));
  for (const scopeLogs of (value.scopeLogs as Json[]) ?? []) pushMessageField(out, 2, encodeScopeLogs(scopeLogs));
  if (value.schemaUrl) pushStringField(out, 3, String(value.schemaUrl));
  return out;
}

export function encodeLogsRequest(json: Json): Uint8Array {
  const out: number[] = [];
  for (const resourceLogs of (json.resourceLogs as Json[]) ?? []) pushMessageField(out, 1, encodeResourceLogs(resourceLogs));
  return Uint8Array.from(out);
}

function encodeStatus(value: Json): number[] {
  const out: number[] = [];
  if (value.message) pushStringField(out, 2, String(value.message));
  if (value.code !== undefined) pushVarintField(out, 3, enumInt(value.code, STATUS_CODE));
  return out;
}

function encodeEvent(value: Json): number[] {
  const out: number[] = [];
  if (value.timeUnixNano) pushFixed64Field(out, 1, BigInt(value.timeUnixNano as string));
  if (value.name) pushStringField(out, 2, String(value.name));
  encodeAttributes(out, 3, value.attributes);
  if (value.droppedAttributesCount) pushVarintField(out, 4, Number(value.droppedAttributesCount));
  return out;
}

function encodeLink(value: Json): number[] {
  const out: number[] = [];
  if (value.traceId !== undefined) pushLenField(out, 1, hexToBytes(String(value.traceId), 16));
  if (value.spanId !== undefined) pushLenField(out, 2, hexToBytes(String(value.spanId), 8));
  if (value.traceState) pushStringField(out, 3, String(value.traceState));
  encodeAttributes(out, 4, value.attributes);
  if (value.droppedAttributesCount) pushVarintField(out, 5, Number(value.droppedAttributesCount));
  if (value.flags) {
    pushTag(out, 6, WIRE_FIXED32);
    pushFixed32(out, Number(value.flags));
  }
  return out;
}

function encodeSpan(value: Json): number[] {
  const out: number[] = [];
  if (value.traceId !== undefined) pushLenField(out, 1, hexToBytes(String(value.traceId), 16));
  if (value.spanId !== undefined) pushLenField(out, 2, hexToBytes(String(value.spanId), 8));
  if (value.traceState) pushStringField(out, 3, String(value.traceState));
  if (value.parentSpanId !== undefined) pushLenField(out, 4, hexToBytes(String(value.parentSpanId), 8));
  if (value.name) pushStringField(out, 5, String(value.name));
  if (value.kind !== undefined) pushVarintField(out, 6, enumInt(value.kind, SPAN_KIND));
  if (value.startTimeUnixNano) pushFixed64Field(out, 7, BigInt(value.startTimeUnixNano as string));
  if (value.endTimeUnixNano) pushFixed64Field(out, 8, BigInt(value.endTimeUnixNano as string));
  encodeAttributes(out, 9, value.attributes);
  if (value.droppedAttributesCount) pushVarintField(out, 10, Number(value.droppedAttributesCount));
  for (const event of (value.events as Json[]) ?? []) pushMessageField(out, 11, encodeEvent(event));
  if (value.droppedEventsCount) pushVarintField(out, 12, Number(value.droppedEventsCount));
  for (const link of (value.links as Json[]) ?? []) pushMessageField(out, 13, encodeLink(link));
  if (value.droppedLinksCount) pushVarintField(out, 14, Number(value.droppedLinksCount));
  if (value.status) pushMessageField(out, 15, encodeStatus(value.status as Json));
  if (value.flags) {
    pushTag(out, 16, WIRE_FIXED32);
    pushFixed32(out, Number(value.flags));
  }
  return out;
}

function encodeScopeSpans(value: Json): number[] {
  const out: number[] = [];
  if (value.scope) pushMessageField(out, 1, encodeScope(value.scope as Json));
  for (const span of (value.spans as Json[]) ?? []) pushMessageField(out, 2, encodeSpan(span));
  if (value.schemaUrl) pushStringField(out, 3, String(value.schemaUrl));
  return out;
}

function encodeResourceSpans(value: Json): number[] {
  const out: number[] = [];
  if (value.resource) pushMessageField(out, 1, encodeResource(value.resource as Json));
  for (const scopeSpans of (value.scopeSpans as Json[]) ?? []) pushMessageField(out, 2, encodeScopeSpans(scopeSpans));
  if (value.schemaUrl) pushStringField(out, 3, String(value.schemaUrl));
  return out;
}

export function encodeTraceRequest(json: Json): Uint8Array {
  const out: number[] = [];
  for (const resourceSpans of (json.resourceSpans as Json[]) ?? []) pushMessageField(out, 1, encodeResourceSpans(resourceSpans));
  return Uint8Array.from(out);
}
