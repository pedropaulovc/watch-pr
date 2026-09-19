import type {
  PullRequestCheck,
  PullRequestComment,
  PullRequestReaction,
  PullRequestReview,
  PullRequestSnapshot,
  ReactionCounts,
  ReactionDetailsState,
  ReactionReadProgress,
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

function sanitizeDetail(value: string): string {
  return value
    .replace(ANSI_ESCAPE_SEQUENCE_RE, "")
    .replace(/[\u0000-\u001f\u007f-\u009f]/gu, "")
    .trim();
}

function boundedDetails(lines: string[]): string[] {
  const candidates = [...new Set(
    lines
      .map(sanitizeDetail)
      .filter(Boolean)
      .map((line) => truncate(line, MAX_MONITOR_DETAIL_LENGTH)),
  )];
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

/**
 * Comment content, without the reaction details that ride along on the same record: those
 * are compared as reactions so an unknown-to-known reaction read is not read as an edit.
 */
function commentsKey(comments: PullRequestComment[]): string {
  return JSON.stringify(
    comments,
    (key, value: unknown) =>
      key === "reactionDetails" || key === "reactionDetailsState" || key === "reactionProgress"
        ? undefined
        : value,
  );
}

function reactionDetailsChanged(
  previous: PullRequestReaction[] | undefined,
  current: PullRequestReaction[] | undefined,
): boolean {
  // Unknown on either side is a baseline being learned or lost, not reaction activity.
  if (previous === undefined || current === undefined) return false;
  return JSON.stringify(previous) !== JSON.stringify(current);
}

function commentReactionsChanged(previous: PullRequestComment[], current: PullRequestComment[]): boolean {
  const previousById = new Map(previous.map((comment) => [comment.id, comment] as const));
  return current.some((comment) => {
    const prior = previousById.get(comment.id);
    return prior !== undefined && reactionDetailsChanged(prior.reactionDetails, comment.reactionDetails);
  });
}

/**
 * True when this refresh learned reactions a stored snapshot did not know: the PR body, or
 * a comment both snapshots carry, went from unknown details to known ones. Learning a
 * baseline is deliberately not a `snapshotChanges` entry - it publishes nothing and reports
 * no activity - so it is also the one case where a refresh has something worth storing and
 * no event to store it with. Without this the same unknown target would be re-read forever.
 */
export function reactionKnowledgeAdvanced(
  previous: PullRequestSnapshot,
  current: PullRequestSnapshot,
): boolean {
  const learned = (
    prior: PullRequestReaction[] | undefined,
    next: PullRequestReaction[] | undefined,
    priorProgress: { records: PullRequestReaction[]; nextUrl: string } | undefined,
    nextProgress: { records: PullRequestReaction[]; nextUrl: string } | undefined,
  ): boolean => {
    if (prior === undefined && next !== undefined) return true;
    if (prior !== undefined || next !== undefined || !nextProgress) return false;
    if (!priorProgress) return true;
    return nextProgress.records.length > priorProgress.records.length ||
      nextProgress.nextUrl !== priorProgress.nextUrl;
  };
  if (learned(
    previous.bodyReactionDetails,
    current.bodyReactionDetails,
    previous.bodyReactionProgress,
    current.bodyReactionProgress,
  )) return true;
  const learnedComment = (prior: PullRequestComment[], next: PullRequestComment[]): boolean => {
    const priorById = new Map(prior.map((comment) => [comment.id, comment] as const));
    return next.some((comment) => {
      const before = priorById.get(comment.id);
      return before !== undefined && learned(
        before.reactionDetails,
        comment.reactionDetails,
        before.reactionProgress,
        comment.reactionProgress,
      );
    });
  };
  return learnedComment(previous.comments, current.comments) ||
    learnedComment(previous.reviewComments, current.reviewComments);
}

/** Aggregate reaction counts are compared key by key, never by property order. */
export function sameReactionCounts(previous: ReactionCounts, current: ReactionCounts): boolean {
  for (const key of new Set([...Object.keys(previous), ...Object.keys(current)])) {
    if (previous[key] !== current[key]) return false;
  }
  return true;
}

/**
 * What one snapshot knows about one reaction target: the aggregate counts it observed, and
 * whatever stands behind them - complete details, a resumable cursor partway through them,
 * or nothing. `PullRequestComment` is one of these; the PR body is assembled into one.
 */
interface ReactionKnowledge {
  reactions: ReactionCounts;
  reactionDetails?: PullRequestReaction[];
  reactionDetailsState?: ReactionDetailsState;
  reactionProgress?: ReactionReadProgress;
}

/**
 * Resolves one target against the state the write lands on, returning undefined when `base`
 * already holds the best knowledge and needs no rewrite. Three rules decide it.
 *
 * Details `base` actually read are never replaced: they are this writer's evidence, and the
 * merge only ever fills what it does not know.
 *
 * Details `base` only borrowed - reused unread because the summary counts had not moved -
 * are not evidence of anything. Anything the committed state learned outranks them, and
 * counts the committed state disagrees with mean the borrow describes a reaction state this
 * write never observed, so the committed pair stands and the next refresh reads the target
 * again rather than the borrow overwriting it or passing as current.
 *
 * Between a cursor and complete details the later observation wins, which both callers order
 * by `fetchedAt`: they commit the newer of the two snapshots and bail out otherwise. Pairing
 * details with counts a later read contradicts strands the target - the next refresh drops
 * the mismatched knowledge and restarts at page one, only to be overwritten again - so a
 * cursor opened against counts `source` does not share is the only route to the reactions
 * those older details predate.
 */
function resolveReactionKnowledge(
  base: ReactionKnowledge,
  source: ReactionKnowledge | undefined,
  sourceObservedLater: boolean,
): ReactionKnowledge | undefined {
  const agrees = source !== undefined && sameReactionCounts(base.reactions, source.reactions);
  if (base.reactionDetails !== undefined) {
    if (base.reactionDetailsState !== "borrowed") return undefined;
    if (source !== undefined) {
      const outranks = agrees
        ? source.reactionDetails !== undefined && source.reactionDetailsState !== "borrowed"
        : source.reactionDetails !== undefined || source.reactionProgress !== undefined;
      if (outranks) {
        return {
          reactions: source.reactions,
          reactionDetails: source.reactionDetails,
          reactionProgress: source.reactionProgress,
        };
      }
      // Counts disagree and the committed state has nothing to keep: unread stays unknown,
      // so the next refresh reads the target instead of inheriting the borrow again.
      if (!agrees) return { reactions: base.reactions };
    }
    // Nothing committed contradicts the borrow: keep it as the baseline, now confirmed
    // against the state the write lands on.
    return { reactions: base.reactions, reactionDetails: base.reactionDetails };
  }
  if (source === undefined) return undefined;
  const supersedes = agrees || sourceObservedLater;
  if (
    source.reactionDetails !== undefined &&
    (source.reactionDetailsState !== "borrowed" || agrees) &&
    (!base.reactionProgress || supersedes)
  ) {
    return { reactions: source.reactions, reactionDetails: source.reactionDetails };
  }
  if (
    source.reactionProgress &&
    (!base.reactionProgress ||
      supersedes && source.reactionProgress.records.length > base.reactionProgress.records.length)
  ) {
    return { reactions: source.reactions, reactionProgress: source.reactionProgress };
  }
  return undefined;
}

/**
 * Returns `base` with every reaction target it does not know filled in from `source`, and
 * nothing else: each non-reaction field, `fetchedAt` included, comes from `base` alone. Two
 * refreshes can be in flight over one watch and each can learn a different subset of targets
 * - one reads the PR body while the other's body read fails and it reads a comment instead -
 * so whichever writes second must add the other's knowledge without publishing its own view
 * of anything else. The caller picks the base accordingly: a silent enrichment keeps the
 * stored snapshot as the base, so it can never revert a title, head or check that landed
 * while it was in flight, while a published event keeps its own snapshot as the base,
 * because reporting that change is the point of the write.
 *
 * A filled target also takes `source`'s aggregate counts, because the counts are what the
 * next refresh compares against: details from one refresh beside counts from another would
 * either hide a real change or force a pointless re-read. Details `base` read itself are
 * never overwritten, so the merge only ever adds knowledge, and `base` is returned untouched
 * when there was nothing to add. Borrowed details are resolved here and never persist:
 * `resolveReactionKnowledge` settles each one against the committed state.
 */
export function mergeReactionKnowledge(
  base: PullRequestSnapshot,
  source: PullRequestSnapshot,
): PullRequestSnapshot {
  const baseTime = Date.parse(base.fetchedAt);
  const sourceTime = Date.parse(source.fetchedAt);
  const sourceObservedLater = Number.isFinite(baseTime) && Number.isFinite(sourceTime) &&
    sourceTime > baseTime;
  let merged = false;
  const body = resolveReactionKnowledge(
    {
      reactions: base.bodyReactions,
      reactionDetails: base.bodyReactionDetails,
      reactionDetailsState: base.bodyReactionDetailsState,
      reactionProgress: base.bodyReactionProgress,
    },
    {
      reactions: source.bodyReactions,
      reactionDetails: source.bodyReactionDetails,
      reactionDetailsState: source.bodyReactionDetailsState,
      reactionProgress: source.bodyReactionProgress,
    },
    sourceObservedLater,
  );
  if (body) merged = true;
  const fill = (targets: PullRequestComment[], known: PullRequestComment[]): PullRequestComment[] => {
    const knownById = new Map(known.map((comment) => [comment.id, comment] as const));
    return targets.map((comment) => {
      const resolved = resolveReactionKnowledge(comment, knownById.get(comment.id), sourceObservedLater);
      if (!resolved) return comment;
      merged = true;
      return {
        ...comment,
        reactions: resolved.reactions,
        reactionDetails: resolved.reactionDetails,
        reactionDetailsState: undefined,
        reactionProgress: resolved.reactionProgress,
      };
    });
  };
  const comments = fill(base.comments, source.comments);
  const reviewComments = fill(base.reviewComments, source.reviewComments);
  if (!merged) return base;
  return {
    ...base,
    bodyReactions: body ? body.reactions : base.bodyReactions,
    bodyReactionDetails: body ? body.reactionDetails : base.bodyReactionDetails,
    bodyReactionDetailsState: undefined,
    bodyReactionProgress: body ? body.reactionProgress : base.bodyReactionProgress,
    comments,
    reviewComments,
  };
}

/** Logins are renameable and recasable, so they are only ever compared normalized. */
export function normalizedLogin(login: string | null | undefined): string {
  return (login ?? "").toLowerCase();
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
  if (commentsKey(previous.comments) !== commentsKey(current.comments)) changes.push("comments");
  if (JSON.stringify(previous.reviews) !== JSON.stringify(current.reviews)) changes.push("reviews");
  if (commentsKey(previous.reviewComments) !== commentsKey(current.reviewComments)) changes.push("review_comments");
  if (JSON.stringify(previous.checks) !== JSON.stringify(current.checks)) changes.push("checks");
  if (
    JSON.stringify(previous.bodyReactions) !== JSON.stringify(current.bodyReactions) ||
    reactionDetailsChanged(previous.bodyReactionDetails, current.bodyReactionDetails) ||
    commentReactionsChanged(previous.comments, current.comments) ||
    commentReactionsChanged(previous.reviewComments, current.reviewComments)
  ) changes.push("reactions");
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
  return check.kind === "commit_status"
    ? `${check.kind}:${check.name.toLowerCase()}`
    : `${check.kind}:${check.id}`;
}

function checkSummary(checks: PullRequestCheck[]): string {
  const details = [...checks]
    .sort((left, right) => left.name.localeCompare(right.name))
    .map((check) => {
      const bucket = checkBucket(check);
      const url = (bucket === "fail" || bucket === "cancel") && check.url ? ` ${check.url}` : "";
      return `${check.name} -> ${bucket}${url}`;
    });
  return `checks: ${details.join(", ")}`;
}

function checkDetails(previous: PullRequestCheck[], current: PullRequestCheck[]): string[] {
  const previousByKey = new Map(previous.map((check) => [checkKey(check), check]));
  const previousPending = new Set(
    previous.filter((check) => checkBucket(check) === "pending").map(checkKey),
  );
  const currentPending = new Set(
    current.filter((check) => checkBucket(check) === "pending").map(checkKey),
  );
  const selected = new Map<string, PullRequestCheck>();
  for (const check of current) {
    const bucket = checkBucket(check);
    if (bucket !== "fail" && bucket !== "cancel") continue;
    const prior = previousByKey.get(checkKey(check));
    if (!prior || checkBucket(prior) !== bucket || prior.completedAt !== check.completedAt) {
      selected.set(checkKey(check), check);
    }
  }

  if (previousPending.size === 0 && currentPending.size > 0) {
    for (const check of current) {
      if (currentPending.has(checkKey(check))) selected.set(checkKey(check), check);
    }
  }
  if (
    previousPending.size > 0 &&
    currentPending.size === 0 &&
    [...previousPending].every((key) => current.some((check) => checkKey(check) === key))
  ) {
    return current.length > 0 ? [checkSummary(current)] : [];
  }
  return selected.size > 0 ? [checkSummary([...selected.values()])] : [];
}

function reconciliationCheckDetails(checks: PullRequestCheck[]): string[] {
  return checks.length > 0 ? [checkSummary(checks)] : [];
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
  const details: string[] = [];
  if (
    (!previous || previous.headRefName !== current.headRefName || previous.headSha !== current.headSha) &&
    current.headRefName &&
    current.headSha
  ) {
    details.push(`head -> ${current.headRefName}@${current.headSha}`);
  }
  if (previous && previous.baseRefName !== current.baseRefName) {
    details.push(`base ${previous.baseRefName ?? "<unknown>"} -> ${current.baseRefName ?? "<unknown>"}`);
  }
  const previousState = previous?.mergeableState?.toUpperCase();
  const currentState = current.mergeableState?.toUpperCase();
  const previousNeedsRebase = previousState === "BEHIND" || previousState === "DIRTY";
  const currentNeedsRebase = currentState === "BEHIND" || currentState === "DIRTY";
  if (currentNeedsRebase && previousState !== currentState) {
    details.push(`state -> ${currentState}`);
  } else if (
    previous &&
    previousNeedsRebase &&
    currentState !== undefined &&
    currentState !== "UNKNOWN" &&
    previousState !== currentState
  ) {
    details.push(`state -> ${currentState}`);
  }
  return details.length > 0 ? [`mergeability: ${details.join(", ")}`] : [];
}

function threadDetails(previous: PullRequestSnapshot, current: PullRequestSnapshot): string[] {
  const previousById = new Map(previous.threads.map((thread) => [thread.id, thread]));
  return current.threads.flatMap((thread) => {
    const prior = previousById.get(thread.id);
    if (!prior || prior.isResolved === thread.isResolved) return [];
    return [`thread ${thread.id}: ${thread.isResolved ? "resolved" : "reopened"}`];
  });
}

const REACTION_DISPLAY_NAMES: Record<string, string> = {
  "+1": "THUMBS_UP",
  "-1": "THUMBS_DOWN",
  confused: "CONFUSED",
  eyes: "EYES",
  heart: "HEART",
  hooray: "HOORAY",
  laugh: "LAUGH",
  rocket: "ROCKET",
};

function reactionContentName(content: string): string {
  return REACTION_DISPLAY_NAMES[content] ?? content.toUpperCase();
}

/** Identity of whatever a reaction is attached to, so a line never needs the snapshot again. */
export interface ReactionTarget {
  /** Target type plus its ID where GitHub has one, for example `comment #123`. */
  label: string;
  author: string | null;
  url?: string;
}

export interface AttributedReaction {
  reaction: PullRequestReaction;
  target: ReactionTarget;
}

function commentReactionTarget(comment: PullRequestComment, kind: "comment" | "feedback"): ReactionTarget {
  return { label: `${kind} #${comment.id}`, author: comment.author, url: comment.htmlUrl };
}

interface ReactionGroup {
  target: ReactionTarget;
  /** Undefined is unknown: never read, or read and failed. It is not "no reactions". */
  reactions: PullRequestReaction[] | undefined;
}

/** Every reaction target the snapshot knows, including the ones carrying no reactions. */
function reactionGroups(snapshot: PullRequestSnapshot): Map<string, ReactionGroup> {
  const groups = new Map<string, ReactionGroup>();
  const pullRequest: ReactionTarget = {
    label: `PR #${snapshot.number}`,
    author: snapshot.author,
    url: snapshot.url,
  };
  groups.set(pullRequest.label, { target: pullRequest, reactions: snapshot.bodyReactionDetails });
  for (const comment of snapshot.comments) {
    const target = commentReactionTarget(comment, "comment");
    groups.set(target.label, { target, reactions: comment.reactionDetails });
  }
  for (const comment of snapshot.reviewComments) {
    const target = commentReactionTarget(comment, "feedback");
    groups.set(target.label, { target, reactions: comment.reactionDetails });
  }
  return groups;
}

export function snapshotReactions(snapshot: PullRequestSnapshot): AttributedReaction[] {
  return [...reactionGroups(snapshot).values()]
    .flatMap(({ target, reactions }) => (reactions ?? []).map((reaction) => ({ reaction, target })));
}

function reactionTargetDescription(target: ReactionTarget): string {
  return `${target.label} @${target.author ?? "unknown"}${target.url ? ` ${target.url}` : ""}`;
}

/** Current-state line: who reacted with what, and to whose content. */
export function reactionStateLine(entry: AttributedReaction): string {
  return `reaction @${entry.reaction.author ?? "unknown"} ${reactionContentName(entry.reaction.content)} on ${reactionTargetDescription(entry.target)}`;
}

function reactionChangeLine(
  action: "created" | "deleted",
  reaction: PullRequestReaction,
  target: ReactionTarget,
): string {
  const preposition = action === "created" ? "on" : "from";
  return `reaction ${action}: @${reaction.author ?? "unknown"} ${reactionContentName(reaction.content)} ${preposition} ${reactionTargetDescription(target)}`;
}

/**
 * Whether two records of the same reaction ID describe the same reaction. Numeric actor IDs
 * decide it whenever both sides have one, because logins are renameable. A record persisted
 * before actor IDs were stored has none, so enriching it with a freshly read copy of the
 * same reaction must not look like a different actor: those fall back to the login, compared
 * normalized, which is also all a recased login needs.
 */
function sameReaction(prior: PullRequestReaction, next: PullRequestReaction): boolean {
  if (prior.content !== next.content) return false;
  if (prior.authorId != null && next.authorId != null) return prior.authorId === next.authorId;
  return normalizedLogin(prior.author) === normalizedLogin(next.author);
}

function reactionTargetDetails(
  previous: PullRequestReaction[],
  current: PullRequestReaction[],
  target: ReactionTarget,
): string[] {
  const previousById = new Map(previous.map((reaction) => [reaction.id, reaction]));
  const currentById = new Map(current.map((reaction) => [reaction.id, reaction]));
  return [
    ...current
      .filter((reaction) => {
        const prior = previousById.get(reaction.id);
        return !prior || !sameReaction(prior, reaction);
      })
      .map((reaction) => reactionChangeLine("created", reaction, target)),
    ...previous
      .filter((reaction) => {
        const next = currentById.get(reaction.id);
        return !next || !sameReaction(reaction, next);
      })
      .map((reaction) => reactionChangeLine("deleted", reaction, target)),
  ];
}

/**
 * Within an ongoing watch every reaction the current snapshot carries is news, including
 * the ones on a target this refresh reveals for the first time. Only the initial
 * reconciliation suppresses reaction history, and it never reaches here: `monitorEventDetails`
 * routes a null predecessor to `monitorReconciliationDetails`. A target that disappeared is
 * reported by its own deletion line, so its reactions are not repeated here.
 *
 * A target whose previous reactions are unknown - a snapshot persisted before individual
 * reactions existed, or a read that failed - reports nothing on the refresh that first learns
 * them: those reactions are a baseline, not activity. It is diffed normally from then on.
 */
function reactionDetails(previous: PullRequestSnapshot, current: PullRequestSnapshot): string[] {
  const previousGroups = reactionGroups(previous);
  const lines: string[] = [];
  for (const [label, group] of reactionGroups(current)) {
    if (group.reactions === undefined) continue;
    const prior = previousGroups.get(label);
    if (prior && prior.reactions === undefined) continue;
    lines.push(...reactionTargetDetails(prior?.reactions ?? [], group.reactions, group.target));
  }
  return lines;
}

function activeReviewComments(snapshot: PullRequestSnapshot): PullRequestComment[] {
  if (snapshot.threads.length === 0) return snapshot.reviewComments;
  const knownThreadCommentIds = new Set(
    snapshot.threads.flatMap((thread) => thread.commentIds),
  );
  const unresolvedCommentIds = new Set(
    snapshot.threads
      .filter((thread) => !thread.isResolved)
      .flatMap((thread) => thread.commentIds),
  );
  return snapshot.reviewComments.filter((comment) =>
    unresolvedCommentIds.has(comment.id) || !knownThreadCommentIds.has(comment.id));
}

function activeCommentDetails(
  previous: PullRequestSnapshot,
  current: PullRequestSnapshot,
): string[] {
  const previousCount = activeReviewComments(previous).length;
  const currentCount = activeReviewComments(current).length;
  if (previousCount === currentCount) return [];
  const delta = currentCount - previousCount;
  return [`active comments: ${delta > 0 ? "+" : ""}${delta}, now ${currentCount}`];
}

function recordValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? value as Record<string, unknown> : null;
}

function stringProperty(value: Record<string, unknown> | null, key: string): string | null {
  const property = value?.[key];
  return typeof property === "string" && property.trim() ? property.trim() : null;
}

function deploymentDetails(
  event: Pick<WatchEvent, "githubEvent" | "action" | "payload"> | null,
): string[] {
  if (!event || (event.githubEvent !== "deployment" && event.githubEvent !== "deployment_status")) {
    return [];
  }
  const payload = recordValue(event.payload);
  const deployment = recordValue(payload?.deployment);
  const status = recordValue(payload?.deployment_status);
  const environment = stringProperty(status, "environment") ??
    stringProperty(deployment, "environment") ??
    "unknown";
  const state = stringProperty(status, "state") ?? event.action ?? "updated";
  const ref = stringProperty(deployment, "ref");
  const url = stringProperty(status, "environment_url") ?? stringProperty(status, "target_url");
  return [
    `deployment: ${environment}${ref ? ` (${ref})` : ""} -> ${state}${url ? ` ${url}` : ""}`,
  ];
}

export function monitorReconciliationDetails(snapshot: PullRequestSnapshot): string[] {
  const reviewComments = activeReviewComments(snapshot);
  return boundedDetails([
    ...mergeabilityDetails(null, snapshot),
    ...reconciliationCheckDetails(snapshot.checks),
    ...(reviewComments.length > 0 ? [`active comments: now ${reviewComments.length}`] : []),
    ...reviewComments.map((comment) => reviewCommentDetail(comment, snapshot)),
  ]);
}

export function monitorEventDetails(
  previous: PullRequestSnapshot | null,
  current: PullRequestSnapshot,
  event: Pick<WatchEvent, "githubEvent" | "action" | "payload"> | null = null,
): string[] {
  if (!previous) return monitorReconciliationDetails(current);
  const lines = [
    ...mergeabilityDetails(previous, current),
    ...checkDetails(previous.checks, current.checks),
    ...deploymentDetails(event),
    ...activeCommentDetails(previous, current),
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
    ...reactionDetails(previous, current),
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
