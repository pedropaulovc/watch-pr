import type {
  PullRequestCheck,
  PullRequestComment,
  PullRequestReview,
  PullRequestSnapshot,
  WatchEvent,
} from "./types";

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

const MAX_MONITOR_DETAIL_LINES = 24;
const MAX_MONITOR_DETAIL_LENGTH = 500;
const MAX_MONITOR_DETAILS_LENGTH = 3_900;
const MAX_MONITOR_BODY_LENGTH = 240;
const ANSI_ESCAPE_SEQUENCE_RE = /\u001b(?:\][^\u0007]*(?:\u0007|\u001b\\)|\[[0-?]*[ -/]*[@-~])/gu;

function truncate(value: string, maximumLength: number): string {
  if (value.length <= maximumLength) return value;
  let prefix = value.slice(0, maximumLength - 1);
  const lastCodeUnit = prefix.charCodeAt(prefix.length - 1);
  if (lastCodeUnit >= 0xd800 && lastCodeUnit <= 0xdbff) prefix = prefix.slice(0, -1);
  return `${prefix}…`;
}

function boundedDetails(lines: string[]): string[] {
  const candidates = [...new Set(lines)].map((line) => truncate(line, MAX_MONITOR_DETAIL_LENGTH));
  const details: string[] = [];
  let length = 0;
  let index = 0;
  while (index < candidates.length && details.length < MAX_MONITOR_DETAIL_LINES) {
    const line = candidates[index];
    if (length + line.length > MAX_MONITOR_DETAILS_LENGTH) break;
    details.push(line);
    length += line.length;
    index += 1;
  }
  if (index === candidates.length) return details;

  let omitted = candidates.length - index;
  let marker = `+${omitted} more changes`;
  if (details.length >= MAX_MONITOR_DETAIL_LINES) {
    const removed = details.pop()!;
    length -= removed.length;
    omitted += 1;
    marker = `+${omitted} more changes`;
  }
  while (details.length > 0 && length + marker.length > MAX_MONITOR_DETAILS_LENGTH) {
    const removed = details.pop()!;
    length -= removed.length;
    omitted += 1;
    marker = `+${omitted} more changes`;
  }
  if (details.length < MAX_MONITOR_DETAIL_LINES) details.push(marker);
  return details;
}

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
export interface WatchedPullRequest {
  key: string;
  snapshot: PullRequestSnapshot | null;
}

function pushedBranch(payload: Record<string, unknown>): string | null | undefined {
  if (typeof payload.ref !== "string") return undefined;
  const prefix = "refs/heads/";
  return payload.ref.startsWith(prefix) && payload.ref.length > prefix.length
    ? payload.ref.slice(prefix.length)
    : null;
}

function pushTargetsWatch(
  payload: Record<string, unknown>,
  pushedRepository: string,
  watchedRepository: string,
  snapshot: PullRequestSnapshot | null,
): boolean {
  const branch = pushedBranch(payload);
  if (branch === null) return false;
  if (!snapshot) return pushedRepository === watchedRepository;

  const headRepository = snapshot.headRepository;
  if (branch === undefined) {
    return pushedRepository === watchedRepository || headRepository === pushedRepository;
  }
  if (pushedRepository === watchedRepository && snapshot.baseRefName === branch) return true;
  if (snapshot.headRefName === branch) {
    // Legacy snapshots retain repository-local routing until their next refresh
    // populates headRepository and can distinguish a fork branch collision.
    return headRepository ? headRepository === pushedRepository : pushedRepository === watchedRepository;
  }
  if (pushedRepository === watchedRepository && !snapshot.baseRefName) return true;
  if (!snapshot.headRefName) {
    return headRepository ? headRepository === pushedRepository : pushedRepository === watchedRepository;
  }
  return false;
}

