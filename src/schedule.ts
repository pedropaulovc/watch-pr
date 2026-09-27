import { normalizeRepository, recordValue } from "./events";
import type { InstallationCoverage } from "./github";
import type {
  CoverageEvidence,
  CoverageIndex,
  CoverageRecord,
  MonitorTerminalState,
  PollSchedule,
  PollScheduleEntry,
  WebhookCoverage,
} from "./types";

/** Cron ticks are about a minute apart; an entry due within this margin runs on this tick. */
export const POLL_TICK_TOLERANCE_MS = 30_000;
/** Webhook-covered watches are read this often to pick up reactions, drift, and missed deliveries. */
export const WEBHOOK_RECONCILE_MS = 60 * 60 * 1000;
/** A failed read is retried this soon, so a webhook-covered watch is not left stale for the hour. */
export const FAILED_POLL_RETRY_MS = 5 * 60 * 1000;
/** GitHub computes mergeability asynchronously after a push; the first check waits this long. */
export const MERGEABILITY_FOLLOW_UP_MS = 60_000;
/** Delay before the next check when attempt N still found mergeability unknown. The last attempt has none. */
const MERGEABILITY_RETRY_MS: Record<number, number> = { 1: 2 * 60_000, 2: 4 * 60_000 };

/**
 * A pending read that waits for GitHub to finish computing mergeability after a push. Follow-ups
 * live in the hub's memory, not in storage: each push would otherwise add a write, and one lost
 * to an eviction only defers the read to the hourly reconcile.
 */
export interface MergeabilityFollowUp {
  /** 1-based attempt the next read performs. */
  attempt: number;
  /** Receipt time of the delivery that asked for it, which identifies the follow-up. */
  requestedAt: number;
  /** When the next read is due; infinite while that read is running. */
  dueAt: number;
}

/**
 * What a refresh found, as the schedule needs it: a merged or closed pull request stops being
 * scheduled, and a follow-up keeps retrying while mergeability is still being computed.
 */
export type RefreshOutcome = "terminal" | "failed" | "mergeability_unknown" | "settled";

/**
 * The record that decides a repository's coverage: its own or its account's, whichever was
 * observed last. A repository record wins a tie because it is the more specific.
 */
export function coverageRecord(index: CoverageIndex, repository: string): CoverageRecord | null {
  const own = index.repositories[repository];
  const account = index.accounts[repository.slice(0, repository.indexOf("/"))];
  if (!own || !account) return own ?? account ?? null;
  return Date.parse(account.at) > Date.parse(own.at) ? account : own;
}

/** Unknown coverage is `polling`: a watch without deliveries must still be read every minute. */
export function repositoryCoverage(index: CoverageIndex, repository: string): WebhookCoverage {
  return coverageRecord(index, repository)?.coverage ?? "polling";
}

function repositoryNames(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    const fullName = recordValue(entry)?.full_name;
    if (typeof fullName !== "string") return [];
    try {
      return [normalizeRepository(fullName)];
    } catch {
      return [];
    }
  });
}

const INSTALLATION_ACTIONS: Record<string, { coverage: WebhookCoverage; evidence: CoverageEvidence }> = {
  created: { coverage: "webhook", evidence: "installation_created" },
  unsuspend: { coverage: "webhook", evidence: "installation_unsuspend" },
  deleted: { coverage: "polling", evidence: "installation_deleted" },
  suspend: { coverage: "polling", evidence: "installation_suspend" },
};

/**
 * An installation event about the whole account supersedes what earlier events said about
 * single repositories of it: an uninstall ends them all, an install on every repository
 * covers them all.
 */
function setAccountCoverage(index: CoverageIndex, account: string, record: CoverageRecord): void {
  index.accounts[account] = record;
  for (const repository of Object.keys(index.repositories)) {
    if (repository.startsWith(`${account}/`)) delete index.repositories[repository];
  }
}

/**
 * Applies an `installation` or `installation_repositories` delivery. An installation on every
 * repository of an account (`repository_selection: all`), and any removal of the whole
 * installation, is recorded for the account; a `selected` installation records its listed
 * repositories. Returns whether the index changed.
 */
