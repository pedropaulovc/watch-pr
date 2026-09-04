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

export interface PullRequestComment {
  id: number;
  author: string | null;
  body: string;
  createdAt: string | null;
  updatedAt: string | null;
  reactions: ReactionCounts;
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
  headSha: string | null;
  author: string | null;
  fetchedAt: string;
  bodyReactions: ReactionCounts;
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
}

export interface StoredWatchState {
  snapshot: PullRequestSnapshot | null;
  events: WatchEvent[];
}

export function sessionStorageKey(token: string): string {
  return `session:${token}`;
}

export function watchStorageKey(userId: number, repository: string, number: number): string {
  return `watch:${userId}:${repository}:${number}`;
}