export function eventPullRequestNumbers(
  eventName: string,
  payload: Record<string, unknown>,
  watchedPullRequests: Iterable<WatchedPullRequest>,
): number[] {
  const repository = repositoryName(payload);
  if (!repository) return [];
  const watched = [...watchedPullRequests];
  const watchedKeys = new Set(watched.map((watch) => watch.key));
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

  const matching = [...numbers].filter((number) => watchedKeys.has(`${repository}#${number}`));
  if (matching.length > 0 || hasExplicitTargets) return matching.sort((left, right) => left - right);

  // These deliveries can omit pull_requests. Non-push events still refresh every
  // repository watch; pushes are narrowed below to the affected head/base branches.
  if (["check_run", "check_suite", "commit_comment", "deployment", "deployment_status", "merge_group", "push", "status"].includes(eventName)) {
    const repositoryNumbers = new Set<number>();
    for (const watch of watched) {
      try {
        const parsed = parseWatchKey(watch.key);
        if (eventName === "push") {
          if (!pushTargetsWatch(payload, repository, parsed.repository, watch.snapshot)) continue;
        } else if (parsed.repository !== repository) {
          continue;
        }
        repositoryNumbers.add(parsed.number);
      } catch {
        // Ignore malformed watch keys from other callers.
      }
    }
    return [...repositoryNumbers].sort((left, right) => left - right);
  }

  return matching;
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

function checkBucket(check: PullRequestCheck): "pending" | "pass" | "fail" | "skipping" | "cancel" {
  if (check.status?.toLowerCase() !== "completed") return "pending";
  switch (check.conclusion?.toLowerCase()) {
    case "success":
    case "neutral":
      return "pass";
    case "pending":
      return "pending";
    case "skipped":
      return "skipping";
    case "cancelled":
    case "canceled":
      return "cancel";
    default:
      return check.conclusion ? "fail" : "pending";
  }
}

function checkKey(check: PullRequestCheck): string {
  return check.kind === "commit_status" ? `${check.kind}:${check.name}` : `${check.kind}:${check.id}`;
}

function checkTerminalSummary(checks: PullRequestCheck[]): string {
  const counts = { pass: 0, fail: 0, skipping: 0, cancel: 0 };
  for (const check of checks) {
    const bucket = checkBucket(check);
    if (bucket !== "pending") counts[bucket] += 1;
  }
  return `checks: all terminal (pass: ${counts.pass}, fail: ${counts.fail}, skipping: ${counts.skipping}, cancel: ${counts.cancel})`;
}

function checkDetails(previous: PullRequestCheck[], current: PullRequestCheck[]): string[] {
  const previousByKey = new Map(previous.map((check) => [checkKey(check), check]));
  const previousPending = new Set(
    previous.filter((check) => checkBucket(check) === "pending").map(checkKey),
  );
  const currentPending = new Set(
    current.filter((check) => checkBucket(check) === "pending").map(checkKey),
  );
  const lines = current
    .filter((check) => {
      const bucket = checkBucket(check);
      if (bucket !== "fail" && bucket !== "cancel") return false;
      const prior = previousByKey.get(checkKey(check));
      return !prior || checkBucket(prior) !== bucket || prior.completedAt !== check.completedAt;
    })
    .map((check) => `check ${check.name}: ${checkBucket(check)}${check.url ? ` ${check.url}` : ""}`);

  if (previousPending.size === 0 && currentPending.size > 0) {
    const names = [...new Set(
      current.filter((check) => currentPending.has(checkKey(check))).map((check) => check.name),
    )].sort();
    lines.push(`checks: rerun started (pending: ${names.join(", ")})`);
  }
  if (
    previousPending.size > 0 &&
    currentPending.size === 0 &&
    [...previousPending].every((key) => current.some((check) => checkKey(check) === key))
  ) {
    lines.push(checkTerminalSummary(current));
  }
  return lines;
}

function reconciliationCheckDetails(checks: PullRequestCheck[]): string[] {
  const lines = checks
    .filter((check) => checkBucket(check) === "fail" || checkBucket(check) === "cancel")
    .map((check) => `check ${check.name}: ${checkBucket(check)}${check.url ? ` ${check.url}` : ""}`);
  const pendingNames = [...new Set(
    checks.filter((check) => checkBucket(check) === "pending").map((check) => check.name),
  )].sort();
  if (pendingNames.length > 0) {
    lines.push(`checks: pending (${pendingNames.join(", ")})`);
  } else if (checks.length > 0) {
    lines.push(checkTerminalSummary(checks));
  }
  return lines;
}

function compactBody(value: string): string {
  return truncate(
    value
      .replace(ANSI_ESCAPE_SEQUENCE_RE, "")
      .replace(/<!--[\s\S]*?-->/gu, "")
      .replace(/\s+/gu, " ")
      .replace(/[\u0000-\u001f\u007f-\u009f]/gu, "")
      .trim(),
    MAX_MONITOR_BODY_LENGTH,
  );
}

function commentLocation(comment: PullRequestComment): string {
  if (!comment.path) return "";
  const start = comment.startLine ?? comment.line;
  const end = comment.line ?? start;
  if (!start) return comment.path;
  return `${comment.path}:${start}${end && end !== start ? `-${end}` : ""}`;
}

function commentContentKey(comment: PullRequestComment): string {
  return JSON.stringify([
    comment.author,
    comment.body,
    comment.updatedAt,
    comment.path,
    comment.line,
    comment.startLine,
    comment.inReplyToId,
  ]);
}

function reviewContentKey(review: PullRequestReview): string {
  return JSON.stringify([review.author, review.state, review.body, review.submittedAt]);
}

function changedComments(
  previous: PullRequestComment[],
  current: PullRequestComment[],
): PullRequestComment[] {
  const previousById = new Map(previous.map((comment) => [comment.id, comment]));
  return current.filter((comment) => {
    const prior = previousById.get(comment.id);
    return !prior || commentContentKey(prior) !== commentContentKey(comment);
  });
}

function changedReviews(
  previous: PullRequestReview[],
  current: PullRequestReview[],
): PullRequestReview[] {
  const previousById = new Map(previous.map((review) => [review.id, review]));
  return current.filter((review) => {
    const prior = previousById.get(review.id);
    return !prior || reviewContentKey(prior) !== reviewContentKey(review);
  });
}

function removedComments(
  previous: PullRequestComment[],
  current: PullRequestComment[],
): PullRequestComment[] {
  const currentIds = new Set(current.map((comment) => comment.id));
  return previous.filter((comment) => !currentIds.has(comment.id));
}

function removedReviews(
  previous: PullRequestReview[],
  current: PullRequestReview[],
): PullRequestReview[] {
  const currentIds = new Set(current.map((review) => review.id));
  return previous.filter((review) => !currentIds.has(review.id));
}

function commentDetail(comment: PullRequestComment): string {
  const body = compactBody(comment.body);
  return `comment #${comment.id} @${comment.author ?? "unknown"}${comment.htmlUrl ? ` ${comment.htmlUrl}` : ""}${body ? `: ${body}` : ""}`;
}

function reviewDetail(review: PullRequestReview): string {
  const body = compactBody(review.body);
  return `review #${review.id} @${review.author ?? "unknown"} ${review.state}${review.htmlUrl ? ` ${review.htmlUrl}` : ""}${body ? `: ${body}` : ""}`;
}

function reviewCommentDetail(comment: PullRequestComment, snapshot: PullRequestSnapshot): string {
  const thread = snapshot.threads.find((candidate) => candidate.commentIds.includes(comment.id));
  const location = commentLocation(comment);
  const body = compactBody(comment.body);
  return `feedback [${thread?.id ?? "-"}] #${comment.id}${location ? ` ${location}` : ""} @${comment.author ?? "unknown"}${comment.htmlUrl ? ` ${comment.htmlUrl}` : ""}${body ? `: ${body}` : ""}`;
}

function mergeabilityDetails(
  previous: PullRequestSnapshot | null,
  current: PullRequestSnapshot,
): string[] {
  const lines: string[] = [];
  if (
    (!previous || previous.headRefName !== current.headRefName || previous.headSha !== current.headSha) &&
    current.headRefName &&
    current.headSha
  ) {
    lines.push(`head: ${current.headRefName}@${current.headSha}`);
  }
  if (previous && previous.baseRefName !== current.baseRefName) {
    lines.push(`base: ${previous.baseRefName ?? "<unknown>"} -> ${current.baseRefName ?? "<unknown>"}`);
  }
  const previousState = previous?.mergeableState?.toUpperCase();
  const currentState = current.mergeableState?.toUpperCase();
  const previousNeedsRebase = previousState === "BEHIND" || previousState === "DIRTY";
  const currentNeedsRebase = currentState === "BEHIND" || currentState === "DIRTY";
  if (currentNeedsRebase && previousState !== currentState) {
    lines.push(`rebase: ${currentState}`);
  } else if (
    previous &&
    previousNeedsRebase &&
    currentState !== undefined &&
    currentState !== "UNKNOWN" &&
    previousState !== currentState
  ) {
    lines.push(`rebase: ${currentState}`);
  }
  return lines;
}

function threadDetails(previous: PullRequestSnapshot, current: PullRequestSnapshot): string[] {
  const previousById = new Map(previous.threads.map((thread) => [thread.id, thread]));
  return current.threads.flatMap((thread) => {
    const prior = previousById.get(thread.id);
    if (!prior || prior.isResolved === thread.isResolved) return [];
    return [`thread ${thread.id}: ${thread.isResolved ? "resolved" : "reopened"}`];
  });
}

export function monitorReconciliationDetails(snapshot: PullRequestSnapshot): string[] {
  const unresolvedCommentIds = new Set(
    snapshot.threads
      .filter((thread) => !thread.isResolved)
      .flatMap((thread) => thread.commentIds),
  );
  const reviewComments = snapshot.threads.length === 0
    ? snapshot.reviewComments
    : snapshot.reviewComments.filter((comment) => unresolvedCommentIds.has(comment.id));
  return boundedDetails([
    ...mergeabilityDetails(null, snapshot),
    ...reconciliationCheckDetails(snapshot.checks),
    ...reviewComments.map((comment) => reviewCommentDetail(comment, snapshot)),
  ]);
}

export function monitorEventDetails(
  previous: PullRequestSnapshot | null,
  current: PullRequestSnapshot,
): string[] {
  if (!previous) return monitorReconciliationDetails(current);
  const lines = [
    ...mergeabilityDetails(previous, current),
    ...checkDetails(previous.checks, current.checks),
    ...changedComments(previous.comments, current.comments).map(commentDetail),
    ...removedComments(previous.comments, current.comments)
      .map((comment) => `comment #${comment.id} deleted`),
    ...changedReviews(previous.reviews, current.reviews).map(reviewDetail),
    ...removedReviews(previous.reviews, current.reviews)
      .map((review) => `review #${review.id} deleted`),
    ...changedComments(previous.reviewComments, current.reviewComments)
      .map((comment) => reviewCommentDetail(comment, current)),
    ...removedComments(previous.reviewComments, current.reviewComments)
      .map((comment) => {
        const thread = previous.threads.find((candidate) => candidate.commentIds.includes(comment.id));
        return `feedback [${thread?.id ?? "-"}] #${comment.id} deleted`;
      }),
    ...threadDetails(previous, current),
  ];
  if (previous.state !== current.state || previous.draft !== current.draft) {
    lines.unshift(`PR state: ${current.state.toUpperCase()}${current.draft ? " DRAFT" : ""}`);
  }
  return boundedDetails(lines);
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
