import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { constantTimeEqual, parseBearerToken, randomToken, sha256Base64Url, verifyGithubSignature } from "./crypto";
import {
  createWatchEvent,
  eventPullRequestNumbers,
  isSupportedGithubEvent,
  mergeReactionKnowledge,
  monitorEventDetails,
  monitorReconciliationDetails,
  parseWatchKey,
  reactionKnowledgeAdvanced,
  resourceUri,
  snapshotChanges,
  terminalState,
  watchKey,
} from "./events";
import { exchangeGithubCode, GithubApiError, githubUser, pullRequestSnapshot, refreshGithubToken } from "./github";
import { createMcpServer, type McpSessionContext, type WatchRegistration } from "./mcp";
import type {
  GithubUser,
  MonitorCapabilityRecord,
  MonitorTerminalState,
  OAuthClientRecord,
  OAuthCodeRecord,
  OAuthRequestRecord,
  PrMonitorEvent,
  PrMonitorRegistration,
  PullRequestCheck,
  PullRequestComment,
  PullRequestReaction,
  PullRequestReview,
  PullRequestSnapshot,
  PullRequestThread,
  ReactionCounts,
  SessionRecord,
  StoredWatchState,
  WatchEvent,
  WatchEventMetadata,
  WatchEventSummary,
  WatchStateMetadata,
} from "./types";
import {
  legacyWatchStorageKey,
  monitorCapabilityStorageKey,
  monitorScopeStorageKey,
  sessionStorageKey,
  watchSidecarCleanupKey,
  watchSidecarEventKey,
  watchSidecarIndexKey,
  watchSidecarSnapshotKey,
  watchStorageKey,
} from "./types";

export interface Env {
  HUB: DurableObjectNamespace;
  GITHUB_CLIENT_ID: string;
  GITHUB_CLIENT_SECRET?: string;
  GITHUB_WEBHOOK_SECRET?: string;
  PUBLIC_BASE_URL: string;
  SESSION_TTL_SECONDS?: string;
}

interface ActiveSession {
  token: string;
  record: SessionRecord;
  watches: Set<string>;
  subscriptions: Set<string>;
  kind: "stateful" | "recovered-stream";
  transport?: WebStandardStreamableHTTPServerTransport;
  server?: McpServer;
  sessionId?: string;
}

interface ActiveMonitorFeed {
  capability: string;
  sessionToken: string;
  userId: number;
  key: string;
  controller: ReadableStreamDefaultController<Uint8Array>;
  heartbeat: number;
  expiration: number;
  ready: boolean;
  pending: PrMonitorEvent[];
  closed: boolean;
}
const SESSION_TTL_SECONDS = 30 * 24 * 60 * 60;
const OAUTH_TTL_SECONDS = 10 * 60;
const MAX_EVENTS = 100;
const MAX_CLOSED_MCP_SESSIONS = 64;
const MONITOR_HEARTBEAT_MS = 15_000;
const MONITOR_TTL_MS = 12 * 60 * 60 * 1000;
const MAX_MONITOR_CURSOR_LENGTH = 256;

const MAX_STORAGE_BATCH_KEYS = 128;
const MAX_WATCH_STATE_BYTES = 64 * 1024;
const MAX_WATCH_CHUNK_CHARACTERS = 16_000;
const DELIVERY_DEDUPLICATION_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_DEFERRED_CLEANUP_DATA_ROWS_PER_JOB = 8;
const MIN_DEFERRED_CLEANUP_ROWS = MAX_DEFERRED_CLEANUP_DATA_ROWS_PER_JOB;

/**
 * Sidecar layout version. Version 3 uses immutable payload and snapshot records behind a
 * compact index, so appending never rewrites or mass-deletes historical event data.
 */
const WATCH_SIDECAR_VERSION = 3;

const stateEncoder = new TextEncoder();

/** Marker stored at a record key whose JSON was split across `${key}:chunk:<index>` rows. */
interface ChunkedRecordIndex {
  chunkCount: number;
}

interface WatchSnapshotRecord {
  snapshot: PullRequestSnapshot | null;
}

/** Where the current snapshot keeps its immutable payload. */
interface SidecarSnapshotRef {
  sequence: number;
  chunkCount: number;
}

/** Where one windowed event keeps its raw payload. */
type SidecarPayloadRef =
  | { source: "root"; position: number }
  | { source: "sidecar"; sequence: number; chunkCount: number };

interface SidecarEventRef {
  meta: WatchEventSummary;
  payload: SidecarPayloadRef;
}

/** A bounded cleanup job for one unreferenced immutable record. */
interface SidecarCleanupJob {
  recordKey: string;
  chunkCount: number;
  nextRow: number;
}

interface SidecarCleanupQueue {
  cursor: number;
  next: number;
}

interface WatchSidecarIndex {
  version: number;
  /** Next unused event payload sequence. */
  nextSequence: number;
  /** Next unused immutable snapshot sequence. */
  nextSnapshotSequence: number;
  /** Current snapshot payload. */
  snapshot: SidecarSnapshotRef;
  /**
   * The predecessor root record, kept verbatim while it still holds payloads for `root`
   * refs. Its chunk count is remembered so the record can be dropped without probing.
   */
  root: { chunkCount: number } | null;
  /** Deferred retirement of chunked records keeps a single append from deleting historical rows en masse. */
  cleanup: SidecarCleanupQueue;
  /** Oldest to newest, capped at MAX_EVENTS. */
  events: SidecarEventRef[];
}

export interface WatchStateWriteStats {
  puts: number;
  deletes: number;
  encodedBytes: number;
  chunkCount: number;
  format: "compact" | "chunked";
}

export interface WatchAppendStats extends WatchStateWriteStats {
  windowEvents: number;
  rootReferences: number;
}

interface PublishResult {
  published: boolean;
  write: WatchAppendStats | null;
}

interface WebhookProcessStats {
  candidateWatches: number;
  routedWatches: number;
  duplicateWatches: number;
  publishedWatches: number;
  deliveryDedupePuts: number;

  storageKeyPuts: number;
  storageKeyDeletes: number;
  compactWrites: number;
  chunkedWrites: number;
  largestStateBytes: number;
  largestStateChunkCount: number;
}

function createWebhookProcessStats(): WebhookProcessStats {
  return {
    candidateWatches: 0,
    routedWatches: 0,
    duplicateWatches: 0,
    publishedWatches: 0,
    deliveryDedupePuts: 0,
    storageKeyPuts: 0,
    storageKeyDeletes: 0,
    compactWrites: 0,
    chunkedWrites: 0,
    largestStateBytes: 0,
    largestStateChunkCount: 0,
  };
}

interface WebhookWatcher {
  userId: number;
  key: string;
  githubToken: string;
  sessionToken: string;
}

interface WebhookTarget extends WebhookWatcher {
  repository: string;
  number: number;
  previous: WatchStateMetadata;
}

export type WatchStorage = Pick<DurableObjectStorage, "get" | "put" | "delete">;

interface WatchStorageWrites {
  puts: number;
  deletes: number;
}

function countWatchStorageWrites(storage: WatchStorage, writes: WatchStorageWrites): WatchStorage {
  const get = storage.get.bind(storage) as WatchStorage["get"];
  const put = storage.put.bind(storage) as (key: string | Record<string, unknown>, value?: unknown) => Promise<void>;
  const remove = storage.delete.bind(storage) as (key: string | string[]) => Promise<boolean>;
  return {
    get,
    async put(key: string | Record<string, unknown>, value?: unknown): Promise<void> {
      await put(key, value);
      writes.puts += typeof key === "string" ? 1 : Object.keys(key).length;
    },
    async delete(key: string | string[]): Promise<boolean> {
      const deleted = await remove(key);
      writes.deletes += Array.isArray(key) ? key.length : 1;
      return deleted;
    },
  } as WatchStorage;
}

/**
 * One read pass over a watch, reused by the append that follows it. Mutating paths need the
 * metadata projection to decide whether to publish, and the append then reuses the record
 * layout discovered by that same read instead of reading it again.
 */
export interface WatchStateMutation {
  metadata: WatchStateMetadata;
  append(event: WatchEvent, snapshot: PullRequestSnapshot | null): Promise<WatchAppendStats>;
  /**
   * Stores a newer snapshot without an event. Used only for refreshes that carry nothing
   * reportable but do carry knowledge worth keeping, so the next refresh starts from it.
   */
  replaceSnapshot(snapshot: PullRequestSnapshot): Promise<WatchStateWriteStats>;
}

function emptyWatchState(): StoredWatchState {
  return { snapshot: null, events: [] };
}

/**
 * The one read boundary that repairs persisted snapshots written before a field existed:
 * fork routing. Reaction detail arrays are deliberately not repaired here - a snapshot that
 * predates individual reactions has unknown reactions, not empty ones, and claiming empty
 * would make every reaction already on the PR look newly created on the next refresh.
 */
function normalizePullRequestSnapshot(snapshot: PullRequestSnapshot | null): PullRequestSnapshot | null {
  if (snapshot === null || snapshot.headRepository !== undefined) return snapshot;
  return { ...snapshot, headRepository: null };
}

function normalizeStoredWatchState(state: StoredWatchState): StoredWatchState {
  const snapshot = normalizePullRequestSnapshot(state.snapshot);
  let events: WatchEvent[] | undefined;
  for (const [index, event] of state.events.entries()) {
    const eventSnapshot = normalizePullRequestSnapshot(event.snapshot);
    if (eventSnapshot === event.snapshot) continue;
    events ??= [...state.events];
    events[index] = { ...event, snapshot: eventSnapshot };
  }
  if (snapshot === state.snapshot && events === undefined) return state;
  return { snapshot, events: events ?? state.events };
}

function isStoredWatchState(value: unknown): value is StoredWatchState {
  return Boolean(
    value &&
    typeof value === "object" &&
    "snapshot" in value &&
    Array.isArray((value as Record<string, unknown>).events),
  );
}

