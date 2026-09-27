import type {
  GithubUser,
  PullRequestCheck,
  PullRequestComment,
  PullRequestReaction,
  ReactionDetailsState,
  ReactionReadProgress,
  PullRequestReview,
  PullRequestSnapshot,
  PullRequestThread,
  ReactionCounts,
} from "./types";
import { normalizeRepository, sameReactionCounts } from "./events";

const API_ROOT = "https://api.github.com";
const API_VERSION = "2022-11-28";
/** Individual reactions are read per target, so a wide PR cannot open one request per comment. */
const REACTION_CONCURRENCY = 8;
/** Total paginated REST calls allowed for individual reaction details in one snapshot. */
const REACTION_REQUEST_BUDGET = 64;

interface RequestBudget {
  remaining: number;
}

/**
 * GitHub requests one snapshot spent. A `304 Not Modified` does not count against the
 * primary rate limit, and GraphQL draws from a separate point budget, so each is kept apart.
 */
export interface GithubUsage {
  /** REST responses other than 304, which consume the caller's primary rate limit. */
  restRequests: number;
  notModified: number;
  graphqlRequests: number;
  /** Lowest `x-ratelimit-remaining` the REST `core` resource reported, if any response did. */
  coreRateLimitRemaining: number | null;
}

export function createGithubUsage(): GithubUsage {
  return { restRequests: 0, notModified: 0, graphqlRequests: 0, coreRateLimitRemaining: null };
}

interface GithubAuth {
  token: string;
  usage?: GithubUsage;
}

function recordGithubUsage(usage: GithubUsage, path: string, response: Response): void {
  if (apiUrl(path) === `${API_ROOT}/graphql`) {
    usage.graphqlRequests += 1;
    return;
  }
  if (response.status === 304) usage.notModified += 1;
  else usage.restRequests += 1;
  if (response.headers.get("x-ratelimit-resource") !== "core") return;
  const remaining = Number.parseInt(response.headers.get("x-ratelimit-remaining") ?? "", 10);
  if (!Number.isSafeInteger(remaining)) return;
  usage.coreRateLimitRemaining = usage.coreRateLimitRemaining === null
    ? remaining
    : Math.min(usage.coreRateLimitRemaining, remaining);
}


export type GithubRecord = Record<string, unknown>;

export class GithubApiError extends Error {
  readonly status: number;
  readonly responseBody: string;

  constructor(status: number, responseBody: string, path: string) {
    super(`GitHub API ${status} for ${path}`);
    this.name = "GithubApiError";
    this.status = status;
    this.responseBody = responseBody;
  }
}

function apiUrl(path: string): string {
  if (path.startsWith("http://") || path.startsWith("https://")) return path;
  return `${API_ROOT}${path.startsWith("/") ? path : `/${path}`}`;
}

async function githubResponse(
  auth: GithubAuth,
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set("accept", "application/vnd.github+json");
  headers.set("x-github-api-version", API_VERSION);
  headers.set("user-agent", "watch-pr-mcp/0.1");
  headers.set("authorization", `Bearer ${auth.token}`);
  const response = await fetch(apiUrl(path), { ...init, headers });
  if (auth.usage) recordGithubUsage(auth.usage, path, response);
  return response;
}

/** A GitHub response and the moment it actually returned, which dates what it says. */
interface Observed<T> {
  value: T;
  observedAt: string;
}

async function githubJson<T>(
  auth: GithubAuth,
  path: string,
  init: RequestInit = {},
): Promise<T> {
  const response = await githubResponse(auth, path, init);
  const text = await response.text();
  if (!response.ok) throw new GithubApiError(response.status, text, path);
  return text ? JSON.parse(text) as T : {} as T;
}

/** ETags by request URL, as a snapshot stores them. */
type GithubValidators = Record<string, string>;

/**
 * One conditional REST read. `not_modified` means GitHub confirmed, as of `observedAt`, that
 * the response the sent validator was issued for is still current. `etag` is null whenever the
 * response cannot be revalidated as a whole: GitHub sent none, or the list ran past one page.
 */
type Revalidated<T> =
  | { status: "not_modified"; observedAt: string }
  | { status: "fetched"; value: T; observedAt: string; etag: string | null };

/** The first page URL of a list, which is also the key its validator is stored under. */
function firstPageUrl(path: string): string {
  return `${apiUrl(path)}${path.includes("?") ? "&" : "?"}per_page=100`;
}

async function githubObjectRead(
  auth: GithubAuth,
  path: string,
  validators: GithubValidators,
): Promise<Revalidated<GithubRecord>> {
  const etag = validators[apiUrl(path)];
  const response = await githubResponse(auth, path, { headers: etag ? { "if-none-match": etag } : {} });
  const text = await response.text();
  const observedAt = new Date().toISOString();
  if (response.status === 304 && etag) return { status: "not_modified", observedAt };
  if (!response.ok) throw new GithubApiError(response.status, text, path);
  const value = text ? JSON.parse(text) as GithubRecord : {};
  return { status: "fetched", value, observedAt, etag: response.headers.get("etag") };
}

/**
 * Each page separately, with the time it returned. A list response dates every summary it
 * carries - including the reaction counts riding on each comment - and pages of one list can
 * be minutes apart on a wide PR, so a record is only ever as fresh as its own page.
 *
 * Only the first page is sent conditionally. A validator describes one page, so a list that
 * runs past it has no single ETag for the whole and is always read in full.
 */
