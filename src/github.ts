import type {
  GithubUser,
  PullRequestCheck,
  PullRequestComment,
  PullRequestReaction,
  PullRequestReview,
  PullRequestSnapshot,
  PullRequestThread,
  ReactionCounts,
} from "./types";
import { normalizeRepository } from "./events";

const API_ROOT = "https://api.github.com";
const API_VERSION = "2022-11-28";
/** Individual reactions are read per target, so a wide PR cannot open one request per comment. */
const REACTION_CONCURRENCY = 8;
/** Total paginated REST calls allowed for individual reaction details in one snapshot. */
const REACTION_REQUEST_BUDGET = 64;

interface RequestBudget {
  remaining: number;
}


type GithubRecord = Record<string, unknown>;

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
  token: string,
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set("accept", "application/vnd.github+json");
  headers.set("x-github-api-version", API_VERSION);
  headers.set("user-agent", "watch-pr-mcp/0.1");
  headers.set("authorization", `Bearer ${token}`);
  return fetch(apiUrl(path), { ...init, headers });
}

export async function githubJson<T>(
  token: string,
  path: string,
  init: RequestInit = {},
): Promise<T> {
  const response = await githubResponse(token, path, init);
  const text = await response.text();
  if (!response.ok) throw new GithubApiError(response.status, text, path);
  if (!text) return {} as T;
  return JSON.parse(text) as T;
}

async function githubPaginated<T>(
  token: string,
  path: string,
  field?: string,
  budget?: RequestBudget,
): Promise<T[]> {
  const values: T[] = [];
  let nextUrl: string | null = `${apiUrl(path)}${path.includes("?") ? "&" : "?"}per_page=100`;

  while (nextUrl) {
    if (budget) {
      if (budget.remaining === 0) throw new Error("GitHub reaction request budget exhausted");
      budget.remaining -= 1;
    }
    const response = await githubResponse(token, nextUrl);
    const text = await response.text();
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
    values.push(...page);
    nextUrl = nextLink(response.headers.get("link"));
  }

  return values;
}

function nextLink(linkHeader: string | null): string | null {
  if (!linkHeader) return null;
  for (const part of linkHeader.split(",")) {
    const match = /<([^>]+)>;\s*rel="([^"]+)"/u.exec(part.trim());
    if (match?.[2] === "next") return match[1];
  }
  return null;
}