function isChunkedRecordIndex(value: unknown): value is ChunkedRecordIndex {
  return Boolean(
    value &&
    typeof value === "object" &&
    Number.isInteger((value as Record<string, unknown>).chunkCount) &&
    Number((value as Record<string, unknown>).chunkCount) > 0,
  );
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function isStringArray(value: unknown): value is string[] {
  if (!Array.isArray(value)) return false;
  for (const entry of value) {
    if (typeof entry !== "string") return false;
  }
  return true;
}

function isSafeIntegerArray(value: unknown): value is number[] {
  if (!Array.isArray(value)) return false;
  for (const entry of value) {
    if (!Number.isSafeInteger(entry)) return false;
  }
  return true;
}

function isArrayOf<T>(value: unknown, predicate: (entry: unknown) => entry is T): value is T[] {
  if (!Array.isArray(value)) return false;
  for (const entry of value) {
    if (!predicate(entry)) return false;
  }
  return true;
}

function isOptionalString(record: Record<string, unknown>, key: string): boolean {
  const value = record[key];
  return value === undefined || typeof value === "string";
}

function isOptionalNullableSafeInteger(record: Record<string, unknown>, key: string): boolean {
  const value = record[key];
  return value === undefined || value === null || Number.isSafeInteger(value);
}

function isReactionCounts(value: unknown): value is ReactionCounts {
  if (!isObjectRecord(value)) return false;
  for (const key in value) {
    if (Object.hasOwn(value, key) && typeof value[key] !== "number") return false;
  }
  return true;
}

function isPullRequestReaction(value: unknown): value is PullRequestReaction {
  if (!isObjectRecord(value)) return false;
  return Number.isSafeInteger(value.id) &&
    typeof value.content === "string" &&
    isNullableString(value.author) &&
    isOptionalNullableSafeInteger(value, "authorId") &&
    isNullableString(value.createdAt);
}

/** Undefined is the persisted form of unknown: stored before individual reactions, or unread. */
function isOptionalReactionDetails(value: unknown): boolean {
  return value === undefined || isArrayOf(value, isPullRequestReaction);
}

function isPullRequestComment(value: unknown): value is PullRequestComment {
  if (!isObjectRecord(value)) return false;
  return Number.isSafeInteger(value.id) &&
    isNullableString(value.author) &&
    typeof value.body === "string" &&
    isNullableString(value.createdAt) &&
    isNullableString(value.updatedAt) &&
    isReactionCounts(value.reactions) &&
    isOptionalReactionDetails(value.reactionDetails) &&
    isOptionalString(value, "path") &&
    isOptionalNullableSafeInteger(value, "line") &&
    isOptionalNullableSafeInteger(value, "startLine") &&
    isOptionalString(value, "diffHunk") &&
    isOptionalNullableSafeInteger(value, "inReplyToId") &&
    isOptionalString(value, "htmlUrl");
}

function isPullRequestReview(value: unknown): value is PullRequestReview {
  if (!isObjectRecord(value)) return false;
  return Number.isSafeInteger(value.id) &&
    isNullableString(value.author) &&
    typeof value.state === "string" &&
    typeof value.body === "string" &&
    isNullableString(value.submittedAt) &&
    isOptionalString(value, "htmlUrl");
}

function isPullRequestCheck(value: unknown): value is PullRequestCheck {
  if (!isObjectRecord(value)) return false;
  return Number.isSafeInteger(value.id) &&
    typeof value.name === "string" &&
    isNullableString(value.status) &&
    isNullableString(value.conclusion) &&
    isNullableString(value.completedAt) &&
    isNullableString(value.startedAt) &&
    isNullableString(value.url) &&
    (value.kind === "check_run" || value.kind === "commit_status");
}

function isPullRequestThread(value: unknown): value is PullRequestThread {
  if (!isObjectRecord(value)) return false;
  return typeof value.id === "string" &&
    typeof value.isResolved === "boolean" &&
    isSafeIntegerArray(value.commentIds);
}

function isWatchEventSummary(value: unknown): value is WatchEventSummary {
  if (!isObjectRecord(value)) return false;
  const summary = value as Partial<WatchEventSummary>;
  const legacyDetails = value.details;
  return typeof summary.id === "string" &&
    typeof summary.deliveryId === "string" &&
    typeof summary.receivedAt === "string" &&
    typeof summary.githubEvent === "string" &&
    (summary.action === null || typeof summary.action === "string") &&
    typeof summary.repository === "string" &&
    Number.isSafeInteger(summary.pullRequestNumber) &&
    typeof summary.resourceUri === "string" &&
    isStringArray(summary.changes) &&
    (legacyDetails === undefined || isStringArray(legacyDetails));
}

function isSidecarPayloadRef(value: unknown): value is SidecarPayloadRef {
  if (!value || typeof value !== "object") return false;
  const ref = value as Partial<SidecarPayloadRef>;
  if (ref.source === "root") return isNonNegativeSafeInteger(ref.position);
  return ref.source === "sidecar" &&
    isNonNegativeSafeInteger(ref.sequence) &&
    isNonNegativeSafeInteger(ref.chunkCount);
}

function isSidecarEventRef(value: unknown): value is SidecarEventRef {
  if (!value || typeof value !== "object") return false;
  const ref = value as Partial<SidecarEventRef>;
  return isWatchEventSummary(ref.meta) && isSidecarPayloadRef(ref.payload);
}

function isSidecarCleanupQueue(value: unknown): value is SidecarCleanupQueue {
  if (!value || typeof value !== "object") return false;
  const queue = value as Partial<SidecarCleanupQueue>;
  return isNonNegativeSafeInteger(queue.cursor) &&
    isNonNegativeSafeInteger(queue.next) &&
    queue.cursor <= queue.next;
}

function sidecarCleanupQueue(index: WatchSidecarIndex): SidecarCleanupQueue {
  return index.cleanup;
}

function isPullRequestSnapshot(value: unknown): value is PullRequestSnapshot {
  if (!isObjectRecord(value)) return false;
  const snapshot = value as Partial<PullRequestSnapshot>;
  return typeof snapshot.repository === "string" &&
    Number.isSafeInteger(snapshot.number) &&
    typeof snapshot.url === "string" &&
    typeof snapshot.title === "string" &&
    typeof snapshot.body === "string" &&
    typeof snapshot.state === "string" &&
    typeof snapshot.draft === "boolean" &&
    typeof snapshot.merged === "boolean" &&
    isNullableString(snapshot.mergedAt) &&
    (snapshot.mergeable === null || typeof snapshot.mergeable === "boolean") &&
    isNullableString(snapshot.mergeableState) &&
    isNullableString(snapshot.baseRefName) &&
    isNullableString(snapshot.headRefName) &&
    // Snapshots stored before fork-aware routing omitted this persisted field.
    (snapshot.headRepository === undefined || isNullableString(snapshot.headRepository)) &&
    isNullableString(snapshot.headSha) &&
    isNullableString(snapshot.author) &&
    typeof snapshot.fetchedAt === "string" &&
    isReactionCounts(snapshot.bodyReactions) &&
    isOptionalReactionDetails(snapshot.bodyReactionDetails) &&
    isArrayOf(snapshot.comments, isPullRequestComment) &&
    isArrayOf(snapshot.reviews, isPullRequestReview) &&
    isArrayOf(snapshot.reviewComments, isPullRequestComment) &&
    isArrayOf(snapshot.checks, isPullRequestCheck) &&
    isArrayOf(snapshot.threads, isPullRequestThread);
}

function isWatchSnapshotRecord(value: unknown): value is WatchSnapshotRecord {
  if (!isObjectRecord(value) || !Object.hasOwn(value, "snapshot")) return false;
  const snapshot = value.snapshot;
  return snapshot === null || isPullRequestSnapshot(snapshot);
}

function isSidecarSnapshotRef(value: unknown): value is SidecarSnapshotRef {
  if (!value || typeof value !== "object") return false;
  const ref = value as Partial<SidecarSnapshotRef>;
  return isNonNegativeSafeInteger(ref.sequence) && isNonNegativeSafeInteger(ref.chunkCount);
}

function isWatchSidecarIndex(value: unknown): value is WatchSidecarIndex {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<WatchSidecarIndex>;
  if (candidate.version !== WATCH_SIDECAR_VERSION) return false;
  if (!isNonNegativeSafeInteger(candidate.nextSequence) ||
    !isNonNegativeSafeInteger(candidate.nextSnapshotSequence) ||
    !Array.isArray(candidate.events)) return false;
  if (!isSidecarSnapshotRef(candidate.snapshot) ||
    candidate.snapshot.sequence >= candidate.nextSnapshotSequence) return false;
  if (candidate.events.length > MAX_EVENTS) return false;
  if (candidate.root !== null && !isNonNegativeSafeInteger(candidate.root?.chunkCount)) return false;
  if (!isSidecarCleanupQueue(candidate.cleanup)) return false;
  const sidecarSequences = new Set<number>();
  const rootPositions = new Set<number>();
  for (const ref of candidate.events) {
    if (!isSidecarEventRef(ref)) return false;
    if (ref.payload.source === "sidecar") {
      if (ref.payload.sequence >= candidate.nextSequence || sidecarSequences.has(ref.payload.sequence)) return false;
      sidecarSequences.add(ref.payload.sequence);
      continue;
    }
    if (rootPositions.has(ref.payload.position)) return false;
    rootPositions.add(ref.payload.position);
  }
  return (candidate.root !== null) === (rootPositions.size > 0);
}

function chunkKey(recordKey: string, index: number): string {
  return `${recordKey}:chunk:${index}`;
}

function chunkedRecordKeys(recordKey: string, chunkCount: number): string[] {
  const keys = [recordKey];
  for (let index = 0; index < chunkCount; index += 1) keys.push(chunkKey(recordKey, index));
  return keys;
}

function eventSummary(event: WatchEvent | WatchEventSummary): WatchEventSummary {
  return {
    id: event.id,
    deliveryId: event.deliveryId,
    receivedAt: event.receivedAt,
    githubEvent: event.githubEvent,
    action: event.action,
    repository: event.repository,
    pullRequestNumber: event.pullRequestNumber,
    resourceUri: event.resourceUri,
    changes: event.changes,
  };
}

function storageBatches<T>(values: readonly T[]): T[][] {
  const batches: T[][] = [];
  for (let index = 0; index < values.length; index += MAX_STORAGE_BATCH_KEYS) {
    batches.push(values.slice(index, index + MAX_STORAGE_BATCH_KEYS));
  }
  return batches;
}

async function getStorageEntries<T>(storage: WatchStorage, keys: readonly string[]): Promise<Map<string, T>> {
  const entries = new Map<string, T>();
  for (const batch of storageBatches(keys)) {
    const values = await storage.get<T>(batch);
    for (const [key, value] of values) entries.set(key, value);
  }
  return entries;
}

async function putStorageEntries(storage: WatchStorage, entries: Record<string, unknown>): Promise<void> {
  const values = Object.entries(entries);
  for (const batch of storageBatches(values)) {
    await storage.put(Object.fromEntries(batch));
  }
}

async function deleteStorageKeys(storage: WatchStorage, keys: readonly string[]): Promise<void> {
  for (const batch of storageBatches(keys)) await storage.delete(batch);
}

interface ChunkedRecord<T> {
  value: T | undefined;
  chunkCount: number;
  present: boolean;
}

async function readChunkedRecord<T>(storage: WatchStorage, recordKey: string): Promise<ChunkedRecord<T>> {
  const stored = await storage.get<unknown>(recordKey);
  if (stored === undefined) return { value: undefined, chunkCount: 0, present: false };
  if (!isChunkedRecordIndex(stored)) return { value: stored as T, chunkCount: 0, present: true };
  const keys = Array.from({ length: stored.chunkCount }, (_, index) => chunkKey(recordKey, index));
  const chunks = await getStorageEntries<string>(storage, keys);
  let encoded = "";
  for (const key of keys) {
    const chunk = chunks.get(key);
    if (typeof chunk !== "string") return { value: undefined, chunkCount: stored.chunkCount, present: true };
    encoded += chunk;
  }
  try {
    return { value: JSON.parse(encoded) as T, chunkCount: stored.chunkCount, present: true };
  } catch {
    return { value: undefined, chunkCount: stored.chunkCount, present: true };
  }
}

/** Reads only the record's head row, which is all a rewrite needs to retire stale chunks. */
async function readRecordChunkCount(storage: WatchStorage, recordKey: string): Promise<number> {
  const stored = await storage.get<unknown>(recordKey);
  return isChunkedRecordIndex(stored) ? stored.chunkCount : 0;
}

function assembleRecord<T>(entries: Map<string, unknown>, recordKey: string, chunkCount: number): T | undefined {
  const head = entries.get(recordKey);
  if (chunkCount === 0) {
    if (head === undefined || isChunkedRecordIndex(head)) return undefined;
    return head as T;
  }
  if (!isChunkedRecordIndex(head) || head.chunkCount !== chunkCount) return undefined;
  let encoded = "";
  for (let index = 0; index < chunkCount; index += 1) {
    const chunk = entries.get(chunkKey(recordKey, index));
    if (typeof chunk !== "string") return undefined;
    encoded += chunk;
  }
  try {
    return JSON.parse(encoded) as T;
  } catch {
    return undefined;
  }
}

async function writeChunkedRecord(
  storage: WatchStorage,
  recordKey: string,
  value: unknown,
  previousChunkCount: number,
): Promise<WatchStateWriteStats> {
  const encoded = JSON.stringify(value);
  const encodedBytes = stateEncoder.encode(encoded).byteLength;
  if (encodedBytes <= MAX_WATCH_STATE_BYTES) {
    await storage.put(recordKey, value);
    if (previousChunkCount === 0) {
      return { puts: 1, deletes: 0, encodedBytes, chunkCount: 0, format: "compact" };
    }
    const staleChunks = Array.from({ length: previousChunkCount }, (_, index) => chunkKey(recordKey, index));
    await deleteStorageKeys(storage, staleChunks);
    return { puts: 1, deletes: staleChunks.length, encodedBytes, chunkCount: 0, format: "compact" };
  }

  const chunkCount = Math.ceil(encoded.length / MAX_WATCH_CHUNK_CHARACTERS);
  const chunks: Record<string, string> = {};
  for (let index = 0; index < chunkCount; index += 1) {
    chunks[chunkKey(recordKey, index)] = encoded.slice(
      index * MAX_WATCH_CHUNK_CHARACTERS,
      (index + 1) * MAX_WATCH_CHUNK_CHARACTERS,
    );
  }
  await putStorageEntries(storage, chunks);
  let puts = chunkCount;
  if (previousChunkCount !== chunkCount) {
    await storage.put(recordKey, { chunkCount } satisfies ChunkedRecordIndex);
    puts += 1;
  }
  const staleChunkCount = Math.max(previousChunkCount - chunkCount, 0);
  if (staleChunkCount > 0) {
    await deleteStorageKeys(
      storage,
      Array.from({ length: staleChunkCount }, (_, index) => chunkKey(recordKey, chunkCount + index)),
    );
  }
  return { puts, deletes: staleChunkCount, encodedBytes, chunkCount, format: "chunked" };
}

function sidecarCorruption(): Error {
  return new Error("watch sidecar storage is corrupt");
}

function cleanupRowCount(job: SidecarCleanupJob): number {
  return 1 + job.chunkCount;
}

function isSidecarCleanupJob(value: unknown): value is SidecarCleanupJob {
  if (!value || typeof value !== "object") return false;
  const job = value as Partial<SidecarCleanupJob>;
  if (typeof job.recordKey !== "string" || job.recordKey.length === 0) return false;
  if (!isNonNegativeSafeInteger(job.chunkCount) || !isNonNegativeSafeInteger(job.nextRow)) return false;
  return job.nextRow < 1 + job.chunkCount;
}

function cleanupRowKey(job: SidecarCleanupJob, row: number): string {
  return row === 0 ? job.recordKey : chunkKey(job.recordKey, row - 1);
}

function retireRecord(recordKey: string, chunkCount: number): SidecarCleanupJob {
  return { recordKey, chunkCount, nextRow: 0 };
}

function isDecimalText(value: string): boolean {
  if (value.length === 0) return false;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 48 || code > 57) return false;
  }
  return true;
}

function isSidecarPayloadRecordKey(storageKey: string, recordKey: string): boolean {
  const prefix = `${storageKey}:sidecar:`;
  if (!recordKey.startsWith(prefix)) return false;
  const suffix = recordKey.slice(prefix.length);
  const separator = suffix.indexOf(":");
  if (separator <= 0) return false;
  const kind = suffix.slice(0, separator);
  return (kind === "event" || kind === "snapshot") && isDecimalText(suffix.slice(separator + 1));
}

function isCleanupRecordKey(storageKey: string, recordKey: string): boolean {
  return recordKey === storageKey || isSidecarPayloadRecordKey(storageKey, recordKey);
}

function protectedCleanupRecordKeys(
  storageKey: string,
  snapshot: SidecarSnapshotRef,
  events: readonly SidecarEventRef[],
  root: { chunkCount: number } | null,
): Set<string> {
  const protectedKeys = new Set<string>([watchSidecarSnapshotKey(storageKey, snapshot.sequence)]);
  for (const event of events) {
    if (event.payload.source === "sidecar") {
      protectedKeys.add(watchSidecarEventKey(storageKey, event.payload.sequence));
    }
  }
  if (root) protectedKeys.add(storageKey);
  return protectedKeys;
}

interface CleanupAdvance {
  cleanup: SidecarCleanupQueue;
  puts: number;
  deletes: number;
  dataDeletes: number;
}

/**
 * Retires at most a fixed number of data rows from one unreferenced record. Partial jobs
 * rotate to the tail, so a large predecessor never blocks cleanup of later records.
 */