async function githubListRead<T>(
  auth: GithubAuth,
  path: string,
  validators: GithubValidators,
  field?: string,
): Promise<Revalidated<Observed<T[]>[]>> {
  const pages: Observed<T[]>[] = [];
  const firstUrl = firstPageUrl(path);
  const etag = validators[firstUrl];
  let firstEtag: string | null = null;
  let nextUrl: string | null = firstUrl;

  while (nextUrl) {
    const first = pages.length === 0;
    const response = await githubResponse(auth, nextUrl, { headers: first && etag ? { "if-none-match": etag } : {} });
    const text = await response.text();
    const observedAt = new Date().toISOString();
    if (first && response.status === 304 && etag) return { status: "not_modified", observedAt };
    if (!response.ok) throw new GithubApiError(response.status, text, path);
    const payload: unknown = text ? JSON.parse(text) : [];
    const page = field
      ? payload && typeof payload === "object" && Array.isArray((payload as GithubRecord)[field])
        ? (payload as GithubRecord)[field] as T[]
        : null
      : Array.isArray(payload)
        ? payload as T[]
        : null;
    if (!page) throw new Error(`GitHub returned a non-array page for ${path}`);
    if (first) firstEtag = response.headers.get("etag");
    pages.push({ value: page, observedAt });
    nextUrl = nextLink(response.headers.get("link"));
  }

  return {
    status: "fetched",
    value: pages,
    observedAt: pages[pages.length - 1].observedAt,
    etag: pages.length === 1 ? firstEtag : null,
  };
}

function nextLink(linkHeader: string | null): string | null {
  if (!linkHeader) return null;
  for (const part of linkHeader.split(",")) {
    const match = /<([^>]+)>;\s*rel="([^"]+)"/u.exec(part.trim());
    if (match?.[2] === "next") return match[1];
  }
  return null;
}

export function stringValue(record: GithubRecord, key: string): string | null {
  const value = record[key];
  return typeof value === "string" ? value : null;
}

function repositoryFullName(value: unknown): string | null {
  if (!value || typeof value !== "object") return null;
  const fullName = stringValue(value as GithubRecord, "full_name");
  if (!fullName) return null;
  try {
    return normalizeRepository(fullName);
  } catch {
    return null;
  }
}

export function numberValue(record: GithubRecord, key: string): number {
  const value = record[key];
  return typeof value === "number" ? value : 0;
}

function booleanValue(record: GithubRecord, key: string): boolean {
  return record[key] === true;
}

function userLogin(record: GithubRecord, key = "user"): string | null {
  const user = record[key];
  if (!user || typeof user !== "object") return null;
  const login = (user as GithubRecord).login;
  return typeof login === "string" ? login : null;
}

function reactionCounts(value: unknown): ReactionCounts {
  if (!value || typeof value !== "object") return {};
  const result: ReactionCounts = {};
  for (const [key, count] of Object.entries(value as GithubRecord)) {
    if (typeof count === "number") result[key] = count;
  }
  return result;
}

/**
 * Reaction totals decide whether a target is worth a request at all: the summary GitHub
 * already returned with the comment is authoritative for "has no reactions".
 */
export function reactionTotal(counts: ReactionCounts): number {
  const total = counts.total_count;
  if (typeof total === "number") return total;
  let sum = 0;
  for (const [content, count] of Object.entries(counts)) {
    if (content !== "total_count" && typeof count === "number" && count > 0) sum += count;
  }
  return sum;
}

function userId(record: GithubRecord, key = "user"): number | null {
  const user = record[key];
  if (!user || typeof user !== "object") return null;
  const id = (user as GithubRecord).id;
  return typeof id === "number" ? id : null;
}

function normalizeReaction(record: GithubRecord): PullRequestReaction {
  return {
    id: numberValue(record, "id"),
    content: stringValue(record, "content") ?? "",
    author: userLogin(record),
    authorId: userId(record),
    createdAt: stringValue(record, "created_at"),
  };
}

function reactionDetailsMatchCounts(
  details: readonly PullRequestReaction[],
  counts: ReactionCounts,
): boolean {
  if (details.length !== reactionTotal(counts)) return false;
  const ids = new Set<number>();
  const byContent = new Map<string, number>();
  for (const detail of details) {
    if (ids.has(detail.id)) return false;
    ids.add(detail.id);
    byContent.set(detail.content, (byContent.get(detail.content) ?? 0) + 1);
  }
  for (const [content, count] of Object.entries(counts)) {
    if (content === "total_count") continue;
    if ((byContent.get(content) ?? 0) !== count) return false;
    byContent.delete(content);
  }
  return byContent.size === 0;
}

async function mapBounded<T, R>(
  values: readonly T[],
  limit: number,
  map: (value: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(values.length);
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(limit, values.length) }, async () => {
    while (cursor < values.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await map(values[index]);
    }
  }));
  return results;
}

interface ReactionPageResult {
  reactionDetails?: PullRequestReaction[];
  reactionProgress?: ReactionReadProgress;
  /** Set only when this call actually fetched a page, so reuse never restamps a target. */
  reactionDetailsReadAt?: string;
}

async function reactionRecords(
  auth: GithubAuth,
  path: string,
  budget: RequestBudget,
  progress?: ReactionReadProgress,
): Promise<ReactionPageResult> {
  const records = progress ? [...progress.records] : [];
  let readAt: string | undefined;
  let nextUrl: string | null = progress?.nextUrl ?? firstPageUrl(path);
  while (nextUrl) {
    if (budget.remaining === 0) {
      return { reactionProgress: { records, nextUrl }, reactionDetailsReadAt: readAt };
    }
    budget.remaining -= 1;
    const pageUrl: string = nextUrl;
    try {
      const response = await githubResponse(auth, pageUrl);
      const text = await response.text();
      if (!response.ok) throw new GithubApiError(response.status, text, path);
      const payload: unknown = text ? JSON.parse(text) : [];
      if (!Array.isArray(payload)) throw new Error(`GitHub returned a non-array page for ${path}`);
      records.push(...payload
        .filter((record): record is GithubRecord => Boolean(record && typeof record === "object"))
        .map(normalizeReaction)
        .filter((reaction) => reaction.id > 0 && reaction.content !== ""));
      readAt = new Date().toISOString();
      nextUrl = nextLink(response.headers.get("link"));
    } catch (error) {
      // Only the page that failed is unknown: the pages already in hand were read
      // successfully, so the target resumes from the failed page instead of paying for the
      // whole prefix again on every refresh, which a persistent failure would repeat
      // forever. With nothing collected there is no progress worth keeping and the failure
      // stands, leaving the target unknown.
      if (records.length === 0) throw error;
      return { reactionProgress: { records, nextUrl: pageUrl }, reactionDetailsReadAt: readAt };
    }
  }
  return { reactionDetails: records, reactionDetailsReadAt: readAt };
}

