import { recordValue, sameReactionCounts } from "./events";
import {
  awaitingApprovalSuites,
  coherentRequestKnowledge,
  latestCommitStatuses,
  normalizeCheckRun,
  normalizeComment,
  normalizeCommitStatus,
  normalizeReview,
  numberValue,
  pullFields,
  reactionTotal,
  stringValue,
  type GithubRecord,
} from "./github";
import type { PullRequestCheck, PullRequestComment, PullRequestSnapshot } from "./types";

/**
 * What one delivery did to a stored snapshot.
 *
 * - `applied`: the payload changed the snapshot, with no GitHub request.
 * - `applied_mergeability_unknown`: applied, and the head or base moved while the payload
 *   carried no mergeability. GitHub computes it asynchronously, so the snapshot says unknown
 *   and the next conditional read, which no longer holds the pull validator, learns it.
 * - `refetch`: the payload cannot be applied - no reducer for the event, an incomplete
 *   payload, or a thread the snapshot does not know - so the snapshot is read from GitHub.
 * - `ignored`: nothing to change - an out-of-order delivery older than what is stored, checks
 *   for another head revision, or a payload the snapshot already reflects.
 */
export type WebhookOutcome = "applied" | "applied_mergeability_unknown" | "refetch" | "ignored";

export interface WebhookReduction {
  snapshot: PullRequestSnapshot;
  outcome: WebhookOutcome;
}

type Reducer = (snapshot: PullRequestSnapshot, payload: GithubRecord, receivedAt: string) => WebhookReduction;

/**
 * Whether an incoming item's timestamp is older than the stored one's. An item whose stored
 * copy has a time and whose incoming copy has none - a check run that is no longer completed,
 * a review that is no longer submitted - is older too.
 */
function predates(incoming: string | null | undefined, stored: string | null | undefined): boolean {
  const storedTime = Date.parse(stored ?? "");
  if (!Number.isFinite(storedTime)) return false;
  const incomingTime = Date.parse(incoming ?? "");
  return !Number.isFinite(incomingTime) || incomingTime < storedTime;
}

/** Replaces the item with the same ID, or inserts it in ID order, which is the REST list order. */
function upsertById<T extends { id: number }>(items: readonly T[], item: T): T[] {
  const index = items.findIndex((candidate) => candidate.id === item.id);
  if (index >= 0) return items.map((candidate, position) => position === index ? item : candidate);
  const after = items.findIndex((candidate) => candidate.id > item.id);
  return after < 0 ? [...items, item] : [...items.slice(0, after), item, ...items.slice(after)];
}

function upsertCheck(checks: readonly PullRequestCheck[], check: PullRequestCheck): PullRequestCheck[] {
  const index = checks.findIndex((candidate) => candidate.kind === check.kind && candidate.id === check.id);
  if (index < 0) return [...checks, check];
  return checks.map((candidate, position) => position === index ? check : candidate);
}

function reducePullRequest(snapshot: PullRequestSnapshot, payload: GithubRecord): WebhookReduction {
  const pull = recordValue(payload.pull_request);
  const head = recordValue(pull?.head);
  const updatedAt = pull && stringValue(pull, "updated_at");
  if (!pull || !head || !stringValue(head, "sha") || !stringValue(pull, "state") || !updatedAt) {
    return { snapshot, outcome: "refetch" };
  }
  if (predates(updatedAt, snapshot.updatedAt)) return { snapshot, outcome: "ignored" };
  const fields = pullFields(pull, snapshot.repository, snapshot.number);
  const headMoved = fields.headSha !== snapshot.headSha;
  const moved = headMoved || fields.baseRefName !== snapshot.baseRefName;
  // Deliveries rarely carry computed mergeability. Without it the stored values stand, unless
  // a new head or base made GitHub start computing them again.
  const mergeability = fields.mergeable !== null
    ? {}
    : moved
      ? { mergeableState: "unknown" }
      : { mergeable: snapshot.mergeable, mergeableState: snapshot.mergeableState };
  return {
    snapshot: {
      ...snapshot,
      ...fields,
      ...mergeability,
      // Stored checks describe the old head; the new head's arrive in their own deliveries.
      checks: headMoved ? [] : snapshot.checks,
    },
    outcome: fields.mergeable === null && moved ? "applied_mergeability_unknown" : "applied",
  };
}