async function advanceDeferredCleanup(
  storage: WatchStorage,
  storageKey: string,
  protectedRecordKeys: ReadonlySet<string>,
  cleanup: SidecarCleanupQueue,
  budget: number,
): Promise<CleanupAdvance> {
  if (budget <= 0 || cleanup.cursor === cleanup.next) {
    return { cleanup, puts: 0, deletes: 0, dataDeletes: 0 };
  }

  const jobKey = watchSidecarCleanupKey(storageKey, cleanup.cursor);
  const stored = await storage.get<unknown>(jobKey);
  if (!isSidecarCleanupJob(stored)) throw sidecarCorruption();
  if (!isCleanupRecordKey(storageKey, stored.recordKey) || protectedRecordKeys.has(stored.recordKey)) {
    throw sidecarCorruption();
  }

  const rows = cleanupRowCount(stored);
  const remainingRows = rows - stored.nextRow;
  const rowsToDelete = Math.min(remainingRows, budget, MAX_DEFERRED_CLEANUP_DATA_ROWS_PER_JOB);
  if (rowsToDelete === 0) return { cleanup, puts: 0, deletes: 0, dataDeletes: 0 };

  const keys = Array.from(
    { length: rowsToDelete },
    (_, index) => cleanupRowKey(stored, stored.nextRow + index),
  );
  await deleteStorageKeys(storage, keys);
  const nextRow = stored.nextRow + rowsToDelete;

  if (nextRow === rows) {
    await storage.delete(jobKey);
    return {
      cleanup: { cursor: cleanup.cursor + 1, next: cleanup.next },
      puts: 0,
      deletes: keys.length + 1,
      dataDeletes: keys.length,
    };
  }

  const next = cleanup.next + 1;
  if (!Number.isSafeInteger(next)) throw sidecarCorruption();
  await storage.put(
    watchSidecarCleanupKey(storageKey, cleanup.next),
    { ...stored, nextRow } satisfies SidecarCleanupJob,
  );
  await storage.delete(jobKey);
  return {
    cleanup: { cursor: cleanup.cursor + 1, next },
    puts: 1,
    deletes: keys.length + 1,
    dataDeletes: keys.length,
  };
}

async function enqueueDeferredCleanup(
  storage: WatchStorage,
  storageKey: string,
  cleanup: SidecarCleanupQueue,
  jobs: readonly SidecarCleanupJob[],
): Promise<{ cleanup: SidecarCleanupQueue; puts: number }> {
  if (jobs.length === 0) return { cleanup, puts: 0 };
  const next = cleanup.next + jobs.length;
  if (!Number.isSafeInteger(next)) throw sidecarCorruption();
  const entries: Record<string, SidecarCleanupJob> = {};
  for (const [offset, job] of jobs.entries()) {
    entries[watchSidecarCleanupKey(storageKey, cleanup.next + offset)] = job;
  }
  await putStorageEntries(storage, entries);
  return { cleanup: { cursor: cleanup.cursor, next }, puts: jobs.length };
}

function sameSnapshot(current: PullRequestSnapshot | null, next: PullRequestSnapshot | null): boolean {
  if (current === next) return true;
  if (!current || !next) return false;
  if (current.fetchedAt !== next.fetchedAt) return false;
  return JSON.stringify(current) === JSON.stringify(next);
}

/** Reads the predecessor single-record layout, which stays authoritative until a sidecar exists. */
async function readRootWatchState(storage: WatchStorage, storageKey: string): Promise<StoredWatchState> {
  const record = await readChunkedRecord<unknown>(storage, storageKey);
  return isStoredWatchState(record.value) ? normalizeStoredWatchState(record.value) : emptyWatchState();
}

async function readRequiredRootWatchState(storage: WatchStorage, storageKey: string): Promise<StoredWatchState> {
  const record = await readChunkedRecord<unknown>(storage, storageKey);
  if (!record.present || !isStoredWatchState(record.value)) throw sidecarCorruption();
  return normalizeStoredWatchState(record.value);
}

async function readSidecarIndex(storage: WatchStorage, storageKey: string): Promise<WatchSidecarIndex | undefined> {
  const record = await readChunkedRecord<unknown>(storage, watchSidecarIndexKey(storageKey));
  if (!record.present) return undefined;
  if (!isWatchSidecarIndex(record.value)) throw sidecarCorruption();
  return record.value;
}

async function readSidecarSnapshot(
  storage: WatchStorage,
  storageKey: string,
  ref: SidecarSnapshotRef,
): Promise<PullRequestSnapshot | null> {
  const record = await readChunkedRecord<unknown>(storage, watchSidecarSnapshotKey(storageKey, ref.sequence));
  if (!record.present || record.chunkCount !== ref.chunkCount || !isWatchSnapshotRecord(record.value)) {
    throw sidecarCorruption();
  }
  return normalizePullRequestSnapshot(record.value.snapshot);
}

function isStoredWatchEvent(value: unknown): value is WatchEvent {
  if (!isObjectRecord(value) || !isWatchEventSummary(value)) return false;
  if (!Object.hasOwn(value, "payload") || !Object.hasOwn(value, "snapshot")) return false;
  const snapshot = (value as Partial<WatchEvent>).snapshot;
  return snapshot === null || isPullRequestSnapshot(snapshot);
}

function matchesSidecarEvent(value: unknown, summary: WatchEventSummary): value is WatchEvent {
  return isStoredWatchEvent(value) &&
    JSON.stringify(eventSummary(value)) === JSON.stringify(eventSummary(summary));
}

async function readSidecarPayloads(
  storage: WatchStorage,
  storageKey: string,
  refs: readonly SidecarEventRef[],
): Promise<Map<number, WatchEvent>> {
  const payloads = new Map<number, WatchEvent>();
  const keys: string[] = [];
  for (const ref of refs) {
    if (ref.payload.source !== "sidecar") continue;
    keys.push(...chunkedRecordKeys(watchSidecarEventKey(storageKey, ref.payload.sequence), ref.payload.chunkCount));
  }
  if (keys.length === 0) return payloads;
  const entries = await getStorageEntries<unknown>(storage, keys);
  for (const ref of refs) {
    if (ref.payload.source !== "sidecar") continue;
    const event = assembleRecord<unknown>(
      entries,
      watchSidecarEventKey(storageKey, ref.payload.sequence),
      ref.payload.chunkCount,
    );
    if (!matchesSidecarEvent(event, ref.meta)) throw sidecarCorruption();
    payloads.set(ref.payload.sequence, event);
  }
  return payloads;
}

/**
 * Hydrates every raw payload in the window. Only consumers of a complete `StoredWatchState`
 * (MCP `get_pr`, `list_pr_events`, the pull request resource) should pay for this.
 */
export async function readStoredWatchState(storage: WatchStorage, storageKey: string): Promise<StoredWatchState> {
  const index = await readSidecarIndex(storage, storageKey);
  if (!index) return readRootWatchState(storage, storageKey);

  const snapshot = await readSidecarSnapshot(storage, storageKey, index.snapshot);
  const rootEvents = index.events.some((ref) => ref.payload.source === "root")
    ? (await readRequiredRootWatchState(storage, storageKey)).events
    : [];
  const payloads = await readSidecarPayloads(storage, storageKey, index.events);
  const newest = index.events.length - 1;
  const events: WatchEvent[] = [];
  for (const [position, ref] of index.events.entries()) {
    const stored = ref.payload.source === "root"
      ? rootEvents[ref.payload.position]
      : payloads.get(ref.payload.sequence);
    if (!matchesSidecarEvent(stored, ref.meta)) throw sidecarCorruption();
    // Only the newest event carries the snapshot, exactly as the single-record layout stored it.
    events.push({ ...stored, snapshot: position === newest ? snapshot : null });
  }
  return { snapshot, events };
}

async function readStoredWatchEvents(
  storage: WatchStorage,
  storageKey: string,
  eventIds: readonly string[],
): Promise<WatchEvent[]> {
  if (eventIds.length === 0) return [];
  const selectedIds = new Set(eventIds);
  const index = await readSidecarIndex(storage, storageKey);
  if (!index) {
    const state = await readRootWatchState(storage, storageKey);
    return state.events.filter((event) => selectedIds.has(event.id));
  }

  const refs = index.events.filter((ref) => selectedIds.has(ref.meta.id));
  const rootEvents = refs.some((ref) => ref.payload.source === "root")
    ? (await readRequiredRootWatchState(storage, storageKey)).events
    : [];
  const payloads = await readSidecarPayloads(storage, storageKey, refs);
  return refs.map((ref) => {
    const stored = ref.payload.source === "root"
      ? rootEvents[ref.payload.position]
      : payloads.get(ref.payload.sequence);
    if (!matchesSidecarEvent(stored, ref.meta)) throw sidecarCorruption();
    return { ...stored, snapshot: null };
  });
}

/**
 * Snapshot plus per-event metadata without touching any payload row. Webhook routing,
 * polling, and registration lists read watches through this projection.
 */
export async function readWatchStateMetadata(storage: WatchStorage, storageKey: string): Promise<WatchStateMetadata> {
  const index = await readSidecarIndex(storage, storageKey);
  if (!index) {
    const root = await readRootWatchState(storage, storageKey);
    return {
      snapshot: root.snapshot,
      events: root.events.map((event) => ({ ...eventSummary(event), terminalState: terminalState(event.snapshot) })),
    };
  }
  const snapshot = await readSidecarSnapshot(storage, storageKey, index.snapshot);
  return { snapshot, events: sidecarEventMetadata(index.events, snapshot) };
}

function sidecarEventMetadata(
  refs: readonly SidecarEventRef[],
  snapshot: PullRequestSnapshot | null,
): WatchEventMetadata[] {
  const newest = refs.length - 1;
  return refs.map((ref, position) => ({
    ...ref.meta,
    terminalState: position === newest ? terminalState(snapshot) : "watching",
  }));
}

/**
 * Opens one watch for mutation. The first append over a predecessor record indexes the
 * existing events by position and leaves their payloads where they are, so no watch ever
 * pays a full-history rewrite.
 */