interface ReactionState {
  reactions: ReactionCounts;
  /** When the response carrying `reactions` arrived, which ages apart from any read. */
  reactionsObservedAt: string;
  reactionDetails?: PullRequestReaction[];
  /** In-flight provenance; the transactional merge consumes both states before storage. */
  reactionDetailsState?: ReactionDetailsState;
  /** When this target's own read last returned, independent of the snapshot's `fetchedAt`. */
  reactionDetailsReadAt?: string;
  reactionProgress?: ReactionReadProgress;
}

interface ReactionTargetRead {
  /** Index of the target slot this read fills. */
  slot: number;
  path: string;
}

interface SnapshotReactions {
  bodyReactions: ReactionCounts;
  bodyReactionsObservedAt: string;
  bodyReactionDetails: PullRequestReaction[] | undefined;
  bodyReactionDetailsState: ReactionDetailsState | undefined;
  bodyReactionDetailsReadAt: string | undefined;
  bodyReactionProgress: ReactionReadProgress | undefined;
  comments: PullRequestComment[];
  reviewComments: PullRequestComment[];
}

/**
 * One wave for the whole snapshot: every target that still needs a read, across the PR body,
 * top-level comments, and inline review comments, shares a single `REACTION_CONCURRENCY`
 * budget. Two kinds of target never spend a request: a zero summary count is authoritative
 * for "no reactions" as of the moment that summary response returned, and an unchanged
 * summary count over known details that add up to it means the stored details still
 * describe the target. A webhook stores the counts its payload carries beside the details
 * it could not read, so those details stop adding up and the next refresh reads them. The
 * residual blind spot is a swap that leaves every count identical - one `heart` replaced by
 * another actor's `heart` between two refreshes - which the summary cannot express and only
 * a per-target read would reveal. Reused details
 * are recorded as `borrowed` for exactly that reason: no read backs them, so the
 * transactional merge settles them against the state the write lands on instead of taking
 * them for an observation of their own, and they keep the time of the read they descend
 * from rather than passing as read now.
 * A failed or internally inconsistent read leaves that target unknown. Its current summary
 * counts still advance, but the absent details force the next refresh to read the target
 * again. The two failures part company over the cursor: a transport failure leaves the pages
 * already collected intact and resumable, while a finished read whose records contradict the
 * counts proves the prefix itself is incoherent. A read that was resuming one reports that
 * as `invalidated`, since the prefix it disproved is committed too and only the merge can
 * remove it; the next refresh then starts at page one instead of inheriting the same prefix
 * and disproving it again.
 * Unknown details also let the transactional merge preserve reaction knowledge that
 * another concurrent refresh committed while this request was in flight. Every other
 * snapshot field still advances.
 *
 * Each target that is read carries the time its own read returned, and each target the
 * summary settled carries the time that summary response returned - never the end of the
 * wave, which can be minutes later on a wide PR and would let a zero observed early outrank
 * a reaction another refresh read in the meantime. Two refreshes overlap one target at a
 * time, so the snapshot that commits second often holds the older observation of some
 * target and the newer one of another; only a per-target time can order them.
 */