function reduceReview(snapshot: PullRequestSnapshot, payload: GithubRecord): WebhookReduction {
  const record = recordValue(payload.review);
  if (!record || numberValue(record, "id") <= 0) return { snapshot, outcome: "refetch" };
  const review = normalizeReview(record);
  const stored = snapshot.reviews.find((candidate) => candidate.id === review.id);
  // A dismissal keeps the submission time, and nothing undoes it.
  if (stored && (predates(review.submittedAt, stored.submittedAt) || stored.state === "DISMISSED" && review.state !== "DISMISSED")) {
    return { snapshot, outcome: "ignored" };
  }
  return { snapshot: { ...snapshot, reviews: upsertById(snapshot.reviews, review) }, outcome: "applied" };
}

/**
 * Comment content comes from the payload. Reaction knowledge stays as stored: the payload's
 * summary moves the aggregate counts only, so details that no longer add up to them are read
 * by the next refresh and their difference is announced as reaction activity.
 */
function reduceComment(field: "comments" | "reviewComments"): Reducer {
  return (snapshot, payload, receivedAt) => {
    const record = recordValue(payload.comment);
    if (!record || numberValue(record, "id") <= 0) return { snapshot, outcome: "refetch" };
    const incoming = normalizeComment(record);
    const comments = snapshot[field];
    // Deletions win: a deleted comment is removed whatever its timestamps say.
    if (payload.action === "deleted") {
      return { snapshot: { ...snapshot, [field]: comments.filter((comment) => comment.id !== incoming.id) }, outcome: "applied" };
    }
    const summary = recordValue(record.reactions) ? incoming.reactions : null;
    const stored = comments.find((comment) => comment.id === incoming.id);
    if (stored && predates(incoming.updatedAt, stored.updatedAt)) return { snapshot, outcome: "ignored" };
    let comment: PullRequestComment;
    if (stored) {
      const countsMoved = summary !== null && !sameReactionCounts(stored.reactions, summary);
      comment = {
        ...stored,
        ...incoming,
        reactions: countsMoved ? summary : stored.reactions,
        ...(countsMoved ? { reactionsObservedAt: receivedAt } : {}),
      };
    } else {
      // A summary of zero is authoritative for "no reactions", exactly as on a list read.
      comment = {
        ...incoming,
        ...(summary ? { reactionsObservedAt: receivedAt } : {}),
        ...(summary && reactionTotal(summary) === 0 ? { reactionDetails: [], reactionDetailsReadAt: receivedAt } : {}),
      };
    }
    return { snapshot: { ...snapshot, [field]: upsertById(comments, comment) }, outcome: "applied" };
  };
}

function reduceThread(snapshot: PullRequestSnapshot, payload: GithubRecord): WebhookReduction {
  const thread = recordValue(payload.thread);
  if (!thread || (payload.action !== "resolved" && payload.action !== "unresolved")) {
    return { snapshot, outcome: "refetch" };
  }
  const nodeId = stringValue(thread, "node_id");
  const commentIds = new Set((Array.isArray(thread.comments) ? thread.comments : []).flatMap((comment) => {
    const record = recordValue(comment);
    return record ? [numberValue(record, "id")] : [];
  }));
  const index = snapshot.threads.findIndex((candidate) =>
    candidate.id === nodeId || candidate.commentIds.some((id) => commentIds.has(id)));
  if (index < 0) return { snapshot, outcome: "refetch" };
  const isResolved = payload.action === "resolved";
  return {
    snapshot: {
      ...snapshot,
      threads: snapshot.threads.map((candidate, position) => position === index ? { ...candidate, isResolved } : candidate),
    },
    outcome: "applied",
  };
}

function reduceCheckRun(snapshot: PullRequestSnapshot, payload: GithubRecord): WebhookReduction {
  const run = recordValue(payload.check_run);
  const sha = run && stringValue(run, "head_sha");
  if (!run || !sha) return { snapshot, outcome: "refetch" };
  if (sha !== snapshot.headSha) return { snapshot, outcome: "ignored" };
  const check = normalizeCheckRun(run);
  const stored = snapshot.checks.find((candidate) => candidate.kind === "check_run" && candidate.id === check.id);
  if (stored && predates(check.completedAt, stored.completedAt)) return { snapshot, outcome: "ignored" };
  // A suite that has a run is represented by it, so its awaiting-approval placeholder goes.
  const suite = recordValue(run.check_suite);
  const suiteId = suite ? numberValue(suite, "id") : 0;
  const checks = snapshot.checks.filter((candidate) => candidate.kind !== "check_suite" || candidate.id !== suiteId);
  return { snapshot: { ...snapshot, checks: upsertCheck(checks, check) }, outcome: "applied" };
}