export async function openWatchStateMutation(
  storage: WatchStorage,
  storageKey: string,
): Promise<WatchStateMutation> {
  const indexRecord = await readChunkedRecord<unknown>(storage, watchSidecarIndexKey(storageKey));
  if (indexRecord.present && !isWatchSidecarIndex(indexRecord.value)) throw sidecarCorruption();
  const index: WatchSidecarIndex | undefined = indexRecord.present
    ? indexRecord.value as WatchSidecarIndex
    : undefined;

  let refs: readonly SidecarEventRef[];
  let nextSequence: number;
  let root: { chunkCount: number } | null;
  let cleanup: SidecarCleanupQueue;
  let snapshot: PullRequestSnapshot | null;
  let snapshotRef: SidecarSnapshotRef | null;
  let nextSnapshotSequence: number;
  let metadata: WatchStateMetadata;
  let indexChunkCount = indexRecord.chunkCount;
  let hasSidecar = index !== undefined;

  if (index) {
    snapshot = await readSidecarSnapshot(storage, storageKey, index.snapshot);
    snapshotRef = index.snapshot;
    nextSnapshotSequence = index.nextSnapshotSequence;
    refs = index.events;
    nextSequence = index.nextSequence;
    root = index.root;
    cleanup = sidecarCleanupQueue(index);
    metadata = { snapshot, events: sidecarEventMetadata(index.events, snapshot) };
  } else {
    const rootRecord = await readChunkedRecord<unknown>(storage, storageKey);
    const rootState = isStoredWatchState(rootRecord.value)
      ? normalizeStoredWatchState(rootRecord.value)
      : emptyWatchState();
    snapshot = rootState.snapshot;
    snapshotRef = null;
    nextSnapshotSequence = 0;
    refs = rootState.events.map((event, position): SidecarEventRef => ({
      meta: eventSummary(event),
      payload: { source: "root", position },
    }));
    nextSequence = 0;
    root = rootRecord.present ? { chunkCount: rootRecord.chunkCount } : null;
    cleanup = { cursor: 0, next: 0 };
    metadata = {
      snapshot,
      events: rootState.events.map((event) => ({
        ...eventSummary(event),
        terminalState: terminalState(event.snapshot),
      })),
    };
  }

  return {
    get metadata() {
      return metadata;
    },
    append: async (event, appendSnapshot) => {
      let nextCleanup = cleanup;
      let cleanupPuts = 0;
      let cleanupDeletes = 0;
      const sequence = nextSequence;
      const payloadWrite = await writeChunkedRecord(
        storage,
        watchSidecarEventKey(storageKey, sequence),
        // The snapshot lives in the snapshot record; a full read re-attaches it to the newest event.
        { ...event, snapshot: null },
        0,
      );
      let puts = payloadWrite.puts;
      let deletes = payloadWrite.deletes;
      let encodedBytes = payloadWrite.encodedBytes;
      let chunkCount = payloadWrite.chunkCount;
      let incomingRows = payloadWrite.puts;

      const windowed: SidecarEventRef[] = [
        ...refs.map((ref) => ({ ...ref, meta: eventSummary(ref.meta) })),
        {
          meta: eventSummary(event),
          payload: { source: "sidecar", sequence, chunkCount: payloadWrite.chunkCount },
        },
      ];
      const evicted = windowed.splice(0, Math.max(windowed.length - MAX_EVENTS, 0));
      const rootReferences = windowed.filter((ref) => ref.payload.source === "root").length;
      const retirements: SidecarCleanupJob[] = [];

      let nextSnapshotRef = snapshotRef;
      let nextSnapshotSequenceValue = nextSnapshotSequence;
      if (!hasSidecar || !sameSnapshot(snapshot, appendSnapshot)) {
        const snapshotSequence = nextSnapshotSequenceValue;
        const snapshotWrite = await writeChunkedRecord(
          storage,
          watchSidecarSnapshotKey(storageKey, snapshotSequence),
          { snapshot: appendSnapshot } satisfies WatchSnapshotRecord,
          0,
        );
        puts += snapshotWrite.puts;
        deletes += snapshotWrite.deletes;
        encodedBytes += snapshotWrite.encodedBytes;
        incomingRows += snapshotWrite.puts;
        chunkCount = Math.max(chunkCount, snapshotWrite.chunkCount);
        nextSnapshotRef = { sequence: snapshotSequence, chunkCount: snapshotWrite.chunkCount };
        nextSnapshotSequenceValue = snapshotSequence + 1;
        if (snapshotRef) {
          retirements.push(retireRecord(
            watchSidecarSnapshotKey(storageKey, snapshotRef.sequence),
            snapshotRef.chunkCount,
          ));
        }
      }
      if (!nextSnapshotRef) throw sidecarCorruption();

      for (const ref of evicted) {
        if (ref.payload.source !== "sidecar") continue;
        retirements.push(retireRecord(
          watchSidecarEventKey(storageKey, ref.payload.sequence),
          ref.payload.chunkCount,
        ));
      }
      const nextRoot = rootReferences > 0 ? root : null;
      if (root && nextRoot === null) retirements.push(retireRecord(storageKey, root.chunkCount));

      const protectedRecordKeys = protectedCleanupRecordKeys(
        storageKey,
        nextSnapshotRef,
        windowed,
        nextRoot,
      );
      const deferredRetirements = retirements.filter((retirement) => retirement.chunkCount > 0);
      const immediateRetirementKeys = retirements
        .filter((retirement) => retirement.chunkCount === 0)
        .map((retirement) => retirement.recordKey);
      if (immediateRetirementKeys.some((key) => protectedRecordKeys.has(key))) {
        throw sidecarCorruption();
      }
      if (immediateRetirementKeys.length > 0) {
        await deleteStorageKeys(storage, immediateRetirementKeys);
        deletes += immediateRetirementKeys.length;
      }
      let cleanupDataBudget = Math.max(MIN_DEFERRED_CLEANUP_ROWS, incomingRows + deferredRetirements.length);
      let jobsToAdvance = nextCleanup.next - nextCleanup.cursor;
      while (cleanupDataBudget > 0 && jobsToAdvance > 0) {
        const advance = await advanceDeferredCleanup(
          storage,
          storageKey,
          protectedRecordKeys,
          nextCleanup,
          cleanupDataBudget,
        );
        if (advance.dataDeletes === 0) break;
        nextCleanup = advance.cleanup;
        cleanupPuts += advance.puts;
        cleanupDeletes += advance.deletes;
        cleanupDataBudget -= advance.dataDeletes;
        jobsToAdvance -= 1;
      }
      puts += cleanupPuts;
      deletes += cleanupDeletes;


      const enqueued = await enqueueDeferredCleanup(storage, storageKey, nextCleanup, deferredRetirements);
      nextCleanup = enqueued.cleanup;
      puts += enqueued.puts;

      const nextIndex: WatchSidecarIndex = {
        version: WATCH_SIDECAR_VERSION,
        nextSequence: sequence + 1,
        nextSnapshotSequence: nextSnapshotSequenceValue,
        snapshot: nextSnapshotRef,
        root: nextRoot,
        cleanup: nextCleanup,
        events: windowed,
      };
      const indexWrite = await writeChunkedRecord(
        storage,
        watchSidecarIndexKey(storageKey),
        nextIndex,
        indexChunkCount,
      );
      puts += indexWrite.puts;
      deletes += indexWrite.deletes;
      encodedBytes += indexWrite.encodedBytes;
      chunkCount = Math.max(chunkCount, indexWrite.chunkCount);
      indexChunkCount = indexWrite.chunkCount;

      refs = windowed;
      nextSequence = sequence + 1;
      snapshotRef = nextSnapshotRef;
      nextSnapshotSequence = nextSnapshotSequenceValue;
      root = nextRoot;
      cleanup = nextCleanup;
      hasSidecar = true;
      snapshot = appendSnapshot;
      metadata = { snapshot, events: sidecarEventMetadata(windowed, snapshot) };
      return {
        puts,
        deletes,
        encodedBytes,
        chunkCount,
        format: chunkCount > 0 ? "chunked" : "compact",
        windowEvents: windowed.length,
        rootReferences,
      };
    },
    replaceSnapshot: async (nextSnapshot) => {
      const snapshotSequence = nextSnapshotSequence;
      const snapshotWrite = await writeChunkedRecord(
        storage,
        watchSidecarSnapshotKey(storageKey, snapshotSequence),
        { snapshot: nextSnapshot } satisfies WatchSnapshotRecord,
        0,
      );
      let puts = snapshotWrite.puts;
      let deletes = snapshotWrite.deletes;
      const nextSnapshotRef: SidecarSnapshotRef = {
        sequence: snapshotSequence,
        chunkCount: snapshotWrite.chunkCount,
      };

      // Retirements are settled before the index is written: a deferred retirement moves the
      // queue's `next`, and only the index write persists that pointer. Enqueueing after the
      // write would leave the job rows unreachable and their chunks unreclaimable.
      const rootReferences = refs.filter((ref) => ref.payload.source === "root").length;
      const nextRoot = rootReferences > 0 ? root : null;
      const retirements: SidecarCleanupJob[] = [];
      if (snapshotRef) {
        retirements.push(retireRecord(
          watchSidecarSnapshotKey(storageKey, snapshotRef.sequence),
          snapshotRef.chunkCount,
        ));
      }
      // A predecessor record with no events leaves nothing pointing at it once its snapshot
      // moves into the sidecar, so keeping it in the index would claim a root nobody reads.
      if (root && nextRoot === null) retirements.push(retireRecord(storageKey, root.chunkCount));

      let nextCleanup = cleanup;
      const protectedRecordKeys = protectedCleanupRecordKeys(storageKey, nextSnapshotRef, refs, nextRoot);
      const immediateRetirementKeys = retirements
        .filter((retirement) => retirement.chunkCount === 0)
        .map((retirement) => retirement.recordKey);
      if (immediateRetirementKeys.some((key) => protectedRecordKeys.has(key))) throw sidecarCorruption();
      if (immediateRetirementKeys.length > 0) {
        await deleteStorageKeys(storage, immediateRetirementKeys);
        deletes += immediateRetirementKeys.length;
      }
      const deferredRetirements = retirements.filter((retirement) => retirement.chunkCount > 0);
      const enqueued = await enqueueDeferredCleanup(storage, storageKey, nextCleanup, deferredRetirements);
      nextCleanup = enqueued.cleanup;
      puts += enqueued.puts;

      // Drained at the same bounded rate an append uses, and over the work just enqueued as
      // well, so a silent replacement pays for the record it retired instead of parking it
      // until the watch happens to publish something.
      let cleanupDataBudget = Math.max(MIN_DEFERRED_CLEANUP_ROWS, snapshotWrite.puts + deferredRetirements.length);
      let jobsToAdvance = nextCleanup.next - nextCleanup.cursor;
      while (cleanupDataBudget > 0 && jobsToAdvance > 0) {
        const advance = await advanceDeferredCleanup(
          storage,
          storageKey,
          protectedRecordKeys,
          nextCleanup,
          cleanupDataBudget,
        );
        if (advance.dataDeletes === 0) break;
        nextCleanup = advance.cleanup;
        puts += advance.puts;
        deletes += advance.deletes;
        cleanupDataBudget -= advance.dataDeletes;
        jobsToAdvance -= 1;
      }

      // The events stay exactly where they are; only the snapshot record is replaced.
      const nextIndex: WatchSidecarIndex = {
        version: WATCH_SIDECAR_VERSION,
        nextSequence,
        nextSnapshotSequence: snapshotSequence + 1,
        snapshot: nextSnapshotRef,
        root: nextRoot,
        cleanup: nextCleanup,
        events: [...refs],
      };
      const indexWrite = await writeChunkedRecord(
        storage,
        watchSidecarIndexKey(storageKey),
        nextIndex,
        indexChunkCount,
      );
      puts += indexWrite.puts;
      deletes += indexWrite.deletes;
      indexChunkCount = indexWrite.chunkCount;

      snapshotRef = nextSnapshotRef;
      nextSnapshotSequence = snapshotSequence + 1;
      cleanup = nextCleanup;
      root = nextRoot;
      hasSidecar = true;
      snapshot = nextSnapshot;
      metadata = { snapshot, events: sidecarEventMetadata(refs, snapshot) };
      const chunkCount = Math.max(snapshotWrite.chunkCount, indexWrite.chunkCount);
      return {
        puts,
        deletes,
        encodedBytes: snapshotWrite.encodedBytes + indexWrite.encodedBytes,
        chunkCount,
        format: chunkCount > 0 ? "chunked" : "compact",
      };
    },
  };
}

/**
 * Writes the predecessor single-record layout. Only the unscoped-to-scoped session
 * migration and tests seeding historical state still produce it.
 */
export async function writeStoredWatchState(
  storage: WatchStorage,
  storageKey: string,
  state: StoredWatchState,
): Promise<WatchStateWriteStats> {
  const previousChunkCount = await readRecordChunkCount(storage, storageKey);
  return writeChunkedRecord(storage, storageKey, state, previousChunkCount);
}

function logWatchStateWrite(event: WatchEvent, write: WatchAppendStats): void {
  const storageKeyWrites = write.puts + write.deletes;
  console.log(JSON.stringify({
    event: "watch_pr.do_storage",
    schema_version: 1,
    sample_rate: 1,
    sample_reason: "all",
    source: event.githubEvent === "snapshot" ? "refresh" : "webhook",
    github_event: event.githubEvent,
    github_action: event.action,
    storage_key_puts: write.puts,
    storage_key_deletes: write.deletes,
    storage_key_writes: storageKeyWrites,
    encoded_state_bytes: write.encodedBytes,
    state_chunk_count: write.chunkCount,
    state_format: write.format,
    windowed_events: write.windowEvents,
    predecessor_payload_references: write.rootReferences,
  }));
}

type WebhookAdmissionOutcome =
  | "accepted"
  | "admission_error"
  | "duplicate_in_flight"
  | "duplicate_persisted"
  | "invalid_json"
  | "unsupported_event";

function logWebhookAdmission(outcome: WebhookAdmissionOutcome, eventName?: string): void {
  console.log(JSON.stringify({
    event: "watch_pr.webhook_admission",
    schema_version: 1,
    ...(eventName === undefined ? {} : { github_event: eventName }),
    outcome,
  }));
}

function logWebhookFanout(eventName: string, outcome: "completed" | "failed", stats: WebhookProcessStats): void {
  const storageKeyWrites = stats.storageKeyPuts + stats.storageKeyDeletes;
  console.log(JSON.stringify({
    event: "watch_pr.webhook_fanout",
    schema_version: 1,
    sample_rate: 1,
    sample_reason: "all",
    outcome,
    github_event: eventName,
    candidate_watches: stats.candidateWatches,
    routed_watches: stats.routedWatches,
    duplicate_watches: stats.duplicateWatches,
    published_watches: stats.publishedWatches,
    storage_key_puts: stats.storageKeyPuts,
    delivery_dedupe_puts: stats.deliveryDedupePuts,
    storage_key_deletes: stats.storageKeyDeletes,
    storage_key_writes: storageKeyWrites,
    compact_writes: stats.compactWrites,
    chunked_writes: stats.chunkedWrites,
    largest_state_bytes: stats.largestStateBytes,
    largest_state_chunk_count: stats.largestStateChunkCount,
  }));
}

const monitorEncoder = new TextEncoder();

function resumesClosedWatch(event: WatchEvent, snapshot: PullRequestSnapshot | null): boolean {
  if (terminalState(snapshot) !== "watching") return false;
  return (
    (event.githubEvent === "pull_request" && event.action === "reopened") ||
    (event.githubEvent === "snapshot" && event.action === "watch")
  );
}

function compactMonitorEvent(event: WatchEvent, state: MonitorTerminalState): PrMonitorEvent {
  return {
    id: event.id,
    repository: event.repository,
    pullRequestNumber: event.pullRequestNumber,
    githubEvent: event.githubEvent,
    action: event.action,
    receivedAt: event.receivedAt,
    changes: event.changes,
    details: event.details ?? [],
    terminalState: state,
  };
}

function reconciliationMonitorEvent(
  state: { events: readonly Pick<WatchEvent, "id" | "receivedAt">[]; snapshot: PullRequestSnapshot | null },
  action: "cursor_miss" | "terminal_snapshot",
  repository: string,
  pullRequestNumber: number,
): PrMonitorEvent {
  const latest = state.events.at(-1);
  const snapshot = state.snapshot;
  return {
    id: latest?.id ?? `snapshot-${snapshot?.fetchedAt ?? "unavailable"}`,
    repository,
    pullRequestNumber,
    githubEvent: "reconciliation",
    action,
    receivedAt: snapshot?.fetchedAt ?? latest?.receivedAt ?? new Date().toISOString(),
    changes: action === "cursor_miss" ? ["reconciled"] : [],
    details: snapshot ? monitorReconciliationDetails(snapshot) : [],
    terminalState: terminalState(snapshot),
  };
}

function monitorFrame(event: PrMonitorEvent): Uint8Array {
  const id = event.id.replace(/[\r\n]/gu, "");
  return monitorEncoder.encode(`id: ${id}\nevent: pr\ndata: ${JSON.stringify(event)}\n\n`);
}



export class WatchPrHub {
  private readonly activeSessions = new Map<string, ActiveSession>();
  private readonly activeMonitorFeeds = new Map<string, Set<ActiveMonitorFeed>>();
  private readonly refreshes = new Set<string>();
  private readonly sessionOperations = new Map<string, Promise<void>>();
  private readonly recentDeliveries = new Set<string>();

  constructor(
    private readonly state: DurableObjectState,
    private readonly env: Env,
  ) { }

  private rememberDelivery(deliveryId: string): boolean {
    if (this.recentDeliveries.has(deliveryId)) return false;
    this.recentDeliveries.add(deliveryId);
    return true;
  }