async function snapshotReactions(
  auth: GithubAuth,
  repository: string,
  number: number,
  bodyReactions: Observed<ReactionCounts>,
  comments: Observed<PullRequestComment>[],
  reviewComments: Observed<PullRequestComment>[],
  previous: PullRequestSnapshot | null,
): Promise<SnapshotReactions> {
  // One slot per reaction target, seeded with what this refresh already knows: the summary
  // counts GitHub returned, and details only once they are known.
  const slots: ReactionState[] = [];
  const reads: ReactionTargetRead[] = [];
  const plan = (
    summary: Observed<ReactionCounts>,
    path: string,
    prior: Pick<
      PullRequestComment,
      "reactions" | "reactionDetails" | "reactionDetailsReadAt" | "reactionProgress"
    > | undefined,
  ): number => {
    const reactions = summary.value;
    const slot = slots.push({ reactions, reactionsObservedAt: summary.observedAt }) - 1;
    if (reactionTotal(reactions) === 0) {
      slots[slot].reactionDetails = [];
      slots[slot].reactionDetailsReadAt = summary.observedAt;
    } else if (
      prior?.reactionDetails &&
      sameReactionCounts(prior.reactions, reactions) &&
      // A webhook advances the stored counts without reading the details behind them.
      reactionDetailsMatchCounts(prior.reactionDetails, reactions)
    ) {
      slots[slot].reactionDetails = prior.reactionDetails;
      slots[slot].reactionDetailsState = "borrowed";
      slots[slot].reactionDetailsReadAt = prior.reactionDetailsReadAt;
    } else {
      if (prior?.reactionProgress && sameReactionCounts(prior.reactions, reactions)) {
        slots[slot].reactionProgress = prior.reactionProgress;
        slots[slot].reactionDetailsReadAt = prior.reactionDetailsReadAt;
      }
      reads.push({ slot, path });
    }
    return slot;
  };

  const previousComments = new Map(previous?.comments.map((comment) => [comment.id, comment] as const));
  const previousReviewComments = new Map(previous?.reviewComments.map((comment) => [comment.id, comment] as const));
  const bodySlot = plan(
    bodyReactions,
    `/repos/${repository}/issues/${number}/reactions`,
    previous ? {
      reactions: previous.bodyReactions,
      reactionDetails: previous.bodyReactionDetails,
      reactionDetailsReadAt: previous.bodyReactionDetailsReadAt,
      reactionProgress: previous.bodyReactionProgress,
    } : undefined,
  );
  const commentSlots = comments.map((comment) => plan(
    { value: comment.value.reactions, observedAt: comment.observedAt },
    `/repos/${repository}/issues/comments/${comment.value.id}/reactions`,
    previousComments.get(comment.value.id),
  ));
  const reviewCommentSlots = reviewComments.map((comment) => plan(
    { value: comment.value.reactions, observedAt: comment.observedAt },
    `/repos/${repository}/pulls/comments/${comment.value.id}/reactions`,
    previousReviewComments.get(comment.value.id),
  ));

  const budget: RequestBudget = { remaining: REACTION_REQUEST_BUDGET };
  const states = await mapBounded(reads, REACTION_CONCURRENCY, async (read): Promise<ReactionState> => {
    const resumed = slots[read.slot].reactionProgress;
    const { reactions, reactionsObservedAt } = slots[read.slot];
    try {
      const page = await reactionRecords(
        auth,
        read.path,
        budget,
        resumed,
      );
      if (page.reactionDetails && !reactionDetailsMatchCounts(page.reactionDetails, reactions)) {
        // The finished read does not describe the counts: a reaction was added or removed
        // while it was paginating, which shifts page boundaries and leaves the collected
        // records duplicated or short. The target keeps only its counts, and a read that was
        // resuming says so as a transition, because the prefix it just disproved is also
        // sitting in the committed snapshot: dropping it here alone would leave the durable
        // cursor for the next refresh to inherit and disprove again, forever.
        return resumed === undefined
          ? { reactions, reactionsObservedAt }
          : {
            reactions,
            reactionsObservedAt,
            reactionDetailsState: "invalidated",
            reactionDetailsReadAt: page.reactionDetailsReadAt ?? slots[read.slot].reactionDetailsReadAt,
          };
      }
      return {
        reactions,
        reactionsObservedAt,
        ...page,
        // A resumed read that never got a page back keeps the time of the pages it inherited.
        reactionDetailsReadAt: page.reactionDetailsReadAt ?? slots[read.slot].reactionDetailsReadAt,
      };
    } catch {
      // A transport or HTTP failure says nothing about the records already collected, so the
      // cursor stays resumable and the next refresh continues where this one stopped.
      return slots[read.slot];
    }
  });
  for (const [position, read] of reads.entries()) slots[read.slot] = states[position];

  const attach = (comment: PullRequestComment, slot: number): PullRequestComment => {
    const {
      reactions,
      reactionsObservedAt,
      reactionDetails,
      reactionDetailsState,
      reactionDetailsReadAt,
      reactionProgress,
    } = slots[slot];
    if (reactionDetails !== undefined) {
      return reactionDetailsState
        ? { ...comment, reactions, reactionsObservedAt, reactionDetails, reactionDetailsState, reactionDetailsReadAt }
        : { ...comment, reactions, reactionsObservedAt, reactionDetails, reactionDetailsReadAt };
    }
    if (reactionProgress !== undefined) {
      return { ...comment, reactions, reactionsObservedAt, reactionProgress, reactionDetailsReadAt };
    }
    if (reactionDetailsState !== undefined) {
      return { ...comment, reactions, reactionsObservedAt, reactionDetailsState, reactionDetailsReadAt };
    }
    return { ...comment, reactions, reactionsObservedAt };
  };
  return {
    bodyReactions: slots[bodySlot].reactions,
    bodyReactionsObservedAt: slots[bodySlot].reactionsObservedAt,
    bodyReactionDetails: slots[bodySlot].reactionDetails,
    bodyReactionDetailsState: slots[bodySlot].reactionDetailsState,
    bodyReactionDetailsReadAt: slots[bodySlot].reactionDetailsReadAt,
    bodyReactionProgress: slots[bodySlot].reactionProgress,
    comments: comments.map((comment, position) => attach(comment.value, commentSlots[position])),
    reviewComments: reviewComments.map((comment, position) => attach(comment.value, reviewCommentSlots[position])),
  };
}

/** REST list items and webhook payload objects share this shape. */
export function normalizeComment(record: GithubRecord): PullRequestComment {
  return {
    id: numberValue(record, "id"),
    author: userLogin(record),
    body: stringValue(record, "body") ?? "",
    createdAt: stringValue(record, "created_at"),
    updatedAt: stringValue(record, "updated_at"),
    reactions: reactionCounts(record.reactions),
    path: stringValue(record, "path") ?? undefined,
    line: typeof record.line === "number" ? record.line : null,
    startLine: typeof record.start_line === "number" ? record.start_line : null,
    diffHunk: stringValue(record, "diff_hunk") ?? undefined,
    inReplyToId: typeof record.in_reply_to_id === "number" ? record.in_reply_to_id : null,
    htmlUrl: stringValue(record, "html_url") ?? undefined,
  };
}

/** Webhooks spell review states in lowercase and the REST list in uppercase. */
export function normalizeReview(record: GithubRecord): PullRequestReview {
  return {
    id: numberValue(record, "id"),
    author: userLogin(record),
    state: stringValue(record, "state")?.toUpperCase() ?? "PENDING",
    body: stringValue(record, "body") ?? "",
    submittedAt: stringValue(record, "submitted_at"),
    htmlUrl: stringValue(record, "html_url") ?? undefined,
  };
}

export function normalizeCheckRun(record: GithubRecord): PullRequestCheck {
  return {
    id: numberValue(record, "id"),
    name: stringValue(record, "name") ?? "check",
    status: stringValue(record, "status"),
    conclusion: stringValue(record, "conclusion"),
    completedAt: stringValue(record, "completed_at"),
    startedAt: stringValue(record, "started_at"),
    url: stringValue(record, "html_url"),
    kind: "check_run",
  };
}

