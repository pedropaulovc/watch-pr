import type {
  GithubUser,
  PullRequestCheck,
  PullRequestComment,
  PullRequestReview,
  PullRequestSnapshot,
  PullRequestThread,
  ReactionCounts,
} from "./types";

const API_ROOT = "https://api.github.com";
const API_VERSION = "2022-11-28";

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

async function githubPaginated<T>(token: string, path: string, field?: string): Promise<T[]> {
  const values: T[] = [];
  let nextUrl: string | null = `${apiUrl(path)}${path.includes("?") ? "&" : "?"}per_page=100`;

  while (nextUrl) {
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

export async function pullRequestSnapshot(
  token: string,
  repository: string,
  number: number,
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
    headSha,
    author: userLogin(pull, "user"),
    fetchedAt: new Date().toISOString(),
    bodyReactions: reactionCounts(issue.reactions),
    comments: comments.map(normalizeComment),
    reviews: reviews.map(normalizeReview),
    reviewComments: reviewComments.map(normalizeComment),
    checks: [
      ...checkRuns
        .filter((check): check is GithubRecord => Boolean(check && typeof check === "object"))
        .map(normalizeCheckRun),
      ...statuses
        .filter((status): status is GithubRecord => Boolean(status && typeof status === "object"))
        .map(normalizeCommitStatus),
    ],
    threads,
  };
}