function stringValue(record: GithubRecord, key: string): string | null {
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

function numberValue(record: GithubRecord, key: string): number {
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
function reactionTotal(counts: ReactionCounts): number {
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

function sameReactionCounts(previous: ReactionCounts, current: ReactionCounts): boolean {
  const keys = new Set([...Object.keys(previous), ...Object.keys(current)]);
  for (const key of keys) {
    if (previous[key] !== current[key]) return false;
  }
  return true;
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

async function reactionRecords(
  token: string,
  path: string,
  budget: RequestBudget,
): Promise<PullRequestReaction[]> {
  const records = await githubPaginated<unknown>(token, path, undefined, budget);
  return records
    .filter((record): record is GithubRecord => Boolean(record && typeof record === "object"))
    .map(normalizeReaction)
    .filter((reaction) => reaction.id > 0 && reaction.content !== "");
}

interface ReactionState {
  reactions: ReactionCounts;
  reactionDetails?: PullRequestReaction[];
}

interface ReactionTargetRead {
  /** Index of the target slot this read fills. */
  slot: number;
  path: string;
}

interface SnapshotReactions {
  bodyReactions: ReactionCounts;
  bodyReactionDetails: PullRequestReaction[] | undefined;
  comments: PullRequestComment[];
  reviewComments: PullRequestComment[];
}

/**
 * One wave for the whole snapshot: every target that still needs a read, across the PR body,
 * top-level comments, and inline review comments, shares a single `REACTION_CONCURRENCY`
 * budget. Two kinds of target never spend a request: a zero summary count is authoritative
 * for "no reactions", and an unchanged summary count over known details means the stored
 * details still describe the target. The residual blind spot is a swap that leaves every
 * count identical - one `heart` replaced by another actor's `heart` between two refreshes -
 * which the summary cannot express and only a per-target read would reveal.
 * A failed or internally inconsistent read leaves that target unknown. Its current summary
 * counts still advance, but the absent details force the next refresh to read the target
 * again. Unknown details also let the transactional merge preserve reaction knowledge that
 * another concurrent refresh committed while this request was in flight. Every other
 * snapshot field still advances.
 */
async function snapshotReactions(
  token: string,
  repository: string,
  number: number,
  bodyReactions: ReactionCounts,
  comments: PullRequestComment[],
  reviewComments: PullRequestComment[],
  previous: PullRequestSnapshot | null,
): Promise<SnapshotReactions> {
  // One slot per reaction target, seeded with what this refresh already knows: the summary
  // counts GitHub returned, and details only once they are known.
  const slots: ReactionState[] = [];
  const reads: ReactionTargetRead[] = [];
  const plan = (reactions: ReactionCounts, path: string, prior: ReactionState | undefined): number => {
    const slot = slots.push({ reactions }) - 1;
    if (reactionTotal(reactions) === 0) slots[slot].reactionDetails = [];
    else if (prior?.reactionDetails && sameReactionCounts(prior.reactions, reactions)) slots[slot].reactionDetails = prior.reactionDetails;
    else reads.push({ slot, path });
    return slot;
  };

  const previousComments = new Map(previous?.comments.map((comment) => [comment.id, comment] as const));
  const previousReviewComments = new Map(previous?.reviewComments.map((comment) => [comment.id, comment] as const));
  const bodySlot = plan(
    bodyReactions,
    `/repos/${repository}/issues/${number}/reactions`,
    previous ? { reactions: previous.bodyReactions, reactionDetails: previous.bodyReactionDetails } : undefined,
  );
  const commentSlots = comments.map((comment) => plan(
    comment.reactions,
    `/repos/${repository}/issues/comments/${comment.id}/reactions`,
    previousComments.get(comment.id),
  ));
  const reviewCommentSlots = reviewComments.map((comment) => plan(
    comment.reactions,
    `/repos/${repository}/pulls/comments/${comment.id}/reactions`,
    previousReviewComments.get(comment.id),
  ));

  const budget: RequestBudget = { remaining: REACTION_REQUEST_BUDGET };
  const states = await mapBounded(reads, REACTION_CONCURRENCY, async (read): Promise<ReactionState> => {
    try {
      const reactions = slots[read.slot].reactions;
      const reactionDetails = await reactionRecords(token, read.path, budget);
      if (!reactionDetailsMatchCounts(reactionDetails, reactions)) {
        throw new Error(`GitHub returned reaction details inconsistent with ${read.path}`);
      }
      return { reactions, reactionDetails };
    } catch {
      return slots[read.slot];
    }
  });
  for (const [position, read] of reads.entries()) slots[read.slot] = states[position];

  const attach = (comment: PullRequestComment, slot: number): PullRequestComment => {
    const { reactions, reactionDetails } = slots[slot];
    if (reactionDetails === undefined) return reactions === comment.reactions ? comment : { ...comment, reactions };
    return { ...comment, reactions, reactionDetails };
  };
  return {
    bodyReactions: slots[bodySlot].reactions,
    bodyReactionDetails: slots[bodySlot].reactionDetails,
    comments: comments.map((comment, position) => attach(comment, commentSlots[position])),
    reviewComments: reviewComments.map((comment, position) => attach(comment, reviewCommentSlots[position])),
  };
}

function normalizeComment(record: GithubRecord): PullRequestComment {
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

function normalizeReview(record: GithubRecord): PullRequestReview {
  return {
    id: numberValue(record, "id"),
    author: userLogin(record),
    state: stringValue(record, "state") ?? "PENDING",
    body: stringValue(record, "body") ?? "",
    submittedAt: stringValue(record, "submitted_at"),
    htmlUrl: stringValue(record, "html_url") ?? undefined,
  };
}

function normalizeCheckRun(record: GithubRecord): PullRequestCheck {
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

function normalizeCommitStatus(record: GithubRecord, index: number): PullRequestCheck {
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

function latestCommitStatuses(records: GithubRecord[]): PullRequestCheck[] {
  const latestByContext = new Map<string, PullRequestCheck>();
  for (const [index, record] of records.entries()) {
    const candidate = normalizeCommitStatus(record, index);
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

async function reviewThreads(
  token: string,
  repository: string,
  number: number,
): Promise<PullRequestThread[]> {
  const [owner, repo] = repository.split("/");
  const query = `query($owner:String!,$repo:String!,$number:Int!,$cursor:String){repository(owner:$owner,name:$repo){pullRequest(number:$number){reviewThreads(first:100,after:$cursor){nodes{id,isResolved,comments(first:100){nodes{databaseId}}}pageInfo{hasNextPage,endCursor}}}}}`;
  const threads: PullRequestThread[] = [];
  let cursor: string | null = null;

  try {
    while (true) {
      const response = await githubJson<GithubRecord>(token, "/graphql", {
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
  } catch {
    return [];
  }
}

export async function githubUser(token: string): Promise<GithubUser> {
  const record = await githubJson<GithubRecord>(token, "/user");
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

/**
 * `previous` is the caller's last stored snapshot for this PR, and it only saves requests:
 * a reaction target whose aggregate counts are unchanged keeps the details already stored
 * instead of being read again every minute.
 */
export async function pullRequestSnapshot(
  token: string,
  repository: string,
  number: number,
  previous: PullRequestSnapshot | null = null,
): Promise<PullRequestSnapshot> {
  const [pull, issue] = await Promise.all([
    githubJson<GithubRecord>(token, `/repos/${repository}/pulls/${number}`),
    githubJson<GithubRecord>(token, `/repos/${repository}/issues/${number}`),
  ]);
  const head = pull.head && typeof pull.head === "object" ? pull.head as GithubRecord : {};
  const base = pull.base && typeof pull.base === "object" ? pull.base as GithubRecord : {};
  const headSha = stringValue(head, "sha");
  const [comments, reviews, reviewComments, checkRuns, statuses, threads] = await Promise.all([
    githubPaginated<GithubRecord>(token, `/repos/${repository}/issues/${number}/comments`),
    githubPaginated<GithubRecord>(token, `/repos/${repository}/pulls/${number}/reviews`),
    githubPaginated<GithubRecord>(token, `/repos/${repository}/pulls/${number}/comments`),
    headSha ? githubPaginated<GithubRecord>(token, `/repos/${repository}/commits/${headSha}/check-runs`, "check_runs") : Promise.resolve([]),
    headSha ? githubPaginated<GithubRecord>(token, `/repos/${repository}/commits/${headSha}/statuses`) : Promise.resolve([]),
    reviewThreads(token, repository, number),
  ]);

  // Individual reactions need the comment IDs from the first wave. A target whose read fails
  // keeps its previous counts too, so the next refresh sees the same delta and retries.
  const bodyReactions = reactionCounts(issue.reactions);
  const reactions = await snapshotReactions(
    token,
    repository,
    number,
    bodyReactions,
    comments.map(normalizeComment),
    reviewComments.map(normalizeComment),
    previous,
  );

  return {
    repository,
    number,
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
    headSha,
    author: userLogin(pull, "user"),
    fetchedAt: new Date().toISOString(),
    bodyReactions: reactions.bodyReactions,
    bodyReactionDetails: reactions.bodyReactionDetails,
    comments: reactions.comments,
    reviews: reviews.map(normalizeReview),
    reviewComments: reactions.reviewComments,
    checks: [
      ...checkRuns
        .filter((check): check is GithubRecord => Boolean(check && typeof check === "object"))
        .map(normalizeCheckRun),
      ...latestCommitStatuses(
        statuses.filter((status): status is GithubRecord => Boolean(status && typeof status === "object")),
      ),
    ],
    threads,
  };
}