export function normalizeCommitStatus(record: GithubRecord, index: number): PullRequestCheck {
  return {
    id: numberValue(record, "id") || index,
    name: stringValue(record, "context") ?? "status",
    status: "completed",
    conclusion: stringValue(record, "state"),
    completedAt: stringValue(record, "updated_at"),
    startedAt: stringValue(record, "created_at"),
    url: stringValue(record, "target_url"),
    kind: "commit_status",
  };
}

/** The newest status per context, which is what GitHub's combined status reports. */
export function latestCommitStatuses(statuses: PullRequestCheck[]): PullRequestCheck[] {
  const latestByContext = new Map<string, PullRequestCheck>();
  for (const candidate of statuses) {
    const contextKey = candidate.name.toLowerCase();
    const previous = latestByContext.get(contextKey);
    if (!previous) {
      latestByContext.set(contextKey, candidate);
      continue;
    }
    const candidateTime = Date.parse(candidate.completedAt ?? candidate.startedAt ?? "");
    const previousTime = Date.parse(previous.completedAt ?? previous.startedAt ?? "");
    const candidateTimestamp = Number.isNaN(candidateTime) ? Number.NEGATIVE_INFINITY : candidateTime;
    const previousTimestamp = Number.isNaN(previousTime) ? Number.NEGATIVE_INFINITY : previousTime;
    if (candidateTimestamp > previousTimestamp ||
      (candidateTimestamp === previousTimestamp && candidate.id > previous.id)) {
      latestByContext.set(contextKey, candidate);
    }
  }
  return [...latestByContext.values()];
}

/**
 * Fork CI waiting for a maintainer to approve it: GitHub creates the suite as
 * `action_required` with no check runs and no statuses, so without this the snapshot would
 * show no checks at all. A suite that has runs is already represented by them.
 */
export function awaitingApprovalSuites(records: GithubRecord[], pullUrl: string): PullRequestCheck[] {
  return records
    .filter((record) => stringValue(record, "conclusion") === "action_required" && record.latest_check_runs_count === 0)
    .map((record) => {
      const app = record.app && typeof record.app === "object" ? record.app as GithubRecord : {};
      return {
        id: numberValue(record, "id"),
        name: stringValue(app, "name") ?? "check suite",
        status: stringValue(record, "status"),
        conclusion: "action_required",
        completedAt: stringValue(record, "updated_at"),
        startedAt: stringValue(record, "created_at"),
        url: `${pullUrl}/checks`,
        kind: "check_suite",
      };
    });
}

/** Throws on any failure, so the caller keeps the threads it already knows. */
async function reviewThreads(
  auth: GithubAuth,
  repository: string,
  number: number,
): Promise<PullRequestThread[]> {
  const [owner, repo] = repository.split("/");
  const query = `query($owner:String!,$repo:String!,$number:Int!,$cursor:String){repository(owner:$owner,name:$repo){pullRequest(number:$number){reviewThreads(first:100,after:$cursor){nodes{id,isResolved,comments(first:100){nodes{databaseId}}}pageInfo{hasNextPage,endCursor}}}}}`;
  const threads: PullRequestThread[] = [];
  let cursor: string | null = null;

  while (true) {
    const response = await githubJson<GithubRecord>(auth, "/graphql", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query, variables: { owner, repo, number, cursor } }),
    });
    const errors = response.errors;
    if (Array.isArray(errors) && errors.length > 0) throw new Error("GitHub GraphQL review thread query failed");
    const pullRequest = (((response.data as GithubRecord)?.repository as GithubRecord)?.pullRequest as GithubRecord | null);
    const connection = pullRequest?.reviewThreads as GithubRecord | undefined;
    if (!connection) return threads;
    const nodes = Array.isArray(connection.nodes) ? connection.nodes : [];
    for (const node of nodes) {
      if (!node || typeof node !== "object") continue;
      const item = node as GithubRecord;
      const comments = item.comments;
      const commentNodes: unknown[] = comments && typeof comments === "object" && Array.isArray((comments as GithubRecord).nodes)
        ? (comments as GithubRecord).nodes as unknown[]
        : [];
      threads.push({
        id: stringValue(item, "id") ?? "",
        isResolved: booleanValue(item, "isResolved"),
        commentIds: commentNodes
          .filter((comment): comment is GithubRecord => Boolean(comment && typeof comment === "object"))
          .map((comment: GithubRecord) => numberValue(comment, "databaseId"))
          .filter((id: number) => id > 0),
      });
    }
    const pageInfo = connection.pageInfo as GithubRecord | undefined;
    if (!pageInfo || pageInfo.hasNextPage !== true) return threads;
    const nextCursor = stringValue(pageInfo, "endCursor");
    if (!nextCursor) return threads;
    cursor = nextCursor;
  }
}

export async function githubUser(token: string): Promise<GithubUser> {
  const record = await githubJson<GithubRecord>({ token }, "/user");
  return {
    login: stringValue(record, "login") ?? "",
    id: numberValue(record, "id"),
    name: stringValue(record, "name"),
    avatarUrl: stringValue(record, "avatar_url"),
    htmlUrl: stringValue(record, "html_url") ?? "https://github.com",
  };
}

export async function exchangeGithubCode(
  clientId: string,
  clientSecret: string,
  code: string,
  redirectUri: string,
): Promise<{
  accessToken: string;
  refreshToken?: string;
  expiresIn?: number;
  refreshTokenExpiresIn?: number;
}> {
  const response = await fetch("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/json", "user-agent": "watch-pr-mcp/0.1" },
    body: JSON.stringify({ client_id: clientId, client_secret: clientSecret, code, redirect_uri: redirectUri }),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`GitHub OAuth exchange failed with HTTP ${response.status}`);
  const payload = JSON.parse(text) as GithubRecord;
  const accessToken = stringValue(payload, "access_token");
  if (!accessToken) throw new Error("GitHub OAuth exchange did not return an access token");
  return {
    accessToken,
    refreshToken: stringValue(payload, "refresh_token") ?? undefined,
    expiresIn: typeof payload.expires_in === "number" ? payload.expires_in : undefined,
    refreshTokenExpiresIn: typeof payload.refresh_token_expires_in === "number" ? payload.refresh_token_expires_in : undefined,
  };
}

