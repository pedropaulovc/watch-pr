export interface GithubUser {
  login: string;
  id: number;
  name: string | null;
  avatarUrl: string | null;
  htmlUrl: string;
}

export interface SessionRecord {
  githubAccessToken: string;
  githubRefreshToken?: string;
  githubTokenExpiresAt?: number;
  githubRefreshTokenExpiresAt?: number;
  user: GithubUser;
  createdAt: number;
  expiresAt: number;
  watches: string[];
  subscriptions?: string[];
  watchStorageVersion?: 1;
}

export type MonitorTerminalState = "watching" | "merged" | "closed";

export interface MonitorCapabilityRecord {
  sessionToken: string;
  userId: number;
  repository: string;
  pullRequestNumber: number;
  createdAt: number;
  expiresAt: number;
}

export interface PrMonitorRegistration {
  monitorUrl: string;
  cursor: string | null;
  terminalState: MonitorTerminalState;
}

export interface PrMonitorEvent {
  id: string;
  repository: string;
  pullRequestNumber: number;
  githubEvent: string;
  action: string | null;
  receivedAt: string;
  changes: string[];
  details: string[];
  terminalState: MonitorTerminalState;
}
export interface OAuthClientRecord {
  clientId: string;
  redirectUris: string[];
  createdAt: number;
}

export interface OAuthRequestRecord {
  clientId: string;
  redirectUri: string;
  clientState: string;
  codeChallenge: string;
  codeChallengeMethod: "S256";
  createdAt: number;
}

export interface OAuthCodeRecord extends OAuthRequestRecord {
  githubAccessToken: string;
  githubRefreshToken?: string;
  githubTokenExpiresAt?: number;
  githubRefreshTokenExpiresAt?: number;
  user: GithubUser;
}

export interface ReactionCounts {
  "+1"?: number;
  "-1"?: number;
  confused?: number;
  eyes?: number;
  heart?: number;
  hooray?: number;
  laugh?: number;
  rocket?: number;
  total_count?: number;
  [name: string]: number | undefined;
}

/**
 * One individual GitHub reaction. The stable `id` lets a refresh tell an added reaction
 * from a removed one without relying on aggregate counts, which cannot attribute either.
 */
export interface PullRequestReaction {
  id: number;
  /** GitHub reaction content key, for example `+1` or `heart`. */
  content: string;
  /** Display login at read time; renameable, so never an identity. */
  author: string | null;
  /** Stable GitHub user ID of the actor, which a rename or a case change does not move. */
  authorId: number | null;
  createdAt: string | null;
}

export interface ReactionReadProgress {
  records: PullRequestReaction[];
  nextUrl: string;
}

/**
 * What a refresh is asking the transactional merge to do with a target's reaction knowledge
 * while it is in flight. `borrowed` is reuse without a read: the summary counts had not
 * moved, so the previous snapshot's details were carried over unverified. `invalidated` is
 * the opposite transition: a read that ran to completion and returned records its own counts
 * contradict, which proves the pages behind it - including any prefix inherited from an
 * earlier refresh - cannot be finished, so the committed details and cursor have to be
 * removed rather than resumed forever. It is never set by a transport or HTTP failure, which
 * says nothing about the pages already collected. Absence is the resolved form the hub
 * persists - details a read produced, or none at all - because the merge settles every
 * borrowed and every invalidated target against the state its write lands on.
 */
export type ReactionDetailsState = "borrowed" | "invalidated";

export interface PullRequestComment {
  id: number;
  author: string | null;
  body: string;
  createdAt: string | null;
  updatedAt: string | null;
  reactions: ReactionCounts;
  /**
   * When the response carrying `reactions` arrived. Aggregate counts and individual details
   * come from different requests, so they age separately: a refresh can hold the newest
   * counts behind the oldest details, which is exactly the case a merge or a closure has to
   * settle. Absent on targets persisted before aggregate observation times were recorded.
   */
  reactionsObservedAt?: string;
  /** Undefined is unknown, not empty: persisted before individual reactions, or unread. */
  reactionDetails?: PullRequestReaction[];
  /** Provenance of `reactionDetails`; absent once the transactional merge has resolved it. */
  reactionDetailsState?: ReactionDetailsState;
  /**
   * When the read behind this target's reaction knowledge last returned: the request that
   * completed `reactionDetails`, or the last page behind `reactionProgress`. Two refreshes
   * overlap target by target, so the snapshot that commits second routinely carries the
   * older read of any one target and its `fetchedAt` cannot order them; this can. A borrowed
   * copy keeps the time of the read it descends from, never the time it was reused. Absent
   * on targets persisted before per-target read times, which lose to any timestamped read.
   */
  reactionDetailsReadAt?: string;
  /** Partial pages retained when one refresh exhausts its reaction request budget. */
  reactionProgress?: ReactionReadProgress;
  path?: string;
  line?: number | null;
  startLine?: number | null;
  diffHunk?: string;
  inReplyToId?: number | null;
  htmlUrl?: string;
}