  private releaseDelivery(deliveryId: string): void {
    this.recentDeliveries.delete(deliveryId);
  }


  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/mcp") return this.handleMcp(request);
    if (url.pathname.startsWith("/monitor/")) return this.handleMonitorFeed(request);
    if (url.pathname === "/webhooks/github") return this.handleGithubWebhook(request);
    if (url.pathname === "/oauth/register") return this.handleOAuthRegister(request);
    if (url.pathname === "/oauth/authorize") return this.handleOAuthAuthorize(request);
    if (url.pathname === "/oauth/callback") return this.handleOAuthCallback(request);
    if (url.pathname === "/oauth/token") return this.handleOAuthToken(request);
    if (url.pathname === "/internal/poll") return this.handlePoll(request);
    return new Response("Not found", { status: 404 });
  }

  private async handleMonitorFeed(request: Request): Promise<Response> {
    if (request.method !== "GET") return this.monitorError(405, "method_not_allowed", "monitor feeds require GET");
    const url = new URL(request.url);
    const match = /^\/monitor\/([A-Za-z0-9_-]+)$/u.exec(url.pathname);
    if (!match) return this.monitorError(404, "monitor_not_found", "monitor capability is invalid or revoked");
    const capability = match[1];
    const capabilityKey = monitorCapabilityStorageKey(capability);
    const record = await this.state.storage.get<MonitorCapabilityRecord>(capabilityKey);
    if (!record) return this.monitorError(404, "monitor_not_found", "monitor capability is invalid or revoked");

    const session = await this.state.storage.get<SessionRecord>(sessionStorageKey(record.sessionToken));
    const key = watchKey(record.repository, record.pullRequestNumber);
    if (
      Math.min(record.expiresAt, record.createdAt + MONITOR_TTL_MS) <= Date.now() ||
      !session ||
      session.expiresAt <= Date.now() ||
      session.user.id !== record.userId ||
      !session.watches.includes(key)
    ) {
      await this.revokeMonitorCapability(capability, record);
      return this.monitorError(404, "monitor_not_found", "monitor capability is invalid or revoked");
    }

    const headerCursor = request.headers.get("last-event-id")?.trim();
    const queryCursor = url.searchParams.get("cursor")?.trim();
    const cursor = headerCursor || queryCursor || null;
    if (cursor && cursor.length > MAX_MONITOR_CURSOR_LENGTH) {
      return this.monitorError(400, "invalid_cursor", `monitor cursor must not exceed ${MAX_MONITOR_CURSOR_LENGTH} characters`);
    }

    const watchState = await this.watchStateMetadata(record.userId, key);
    const currentTerminalState = terminalState(watchState.snapshot);
    let selected = watchState.events;
    let reconciliationAction: "cursor_miss" | "terminal_snapshot" | null = null;
    if (cursor) {
      const cursorIndex = watchState.events.findIndex((event) => event.id === cursor);
      if (cursorIndex >= 0) {
        selected = watchState.events.slice(cursorIndex + 1);
      } else {
        selected = [];
        reconciliationAction = "cursor_miss";
      }
    }
    if (currentTerminalState !== "watching" && selected.length === 0 && !reconciliationAction) {
      const latest = watchState.events.at(-1);
      if (latest) {
        selected = [latest];
      } else {
        reconciliationAction = "terminal_snapshot";
      }
    }

    let activeFeed!: ActiveMonitorFeed;
    let streamController!: ReadableStreamDefaultController<Uint8Array>;
    const body = new ReadableStream<Uint8Array>({
      start: (controller) => {
        streamController = controller;
        const heartbeat = setInterval(() => {
          if (!activeFeed || activeFeed.closed || !activeFeed.ready) return;
          try {
            controller.enqueue(monitorEncoder.encode(": heartbeat\n\n"));
          } catch {
            this.closeMonitorFeed(activeFeed);
          }
        }, MONITOR_HEARTBEAT_MS);
        const expiration = setTimeout(() => {
          if (!activeFeed || activeFeed.closed) return;
          this.closeMonitorFeed(activeFeed);
          this.state.waitUntil(this.revokeMonitorCapability(capability, record));
        }, Math.max(0, Math.min(record.expiresAt, record.createdAt + MONITOR_TTL_MS) - Date.now()));
        activeFeed = {
          capability,
          userId: record.userId,
          sessionToken: record.sessionToken,
          key,
          controller,
          heartbeat,
          expiration,
          ready: false,
          pending: [],
          closed: false,
        };
        const feeds = this.activeMonitorFeeds.get(capability) ?? new Set<ActiveMonitorFeed>();
        feeds.add(activeFeed);
        this.activeMonitorFeeds.set(capability, feeds);
      },
      cancel: () => {
        if (activeFeed) this.closeMonitorFeed(activeFeed, false);
      },
    });

    try {
      const hydrated = await readStoredWatchEvents(
        this.state.storage,
        watchStorageKey(record.userId, record.repository, record.pullRequestNumber),
        selected.map((event) => event.id),
      );
      const metadataById = new Map(selected.map((event) => [event.id, event]));
      let events = hydrated.map((event) =>
        compactMonitorEvent(event, metadataById.get(event.id)?.terminalState ?? "watching"));
      if (reconciliationAction) {
        events = [reconciliationMonitorEvent(
          watchState,
          reconciliationAction,
          record.repository,
          record.pullRequestNumber,
        )];
      }

      const confirmed = await this.state.storage.get<MonitorCapabilityRecord>(capabilityKey);
      if (
        !confirmed ||
        confirmed.sessionToken !== record.sessionToken ||
        confirmed.userId !== record.userId ||
        confirmed.repository !== record.repository ||
        confirmed.pullRequestNumber !== record.pullRequestNumber ||
        confirmed.expiresAt !== record.expiresAt
      ) {
        this.closeMonitorFeed(activeFeed);
        return this.monitorError(404, "monitor_not_found", "monitor capability is invalid or revoked");
      }
      if (!activeFeed.closed) {
        for (const feed of [...(this.activeMonitorFeeds.get(capability) ?? [])]) {
          if (feed !== activeFeed) this.closeMonitorFeed(feed);
        }
        const pending = activeFeed.pending.splice(0);
        const finalTerminalState = pending.at(-1)?.terminalState ?? currentTerminalState;
        const queued = finalTerminalState === "watching"
          ? [...events, ...pending].filter((event) => event.terminalState === "watching")
          : [...events, ...pending];
        activeFeed.ready = true;
        streamController.enqueue(monitorEncoder.encode(": connected\n\n"));
        for (const event of queued) streamController.enqueue(monitorFrame(event));
        if (finalTerminalState !== "watching") this.closeMonitorFeed(activeFeed);
      }
    } catch (error) {
      this.closeMonitorFeed(activeFeed);
      throw error;
    }
    return new Response(body, {
      headers: {
        "cache-control": "no-cache, no-transform",
        "content-type": "text/event-stream; charset=utf-8",
        connection: "keep-alive",
        "x-accel-buffering": "no",
      },
    });
  }

  private closeMonitorFeed(feed: ActiveMonitorFeed, closeController = true): void {
    if (feed.closed) return;
    feed.closed = true;
    clearInterval(feed.heartbeat);
    clearTimeout(feed.expiration);
    const feeds = this.activeMonitorFeeds.get(feed.capability);
    feeds?.delete(feed);
    if (feeds?.size === 0) this.activeMonitorFeeds.delete(feed.capability);
    if (!closeController) return;
    try {
      feed.controller.close();
    } catch {
      // The response can be canceled while an event is being delivered.
    }
  }

  private publishMonitorEvent(userId: number, key: string, event: PrMonitorEvent): void {
    for (const feeds of this.activeMonitorFeeds.values()) {
      for (const feed of [...feeds]) {
        if (feed.userId !== userId || feed.key !== key || feed.closed) continue;
        if (!feed.ready) {
          feed.pending.push(event);
          continue;
        }
        try {
          feed.controller.enqueue(monitorFrame(event));
        } catch {
          this.closeMonitorFeed(feed);
          continue;
        }
        if (event.terminalState !== "watching") this.closeMonitorFeed(feed);
      }
    }
  }

  private monitorError(status: number, error: string, description: string): Response {
    return this.json({ error, error_description: description }, status, {
      "cache-control": "no-store",
    });
  }

  private async handleMcp(request: Request): Promise<Response> {
    const bearer = parseBearerToken(request);
    if (!bearer) return this.unauthorized(request);
    const session = await this.sessionForToken(bearer);
    if (!session) return this.unauthorized(request);

    const sessionId = request.headers.get("mcp-session-id");
    if (sessionId) {
      if (await this.isClosedMcpSession(bearer, sessionId)) return this.mcpSessionNotFound();
      const existing = this.activeSessions.get(sessionId);
      if (existing && existing.token !== bearer) return this.mcpSessionNotFound();
      if (request.method === "DELETE") {
        await this.rememberClosedMcpSession(bearer, sessionId);
        if (existing) await this.closeActiveSession(sessionId, existing);
        return this.withMcpSessionId(new Response(null, { status: 200 }), sessionId);
      }
      if (existing) {
        existing.record = session.record;
        this.syncActiveSession(existing, session.record);
        if (existing.kind === "stateful") {
          return existing.transport ? existing.transport.handleRequest(request) : this.mcpSessionNotFound();
        }
        if (request.method === "GET") {
          await this.closeActiveSession(sessionId, existing);
          return this.openRecoveredMcpStream(request, existing, sessionId);
        }
        return this.handleRecoveredMcpRequest(request, existing, sessionId);
      }
      const recovered = this.newActiveSession(bearer, session.record, "recovered-stream");
      if (request.method === "GET") return this.openRecoveredMcpStream(request, recovered, sessionId);
      return this.handleRecoveredMcpRequest(request, recovered, sessionId);
    }

    let body: unknown;
    try {
      body = await request.clone().json();
    } catch {
      body = null;
    }
    if (!isInitializeMessage(body)) {
      return new Response(JSON.stringify({ error: "MCP initialization is required" }), {
        status: 400,
        headers: { "content-type": "application/json" },
      });
    }

    const active = this.newActiveSession(bearer, session.record, "stateful");
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: () => randomToken(24),
      onsessioninitialized: (id) => {
        active.sessionId = id;
        active.transport = transport;
        active.server = server;
        this.activeSessions.set(id, active);
      },
      onsessionclosed: (id) => {
        this.activeSessions.delete(id);
      },
      keepAliveMs: 15_000,
    });
    const server = createMcpServer(this.mcpContext(active));
    active.transport = transport;
    active.server = server;
    await server.connect(transport);
    return transport.handleRequest(request);
  }

  private newActiveSession(
    token: string,
    record: SessionRecord,
    kind: ActiveSession["kind"],
  ): ActiveSession {
    return {
      token,
      record,
      kind,
      watches: new Set(record.watches),
      subscriptions: new Set(record.subscriptions ?? []),
    };
  }

  private async openRecoveredMcpStream(
    request: Request,
    active: ActiveSession,
    sessionId: string,
  ): Promise<Response> {
    const transport = new WebStandardStreamableHTTPServerTransport({ keepAliveMs: 15_000 });
    const server = createMcpServer(this.mcpContext(active));
    await server.connect(transport);
    const response = await transport.handleRequest(request);
    if (!response.ok) {
      await server.close();
      return this.withMcpSessionId(response, sessionId);
    }
    active.sessionId = sessionId;
    active.transport = transport;
    active.server = server;
    this.activeSessions.set(sessionId, active);
    await this.notifySubscribedResources(active);
    return this.withMcpSessionId(response, sessionId);
  }

  private async handleRecoveredMcpRequest(
    request: Request,
    active: ActiveSession,
    sessionId: string,
  ): Promise<Response> {
    const transport = new WebStandardStreamableHTTPServerTransport({
      enableJsonResponse: true,
      keepAliveMs: 15_000,
    });
    const server = createMcpServer(this.mcpContext(active));
    await server.connect(transport);
    try {
      const response = await transport.handleRequest(request);
      return this.withMcpSessionId(response, sessionId);
    } finally {
      await Promise.allSettled([server.close(), transport.close()]);
    }
  }

  private withMcpSessionId(response: Response, sessionId: string): Response {
    const headers = new Headers(response.headers);
    headers.set("mcp-session-id", sessionId);
    return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
  }

  private mcpSessionNotFound(): Response {
    return new Response(JSON.stringify({ error: "MCP session not found" }), {
      status: 404,
      headers: { "content-type": "application/json" },
    });
  }

  private async isClosedMcpSession(token: string, sessionId: string): Promise<boolean> {
    return this.withSessionLock(token, async () => {
      const closed = await this.state.storage.get<string[]>(`closed-mcp-sessions:${token}`);
      return closed?.includes(sessionId) ?? false;
    });
  }

  private async rememberClosedMcpSession(token: string, sessionId: string): Promise<void> {
    await this.withSessionLock(token, async () => {
      const key = `closed-mcp-sessions:${token}`;
      await this.state.storage.transaction(async (storage) => {
        const closed = await storage.get<string[]>(key) ?? [];
        if (closed.includes(sessionId)) return;
        await storage.put(key, [...closed, sessionId].slice(-MAX_CLOSED_MCP_SESSIONS));
      });
    });
  }

  private mcpContext(active: ActiveSession): McpSessionContext {
    return {
      user: active.record.user,
      watches: active.watches,
      watch: async (repository, number) => this.watch(active, repository, number),
      unwatch: async (repository, number) => this.unwatch(active, repository, number),
      listWatches: async () => this.listWatches(active),
      openMonitor: async (repository, number) => this.openMonitor(active, repository, number),
      readWatch: async (repository, number) => this.readWatch(active, repository, number),
      subscribe: async (repository, number) => this.subscribe(active, repository, number),
      unsubscribe: async (repository, number) => this.unsubscribe(active, repository, number),
    };
  }

  private syncActiveSession(active: ActiveSession, record: SessionRecord): void {
    active.watches.clear();
    for (const key of record.watches) active.watches.add(key);
    active.subscriptions.clear();
    for (const key of record.subscriptions ?? []) {
      if (active.watches.has(key)) active.subscriptions.add(key);
    }
  }

  private async watch(active: ActiveSession, repository: string, number: number): Promise<WatchRegistration> {
    const key = watchKey(repository, number);
    const wasWatched = await this.updateSession(active, (watches, subscriptions) => {
      const existed = watches.has(key);
      watches.add(key);
      subscriptions.add(key);
      return existed;
    });
    const state = await this.watchStateMetadata(active.record.user.id, key);
    const refreshScheduled = terminalState(state.snapshot) !== "merged";
    if (refreshScheduled) this.scheduleRefresh(active.record.user.id, key, active.record.githubAccessToken, active.token, "watch");
    if (!wasWatched) await this.notifyResourceListChanged(active);
    return {
      key,
      repository: parseWatchKey(key).repository,
      number,
      resourceUri: resourceUri(repository, number),
      snapshot: state.snapshot,
      refreshScheduled,
    };
  }

  private async unwatch(active: ActiveSession, repository: string, number: number): Promise<boolean> {
    const key = watchKey(repository, number);
    const removed = await this.updateSession(active, (watches, subscriptions) => {
      subscriptions.delete(key);
      return watches.delete(key);
    });
    await this.revokeMonitorScope(active.token, key);
    if (removed) await this.notifyResourceListChanged(active);
    return removed;
  }

  private async openMonitor(
    active: ActiveSession,
    repository: string,
    number: number,
  ): Promise<PrMonitorRegistration> {
    const key = watchKey(repository, number);
    if (!active.watches.has(key)) throw new Error("pull request is not watched by this session");
    const parsed = parseWatchKey(key);
    const scopeKey = monitorScopeStorageKey(active.token, parsed.repository, parsed.number);
    let capability = await this.state.storage.get<string>(scopeKey);
    let record = capability
      ? await this.state.storage.get<MonitorCapabilityRecord>(monitorCapabilityStorageKey(capability))
      : undefined;
    if (
      !capability ||
      !record ||
      record.sessionToken !== active.token ||
      record.userId !== active.record.user.id ||
      record.repository !== parsed.repository ||
      record.pullRequestNumber !== parsed.number ||
      Math.min(record.expiresAt, record.createdAt + MONITOR_TTL_MS) <= Date.now()
    ) {
      if (capability) await this.revokeMonitorCapability(capability, record);
      capability = randomToken(32);
      const createdAt = Date.now();
      record = {
        sessionToken: active.token,
        userId: active.record.user.id,
        repository: parsed.repository,
        pullRequestNumber: parsed.number,
        createdAt,
        expiresAt: Math.min(active.record.expiresAt, createdAt + MONITOR_TTL_MS),
      };
      await putStorageEntries(this.state.storage, {
        [scopeKey]: capability,
        [monitorCapabilityStorageKey(capability)]: record,
      });
    }

    const state = await this.watchStateMetadata(record.userId, key);
    const cursor = state.events.at(-1)?.id ?? null;
    const monitorUrl = new URL(`${this.baseUrl()}/monitor/${capability}`);
    if (cursor) monitorUrl.searchParams.set("cursor", cursor);
    return {
      monitorUrl: monitorUrl.toString(),
      cursor,
      terminalState: terminalState(state.snapshot),
    };
  }

  private async revokeMonitorScope(sessionToken: string, key: string): Promise<number> {
    const parsed = parseWatchKey(key);
    const scopeKey = monitorScopeStorageKey(sessionToken, parsed.repository, parsed.number);
    const capability = await this.state.storage.get<string>(scopeKey);
    if (!capability) return 0;
    const record = await this.state.storage.get<MonitorCapabilityRecord>(monitorCapabilityStorageKey(capability));
    if (!record) {
      await this.state.storage.delete(scopeKey);
      return 1;
    }
    return this.revokeMonitorCapability(capability, record);
  }

  private async revokeMonitorCapability(
    capability: string,
    record?: MonitorCapabilityRecord,
  ): Promise<number> {
    const keys = [monitorCapabilityStorageKey(capability)];
    if (record) {
      const scopeKey = monitorScopeStorageKey(record.sessionToken, record.repository, record.pullRequestNumber);
      const current = await this.state.storage.get<string>(scopeKey);
      if (current === capability) keys.push(scopeKey);
    }
    await this.state.storage.delete(keys);
    for (const feed of [...(this.activeMonitorFeeds.get(capability) ?? [])]) this.closeMonitorFeed(feed);
    return keys.length;
  }

  private async revokeSessionMonitors(sessionToken: string, watchKeys: Iterable<string>): Promise<number> {
    let deletes = 0;
    for (const key of watchKeys) {
      try {
        deletes += await this.revokeMonitorScope(sessionToken, key);
      } catch {
        // Ignore malformed persisted watch keys while revoking the rest of the session.
      }
    }
    this.closeMonitorFeedsForSession(sessionToken);
    return deletes;
  }

  private closeMonitorFeedsForSession(sessionToken: string): void {
    for (const feeds of this.activeMonitorFeeds.values()) {
      for (const feed of [...feeds]) {
        if (feed.sessionToken === sessionToken) this.closeMonitorFeed(feed);
      }
    }
  }

  private async listWatches(active: ActiveSession): Promise<WatchRegistration[]> {
    const registrations: WatchRegistration[] = [];
    for (const key of [...active.watches].sort()) {
      const parsed = parseWatchKey(key);
      const state = await this.watchStateMetadata(active.record.user.id, key);
      registrations.push({
        key,
        repository: parsed.repository,
        number: parsed.number,
        resourceUri: resourceUri(parsed.repository, parsed.number),
        snapshot: state.snapshot,
        refreshScheduled: state.snapshot === null,
      });
    }
    return registrations;
  }

  private async readWatch(active: ActiveSession, repository: string, number: number): Promise<StoredWatchState> {
    const key = watchKey(repository, number);
    if (!active.watches.has(key)) throw new Error("pull request is not watched by this session");
    const state = await this.watchStateFull(active.record.user.id, key);
    if (!state.snapshot) this.scheduleRefresh(active.record.user.id, key, active.record.githubAccessToken, active.token, "read");
    return state;
  }

  private async subscribe(active: ActiveSession, repository: string, number: number): Promise<void> {
    const key = watchKey(repository, number);
    await this.updateSession(active, (watches, subscriptions) => {
      if (!watches.has(key)) throw new Error("watch the pull request before subscribing to its resource");
      subscriptions.add(key);
    });
  }

  private async unsubscribe(active: ActiveSession, repository: string, number: number): Promise<void> {
    const key = watchKey(repository, number);
    await this.updateSession(active, (_watches, subscriptions) => {
      subscriptions.delete(key);
    });
  }

  private async updateSession<T>(
    active: ActiveSession,
    mutate: (watches: Set<string>, subscriptions: Set<string>) => T,
  ): Promise<T> {
    return this.withSessionLock(active.token, async () => {
      const key = sessionStorageKey(active.token);
      const updated = await this.state.storage.transaction(async (storage) => {
        const current = await storage.get<SessionRecord>(key);
        if (!current || current.expiresAt <= Date.now()) {
          if (current) await storage.delete(key);
          return null;
        }
        const watches = new Set(current.watches);
        const subscriptions = new Set(current.subscriptions ?? []);
        const result = mutate(watches, subscriptions);
        const nextWatches = [...watches].sort();
        const nextSubscriptions = [...subscriptions].filter((entry) => watches.has(entry)).sort();
        const watchesChanged =
          current.watches.length !== nextWatches.length ||
          current.watches.some((entry, index) => entry !== nextWatches[index]);
        const currentSubscriptions = current.subscriptions ?? [];
        const subscriptionsChanged =
          currentSubscriptions.length !== nextSubscriptions.length ||
          currentSubscriptions.some((entry, index) => entry !== nextSubscriptions[index]);
        if (!watchesChanged && !subscriptionsChanged) return { record: current, result };
        const record: SessionRecord = {
          ...current,
          watches: nextWatches,
          subscriptions: nextSubscriptions,
        };
        await storage.put(key, record);
        return { record, result };
      });
      if (!updated) {
        await this.revokeSessionMonitors(active.token, active.watches);
        await this.closeActiveSessionsForToken(active.token);
        throw new Error("session is no longer active");
      }
      this.syncActiveSessions(active.token, updated.record);
      return updated.result;
    });
  }

  private async withSessionLock<T>(token: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.sessionOperations.get(token) ?? Promise.resolve();
    let release = (): void => { };
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.sessionOperations.set(token, current);
    await previous;
    try {
      return await operation();
    } finally {
      release();
      if (this.sessionOperations.get(token) === current) this.sessionOperations.delete(token);
    }
  }

  private async sessionForToken(token: string): Promise<{ token: string; record: SessionRecord } | null> {
    return this.withSessionLock(token, () => this.sessionForTokenUnlocked(token));
  }

  private async sessionForTokenUnlocked(token: string): Promise<{ token: string; record: SessionRecord } | null> {

    const key = sessionStorageKey(token);
    const record = await this.state.storage.get<SessionRecord>(key);
    if (!record) {
      await this.state.storage.delete(`closed-mcp-sessions:${token}`);
      this.closeMonitorFeedsForSession(token);
      await this.closeActiveSessionsForToken(token);
      return null;
    }
    const now = Date.now();
    if (record.expiresAt <= now) {
      await this.revokeSessionMonitors(token, record.watches);
      await this.state.storage.delete([key, `closed-mcp-sessions:${token}`]);
      await this.closeActiveSessionsForToken(token);
      return null;
    }
    await this.migrateLegacyWatchStates(record);
    if (record.watchStorageVersion !== 1) {
      record.watchStorageVersion = 1;
      await this.state.storage.put(key, record);
    }

    const needsRefresh = Boolean(record.githubTokenExpiresAt && record.githubTokenExpiresAt <= now + 60_000);
    const canRefresh = Boolean(
      needsRefresh &&
      record.githubRefreshToken &&
      this.env.GITHUB_CLIENT_SECRET &&
      (!record.githubRefreshTokenExpiresAt || record.githubRefreshTokenExpiresAt > now),
    );
    if (canRefresh) {
      try {
        const refreshed = await refreshGithubToken(this.env.GITHUB_CLIENT_ID, this.env.GITHUB_CLIENT_SECRET!, record.githubRefreshToken!);
        record.githubAccessToken = refreshed.accessToken;
        record.githubRefreshToken = refreshed.refreshToken ?? record.githubRefreshToken;
        record.githubTokenExpiresAt = refreshed.expiresIn ? now + refreshed.expiresIn * 1000 : undefined;
        record.githubRefreshTokenExpiresAt = refreshed.refreshTokenExpiresIn
          ? now + refreshed.refreshTokenExpiresIn * 1000
          : record.githubRefreshTokenExpiresAt;
        await this.state.storage.put(key, record);
      } catch (error) {
        if (isGithubAuthorizationError(error) || (record.githubTokenExpiresAt && record.githubTokenExpiresAt <= now)) {
          await this.revokeSessionMonitors(token, record.watches);
          await this.state.storage.delete([key, `closed-mcp-sessions:${token}`]);
          await this.closeActiveSessionsForToken(token);
          return null;
        }
      }
    }
    if (record.githubTokenExpiresAt && record.githubTokenExpiresAt <= now) {
      await this.revokeSessionMonitors(token, record.watches);
      await this.state.storage.delete([key, `closed-mcp-sessions:${token}`]);
      await this.closeActiveSessionsForToken(token);
      return null;
    }
    return { token, record };
  }
  private async migrateLegacyWatchStates(record: SessionRecord): Promise<void> {
    if (record.watchStorageVersion === 1) return;
    for (const key of record.watches) {
      let parsed;
      try {
        parsed = parseWatchKey(key);
      } catch {
        continue;
      }
      const legacyKey = legacyWatchStorageKey(parsed.repository, parsed.number);
      const legacyStored = await this.state.storage.get<unknown>(legacyKey);
      if (legacyStored === undefined) continue;
      const scopedKey = watchStorageKey(record.user.id, parsed.repository, parsed.number);
      const legacyState = await readStoredWatchState(this.state.storage, legacyKey);
      await this.state.storage.transaction(async (storage) => {
        if ((await storage.get<unknown>(scopedKey)) !== undefined) return;
        // A sidecar already owns this watch: its predecessor record was retired on purpose.
        if ((await storage.get<unknown>(watchSidecarIndexKey(scopedKey))) !== undefined) return;
        await writeStoredWatchState(storage, scopedKey, legacyState);
      });
    }
  }

  private async handleGithubWebhook(request: Request): Promise<Response> {
    if (request.method !== "POST") return new Response("Method not allowed", { status: 405 });
    const body = await request.text();
    const valid = await verifyGithubSignature(body, request.headers.get("x-hub-signature-256"), this.env.GITHUB_WEBHOOK_SECRET);
    if (!valid) return new Response("Invalid webhook signature", { status: 401 });
    const eventName = request.headers.get("x-github-event")?.trim() ?? "";
    const deliveryId = request.headers.get("x-github-delivery")?.trim() || randomToken(12);
    if (!isSupportedGithubEvent(eventName)) {
      logWebhookAdmission("unsupported_event");
      return this.accepted({ accepted: true, ignored: true, event: eventName });
    }

    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(body) as Record<string, unknown>;
    } catch {
      logWebhookAdmission("invalid_json", eventName);
      return new Response("Invalid JSON", { status: 400 });
    }
    const deliveryKey = `delivery:${deliveryId}`;
    let previousDelivery: number | undefined;
    try {
      previousDelivery = await this.state.storage.get<number>(deliveryKey);
    } catch (error) {
      logWebhookAdmission("admission_error", eventName);
      throw error;
    }
    if (previousDelivery && Date.now() - previousDelivery < DELIVERY_DEDUPLICATION_WINDOW_MS) {
      logWebhookAdmission("duplicate_persisted", eventName);
      return this.accepted({ accepted: true, duplicate: true });
    }
    if (!this.rememberDelivery(deliveryId)) {
      logWebhookAdmission("duplicate_in_flight", eventName);
      return this.accepted({ accepted: true, duplicate: true });
    }
    logWebhookAdmission("accepted", eventName);
    const stats = createWebhookProcessStats();
    this.state.waitUntil(
      this.processWebhook(eventName, deliveryId, payload, stats)
        .then(() => {
          logWebhookFanout(eventName, "completed", stats);
        })
        .catch(async (error) => {
          logWebhookFanout(eventName, "failed", stats);
          const errorKind = error instanceof GithubApiError
            ? "github_api"
            : error instanceof TypeError
              ? "network_or_runtime"
              : "unexpected";
          const githubStatus = error instanceof GithubApiError ? error.status : undefined;
          console.log(JSON.stringify({
            event: "watch_pr.webhook_failure",
            github_event: eventName,
            delivery_fingerprint: await sha256Base64Url(deliveryId),
            error_kind: errorKind,
            error_name: error instanceof Error ? error.name : typeof error,
            ...(githubStatus === undefined ? {} : { github_status: githubStatus }),
          }));
        })
        .finally(() => {
          this.releaseDelivery(deliveryId);
        }),
    );
    return this.accepted({ accepted: true, deliveryId, event: eventName });
  }

  private async reconcileActiveSessions(): Promise<void> {
    for (const active of [...this.activeSessions.values()]) {
      const session = await this.sessionForToken(active.token);
      if (!session) continue;
      this.syncActiveSessions(active.token, session.record);
    }
  }

  private async invalidateSession(token: string, expectedGithubToken?: string): Promise<number> {
    return this.withSessionLock(token, async () => {
      const key = sessionStorageKey(token);
      const current = await this.state.storage.get<SessionRecord>(key);
      if (!current) {
        this.closeMonitorFeedsForSession(token);
        await this.closeActiveSessionsForToken(token);
        return 0;
      }
      if (expectedGithubToken && current.githubAccessToken !== expectedGithubToken) return 0;
      const monitorDeletes = await this.revokeSessionMonitors(token, current.watches);
      const closedSessionKey = `closed-mcp-sessions:${token}`;
      const closedSession = await this.state.storage.get<unknown>(closedSessionKey);
      const keys = closedSession === undefined ? [key] : [key, closedSessionKey];
      await this.state.storage.delete(keys);
      await this.closeActiveSessionsForToken(token);
      return monitorDeletes + keys.length;
    });
  }

  private async processWebhook(
    eventName: string,
    deliveryId: string,
    payload: Record<string, unknown>,
    stats = createWebhookProcessStats(),
  ): Promise<WebhookProcessStats> {
    await this.reconcileActiveSessions();
    const sessions = await this.sessionRecords();
    const watchers = new Map<string, WebhookWatcher>();
    const invalidSessionTokens = new Set<string>();
    const addWatchers = (sessionToken: string, record: SessionRecord): void => {
      for (const key of record.watches) {
        watchers.set(`${record.user.id}:${key}`, {
          userId: record.user.id,
          key,
          githubToken: record.githubAccessToken,
          sessionToken,
        });
      }
    };
    for (const [sessionToken, record] of sessions) addWatchers(sessionToken, record);
    for (const active of this.activeSessions.values()) addWatchers(active.token, active.record);
    stats.candidateWatches = watchers.size;

    const repository = repositoryFromPayload(payload);
    if (!repository) {
      return stats;
    }
    const webhookAction = actionFromPayload(payload);
    const targets: WebhookTarget[] = [];
    for (const watcher of watchers.values()) {
      let parsed;
      try {
        parsed = parseWatchKey(watcher.key);
      } catch {
        continue;
      }
      if (eventName !== "push" && parsed.repository !== repository) continue;
      let previous: WatchStateMetadata | undefined;
      if (eventName === "push") previous = await this.watchStateMetadata(watcher.userId, watcher.key);
      const targetNumbers = eventPullRequestNumbers(eventName, payload, [{
        key: watcher.key,
        snapshot: previous?.snapshot ?? null,
      }]);
      if (!targetNumbers.includes(parsed.number)) continue;
      previous ??= await this.watchStateMetadata(watcher.userId, watcher.key);
      const previousTerminalState = terminalState(previous.snapshot);
      if (previousTerminalState === "merged") continue;
      if (previousTerminalState === "closed" && (eventName !== "pull_request" || webhookAction !== "reopened")) continue;
      targets.push({ ...watcher, repository: parsed.repository, number: parsed.number, previous });
    }
    stats.routedWatches = targets.length;
    if (targets.length === 0) {
      return stats;
    }



    for (const target of targets) {
      const { githubToken, key, number, previous, repository: targetRepository, sessionToken, userId } = target;
      if (invalidSessionTokens.has(sessionToken)) continue;
      if (previous.events.some((event) => event.deliveryId === deliveryId)) {
        stats.duplicateWatches += 1;
        continue;
      }
      let snapshot = previous.snapshot;
      try {
        snapshot = await pullRequestSnapshot(githubToken, targetRepository, number, previous.snapshot);
      } catch (error) {
        if (isGithubAuthorizationError(error)) {
          invalidSessionTokens.add(sessionToken);
          stats.storageKeyDeletes += await this.invalidateSession(sessionToken, githubToken);
          continue;
        }
        snapshot = previous.snapshot;
      }
      const changes = snapshot && previous.snapshot ? snapshotChanges(previous.snapshot, snapshot) : snapshot ? ["initial_snapshot"] : [];
      const event = createWatchEvent({
        deliveryId,
        githubEvent: eventName,
        action: webhookAction,
        repository: targetRepository,
        pullRequestNumber: number,
        payload,
        snapshot,
        changes,
      });
      const result = await this.publishEvent(userId, key, event, { snapshot }, (writes) => {
        stats.storageKeyPuts += writes.puts;
        stats.storageKeyDeletes += writes.deletes;
      });
      if (!result.published || !result.write) continue;
      stats.publishedWatches += 1;
      stats.largestStateBytes = Math.max(stats.largestStateBytes, result.write.encodedBytes);
      stats.largestStateChunkCount = Math.max(stats.largestStateChunkCount, result.write.chunkCount);
      if (result.write.format === "compact") stats.compactWrites += 1;
      if (result.write.format === "chunked") stats.chunkedWrites += 1;
    }
    const deliveryKey = `delivery:${deliveryId}`;
    await this.state.storage.put(deliveryKey, Date.now());
    stats.deliveryDedupePuts = 1;
    stats.storageKeyPuts += 1;
    return stats;
  }

  private scheduleRefresh(userId: number, key: string, githubToken: string, sessionToken: string, reason: string): boolean {
    const refreshKey = `${userId}:${key}`;
    if (this.refreshes.has(refreshKey)) return false;
    this.refreshes.add(refreshKey);
    this.state.waitUntil(
      this.refreshAndPublish(userId, key, githubToken, sessionToken, reason).finally(() => {
        this.refreshes.delete(refreshKey);
      }),
    );
    return true;
  }

  private async refreshAndPublish(
    userId: number,
    key: string,
    githubToken: string,
    sessionToken: string,
    reason: string,
  ): Promise<void> {
    const initialState = await this.watchStateMetadata(userId, key);
    const initialTerminalState = terminalState(initialState.snapshot);
    if (initialTerminalState === "merged" || (initialTerminalState === "closed" && reason !== "watch")) return;
    const parsed = parseWatchKey(key);
    let snapshot;
    try {
      snapshot = await pullRequestSnapshot(githubToken, parsed.repository, parsed.number, initialState.snapshot);
    } catch (error) {
      if (isGithubAuthorizationError(error)) await this.invalidateSession(sessionToken, githubToken);
      return;
    }
    const current = await this.watchStateMetadata(userId, key);
    const currentTerminalState = terminalState(current.snapshot);
    if (currentTerminalState === "merged" || (currentTerminalState === "closed" && reason !== "watch")) return;
    const changes = snapshotChanges(current.snapshot, snapshot);
    if (current.snapshot && changes.length === 0) {
      // Nothing to report, but a refresh that learned previously unknown reactions must still
      // be stored, or every later refresh re-reads the same targets and learns them again.
      if (reactionKnowledgeAdvanced(current.snapshot, snapshot)) {
        await this.storeSnapshotOnly(userId, parsed.repository, parsed.number, snapshot);
      }
      return;
    }
    const event = createWatchEvent({
      deliveryId: `snapshot-${randomToken(12)}`,
      githubEvent: "snapshot",
      action: reason,
      repository: parsed.repository,
      pullRequestNumber: parsed.number,
      payload: { reason },
      snapshot,
      changes,
    });
    await this.publishEvent(userId, key, event, { snapshot });
  }

  private async revokeExpiredMonitorCapabilities(): Promise<number> {
    const records = await this.state.storage.list<MonitorCapabilityRecord>({ prefix: "monitor:" });
    let revoked = 0;
    const now = Date.now();
    for (const [storageKey, record] of records) {
      if (Math.min(record.expiresAt, record.createdAt + MONITOR_TTL_MS) > now) continue;
      const capability = storageKey.slice("monitor:".length);
      revoked += await this.revokeMonitorCapability(capability, record);
    }
    return revoked;
  }

  private async handlePoll(request: Request): Promise<Response> {
    if (request.method !== "POST") return new Response("Method not allowed", { status: 405 });
    await this.reconcileActiveSessions();
    const expiredMonitorsRevoked = await this.revokeExpiredMonitorCapabilities();
    const sessions = await this.sessionRecords();
    let refreshesStarted = 0;
    let scheduled = 0;
    for (const [sessionToken, record] of sessions) {
      for (const key of record.watches) {
        const state = await this.watchStateMetadata(record.user.id, key);
        if (terminalState(state.snapshot) !== "watching") continue;
        scheduled += 1;
        if (this.scheduleRefresh(record.user.id, key, record.githubAccessToken, sessionToken, "poll")) refreshesStarted += 1;
      }
    }
    console.log(JSON.stringify({
      event: "watch_pr.poll",
      active_sessions: sessions.size,
      scheduled_watches: scheduled,
      refreshes_started: refreshesStarted,
      expired_monitors_revoked: expiredMonitorsRevoked,
    }));
    return this.accepted({ accepted: true, scheduled });
  }

  /**
   * Stores a refresh that has nothing to announce but does know more than the stored
   * snapshot. No event is appended, so no monitor frame and no resource notification are
   * produced; a concurrently stored newer snapshot wins exactly as it does in `publishEvent`.
   */
  private async storeSnapshotOnly(
    userId: number,
    repository: string,
    pullRequestNumber: number,
    snapshot: PullRequestSnapshot,
  ): Promise<boolean> {
    const storageKey = watchStorageKey(userId, repository, pullRequestNumber);
    let stored = false;
    await this.state.storage.transaction(async (storage) => {
      const mutation = await openWatchStateMutation(storage, storageKey);
      const current = mutation.metadata.snapshot;
      if (!current || terminalState(current) === "merged") return;
      const currentTime = Date.parse(current.fetchedAt);
      const incomingTime = Date.parse(snapshot.fetchedAt);
      if (Number.isFinite(currentTime) && Number.isFinite(incomingTime) && currentTime > incomingTime) return;
      // The stored snapshot is the base: this write reports nothing, so it must add the
      // reactions this refresh read and change nothing else. A title, head or check that
      // landed while the refresh was in flight stays exactly as the writer that saw it left it.
      const next = mergeReactionKnowledge(current, snapshot);
      if (!reactionKnowledgeAdvanced(current, next)) return;
      await mutation.replaceSnapshot(next);
      stored = true;
    });
    return stored;
  }

  private async publishEvent(
    userId: number,
    key: string,
    event: WatchEvent,
    state: Pick<StoredWatchState, "snapshot">,
    onWatchStorageWrites?: (writes: WatchStorageWrites) => void,
  ): Promise<PublishResult> {
    const storageKey = watchStorageKey(userId, event.repository, event.pullRequestNumber);
    const writes = onWatchStorageWrites ? { puts: 0, deletes: 0 } : null;
    let deliveredEvent = event;
    let published = false;
    let write: WatchAppendStats | null = null;
    try {
      await this.state.storage.transaction(async (storage) => {
        const mutation = await openWatchStateMutation(
          writes ? countWatchStorageWrites(storage, writes) : storage,
          storageKey,
        );
        const current = mutation.metadata;
        if (current.events.some((storedEvent) => storedEvent.deliveryId === event.deliveryId)) return;
        const currentTerminalState = terminalState(current.snapshot);
        if (currentTerminalState === "merged") return;
        let snapshot = state.snapshot;
        let changes = event.changes;
        let recomputedChanges = false;
        if (!snapshot) {
          snapshot = current.snapshot;
          changes = [];
        } else if (current.snapshot) {
          const currentTime = Date.parse(current.snapshot.fetchedAt);
          const incomingTime = Date.parse(snapshot.fetchedAt);
          if (Number.isFinite(currentTime) && Number.isFinite(incomingTime) && currentTime > incomingTime) {
            snapshot = current.snapshot;
            changes = [];
          } else {
            // This event's own snapshot is the base - reporting its change is the point of
            // the write - but it must not regress reaction knowledge: a read it failed may
            // already have been stored by another refresh in flight.
            snapshot = mergeReactionKnowledge(snapshot, current.snapshot);
            changes = snapshotChanges(current.snapshot, snapshot);
            recomputedChanges = true;
          }
        }
        if (
          event.githubEvent === "snapshot" &&
          recomputedChanges &&
          event.changes.length > 0 &&
          changes.length === 0
        ) return;
        if (currentTerminalState === "closed" && !resumesClosedWatch(event, snapshot)) return;
        const details = snapshot
          ? monitorEventDetails(current.snapshot, snapshot, event)
          : [];
        deliveredEvent = { ...event, snapshot, changes, details };
        write = await mutation.append(deliveredEvent, snapshot);
        published = true;
      });
    } finally {
      if (writes && onWatchStorageWrites) onWatchStorageWrites(writes);
    }
    if (!published || !write) return { published: false, write: null };
    logWatchStateWrite(deliveredEvent, write);
    this.publishMonitorEvent(
      userId,
      key,
      compactMonitorEvent(deliveredEvent, terminalState(deliveredEvent.snapshot)),
    );

    const active = [...this.activeSessions.values()].filter(
      (session) =>
        session.record.expiresAt > Date.now() &&
        session.record.user.id === userId &&
        session.watches.has(key) &&
        session.subscriptions.has(key),
    );
    await Promise.all(active.map(async (session) => {
      if (!session.server) return;
      try {
        await session.server.server.sendResourceUpdated({ uri: deliveredEvent.resourceUri });
      } catch {
        // A client can close its SSE stream between webhook fanout and delivery.
      }
      try {
        await session.server.server.notification({
          method: "notifications/message",
          params: {
            level: "info",
            logger: "watch-pr",
            data: {
              resourceUri: deliveredEvent.resourceUri,
              githubEvent: deliveredEvent.githubEvent,
              action: deliveredEvent.action,
              receivedAt: deliveredEvent.receivedAt,
              changes: deliveredEvent.changes,
            },
          },
        } as never);
      } catch {
        // Resource updates remain the interoperable push channel.
      }
    }));
    return { published: true, write };
  }

  private syncActiveSessions(token: string, record: SessionRecord): void {
    for (const active of this.activeSessions.values()) {
      if (active.token !== token) continue;
      active.record = record;
      this.syncActiveSession(active, record);
    }
  }

  private async closeActiveSession(sessionId: string, active: ActiveSession): Promise<void> {
    try {
      await active.server?.close();
    } catch {
      // Continue closing the underlying transport and forget the unusable session.
    }
    try {
      await active.transport?.close();
    } catch {
      // Closing is best effort after the bearer session is no longer valid.
    }
    if (this.activeSessions.get(sessionId) === active) this.activeSessions.delete(sessionId);
  }

  private async closeActiveSessionsForToken(token: string): Promise<void> {
    const sessions = [...this.activeSessions.entries()].filter(([, active]) => active.token === token);
    await Promise.all(sessions.map(([sessionId, active]) => this.closeActiveSession(sessionId, active)));
  }

  private async notifySubscribedResources(active: ActiveSession): Promise<void> {
    if (!active.server) return;
    for (const key of active.subscriptions) {
      try {
        const parsed = parseWatchKey(key);
        await active.server.server.sendResourceUpdated({ uri: resourceUri(parsed.repository, parsed.number) });
      } catch {
        // A recovered stream may close while catch-up notifications are queued.
      }
    }
  }

  private async notifyResourceListChanged(active: ActiveSession): Promise<void> {
    if (!active.server) return;
    try {
      await active.server.server.sendResourceListChanged();
    } catch {
      // Resource list notifications are advisory; list_resources remains authoritative.
    }
  }

  private async watchStateMetadata(userId: number, key: string): Promise<WatchStateMetadata> {
    const parsed = parseWatchKey(key);
    return readWatchStateMetadata(this.state.storage, watchStorageKey(userId, parsed.repository, parsed.number));
  }

  private async watchStateFull(userId: number, key: string): Promise<StoredWatchState> {
    const parsed = parseWatchKey(key);
    return readStoredWatchState(this.state.storage, watchStorageKey(userId, parsed.repository, parsed.number));
  }

  private async sessionRecords(): Promise<Map<string, SessionRecord>> {
    const records = await this.state.storage.list<SessionRecord>({ prefix: "session:" });
    const valid = new Map<string, SessionRecord>();
    for (const [key] of records) {
      const token = key.slice("session:".length);
      const session = await this.sessionForToken(token);
      if (session) valid.set(token, session.record);
    }
    return valid;
  }

  private async handleOAuthRegister(request: Request): Promise<Response> {
    if (request.method !== "POST") return new Response("Method not allowed", { status: 405 });
    let body: Record<string, unknown>;
    try {
      body = await request.json() as Record<string, unknown>;
    } catch {
      return this.oauthError("invalid_client_metadata", "registration body must be JSON");
    }
    const redirectUris = body.redirect_uris;
    if (
      !Array.isArray(redirectUris) ||
      redirectUris.length === 0 ||
      redirectUris.length > 10 ||
      redirectUris.some((uri) => typeof uri !== "string" || !isAllowedRedirectUri(uri))
    ) {
      return this.oauthError("invalid_client_metadata", "redirect_uris must contain one to ten HTTPS or loopback HTTP URLs");
    }
    const uniqueRedirectUris = [...new Set(redirectUris as string[])];
    if (uniqueRedirectUris.length !== redirectUris.length) {
      return this.oauthError("invalid_client_metadata", "redirect_uris must not contain duplicates");
    }
    const clientId = randomToken(24);
    const record: OAuthClientRecord = { clientId, redirectUris: uniqueRedirectUris, createdAt: Date.now() };
    await this.state.storage.put(`oauth-client:${clientId}`, record);
    return this.json({
      client_id: clientId,
      client_id_issued_at: Math.floor(record.createdAt / 1000),
      redirect_uris: record.redirectUris,
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code"],
      response_types: ["code"],
      scope: "watch-pr",
    }, 201, { "access-control-allow-origin": "*" });
  }

  private async handleOAuthAuthorize(request: Request): Promise<Response> {
    if (request.method !== "GET") return new Response("Method not allowed", { status: 405 });
    const url = new URL(request.url);
    const clientId = url.searchParams.get("client_id");
    const redirectUri = url.searchParams.get("redirect_uri");
    const clientState = url.searchParams.get("state");
    const responseType = url.searchParams.get("response_type");
    const codeChallenge = url.searchParams.get("code_challenge");
    const method = url.searchParams.get("code_challenge_method");
    if (!clientId || !redirectUri || !clientState || responseType !== "code" || !codeChallenge || method !== "S256") {
      return new Response("OAuth authorization requires code, state, and S256 PKCE", { status: 400 });
    }
    const client = await this.state.storage.get<OAuthClientRecord>(`oauth-client:${clientId}`);
    if (!client) return this.oauthError("invalid_client", "client_id is not registered");
    if (!client.redirectUris.some((registered) => redirectUriMatches(redirectUri, registered))) {
      return this.oauthError("invalid_request", "redirect_uri is not registered for client_id");
    }
    const internalState = randomToken(24);
    const record: OAuthRequestRecord = { clientId, redirectUri, clientState, codeChallenge, codeChallengeMethod: "S256", createdAt: Date.now() };
    await this.state.storage.put(`oauth-request:${internalState}`, record);
    const github = new URL("https://github.com/login/oauth/authorize");
    github.searchParams.set("client_id", this.env.GITHUB_CLIENT_ID);
    github.searchParams.set("redirect_uri", `${this.baseUrl()}/oauth/callback`);
    github.searchParams.set("state", internalState);
    return Response.redirect(github.toString(), 302);
  }

  private async handleOAuthCallback(request: Request): Promise<Response> {
    if (request.method !== "GET") return new Response("Method not allowed", { status: 405 });
    const url = new URL(request.url);
    const internalState = url.searchParams.get("state");
    if (!internalState) return new Response("Missing OAuth state", { status: 400 });
    const requestRecord = await this.state.storage.get<OAuthRequestRecord>(`oauth-request:${internalState}`);
    await this.state.storage.delete(`oauth-request:${internalState}`);
    if (!requestRecord || Date.now() - requestRecord.createdAt > OAUTH_TTL_SECONDS * 1000) return new Response("Expired OAuth state", { status: 400 });
    if (url.searchParams.get("error")) return this.oauthRedirect(requestRecord, { error: "access_denied" });

    const code = url.searchParams.get("code");
    if (!code) return this.oauthRedirect(requestRecord, { error: "invalid_request" });
    if (!this.env.GITHUB_CLIENT_SECRET) return this.oauthRedirect(requestRecord, { error: "server_error" });
    try {
      const exchange = await exchangeGithubCode(this.env.GITHUB_CLIENT_ID, this.env.GITHUB_CLIENT_SECRET, code, `${this.baseUrl()}/oauth/callback`);
      const user = await githubUser(exchange.accessToken);
      const brokerCode = randomToken(32);
      const record: OAuthCodeRecord = {
        ...requestRecord,
        githubAccessToken: exchange.accessToken,
        githubRefreshToken: exchange.refreshToken,
        githubTokenExpiresAt: exchange.expiresIn ? Date.now() + exchange.expiresIn * 1000 : undefined,
        githubRefreshTokenExpiresAt: exchange.refreshTokenExpiresIn ? Date.now() + exchange.refreshTokenExpiresIn * 1000 : undefined,
        user,
      };
      await this.state.storage.put(`oauth-code:${brokerCode}`, record);
      return this.oauthRedirect(requestRecord, { code: brokerCode });
    } catch {
      return this.oauthRedirect(requestRecord, { error: "server_error" });
    }
  }

  private async handleOAuthToken(request: Request): Promise<Response> {
    if (request.method !== "POST") return new Response("Method not allowed", { status: 405 });
    const form = await request.formData();
    const grantType = form.get("grant_type");
    const code = form.get("code");
    const verifier = form.get("code_verifier");
    const clientId = form.get("client_id");
    const redirectUri = form.get("redirect_uri");
    if (grantType !== "authorization_code" || typeof code !== "string" || typeof verifier !== "string" || typeof clientId !== "string" || typeof redirectUri !== "string") {
      return this.oauthError("invalid_request", "authorization_code with PKCE is required");
    }
    const record = await this.state.storage.get<OAuthCodeRecord>(`oauth-code:${code}`);
    await this.state.storage.delete(`oauth-code:${code}`);
    if (
      !record ||
      Date.now() - record.createdAt > OAUTH_TTL_SECONDS * 1000 ||
      record.clientId !== clientId ||
      record.redirectUri !== redirectUri
    ) return this.oauthError("invalid_grant", "authorization code is invalid or expired");
    const challenge = await sha256Base64Url(verifier);
    if (!(await constantTimeEqual(challenge, record.codeChallenge))) return this.oauthError("invalid_grant", "PKCE verification failed");

    const sessionToken = randomToken(32);
    const ttl = Number(this.env.SESSION_TTL_SECONDS ?? SESSION_TTL_SECONDS);
    const sessionTtl = Number.isFinite(ttl) && ttl > 0 ? ttl : SESSION_TTL_SECONDS;
    const session: SessionRecord = {
      githubAccessToken: record.githubAccessToken,
      githubRefreshToken: record.githubRefreshToken,
      githubTokenExpiresAt: record.githubTokenExpiresAt,
      githubRefreshTokenExpiresAt: record.githubRefreshTokenExpiresAt,
      user: record.user,
      createdAt: Date.now(),
      expiresAt: Date.now() + sessionTtl * 1000,
      watches: [],
      watchStorageVersion: 1,
    };
    await this.state.storage.put(sessionStorageKey(sessionToken), session);
    return this.json({ access_token: sessionToken, token_type: "Bearer", expires_in: sessionTtl, scope: "watch-pr" }, 200, { "access-control-allow-origin": "*" });
  }

  private oauthRedirect(record: OAuthRequestRecord, values: Record<string, string>): Response {
    const redirect = new URL(record.redirectUri);
    for (const [key, value] of Object.entries(values)) redirect.searchParams.set(key, value);
    redirect.searchParams.set("state", record.clientState);
    return Response.redirect(redirect.toString(), 302);
  }

  private unauthorized(request: Request): Response {
    const resource = `${this.baseUrl()}/.well-known/oauth-protected-resource`;
    return new Response(JSON.stringify({ error: "unauthorized", error_description: "Bearer token required" }), {
      status: 401,
      headers: {
        "content-type": "application/json",
        "www-authenticate": `Bearer resource_metadata="${resource}"`,
        "access-control-allow-origin": request.headers.get("origin") ?? "*",
      },
    });
  }

  private oauthError(error: string, description: string): Response {
    return this.json({ error, error_description: description }, 400, { "access-control-allow-origin": "*" });
  }

  private accepted(value: unknown): Response {
    return this.json(value, 202);
  }

  private json(value: unknown, status = 200, headers: Record<string, string> = {}): Response {
    return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json", ...headers } });
  }

  private baseUrl(): string {
    return (this.env.PUBLIC_BASE_URL || "https://watch-pr.vza.net").replace(/\/+$/u, "");
  }
}