export async function refreshGithubToken(
  clientId: string,
  clientSecret: string,
  refreshToken: string,
): Promise<{
  accessToken: string;
  refreshToken?: string;
  expiresIn?: number;
  refreshTokenExpiresIn?: number;
}> {
  const response = await fetch("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/json", "user-agent": "watch-pr-mcp/0.1" },
    body: JSON.stringify({
      client_id: clientId,
      client_secret: clientSecret,
      grant_type: "refresh_token",
      refresh_token: refreshToken,
    }),
  });
  const text = await response.text();
  if (!response.ok) throw new GithubApiError(response.status, text, "https://github.com/login/oauth/access_token");
  const payload = JSON.parse(text) as GithubRecord;
  const accessToken = stringValue(payload, "access_token");
  if (!accessToken) throw new Error("GitHub OAuth refresh did not return an access token");
  return {
    accessToken,
    refreshToken: stringValue(payload, "refresh_token") ?? undefined,
    expiresIn: typeof payload.expires_in === "number" ? payload.expires_in : undefined,
    refreshTokenExpiresIn: typeof payload.refresh_token_expires_in === "number" ? payload.refresh_token_expires_in : undefined,
  };
}

/** Review threads are read at least this often, even while the review comments answer 304. */
const THREADS_MAX_AGE_MS = 15 * 60 * 1000;

/**
 * `Promise.all` that waits for every request before rejecting. A wave that fails fast would
 * leave peers still counting into the caller's usage after the caller has reported it.
 */
async function settleWave<T extends readonly unknown[]>(wave: { [K in keyof T]: Promise<T[K]> }): Promise<T> {
  const results = await Promise.allSettled(wave);
  const rejected = results.find((result): result is PromiseRejectedResult => result.status === "rejected");
  if (rejected) throw rejected.reason;
  return results.map((result) => (result as PromiseFulfilledResult<unknown>).value) as unknown as T;
}

/**
 * How a refresh treats review threads, which GraphQL cannot revalidate. `when_stale` reuses
 * the stored threads while the review comments are unchanged and the last read is recent;
 * `refetch` always reads them, for a delivery that is itself about a thread.
 */
export type ThreadsRead = "when_stale" | "refetch";

/** Whether a snapshot's threads were never read or are too old to reuse. */
export function threadsStale(snapshot: PullRequestSnapshot, now: number): boolean {
  const readAt = Date.parse(snapshot.threadsReadAt ?? "");
  return !Number.isFinite(readAt) || now - readAt >= THREADS_MAX_AGE_MS;
}

/** The snapshot fields the pull request response alone produces. */
type PullFields = Pick<
  PullRequestSnapshot,
  | "url"
  | "title"
  | "body"
  | "state"
  | "draft"
  | "merged"
  | "mergedAt"
  | "mergeable"
  | "mergeableState"
  | "baseRefName"
  | "headRefName"
  | "headRepository"
  | "headSha"
  | "author"
  | "updatedAt"
>;

export function pullFields(pull: GithubRecord, repository: string, number: number): PullFields {
  const head = pull.head && typeof pull.head === "object" ? pull.head as GithubRecord : {};
  const base = pull.base && typeof pull.base === "object" ? pull.base as GithubRecord : {};
  return {
    url: stringValue(pull, "html_url") ?? `https://github.com/${repository}/pull/${number}`,
    title: stringValue(pull, "title") ?? "",
    body: stringValue(pull, "body") ?? "",
    state: stringValue(pull, "state") ?? "unknown",
    draft: booleanValue(pull, "draft"),
    merged: booleanValue(pull, "merged") || pull.merged_at !== null && pull.merged_at !== undefined,
    mergedAt: stringValue(pull, "merged_at"),
    mergeable: typeof pull.mergeable === "boolean" ? pull.mergeable : null,
    mergeableState: stringValue(pull, "mergeable_state"),
    baseRefName: stringValue(base, "ref"),
    headRefName: stringValue(head, "ref"),
    headRepository: repositoryFullName(head.repo),
    headSha: stringValue(head, "sha"),
    author: userLogin(pull, "user"),
    updatedAt: stringValue(pull, "updated_at") ?? undefined,
  };
}

function storedPullFields(snapshot: PullRequestSnapshot): PullFields {
  return {
    url: snapshot.url,
    title: snapshot.title,
    body: snapshot.body,
    state: snapshot.state,
    draft: snapshot.draft,
    merged: snapshot.merged,
    mergedAt: snapshot.mergedAt,
    mergeable: snapshot.mergeable,
    mergeableState: snapshot.mergeableState,
    baseRefName: snapshot.baseRefName,
    headRefName: snapshot.headRefName,
    headRepository: snapshot.headRepository,
    headSha: snapshot.headSha,
    author: snapshot.author,
    updatedAt: snapshot.updatedAt,
  };
}

/** A stored comment as its list response carried it, without what reaction reads added. */
function listedComment(comment: PullRequestComment): PullRequestComment {
  return {
    id: comment.id,
    author: comment.author,
    body: comment.body,
    createdAt: comment.createdAt,
    updatedAt: comment.updatedAt,
    reactions: comment.reactions,
    path: comment.path,
    line: comment.line,
    startLine: comment.startLine,
    diffHunk: comment.diffHunk,
    inReplyToId: comment.inReplyToId,
    htmlUrl: comment.htmlUrl,
  };
}

function snapshotRequestPaths(repository: string, number: number) {
  return {
    pull: `/repos/${repository}/pulls/${number}`,
    issue: `/repos/${repository}/issues/${number}`,
    comments: `/repos/${repository}/issues/${number}/comments`,
    reviews: `/repos/${repository}/pulls/${number}/reviews`,
    reviewComments: `/repos/${repository}/pulls/${number}/comments`,
    checkRuns: (sha: string) => `/repos/${repository}/commits/${sha}/check-runs`,
    statuses: (sha: string) => `/repos/${repository}/commits/${sha}/statuses`,
    checkSuites: (sha: string) => `/repos/${repository}/commits/${sha}/check-suites`,
  };
}