export interface PullRequestReview {
  id: number;
  author: string | null;
  state: string;
  body: string;
  submittedAt: string | null;
  htmlUrl?: string;
}

export interface PullRequestCheck {
  id: number;
  name: string;
  status: string | null;
  conclusion: string | null;
  completedAt: string | null;
  startedAt: string | null;
  url: string | null;
  kind: "check_run" | "commit_status";
}

export interface PullRequestThread {
  id: string;
  isResolved: boolean;
  commentIds: number[];
}

export interface PullRequestSnapshot {
  repository: string;
  number: number;
  url: string;
  title: string;
  body: string;
  state: string;
  draft: boolean;
  merged: boolean;
  mergedAt: string | null;
  mergeable: boolean | null;
  mergeableState: string | null;
  baseRefName: string | null;
  headRefName: string | null;
  headRepository: string | null;
  headSha: string | null;
  author: string | null;
  fetchedAt: string;
  bodyReactions: ReactionCounts;
  /** Body counterpart of `PullRequestComment.reactionsObservedAt`. */
  bodyReactionsObservedAt?: string;
  /** Undefined is unknown, not empty: persisted before individual reactions, or unread. */
  bodyReactionDetails?: PullRequestReaction[];
  /** Body counterpart of `PullRequestComment.reactionDetailsState`. */
  bodyReactionDetailsState?: ReactionDetailsState;
  /** Body counterpart of `PullRequestComment.reactionDetailsReadAt`. */
  bodyReactionDetailsReadAt?: string;
  /** Partial pages retained when one refresh exhausts its reaction request budget. */
  bodyReactionProgress?: ReactionReadProgress;
  comments: PullRequestComment[];
  reviews: PullRequestReview[];
  reviewComments: PullRequestComment[];
  checks: PullRequestCheck[];
  threads: PullRequestThread[];
}

export interface WatchEvent {
  id: string;
  deliveryId: string;
  receivedAt: string;
  githubEvent: string;
  action: string | null;
  repository: string;
  pullRequestNumber: number;
  resourceUri: string;
  payload: unknown;
  snapshot: PullRequestSnapshot | null;
  changes: string[];
  /**
   * Size-bounded, event-specific lines that let monitor clients act without fetching
   * the complete snapshot. Optional for persisted events written before this field
   * existed.
   */
  details?: string[];
}

export interface StoredWatchState {
  snapshot: PullRequestSnapshot | null;
  events: WatchEvent[];
}

/**
 * Bounded event metadata. Payloads, snapshots, and monitor details stay in immutable
 * event records so the frequently rewritten sidecar index remains compact.
 */
export type WatchEventSummary = Omit<WatchEvent, "payload" | "snapshot" | "details">;

export interface WatchEventMetadata extends WatchEventSummary {
  /** Terminal state implied by the snapshot this event carries in a full read. */
  terminalState: MonitorTerminalState;
}

export interface WatchStateMetadata {
  snapshot: PullRequestSnapshot | null;
  events: WatchEventMetadata[];
}

export function sessionStorageKey(token: string): string {
  return `session:${token}`;
}

export function watchStorageKey(userId: number, repository: string, number: number): string {
  return `watch:${userId}:${repository}:${number}`;
}
export function legacyWatchStorageKey(repository: string, number: number): string {
  return `watch:${repository}:${number}`;
}

export function watchSidecarIndexKey(storageKey: string): string {
  return `${storageKey}:sidecar`;
}

export function watchSidecarSnapshotKey(storageKey: string, sequence: number): string {
  return `${storageKey}:sidecar:snapshot:${sequence}`;
}

export function watchSidecarEventKey(storageKey: string, sequence: number): string {
  return `${storageKey}:sidecar:event:${sequence}`;
}

export function watchSidecarCleanupKey(storageKey: string, sequence: number): string {
  return `${storageKey}:sidecar:cleanup:${sequence}`;
}

export function monitorCapabilityStorageKey(capability: string): string {
  return `monitor:${capability}`;
}

export function monitorScopeStorageKey(sessionToken: string, repository: string, number: number): string {
  return `monitor-scope:${sessionToken}:${repository}:${number}`;
}