export function applyInstallationWebhook(
  index: CoverageIndex,
  eventName: string,
  payload: Record<string, unknown>,
  at: string,
): boolean {
  const installation = recordValue(payload.installation);
  const login = recordValue(installation?.account)?.login;
  if (typeof login !== "string" || !login) return false;
  const account = login.toLowerCase();

  if (eventName === "installation") {
    const action = typeof payload.action === "string" ? payload.action : "";
    if (!Object.hasOwn(INSTALLATION_ACTIONS, action)) return false;
    const record: CoverageRecord = { ...INSTALLATION_ACTIONS[action], at };
    if (record.coverage === "polling" || installation?.repository_selection === "all") {
      setAccountCoverage(index, account, record);
      return true;
    }
    const repositories = repositoryNames(payload.repositories);
    for (const repository of repositories) index.repositories[repository] = record;
    return repositories.length > 0;
  }

  if (eventName !== "installation_repositories") return false;
  let changed = false;
  if (payload.repository_selection === "all") {
    setAccountCoverage(index, account, { coverage: "webhook", evidence: "installation_repositories_added", at });
    changed = true;
  } else {
    for (const repository of repositoryNames(payload.repositories_added)) {
      index.repositories[repository] = { coverage: "webhook", evidence: "installation_repositories_added", at };
      changed = true;
    }
  }
  for (const repository of repositoryNames(payload.repositories_removed)) {
    index.repositories[repository] = { coverage: "polling", evidence: "installation_repositories_removed", at };
    changed = true;
  }
  return changed;
}

/** A signature-valid delivery for a repository proves the app receives its webhooks. */
export function recordDeliveryCoverage(index: CoverageIndex, repository: string, at: string): boolean {
  if (repositoryCoverage(index, repository) === "webhook") return false;
  index.repositories[repository] = { coverage: "webhook", evidence: "delivery", at };
  return true;
}

const SEED_EVIDENCE: Partial<Record<CoverageEvidence, true>> = { user_installations: true, user_installations_failed: true };

/** Whether a watch should consult the user's installations: nothing a webhook said applies yet. */
export function needsInstallationLookup(index: CoverageIndex, repository: string): boolean {
  const record = coverageRecord(index, repository);
  return !record || SEED_EVIDENCE[record.evidence] === true;
}

/**
 * Seeds coverage from the user's installation lookup. Webhook evidence is authoritative and is
 * never overwritten. A failed lookup records `polling` only where nothing is known yet.
 */
export function applyInstallationLookup(
  index: CoverageIndex,
  repository: string,
  result: InstallationCoverage | "failed",
  at: string,
): boolean {
  if (!needsInstallationLookup(index, repository)) return false;
  const current = coverageRecord(index, repository);
  if (result === "failed") {
    if (current) return false;
    index.repositories[repository] = { coverage: "polling", evidence: "user_installations_failed", at };
    return true;
  }
  const coverage: WebhookCoverage = result === "none" ? "polling" : "webhook";
  if (current?.coverage === coverage && current.evidence === "user_installations") return false;
  const record: CoverageRecord = { coverage, evidence: "user_installations", at };
  if (result === "account") index.accounts[repository.slice(0, repository.indexOf("/"))] = record;
  else index.repositories[repository] = record;
  return true;
}

/** One watch the cron should refresh now, with the follow-up it performs, if any. */
export interface DuePoll {
  id: string;
  mergeability?: MergeabilityFollowUp;
}

export interface PollTickPlan {
  due: DuePoll[];
  /** Watches still scheduled, that is, neither merged nor closed. */
  active: number;
  coverage: Record<WebhookCoverage, number>;
  /** Whether `schedule` was changed in place and must be stored. */
  changed: boolean;
}

/**
 * Decides one cron tick from the index alone, without reading any watch record. `watched`
 * maps every watch some live session holds to its repository: a watch missing from the index
 * is due now, and an entry or follow-up no session holds any more is dropped. A `polling`
 * watch is due on every tick; any watch whose `dueAt` has come is due and claims its next
 * hourly reconcile; a due follow-up is marked running until its read settles it.
 */