function isInitializeMessage(value: unknown): boolean {
  return Boolean(value && typeof value === "object" && (value as Record<string, unknown>).method === "initialize");
}

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

function isAllowedRedirectUri(value: string): boolean {
  try {
    const target = new URL(value);
    if (target.hash || target.username || target.password) return false;
    if (target.protocol === "https:") return true;
    return target.protocol === "http:" && LOOPBACK_HOSTS.has(target.hostname);
  } catch {
    return false;
  }
}

function redirectUriMatches(requested: string, registered: string): boolean {
  if (!isAllowedRedirectUri(requested) || !isAllowedRedirectUri(registered)) return false;
  const requestedUrl = new URL(requested);
  const registeredUrl = new URL(registered);
  if (requestedUrl.protocol !== registeredUrl.protocol) return false;
  if (requestedUrl.protocol === "https:") return requested === registered;
  return (
    requestedUrl.hostname === registeredUrl.hostname &&
    requestedUrl.pathname === registeredUrl.pathname &&
    requestedUrl.search === registeredUrl.search
  );
}

function actionFromPayload(payload: Record<string, unknown>): string | null {
  const action = payload.action;
  return typeof action === "string" ? action : null;
}

function repositoryFromPayload(payload: Record<string, unknown>): string | null {
  const repository = payload.repository;
  if (!repository || typeof repository !== "object") return null;
  const fullName = (repository as Record<string, unknown>).full_name;
  if (typeof fullName !== "string") return null;
  try {
    return fullName.trim().toLowerCase();
  } catch {
    return null;
  }
}

function isGithubAuthorizationError(error: unknown): boolean {
  return error instanceof GithubApiError && error.status === 401;
}