type SliceOf = (snapshot: PullRequestSnapshot) => unknown;

/**
 * The part of a snapshot each conditional request produced, keyed by the URL its validator is
 * stored under. Check URLs carry the head revision, so they exist only for `snapshot`'s head.
 */
function requestSlices(snapshot: PullRequestSnapshot): Map<string, SliceOf> {
  const paths = snapshotRequestPaths(snapshot.repository, snapshot.number);
  const checksOf = (kind: PullRequestCheck["kind"]): SliceOf =>
    (candidate) => candidate.checks.filter((check) => check.kind === kind);
  const slices = new Map<string, SliceOf>([
    [apiUrl(paths.pull), storedPullFields],
    [apiUrl(paths.issue), (candidate) => candidate.bodyReactions],
    [firstPageUrl(paths.comments), (candidate) => candidate.comments.map(listedComment)],
    [firstPageUrl(paths.reviews), (candidate) => candidate.reviews],
    [firstPageUrl(paths.reviewComments), (candidate) => candidate.reviewComments.map(listedComment)],
  ]);
  if (!snapshot.headSha) return slices;
  slices.set(firstPageUrl(paths.checkRuns(snapshot.headSha)), checksOf("check_run"));
  slices.set(firstPageUrl(paths.statuses(snapshot.headSha)), checksOf("commit_status"));
  slices.set(firstPageUrl(paths.checkSuites(snapshot.headSha)), checksOf("check_suite"));
  return slices;
}

type RequestKnowledge = Pick<PullRequestSnapshot, "githubValidators" | "threadsReadAt">;

/**
 * The validators and threads read time that still describe `content` once the hub has
 * assembled it from more than one snapshot. A validator is taken from the first candidate
 * whose slice for that URL is identical to `content`'s, because a 304 hands that slice back
 * verbatim; any other validator is dropped, which only costs the next refresh a full read.
 * The threads read time is the latest among candidates holding the same threads.
 */
export function coherentRequestKnowledge(
  content: PullRequestSnapshot,
  candidates: readonly (PullRequestSnapshot | null)[],
): RequestKnowledge {
  const slices = requestSlices(content);
  const contentSlices = new Map<string, string>();
  const validators: GithubValidators = {};
  for (const candidate of candidates) {
    for (const [url, etag] of Object.entries(candidate?.githubValidators ?? {})) {
      const slice = slices.get(url);
      if (!candidate || !slice || Object.hasOwn(validators, url)) continue;
      let expected = contentSlices.get(url);
      if (expected === undefined) {
        expected = JSON.stringify(slice(content));
        contentSlices.set(url, expected);
      }
      if (JSON.stringify(slice(candidate)) === expected) validators[url] = etag;
    }
  }
  const threads = JSON.stringify(content.threads);
  let threadsReadAt: string | undefined;
  for (const candidate of candidates) {
    if (!candidate?.threadsReadAt || JSON.stringify(candidate.threads) !== threads) continue;
    if (threadsReadAt === undefined || Date.parse(candidate.threadsReadAt) > Date.parse(threadsReadAt)) {
      threadsReadAt = candidate.threadsReadAt;
    }
  }
  return {
    githubValidators: Object.keys(validators).length > 0 ? validators : undefined,
    threadsReadAt,
  };
}

function sameValidators(left: GithubValidators | undefined, right: GithubValidators | undefined): boolean {
  const leftEntries = Object.entries(left ?? {});
  if (leftEntries.length !== Object.keys(right ?? {}).length) return false;
  return leftEntries.every(([url, etag]) => right?.[url] === etag);
}

/**
 * Whether `next` knows something about its requests worth a silent write over `stored`: a
 * validator the next refresh can send, or a threads read that saves the next refresh one
 * because the stored read has gone stale. A fresher read over a still-fresh one is not worth
 * a write, or a watch whose review comments cannot be revalidated would store every poll.
 */
export function requestKnowledgeAdvanced(stored: PullRequestSnapshot, next: PullRequestSnapshot, now: number): boolean {
  if (!sameValidators(stored.githubValidators, next.githubValidators)) return true;
  return next.threadsReadAt !== undefined &&
    next.threadsReadAt !== stored.threadsReadAt &&
    threadsStale(stored, now);
}

/** A 304 hands back the stored slice; the one-to-one validator guarantees `previous` exists. */
function settle<T, R>(
  read: Revalidated<T>,
  previous: PullRequestSnapshot | null,
  fresh: (value: T) => R,
  stored: (snapshot: PullRequestSnapshot) => R,
): R {
  if (read.status === "fetched") return fresh(read.value);
  if (!previous) throw new Error("GitHub answered 304 to a request sent without a validator");
  return stored(previous);
}

function records(pages: Observed<unknown[]>[]): GithubRecord[] {
  return pages
    .flatMap((page) => page.value)
    .filter((record): record is GithubRecord => Boolean(record && typeof record === "object"));
}

/**
 * `previous` is the caller's last stored snapshot for this PR, and it only saves requests.
 * Each REST request carries the ETag `previous` stored for its URL; a 304 costs no primary
 * rate limit and hands back the slice of `previous` that ETag was issued for. A reaction
 * target whose aggregate counts are unchanged keeps the details already stored instead of
 * being read again every minute, and review threads are reused while the review comments
 * answer 304 and the last threads read is under fifteen minutes old.
 */