export function planPollTick(
  schedule: PollSchedule,
  followUps: Map<string, MergeabilityFollowUp>,
  watched: ReadonlyMap<string, string>,
  coverage: CoverageIndex,
  now: number,
): PollTickPlan {
  const plan: PollTickPlan = { due: [], active: 0, coverage: { webhook: 0, polling: 0 }, changed: false };
  for (const id of Object.keys(schedule)) {
    if (watched.has(id)) continue;
    delete schedule[id];
    plan.changed = true;
  }
  for (const id of followUps.keys()) {
    if (!watched.has(id)) followUps.delete(id);
  }
  for (const [id, repository] of watched) {
    const entry: PollScheduleEntry = schedule[id] ?? { state: "active", dueAt: now };
    if (entry.state === "stopped") continue;
    const repositoryCoverageNow = repositoryCoverage(coverage, repository);
    plan.active += 1;
    plan.coverage[repositoryCoverageNow] += 1;
    const reconcileDue = entry.dueAt <= now + POLL_TICK_TOLERANCE_MS;
    if (reconcileDue) {
      schedule[id] = { state: "active", dueAt: now + WEBHOOK_RECONCILE_MS };
      plan.changed = true;
    }
    const followUp = followUps.get(id);
    if (followUp && followUp.dueAt <= now + POLL_TICK_TOLERANCE_MS) {
      const running = { ...followUp, dueAt: Number.POSITIVE_INFINITY };
      followUps.set(id, running);
      plan.due.push({ id, mergeability: running });
      continue;
    }
    if (reconcileDue || repositoryCoverageNow === "polling") plan.due.push({ id });
  }
  return plan;
}

/**
 * A watch the user just registered, or one a delivery reopened: its read runs now, so the next
 * reconcile is an hour away. A merged pull request is not scheduled at all.
 */
export function registerPollEntry(
  entry: PollScheduleEntry | undefined,
  state: MonitorTerminalState,
  now: number,
): PollScheduleEntry | undefined {
  if (state === "merged") return entry?.state === "stopped" ? undefined : { state: "stopped" };
  if (entry?.state === "active") return undefined;
  return { state: "active", dueAt: now + WEBHOOK_RECONCILE_MS };
}

/**
 * A scheduled read failed: bring an active watch's next read forward to the retry delay. The
 * schedule is left alone, and not rewritten, when that read is already due sooner.
 */
export function retryFailedPoll(schedule: PollSchedule, id: string, now: number): boolean {
  const entry = schedule[id];
  if (entry?.state !== "active") return false;
  const dueAt = now + FAILED_POLL_RETRY_MS;
  if (entry.dueAt <= dueAt) return false;
  schedule[id] = { state: "active", dueAt };
  return true;
}

/**
 * A delivery that moved the head, opened, or reopened the pull request: read it again once
 * GitHub has had time to compute mergeability. A follow-up already due by then reads the
 * state after this delivery, so it is kept; any other, including a running one, is replaced.
 */
export function requestMergeabilityFollowUp(
  followUps: Map<string, MergeabilityFollowUp>,
  id: string,
  now: number,
): void {
  const dueAt = now + MERGEABILITY_FOLLOW_UP_MS;
  if ((followUps.get(id)?.dueAt ?? Number.POSITIVE_INFINITY) <= dueAt) return;
  followUps.set(id, { attempt: 1, requestedAt: now, dueAt });
}

/**
 * Settles a follow-up read. It retries with backoff while mergeability is still unknown or the
 * read failed, and is dropped once mergeability is known, the pull request is merged or closed,
 * or its attempts are spent. A follow-up that a newer delivery replaced while this read ran is
 * left alone.
 */
export function settleMergeabilityFollowUp(
  followUps: Map<string, MergeabilityFollowUp>,
  id: string,
  followUp: MergeabilityFollowUp,
  outcome: RefreshOutcome,
  now: number,
): void {
  const pending = followUps.get(id);
  if (!pending || pending.attempt !== followUp.attempt || pending.requestedAt !== followUp.requestedAt) return;
  const retryIn = outcome === "mergeability_unknown" || outcome === "failed" ? MERGEABILITY_RETRY_MS[followUp.attempt] : undefined;
  if (retryIn === undefined) {
    followUps.delete(id);
    return;
  }
  followUps.set(id, { attempt: followUp.attempt + 1, requestedAt: followUp.requestedAt, dueAt: now + retryIn });
}
