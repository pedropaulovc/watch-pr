import type { PullRequestSnapshot, WatchEvent } from "./types";

export const SUPPORTED_GITHUB_EVENTS = [
  "check_run",
  "check_suite",
  "commit_comment",
  "deployment",
  "deployment_status",
  "issue_comment",
  "merge_group",
  "pull_request",
  "pull_request_review",
  "pull_request_review_comment",
  "pull_request_review_thread",
  "push",
  "status",
] as const;

const supportedEvents = new Set<string>(SUPPORTED_GITHUB_EVENTS);

export function isSupportedGithubEvent(eventName: string): boolean {
  return supportedEvents.has(eventName);
}

export function normalizeRepository(value: string): string {
  const repository = value.trim().toLowerCase();
  if (!/^[a-z0-9_.-]+\/[a-z0-9_.-]+$/u.test(repository)) {
    throw new Error("repository must be in owner/name form");
  }
  return repository;
}

export function watchKey(repository: string, number: number): string {
  if (!Number.isSafeInteger(number) || number < 1) throw new Error("pull request number must be a positive integer");
  return `${normalizeRepository(repository)}#${number}`;
}

export function parseWatchKey(value: string): { repository: string; number: number } {
  const match = /^([^#]+)#([1-9][0-9]*)$/u.exec(value);
  if (!match) throw new Error("invalid watch key");
  const repository = normalizeRepository(match[1]);
  const number = Number(match[2]);
  if (!Number.isSafeInteger(number)) throw new Error("pull request number is too large");
  return { repository, number };
}

export function resourceUri(repository: string, number: number): string {
  const normalized = normalizeRepository(repository);
  const [owner, repo] = normalized.split("/");
  return `watch-pr://${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pull/${number}`;
}

export function parseResourceUri(value: string): { repository: string; number: number } | null {
  try {
    const uri = new URL(value);
    if (uri.protocol !== "watch-pr:") return null;
    const segments = uri.pathname.split("/").filter(Boolean).map(decodeURIComponent);
    if (segments.length !== 3 || segments[1] !== "pull") return null;
    const number = Number(segments[2]);
    if (!Number.isSafeInteger(number) || number < 1) return null;
    return { repository: normalizeRepository(`${decodeURIComponent(uri.hostname)}/${segments[0]}`), number };
  } catch {
    return null;
  }
}

function nestedNumber(value: unknown, key: string): number | null {
  if (!value || typeof value !== "object") return null;
  const result = (value as Record<string, unknown>)[key];
  return typeof result === "number" && Number.isSafeInteger(result) && result > 0 ? result : null;
}

function repositoryName(payload: Record<string, unknown>): string | null {
  const repository = payload.repository;
  if (!repository || typeof repository !== "object") return null;
  const fullName = (repository as Record<string, unknown>).full_name;
  if (typeof fullName !== "string") return null;
  try {
    return normalizeRepository(fullName);
  } catch {
    return null;
  }
}

function addNumber(numbers: Set<number>, value: unknown, key = "number"): boolean {
  const number = nestedNumber(value, key);
  if (number === null) return false;
  numbers.add(number);
  return true;
}

export function eventPullRequestNumbers(
  eventName: string,
  payload: Record<string, unknown>,
  watchedKeys: Iterable<string>,
): number[] {
  const repository = repositoryName(payload);
  if (!repository) return [];
  const watched = [...watchedKeys];
  const numbers = new Set<number>();
  let hasExplicitTargets = false;
  hasExplicitTargets = addNumber(numbers, payload.pull_request) || hasExplicitTargets;
  if (eventName !== "issue_comment" || isPullRequestIssue(payload.issue)) {
    hasExplicitTargets = addNumber(numbers, payload.issue) || hasExplicitTargets;
  }
  hasExplicitTargets = addNumber(numbers, payload.merge_group) || hasExplicitTargets;
  for (const field of ["check_run", "check_suite", "deployment", "deployment_status", "merge_group", "status"]) {
    const value = payload[field];
    if (!value || typeof value !== "object") continue;
    const pullRequests = (value as Record<string, unknown>).pull_requests;
    if (!Array.isArray(pullRequests)) continue;
    hasExplicitTargets = true;
    for (const pullRequest of pullRequests) addNumber(numbers, pullRequest);
  }

  const matching = [...numbers].filter((number) => watchedKeysIterator(watched, repository, number));
  if (matching.length > 0 || hasExplicitTargets) return matching.sort((left, right) => left - right);

  // Status/check/deployment/push deliveries can omit pull_requests. Refresh
  // every watched PR in the repository so mergeability and reaction changes are not lost.
  if (["check_run", "check_suite", "commit_comment", "deployment", "deployment_status", "merge_group", "push", "status"].includes(eventName)) {
    const repositoryNumbers = new Set<number>();
    for (const key of watched) {
      try {
        const parsed = parseWatchKey(key);
        if (parsed.repository === repository) repositoryNumbers.add(parsed.number);
      } catch {
        // Ignore malformed watch keys from other callers.
      }
    }
    return [...repositoryNumbers].sort((left, right) => left - right);
  }

  return matching;
}

function watchedKeysIterator(watchedKeys: Iterable<string>, repository: string, number: number): boolean {
  const key = `${repository}#${number}`;
  for (const watchedKey of watchedKeys) if (watchedKey === key) return true;
  return false;
}

function isPullRequestIssue(value: unknown): boolean {
  return Boolean(value && typeof value === "object" && (value as Record<string, unknown>).pull_request);
}

export function snapshotChanges(
  previous: PullRequestSnapshot | null,
  current: PullRequestSnapshot,
): string[] {
  if (!previous) return ["initial_snapshot"];
  const changes: string[] = [];
  if (
    previous.state !== current.state ||
    previous.draft !== current.draft ||
    previous.merged !== current.merged ||
    previous.mergedAt !== current.mergedAt
  ) changes.push("lifecycle");
  if (previous.title !== current.title || previous.body !== current.body) changes.push("description");
  if (
    previous.mergeable !== current.mergeable ||
    previous.mergeableState !== current.mergeableState ||
    previous.baseRefName !== current.baseRefName ||
    previous.headRefName !== current.headRefName ||
    previous.headSha !== current.headSha
  ) changes.push("mergeability");
  if (JSON.stringify(previous.comments) !== JSON.stringify(current.comments)) changes.push("comments");
  if (JSON.stringify(previous.reviews) !== JSON.stringify(current.reviews)) changes.push("reviews");
  if (JSON.stringify(previous.reviewComments) !== JSON.stringify(current.reviewComments)) changes.push("review_comments");
  if (JSON.stringify(previous.checks) !== JSON.stringify(current.checks)) changes.push("checks");
  if (JSON.stringify(previous.bodyReactions) !== JSON.stringify(current.bodyReactions)) changes.push("reactions");
  if (JSON.stringify(previous.threads) !== JSON.stringify(current.threads)) changes.push("review_threads");
  return changes;
}

export function createWatchEvent(input: {
  deliveryId: string;
  githubEvent: string;
  action: string | null;
  repository: string;
  pullRequestNumber: number;
  payload: unknown;
  snapshot: PullRequestSnapshot | null;
  changes?: string[];
  receivedAt?: string;
}): WatchEvent {
  const receivedAt = input.receivedAt ?? new Date().toISOString();
  return {
    id: `${receivedAt}:${input.deliveryId}:${input.pullRequestNumber}`,
    deliveryId: input.deliveryId,
    receivedAt,
    githubEvent: input.githubEvent,
    action: input.action,
    repository: normalizeRepository(input.repository),
    pullRequestNumber: input.pullRequestNumber,
    resourceUri: resourceUri(input.repository, input.pullRequestNumber),
    payload: input.payload,
    snapshot: input.snapshot,
    changes: input.changes ?? [],
  };
}