export async function pullRequestSnapshot(
  token: string,
  repository: string,
  number: number,
  previous: PullRequestSnapshot | null = null,
  usage?: GithubUsage,
  threadsRead: ThreadsRead = "when_stale",
): Promise<PullRequestSnapshot> {
  const auth: GithubAuth = { token, usage };
  const prior = previous?.githubValidators ?? {};
  const validators: GithubValidators = {};
  // The ETag that now describes a URL's slice: the fresh one, or the one a 304 confirmed.
  const keep = (url: string, read: Revalidated<unknown>): void => {
    const etag = read.status === "not_modified" ? prior[url] : read.etag;
    if (etag) validators[url] = etag;
  };
  const paths = snapshotRequestPaths(repository, number);
  const [pullRead, issueRead] = await settleWave([
    githubObjectRead(auth, paths.pull, prior),
    // The body's reaction summary is only as fresh as the response that carried it, which is
    // also where the wave's slowest work has not happened yet.
    githubObjectRead(auth, paths.issue, prior),
  ]);
  keep(apiUrl(paths.pull), pullRead);
  keep(apiUrl(paths.issue), issueRead);
  const pull = settle(pullRead, previous, (record) => pullFields(record, repository, number), storedPullFields);
  const headSha = pull.headSha;

  const listRead = (path: string, field?: string) => githubListRead<unknown>(auth, path, prior, field);
  const checkRead = (path: ((sha: string) => string), field?: string) =>
    headSha ? listRead(path(headSha), field) : Promise.resolve(null);
  const reviewCommentsRead = listRead(paths.reviewComments);
  const threadsKnowledge = reviewCommentsRead.then(async (read): Promise<Pick<PullRequestSnapshot, "threads" | "threadsReadAt">> => {
    if (
      threadsRead === "when_stale" &&
      read.status === "not_modified" &&
      previous &&
      !threadsStale(previous, Date.now())
    ) return { threads: previous.threads, threadsReadAt: previous.threadsReadAt };
    try {
      const threads = await reviewThreads(auth, repository, number);
      return { threads, threadsReadAt: new Date().toISOString() };
    } catch {
      // A failed read says nothing about the threads, so the known ones stand rather than
      // being announced as removed. No read time goes with them: the next refresh reads
      // them again even if the review comments it would otherwise wait on answer 304.
      return { threads: previous?.threads ?? [], threadsReadAt: undefined };
    }
  });
  const [commentsRead, reviewsRead, reviewComments, checkRunsRead, statusesRead, checkSuitesRead, threads] = await settleWave([
    listRead(paths.comments),
    listRead(paths.reviews),
    reviewCommentsRead,
    checkRead(paths.checkRuns, "check_runs"),
    checkRead(paths.statuses),
    checkRead(paths.checkSuites, "check_suites"),
    threadsKnowledge,
  ]);
  keep(firstPageUrl(paths.comments), commentsRead);
  keep(firstPageUrl(paths.reviews), reviewsRead);
  keep(firstPageUrl(paths.reviewComments), reviewComments);
  if (headSha && checkRunsRead) keep(firstPageUrl(paths.checkRuns(headSha)), checkRunsRead);
  if (headSha && statusesRead) keep(firstPageUrl(paths.statuses(headSha)), statusesRead);
  if (headSha && checkSuitesRead) keep(firstPageUrl(paths.checkSuites(headSha)), checkSuitesRead);

  // A 304 dates the stored comments, and the reaction counts riding on them, at its own return.
  const observedComments = (
    read: Revalidated<Observed<unknown[]>[]>,
    stored: (snapshot: PullRequestSnapshot) => PullRequestComment[],
  ): Observed<PullRequestComment>[] => settle(
    read,
    previous,
    (pages) => pages.flatMap((page) => records([page]).map((record) => ({
      value: normalizeComment(record),
      observedAt: page.observedAt,
    }))),
    (snapshot) => stored(snapshot).map((comment) => ({ value: listedComment(comment), observedAt: read.observedAt })),
  );
  const checksOfKind = (
    read: Revalidated<Observed<unknown[]>[]> | null,
    kind: PullRequestCheck["kind"],
    fresh: (checks: GithubRecord[]) => PullRequestCheck[],
  ): PullRequestCheck[] => read
    ? settle(read, previous, (pages) => fresh(records(pages)), (snapshot) => snapshot.checks.filter((check) => check.kind === kind))
    : [];

  // Individual reactions need the comment IDs from the first wave. A target whose read fails
  // keeps its previous counts too, so the next refresh sees the same delta and retries.
  const reactions = await snapshotReactions(
    auth,
    repository,
    number,
    {
      value: settle(issueRead, previous, (record) => reactionCounts(record.reactions), (snapshot) => snapshot.bodyReactions),
      observedAt: issueRead.observedAt,
    },
    observedComments(commentsRead, (snapshot) => snapshot.comments),
    observedComments(reviewComments, (snapshot) => snapshot.reviewComments),
    previous,
  );

  return {
    repository,
    number,
    ...pull,
    fetchedAt: new Date().toISOString(),
    bodyReactions: reactions.bodyReactions,
    bodyReactionsObservedAt: reactions.bodyReactionsObservedAt,
    bodyReactionDetails: reactions.bodyReactionDetails,
    bodyReactionDetailsState: reactions.bodyReactionDetailsState,
    bodyReactionDetailsReadAt: reactions.bodyReactionDetailsReadAt,
    bodyReactionProgress: reactions.bodyReactionProgress,
    comments: reactions.comments,
    reviews: settle(reviewsRead, previous, (pages) => records(pages).map(normalizeReview), (snapshot) => snapshot.reviews),
    reviewComments: reactions.reviewComments,
    checks: [
      ...checksOfKind(checkRunsRead, "check_run", (runs) => runs.map(normalizeCheckRun)),
      ...checksOfKind(statusesRead, "commit_status", (statuses) => latestCommitStatuses(statuses.map(normalizeCommitStatus))),
      ...checksOfKind(checkSuitesRead, "check_suite", (suites) => awaitingApprovalSuites(suites, pull.url)),
    ],
    threads: threads.threads,
    ...(threads.threadsReadAt === undefined ? {} : { threadsReadAt: threads.threadsReadAt }),
    ...(Object.keys(validators).length === 0 ? {} : { githubValidators: validators }),
  };
}
