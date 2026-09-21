import type {
  MonitorTerminalState,
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
const MAX_MONITOR_CHECK_LINES = 8;
const ANSI_ESCAPE_SEQUENCE_RE = /\u001b(?:\][^\u0007]*(?:\u0007|\u001b\\)|\[[0-?]*[ -/]*[@-~])/gu;

type MonitorDetail = {
  value: string;
  body?: boolean;
  omittedWeight?: number;
};

function fullBodyDetail(value: string): MonitorDetail {
  return { value, body: true };
}

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

/**
 * Body records are deliberately not part of the bounded budget: clients need the complete
 * multiline text, while a large body must not hide a later check, state, or deletion record.
 * Non-body records retain the existing line and aggregate limits.
 */
function boundedDetails(lines: readonly (string | MonitorDetail)[]): string[] {
  const candidates: MonitorDetail[] = [];
  const seenDetails = new Set<string>();
  for (const line of lines) {
    const candidate: MonitorDetail = typeof line === "string" ? { value: line } : line;
    if (candidate.body) {
      if (!candidate.value || seenDetails.has(candidate.value)) continue;
      seenDetails.add(candidate.value);
      candidates.push(candidate);
      continue;
    }
    const sanitized = sanitizeDetail(candidate.value);
    if (!sanitized) continue;
    const value = truncate(sanitized, MAX_MONITOR_DETAIL_LENGTH);
    if (seenDetails.has(value)) continue;
    seenDetails.add(value);
    candidates.push({ ...candidate, value });
  }

  const details: MonitorDetail[] = [];
  let nonBodyLength = 0;
  let nonBodyCount = 0;
  let omitted = 0;
  for (const candidate of candidates) {
    if (candidate.body) {
      details.push(candidate);
      continue;
    }
    if (
      nonBodyCount >= MAX_MONITOR_DETAIL_LINES ||
      nonBodyLength + candidate.value.length > MAX_MONITOR_DETAILS_LENGTH
    ) {
      omitted += candidate.omittedWeight ?? 1;
      continue;
    }
    details.push(candidate);
    nonBodyCount += 1;
    nonBodyLength += candidate.value.length;
  }

  if (omitted > 0) {
    let marker = `+${omitted} more changes`;
    const removeLastNonBody = (): boolean => {
      for (let index = details.length - 1; index >= 0; index -= 1) {
        if (details[index].body) continue;
        const [removed] = details.splice(index, 1);
        nonBodyLength -= removed.value.length;
        nonBodyCount -= 1;
        omitted += removed.omittedWeight ?? 1;
        return true;
      }
      return false;
    };
    while (
      (nonBodyCount >= MAX_MONITOR_DETAIL_LINES ||
        nonBodyLength + marker.length > MAX_MONITOR_DETAILS_LENGTH) &&
      removeLastNonBody()
    ) {
      marker = `+${omitted} more changes`;
    }
    if (
      nonBodyCount < MAX_MONITOR_DETAIL_LINES &&
      nonBodyLength + marker.length <= MAX_MONITOR_DETAILS_LENGTH
    ) {
      details.push({ value: marker });
    }
  }
  return details.map((detail) => detail.value);
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
 * Comment content, without the reaction bookkeeping that rides along on the same record:
 * details are compared as reactions so an unknown-to-known reaction read is not read as an
 * edit, and their provenance and read time describe the read rather than the comment. The
 * aggregate observation time goes the same way - it moves on every refresh that reads the
 * comment list, while the counts beside it decide whether anything actually changed.
 */
const REACTION_BOOKKEEPING = new Set([
  "reactionsObservedAt",
  "reactionDetails",
  "reactionDetailsState",
  "reactionDetailsReadAt",
  "reactionProgress",
]);

function commentsKey(comments: PullRequestComment[]): string {
  return JSON.stringify(
    comments,
    (key, value: unknown) => REACTION_BOOKKEEPING.has(key) ? undefined : value,
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
 * True when this refresh changed what a stored snapshot knows about some reaction target
 * without having anything to announce: it learned details the stored snapshot lacked, got
 * further through a target's pages, or proved that the prefix the stored snapshot is holding
 * cannot be finished. None of those are `snapshotChanges` entries - they publish nothing and
 * report no activity - so this is the one case where a refresh has something worth storing
 * and no event to store it with. Without it the same unknown target would be re-read
 * forever, and an invalidated cursor would be inherited, fail coherence and be dropped again
 * on every single refresh, because only a write can remove it from the committed state.
 *
 * It is asked of the refresh's own snapshot, before the transactional merge settles and
 * consumes its in-flight markers, because those markers are how a refresh states a
 * transition it did not read its way to.
 */
export function reactionKnowledgeAdvanced(
  previous: PullRequestSnapshot,
  current: PullRequestSnapshot,
): boolean {
  const learned = (
    prior: ReactionKnowledge,
    next: ReactionKnowledge,
  ): boolean => {
    if (next.reactionDetailsState === "invalidated") {
      return prior.reactionDetails !== undefined || prior.reactionProgress !== undefined;
    }
    if (prior.reactionDetails === undefined && next.reactionDetails !== undefined) return true;
    if (
      prior.reactionDetails !== undefined ||
      next.reactionDetails !== undefined ||
      !next.reactionProgress
    ) return false;
    if (!prior.reactionProgress) return true;
    return next.reactionProgress.records.length > prior.reactionProgress.records.length ||
      next.reactionProgress.nextUrl !== prior.reactionProgress.nextUrl;
  };
  if (learned(
    {
      reactions: previous.bodyReactions,
      reactionDetails: previous.bodyReactionDetails,
      reactionProgress: previous.bodyReactionProgress,
    },
    {
      reactions: current.bodyReactions,
      reactionDetails: current.bodyReactionDetails,
      reactionDetailsState: current.bodyReactionDetailsState,
      reactionProgress: current.bodyReactionProgress,
    },
  )) return true;
  const learnedComment = (prior: PullRequestComment[], next: PullRequestComment[]): boolean => {
    const priorById = new Map(prior.map((comment) => [comment.id, comment] as const));
    return next.some((comment) => {
      const before = priorById.get(comment.id);
      return before !== undefined && learned(before, comment);
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
  /** When the response carrying `reactions` arrived; it ages apart from the details. */
  reactionsObservedAt?: string;
  reactionDetails?: PullRequestReaction[];
  reactionDetailsState?: ReactionDetailsState;
  reactionDetailsReadAt?: string;
  reactionProgress?: ReactionReadProgress;
}

/**
 * Whether `candidate` returned after `incumbent`, for two stamps of the same kind. A value
 * persisted before that kind of stamp existed carries none, and loses to any timestamped
 * one, because an observation whose age cannot be established must not outrank one whose
 * age can.
 */
function observedLater(candidate: string | undefined, incumbent: string | undefined): boolean {
  const candidateTime = Date.parse(candidate ?? "");
  if (!Number.isFinite(candidateTime)) return false;
  const incumbentTime = Date.parse(incumbent ?? "");
  return !Number.isFinite(incumbentTime) || candidateTime > incumbentTime;
}

/**
 * Whether `candidate`'s read of this target returned after `incumbent`'s. Overlapping
 * refreshes read one target at a time, so neither snapshot is wholly newer than the other
 * and `fetchedAt` cannot decide this: the refresh that commits second may well hold the
 * older read of this particular target.
 */
function readIsNewer(candidate: ReactionKnowledge, incumbent: ReactionKnowledge): boolean {
  return observedLater(candidate.reactionDetailsReadAt, incumbent.reactionDetailsReadAt);
}

/**
 * Resolves one target against the state the write lands on, returning undefined when `base`
 * already holds the best knowledge and needs no rewrite. Three rules decide it.
 *
 * Details `base` read itself stand, except where `basePublishes` and the committed state
 * holds a read of the same target that returned later. Two refreshes overlap, so the one
 * committing second can be carrying the older read of this target while carrying the newer
 * view of everything else; publishing that older read would overwrite details another
 * writer already committed and announce the difference as reaction activity that never
 * happened. A silent enrichment takes the opposite base and reports nothing, so there a
 * newer read is left for the refresh that can announce what it found.
 *
 * Details `base` only borrowed - reused unread because the summary counts had not moved -
 * are not a read at all. Anything the committed state read outranks them, and counts the
 * committed state disagrees with mean the borrow describes a reaction state this write never
 * observed, so while the watch continues the committed pair stands and the next refresh
 * reads the target again rather than the borrow overwriting it or passing as current.
 *
 * Between a cursor and complete details the later read wins. Pairing details with counts a
 * later read contradicts strands the target - the next refresh drops the mismatched
 * knowledge and restarts at page one, only to be overwritten again - so a cursor opened
 * against counts `source` does not share is the only route to the reactions those older
 * details predate.
 *
 * All three rules lean on a next refresh that a merge or closure never grants. Once `base`
 * is terminal, the counts it observed are the last word on that target unless the committed
 * state can show an aggregate observation of its own that arrived later - and that is an
 * ordering of the two count responses, not of the reads behind them, because the whole
 * difficulty is a snapshot holding the newest counts behind details it never re-read.
 * Taking back details committed against counts this snapshot has already left would restore
 * a reaction state the pull request is no longer in and hide the movement away from it -
 * a reaction added and removed again while the merge landed would end up stored as present
 * forever - and a cursor nothing will resume is no better. Read times do not enter into it:
 * a page request that returned after this snapshot's read can carry an aggregate observed
 * long before it, so ordering by read would hand the target back to the older counts. Where
 * `base` has nothing better of its own the terminal counts stand alone, unresolved, and the
 * event announces them as unattributed. Borrowed details take the same route: a borrow is
 * not a read, so it cannot buy the older counts authority they would not otherwise have.
 *
 * A target either side marks `invalidated` is settled before any of that. The read behind it
 * ran to completion and came back with records its own counts contradict, which condemns
 * every page it collected, the committed prefix it resumed from included: resuming that
 * cursor only reproduces the same contradiction, and dropping it in the fetched snapshot
 * alone leaves the durable copy for the next refresh to inherit. Only a read that returned
 * after the invalidation can still describe the target - and past a merge or closure not even
 * that, since the counts a terminal snapshot observed last are not given back. Otherwise the
 * target goes unknown against the later-observed counts, and the next refresh starts at page
 * one. The marker is consumed here in every case, exactly as a borrow is, so it never
 * reaches storage.
 */
function resolveReactionKnowledge(
  base: ReactionKnowledge,
  source: ReactionKnowledge | undefined,
  basePublishes: boolean,
  baseIsTerminal: boolean,
): ReactionKnowledge | undefined {
  const agrees = source !== undefined && sameReactionCounts(base.reactions, source.reactions);
  // Terminal disagreement: `base` saw these counts last, and nothing will look again.
  const terminalCountsStand = baseIsTerminal && !agrees && source !== undefined &&
    !observedLater(source.reactionsObservedAt, base.reactionsObservedAt);
  const invalidated = base.reactionDetailsState === "invalidated"
    ? base
    : source?.reactionDetailsState === "invalidated"
      ? source
      : undefined;
  if (invalidated !== undefined) {
    const other = invalidated === base ? source : base;
    if (
      !terminalCountsStand &&
      other?.reactionDetails !== undefined &&
      other.reactionDetailsState !== "borrowed" &&
      readIsNewer(other, invalidated)
    ) {
      return {
        reactions: other.reactions,
        reactionsObservedAt: other.reactionsObservedAt,
        reactionDetails: other.reactionDetails,
        reactionDetailsReadAt: other.reactionDetailsReadAt,
      };
    }
    const observed = other !== undefined &&
        observedLater(other.reactionsObservedAt, invalidated.reactionsObservedAt)
      ? other
      : invalidated;
    return { reactions: observed.reactions, reactionsObservedAt: observed.reactionsObservedAt };
  }
  if (base.reactionDetails !== undefined) {
    if (base.reactionDetailsState !== "borrowed") {
      const sourceCompleteSupersedes = source?.reactionDetails !== undefined &&
        source.reactionDetailsState !== "borrowed" &&
        readIsNewer(source, base);
      const sourceProgressSupersedes = source?.reactionProgress !== undefined &&
        !agrees &&
        readIsNewer(source, base);
      // Neither shape outranks counts a terminal snapshot observed later. A read - finished
      // or still paginating - that happened to return after this one does not make the older
      // aggregate behind it the newer word on the target, and past a merge or closure nothing
      // would ever correct the swap: the stale counts, and a cursor no refresh will resume,
      // would stay committed for good.
      if (
        basePublishes &&
        !terminalCountsStand &&
        (sourceCompleteSupersedes || sourceProgressSupersedes)
      ) {
        return {
          reactions: source.reactions,
          reactionsObservedAt: source.reactionsObservedAt,
          reactionDetails: source.reactionDetails,
          reactionDetailsReadAt: source.reactionDetailsReadAt,
          reactionProgress: source.reactionProgress,
        };
      }
      return undefined;
    }
    if (source !== undefined) {
      if (terminalCountsStand) return { reactions: base.reactions, reactionsObservedAt: base.reactionsObservedAt };
      const outranks = agrees
        ? source.reactionDetails !== undefined &&
          source.reactionDetailsState !== "borrowed" &&
          !readIsNewer(base, source)
        : source.reactionDetails !== undefined || source.reactionProgress !== undefined;
      if (outranks) {
        return {
          reactions: source.reactions,
          reactionsObservedAt: source.reactionsObservedAt,
          reactionDetails: source.reactionDetails,
          reactionDetailsReadAt: source.reactionDetailsReadAt,
          reactionProgress: source.reactionProgress,
        };
      }
      // Counts disagree and the committed state has nothing to keep: unread stays unknown,
      // so the next refresh reads the target instead of inheriting the borrow again.
      if (!agrees) return { reactions: base.reactions, reactionsObservedAt: base.reactionsObservedAt };
    }
    // Nothing committed contradicts the borrow: keep it as the baseline, still dated by the
    // read it descends from rather than by the refresh that reused it.
    return {
      reactions: base.reactions,
      reactionsObservedAt: base.reactionsObservedAt,
      reactionDetails: base.reactionDetails,
      reactionDetailsReadAt: base.reactionDetailsReadAt,
    };
  }
  if (source === undefined) return undefined;
  if (terminalCountsStand) {
    // Nothing will read this target again, so a cursor here is dead weight; dropping it
    // leaves the counts as the only claim the terminal snapshot makes about it.
    return base.reactionProgress === undefined
      ? undefined
      : { reactions: base.reactions, reactionsObservedAt: base.reactionsObservedAt };
  }
  const supersedes = agrees || readIsNewer(source, base);
  if (
    source.reactionDetails !== undefined &&
    (source.reactionDetailsState !== "borrowed" || agrees) &&
    (!base.reactionProgress || supersedes)
  ) {
    return {
      reactions: source.reactions,
      reactionsObservedAt: source.reactionsObservedAt,
      reactionDetails: source.reactionDetails,
      reactionDetailsReadAt: source.reactionDetailsReadAt,
    };
  }
  if (
    source.reactionProgress &&
    (!base.reactionProgress ||
      supersedes &&
        (!agrees || source.reactionProgress.records.length > base.reactionProgress.records.length))
  ) {
    return {
      reactions: source.reactions,
      reactionsObservedAt: source.reactionsObservedAt,
      reactionDetailsReadAt: source.reactionDetailsReadAt,
      reactionProgress: source.reactionProgress,
    };
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
 * either hide a real change or force a pointless re-read. `base` is returned untouched when
 * there was nothing to add. In-flight markers are resolved here and never persist: borrowed
 * details and invalidated cursors alike are settled by `resolveReactionKnowledge` against
 * the committed state, which always rewrites the target that carried one. The read time of
 * whichever knowledge wins travels with it, since it is what orders the next overlapping
 * pair of reads.
 *
 * Which of the two is publishing follows from the same ordering both callers already apply:
 * each commits the snapshot whose wave ended no earlier than the other's and bails out
 * otherwise, so an older `base` is the stored snapshot of a silent enrichment. That decides
 * only whose view is being announced, never which read of a target is newer - a wave's
 * `fetchedAt` is stamped after all of its reads, so it cannot order them.
 */
export function mergeReactionKnowledge(
  base: PullRequestSnapshot,
  source: PullRequestSnapshot,
): PullRequestSnapshot {
  const baseTime = Date.parse(base.fetchedAt);
  const sourceTime = Date.parse(source.fetchedAt);
  const basePublishes = !(Number.isFinite(baseTime) && Number.isFinite(sourceTime) && baseTime < sourceTime);
  const baseIsTerminal = terminalState(base) !== "watching";
  let merged = false;
  const body = resolveReactionKnowledge(
    {
      reactions: base.bodyReactions,
      reactionsObservedAt: base.bodyReactionsObservedAt,
      reactionDetails: base.bodyReactionDetails,
      reactionDetailsState: base.bodyReactionDetailsState,
      reactionDetailsReadAt: base.bodyReactionDetailsReadAt,
      reactionProgress: base.bodyReactionProgress,
    },
    {
      reactions: source.bodyReactions,
      reactionsObservedAt: source.bodyReactionsObservedAt,
      reactionDetails: source.bodyReactionDetails,
      reactionDetailsState: source.bodyReactionDetailsState,
      reactionDetailsReadAt: source.bodyReactionDetailsReadAt,
      reactionProgress: source.bodyReactionProgress,
    },
    basePublishes,
    baseIsTerminal,
  );
  if (body) merged = true;
  const fill = (targets: PullRequestComment[], known: PullRequestComment[]): PullRequestComment[] => {
    const knownById = new Map(known.map((comment) => [comment.id, comment] as const));
    return targets.map((comment) => {
      const resolved = resolveReactionKnowledge(
        comment,
        knownById.get(comment.id),
        basePublishes,
        baseIsTerminal,
      );
      if (!resolved) return comment;
      merged = true;
      return {
        ...comment,
        reactions: resolved.reactions,
        reactionsObservedAt: resolved.reactionsObservedAt,
        reactionDetails: resolved.reactionDetails,
        reactionDetailsState: undefined,
        reactionDetailsReadAt: resolved.reactionDetailsReadAt,
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
    bodyReactionsObservedAt: body ? body.reactionsObservedAt : base.bodyReactionsObservedAt,
    bodyReactionDetails: body ? body.reactionDetails : base.bodyReactionDetails,
    bodyReactionDetailsState: undefined,
    bodyReactionDetailsReadAt: body ? body.reactionDetailsReadAt : base.bodyReactionDetailsReadAt,
    bodyReactionProgress: body ? body.reactionProgress : base.bodyReactionProgress,
    comments,
    reviewComments,
  };
}

/** Logins are renameable and recasable, so they are only ever compared normalized. */
export function normalizedLogin(login: string | null | undefined): string {
  return (login ?? "").toLowerCase();
}

/**
 * The watch lifecycle a snapshot implies. A merged or closed pull request is terminal: no
 * later refresh reads it, so whatever a terminal snapshot leaves unresolved stays that way.
 */
export function terminalState(snapshot: PullRequestSnapshot | null): MonitorTerminalState {
  if (snapshot?.merged) return "merged";
  return snapshot?.state.toLowerCase() === "closed" ? "closed" : "watching";
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

function checkSummary(checks: PullRequestCheck[]): (string | MonitorDetail)[] {
  const details = [...checks]
    .sort((left, right) => left.name.localeCompare(right.name))
    .map((check) => {
      const bucket = checkBucket(check);
      const url = (bucket === "fail" || bucket === "cancel") && check.url ? ` ${check.url}` : "";
      return `checks: ${check.name} -> ${bucket}${url}`;
    });
  if (details.length <= MAX_MONITOR_CHECK_LINES) return details;
  const omittedWeight = details.length - MAX_MONITOR_CHECK_LINES;
  return [
    ...details.slice(0, MAX_MONITOR_CHECK_LINES),
    { value: `+${omittedWeight} more checks`, omittedWeight },
  ];
}

function checkDetails(
  previous: PullRequestCheck[],
  current: PullRequestCheck[],
): (string | MonitorDetail)[] {
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
    return checkSummary(current);
  }
  return selected.size > 0 ? checkSummary([...selected.values()]) : [];
}

function reconciliationCheckDetails(checks: PullRequestCheck[]): (string | MonitorDetail)[] {
  return checkSummary(checks);
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
  const prefix = `comment #${comment.id} @${comment.author ?? "unknown"}`;
  return comment.body.trim() ? `${prefix}: ${comment.body}` : prefix;
}

function reviewDetail(review: PullRequestReview): string {
  const prefix = `review #${review.id} @${review.author ?? "unknown"} ${review.state}`;
  return review.body.trim() ? `${prefix}: ${review.body}` : prefix;
}

function reviewCommentDetail(comment: PullRequestComment, snapshot: PullRequestSnapshot): string {
  const thread = snapshot.threads.find((candidate) => candidate.commentIds.includes(comment.id));
  const location = commentLocation(comment);
  const prefix = `feedback [${thread?.id ?? "-"}] #${comment.id}${location ? ` ${location}` : ""} @${comment.author ?? "unknown"}`;
  return comment.body.trim() ? `${prefix}: ${comment.body}` : prefix;
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
  /** The aggregate GitHub reports for this target, known whether the details are or not. */
  counts: ReactionCounts;
}

/** Every reaction target the snapshot knows, including the ones carrying no reactions. */
function reactionGroups(snapshot: PullRequestSnapshot): Map<string, ReactionGroup> {
  const groups = new Map<string, ReactionGroup>();
  const pullRequest: ReactionTarget = {
    label: `PR #${snapshot.number}`,
    author: snapshot.author,
    url: snapshot.url,
  };
  groups.set(pullRequest.label, {
    target: pullRequest,
    reactions: snapshot.bodyReactionDetails,
    counts: snapshot.bodyReactions,
  });
  for (const comment of snapshot.comments) {
    const target = commentReactionTarget(comment, "comment");
    groups.set(target.label, { target, reactions: comment.reactionDetails, counts: comment.reactions });
  }
  for (const comment of snapshot.reviewComments) {
    const target = commentReactionTarget(comment, "feedback");
    groups.set(target.label, { target, reactions: comment.reactionDetails, counts: comment.reactions });
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
 * Per-content movement between two aggregates, as `HEART 1 -> 3`, for the targets whose
 * individual reactions never became known. `total_count` is left out: it restates the rest.
 */
function reactionCountMovement(previous: ReactionCounts, current: ReactionCounts): string[] {
  const contents = [...new Set([...Object.keys(previous), ...Object.keys(current)])]
    .filter((content) => content !== "total_count")
    .sort();
  return contents
    .filter((content) => (previous[content] ?? 0) !== (current[content] ?? 0))
    .map((content) =>
      `${reactionContentName(content)} ${previous[content] ?? 0} -> ${current[content] ?? 0}`);
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
 *
 * An unknown target is normally silent too, because the next refresh reads it and reports
 * what it finds. A merge or a closure is the one event with no next refresh: the counts it
 * saw move are all anyone will ever get, so they are reported as an aggregate the event
 * states it could not attribute, rather than being dropped for want of the actors. A baseline
 * learned on that same event is reported the same way - knowing who holds the reactions now
 * says nothing about who added or removed the ones that moved, and no later refresh will say
 * it either. These lines are ordinary details, so `boundedDetails` caps them with everything
 * else.
 */
function reactionDetails(previous: PullRequestSnapshot, current: PullRequestSnapshot): string[] {
  const previousGroups = reactionGroups(previous);
  const unresolvedIsFinal = terminalState(current) !== "watching";
  const lines: string[] = [];
  for (const [label, group] of reactionGroups(current)) {
    const prior = previousGroups.get(label);
    if (group.reactions === undefined || (prior !== undefined && prior.reactions === undefined)) {
      if (!unresolvedIsFinal) continue;
      const movement = reactionCountMovement(prior?.counts ?? {}, group.counts);
      if (movement.length === 0) continue;
      lines.push(
        `reaction counts: ${movement.join(", ")} on ${reactionTargetDescription(group.target)} (attribution unavailable)`,
      );
      continue;
    }
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
    ...reviewComments.map((comment) => fullBodyDetail(reviewCommentDetail(comment, snapshot))),
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
    ...changedComments(previous.comments, current.comments)
      .map((comment) => fullBodyDetail(commentDetail(comment))),
    ...removedComments(previous.comments, current.comments)
      .map((comment) => `comment #${comment.id} deleted`),
    ...changedReviews(previous.reviews, current.reviews)
      .map((review) => fullBodyDetail(reviewDetail(review))),
    ...removedReviews(previous.reviews, current.reviews)
      .map((review) => `review #${review.id} deleted`),
    ...changedComments(previous.reviewComments, current.reviewComments)
      .map((comment) => fullBodyDetail(reviewCommentDetail(comment, current))),
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