function reduceCheckSuite(snapshot: PullRequestSnapshot, payload: GithubRecord): WebhookReduction {
  const suite = recordValue(payload.check_suite);
  const sha = suite && stringValue(suite, "head_sha");
  if (!suite || !sha || typeof suite.latest_check_runs_count !== "number") return { snapshot, outcome: "refetch" };
  if (sha !== snapshot.headSha) return { snapshot, outcome: "ignored" };
  const id = numberValue(suite, "id");
  const stored = snapshot.checks.find((candidate) => candidate.kind === "check_suite" && candidate.id === id);
  const [placeholder] = awaitingApprovalSuites([suite], snapshot.url);
  if (!placeholder) {
    return { snapshot: { ...snapshot, checks: snapshot.checks.filter((candidate) => candidate !== stored) }, outcome: "applied" };
  }
  if (stored && predates(placeholder.completedAt, stored.completedAt)) return { snapshot, outcome: "ignored" };
  return { snapshot: { ...snapshot, checks: upsertCheck(snapshot.checks, placeholder) }, outcome: "applied" };
}

function reduceStatus(snapshot: PullRequestSnapshot, payload: GithubRecord): WebhookReduction {
  const sha = stringValue(payload, "sha");
  if (!sha) return { snapshot, outcome: "refetch" };
  if (sha !== snapshot.headSha) return { snapshot, outcome: "ignored" };
  const incoming = normalizeCommitStatus(payload, 0);
  const context = incoming.name.toLowerCase();
  const stored = snapshot.checks.find((candidate) => candidate.kind === "commit_status" && candidate.name.toLowerCase() === context);
  // The same newest-per-context rule a statuses read applies, so an older delivery loses.
  const [latest] = latestCommitStatuses(stored ? [stored, incoming] : [incoming]);
  if (latest === stored) return { snapshot, outcome: "ignored" };
  const checks = stored
    ? snapshot.checks.map((candidate) => candidate === stored ? latest : candidate)
    : [...snapshot.checks, latest];
  return { snapshot: { ...snapshot, checks }, outcome: "applied" };
}

const REDUCERS: Record<string, Reducer> = {
  pull_request: reducePullRequest,
  pull_request_review: reduceReview,
  pull_request_review_comment: reduceComment("reviewComments"),
  pull_request_review_thread: reduceThread,
  issue_comment: reduceComment("comments"),
  check_run: reduceCheckRun,
  check_suite: reduceCheckSuite,
  status: reduceStatus,
};

/**
 * Applies one webhook delivery to a stored snapshot without reading GitHub. Webhook payload
 * objects have the REST shapes, so the same normalizers build them. `receivedAt` becomes the
 * snapshot's `fetchedAt`, which records the last stored change.
 *
 * Every REST slice the delivery changed loses its validator: the stored ETag no longer
 * describes the stored content, so the next conditional read of that slice returns 200 and
 * reconciles it. Untouched slices keep theirs. `threadsReadAt` is kept, because a thread the
 * delivery resolved is newer than the last read, not older.
 */
export function applyWebhook(
  snapshot: PullRequestSnapshot,
  githubEvent: string,
  payload: GithubRecord,
  receivedAt: string,
): WebhookReduction {
  if (!Object.hasOwn(REDUCERS, githubEvent)) return { snapshot, outcome: "refetch" };
  const reduction = REDUCERS[githubEvent](snapshot, payload, receivedAt);
  if (reduction.outcome === "refetch" || reduction.outcome === "ignored") return reduction;
  if (JSON.stringify(reduction.snapshot) === JSON.stringify(snapshot)) return { snapshot, outcome: "ignored" };
  const next: PullRequestSnapshot = { ...reduction.snapshot, fetchedAt: receivedAt };
  const { githubValidators } = coherentRequestKnowledge(next, [snapshot]);
  if (githubValidators) next.githubValidators = githubValidators;
  else delete next.githubValidators;
  return { snapshot: next, outcome: reduction.outcome };
}
