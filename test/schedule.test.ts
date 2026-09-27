import { describe, expect, it } from "vitest";
import {
  applyInstallationLookup,
  applyInstallationWebhook,
  MERGEABILITY_FOLLOW_UP_MS,
  needsInstallationLookup,
  planPollTick,
  recordDeliveryCoverage,
  registerPollEntry,
  repositoryCoverage,
  requestMergeabilityFollowUp,
  settleMergeabilityFollowUp,
  WEBHOOK_RECONCILE_MS,
  type MergeabilityFollowUp,
} from "../src/schedule";
import type { CoverageIndex, PollSchedule } from "../src/types";

const MINUTE = 60_000;

function emptyIndex(): CoverageIndex {
  return { accounts: {}, repositories: {} };
}

function installation(repositorySelection: "all" | "selected") {
  return { id: 7, account: { login: "Owner" }, repository_selection: repositorySelection };
}

describe("webhook coverage", () => {
  it("treats a repository nothing has reported on as polling", () => {
    expect(repositoryCoverage(emptyIndex(), "owner/repo")).toBe("polling");
  });

  it("covers every repository of an account installed on all repositories, until it is uninstalled", () => {
    const index = emptyIndex();
    expect(applyInstallationWebhook(index, "installation", { action: "created", installation: installation("all") }, "2026-01-01T00:00:00Z")).toBe(true);
    expect(repositoryCoverage(index, "owner/repo")).toBe("webhook");
    expect(repositoryCoverage(index, "owner/other")).toBe("webhook");
    expect(repositoryCoverage(index, "someone/repo")).toBe("polling");

    applyInstallationWebhook(index, "installation", { action: "deleted", installation: installation("all") }, "2026-01-02T00:00:00Z");
    expect(repositoryCoverage(index, "owner/repo")).toBe("polling");
  });

  it("covers only the listed repositories of a selected installation", () => {
    const index = emptyIndex();
    applyInstallationWebhook(index, "installation", {
      action: "created",
      installation: installation("selected"),
      repositories: [{ full_name: "Owner/Repo" }],
    }, "2026-01-01T00:00:00Z");
    expect(repositoryCoverage(index, "owner/repo")).toBe("webhook");
    expect(repositoryCoverage(index, "owner/other")).toBe("polling");
  });

  it("follows repositories added to and removed from an installation", () => {
    const index = emptyIndex();
    applyInstallationWebhook(index, "installation_repositories", {
      action: "added",
      installation: installation("selected"),
      repository_selection: "selected",
      repositories_added: [{ full_name: "owner/a" }, { full_name: "owner/b" }],
      repositories_removed: [],
    }, "2026-01-01T00:00:00Z");
    applyInstallationWebhook(index, "installation_repositories", {
      action: "removed",
      installation: installation("selected"),
      repository_selection: "selected",
      repositories_added: [],
      repositories_removed: [{ full_name: "owner/b" }],
    }, "2026-01-02T00:00:00Z");
    expect(repositoryCoverage(index, "owner/a")).toBe("webhook");
    expect(repositoryCoverage(index, "owner/b")).toBe("polling");
  });

  it("widens a selected installation to every repository when its selection becomes all", () => {
    const index = emptyIndex();
    applyInstallationWebhook(index, "installation_repositories", {
      action: "removed",
      installation: installation("selected"),
      repository_selection: "selected",
      repositories_removed: [{ full_name: "owner/a" }],
    }, "2026-01-01T00:00:00Z");
    applyInstallationWebhook(index, "installation_repositories", {
      action: "added",
      installation: installation("all"),
      repository_selection: "all",
      repositories_added: [],
      repositories_removed: [],
    }, "2026-01-02T00:00:00Z");
    // The account-wide selection supersedes the earlier per-repository removal.
    expect(repositoryCoverage(index, "owner/a")).toBe("webhook");
    expect(repositoryCoverage(index, "owner/new")).toBe("webhook");
  });

  it("stops covering a suspended installation and resumes on unsuspend", () => {
    const index = emptyIndex();
    applyInstallationWebhook(index, "installation", { action: "created", installation: installation("all") }, "2026-01-01T00:00:00Z");
    applyInstallationWebhook(index, "installation", { action: "suspend", installation: installation("all") }, "2026-01-02T00:00:00Z");
    expect(repositoryCoverage(index, "owner/repo")).toBe("polling");
    applyInstallationWebhook(index, "installation", { action: "unsuspend", installation: installation("all") }, "2026-01-03T00:00:00Z");
    expect(repositoryCoverage(index, "owner/repo")).toBe("webhook");
  });

  it("ignores installation actions that say nothing about delivery", () => {
    const index = emptyIndex();
    expect(applyInstallationWebhook(index, "installation", { action: "new_permissions_accepted", installation: installation("all") }, "2026-01-01T00:00:00Z")).toBe(false);
    expect(index).toEqual(emptyIndex());
  });

  it("takes a delivery as proof of coverage, and writes it only once", () => {
    const index = emptyIndex();
    expect(recordDeliveryCoverage(index, "owner/repo", "2026-01-01T00:00:00Z")).toBe(true);
    expect(repositoryCoverage(index, "owner/repo")).toBe("webhook");
    expect(recordDeliveryCoverage(index, "owner/repo", "2026-01-01T00:01:00Z")).toBe(false);
  });

  it("seeds from the user's installations only until a webhook reports on the repository", () => {
    const index = emptyIndex();
    expect(needsInstallationLookup(index, "owner/repo")).toBe(true);
    expect(applyInstallationLookup(index, "owner/repo", "none", "2026-01-01T00:00:00Z")).toBe(true);
    expect(repositoryCoverage(index, "owner/repo")).toBe("polling");
    // A later lookup may still correct its own seed.
    expect(needsInstallationLookup(index, "owner/repo")).toBe(true);
    expect(applyInstallationLookup(index, "owner/repo", "repository", "2026-01-02T00:00:00Z")).toBe(true);
    expect(repositoryCoverage(index, "owner/repo")).toBe("webhook");
    expect(applyInstallationLookup(index, "owner/repo", "repository", "2026-01-03T00:00:00Z")).toBe(false);

    applyInstallationWebhook(index, "installation_repositories", {
      action: "removed",
      installation: installation("selected"),
      repository_selection: "selected",
      repositories_removed: [{ full_name: "owner/repo" }],
    }, "2026-01-04T00:00:00Z");
    expect(needsInstallationLookup(index, "owner/repo")).toBe(false);
    expect(applyInstallationLookup(index, "owner/repo", "repository", "2026-01-05T00:00:00Z")).toBe(false);
    expect(repositoryCoverage(index, "owner/repo")).toBe("polling");
  });

  it("records an account-wide seed for every repository of the account", () => {
    const index = emptyIndex();
    applyInstallationLookup(index, "owner/repo", "account", "2026-01-01T00:00:00Z");
    expect(repositoryCoverage(index, "owner/other")).toBe("webhook");
  });

  it("falls back to polling when the lookup fails, without discarding what is known", () => {
    const unknown = emptyIndex();
    expect(applyInstallationLookup(unknown, "owner/repo", "failed", "2026-01-01T00:00:00Z")).toBe(true);
    expect(repositoryCoverage(unknown, "owner/repo")).toBe("polling");

    const seeded = emptyIndex();
    applyInstallationLookup(seeded, "owner/repo", "repository", "2026-01-01T00:00:00Z");
    expect(applyInstallationLookup(seeded, "owner/repo", "failed", "2026-01-02T00:00:00Z")).toBe(false);
    expect(repositoryCoverage(seeded, "owner/repo")).toBe("webhook");
  });
});

describe("poll due index", () => {
  const now = Date.parse("2026-01-01T00:00:00Z");
  const webhookCovered: CoverageIndex = {
    accounts: { owner: { coverage: "webhook", evidence: "installation_created", at: "2025-12-01T00:00:00Z" } },
    repositories: {},
  };

  it("reads an unindexed watch now and then only at its hourly reconcile when webhooks cover it", () => {
    const schedule: PollSchedule = {};
    const watched = new Map([["42:owner/repo#7", "owner/repo"]]);
    const first = planPollTick(schedule, new Map(), watched, webhookCovered, now);
    expect(first.due).toEqual([{ id: "42:owner/repo#7" }]);
    expect(first.changed).toBe(true);
    expect(schedule["42:owner/repo#7"]).toEqual({ state: "active", dueAt: now + WEBHOOK_RECONCILE_MS });

    const quiet = planPollTick(schedule, new Map(), watched, webhookCovered, now + 30 * MINUTE);
    expect(quiet).toMatchObject({ due: [], active: 1, coverage: { webhook: 1, polling: 0 }, changed: false });
    expect(planPollTick(schedule, new Map(), watched, webhookCovered, now + WEBHOOK_RECONCILE_MS).due).toHaveLength(1);
  });

  it("reads a polling watch on every tick without rewriting the index", () => {
    const schedule: PollSchedule = { "42:other/repo#7": { state: "active", dueAt: now + WEBHOOK_RECONCILE_MS } };
    const plan = planPollTick(schedule, new Map(), new Map([["42:other/repo#7", "other/repo"]]), webhookCovered, now);
    expect(plan).toMatchObject({ due: [{ id: "42:other/repo#7" }], coverage: { webhook: 0, polling: 1 }, changed: false });
  });

  it("skips stopped watches and forgets entries and follow-ups no session watches", () => {
    const schedule: PollSchedule = {
      "42:owner/repo#1": { state: "stopped" },
      "42:owner/repo#2": { state: "active", dueAt: now + MINUTE * 10 },
    };
    const followUps = new Map();
    requestMergeabilityFollowUp(followUps, "42:owner/repo#2", now);
    const plan = planPollTick(schedule, followUps, new Map([["42:owner/repo#1", "owner/repo"]]), webhookCovered, now);
    expect(plan).toMatchObject({ due: [], active: 0, changed: true });
    expect(schedule).toEqual({ "42:owner/repo#1": { state: "stopped" } });
    expect(followUps.size).toBe(0);
  });

  it("registers an open watch an hour out, a merged one stopped, and leaves an indexed watch alone", () => {
    expect(registerPollEntry(undefined, "watching", now)).toEqual({ state: "active", dueAt: now + WEBHOOK_RECONCILE_MS });
    expect(registerPollEntry(undefined, "merged", now)).toEqual({ state: "stopped" });
    expect(registerPollEntry({ state: "stopped" }, "closed", now)).toEqual({ state: "active", dueAt: now + WEBHOOK_RECONCILE_MS });
    expect(registerPollEntry({ state: "active", dueAt: now + MINUTE }, "watching", now)).toBeUndefined();
  });
});

describe("mergeability follow-up", () => {
  const pushedAt = Date.parse("2026-01-01T00:00:00Z");
  const id = "42:owner/repo#7";
  const watched = new Map([[id, "owner/repo"]]);
  const webhookCovered: CoverageIndex = {
    accounts: { owner: { coverage: "webhook", evidence: "installation_created", at: "2025-12-01T00:00:00Z" } },
    repositories: {},
  };

  /** Runs one-minute ticks after the push, settling each due follow-up with the next outcome. */
  function run(followUps: Map<string, MergeabilityFollowUp>, outcomes: ("mergeability_unknown" | "settled" | "failed")[]): number[] {
    const schedule: PollSchedule = { [id]: { state: "active", dueAt: pushedAt + 40 * MINUTE } };
    const reads: number[] = [];
    for (let tick = pushedAt; tick <= pushedAt + 20 * MINUTE; tick += MINUTE) {
      const plan = planPollTick(schedule, followUps, watched, webhookCovered, tick);
      for (const due of plan.due) {
        reads.push((tick - pushedAt) / MINUTE);
        if (due.mergeability) settleMergeabilityFollowUp(followUps, due.id, due.mergeability, outcomes.shift() ?? "settled", tick);
      }
    }
    return reads;
  }

  it("reads a minute after the push, then backs off 2 and 4 minutes, for at most 3 reads", () => {
    const followUps = new Map<string, MergeabilityFollowUp>();
    requestMergeabilityFollowUp(followUps, id, pushedAt);
    expect(followUps.get(id)).toEqual({ attempt: 1, requestedAt: pushedAt, dueAt: pushedAt + MERGEABILITY_FOLLOW_UP_MS });

    // Minute 40 is the hourly reconcile the index already held; follow-ups never move it.
    expect(run(followUps, ["mergeability_unknown", "failed", "mergeability_unknown"])).toEqual([1, 3, 7]);
    expect(followUps.size).toBe(0);
  });

  it("stops retrying once mergeability is known", () => {
    const followUps = new Map<string, MergeabilityFollowUp>();
    requestMergeabilityFollowUp(followUps, id, pushedAt);
    expect(run(followUps, ["settled"])).toEqual([1]);
    expect(followUps.size).toBe(0);
  });

  it("drops the follow-up when the read finds the pull request merged or closed", () => {
    const followUps = new Map<string, MergeabilityFollowUp>();
    requestMergeabilityFollowUp(followUps, id, pushedAt);
    const running = followUps.get(id)!;
    settleMergeabilityFollowUp(followUps, id, running, "terminal", pushedAt + MINUTE);
    expect(followUps.size).toBe(0);
  });

  it("restarts the backoff when another push lands while a follow-up read runs", () => {
    const followUps = new Map<string, MergeabilityFollowUp>();
    requestMergeabilityFollowUp(followUps, id, pushedAt);
    const schedule: PollSchedule = { [id]: { state: "active", dueAt: pushedAt + 40 * MINUTE } };
    const [running] = planPollTick(schedule, followUps, watched, webhookCovered, pushedAt + MINUTE).due;
    requestMergeabilityFollowUp(followUps, id, pushedAt + 90_000);
    // The read that started for the first push does not consume the newer follow-up.
    settleMergeabilityFollowUp(followUps, id, running.mergeability!, "mergeability_unknown", pushedAt + 95_000);
    expect(followUps.get(id)).toEqual({ attempt: 1, requestedAt: pushedAt + 90_000, dueAt: pushedAt + 90_000 + MERGEABILITY_FOLLOW_UP_MS });
  });

  it("keeps a sooner pending follow-up rather than delaying it", () => {
    const followUps = new Map<string, MergeabilityFollowUp>();
    requestMergeabilityFollowUp(followUps, id, pushedAt);
    requestMergeabilityFollowUp(followUps, id, pushedAt + 10_000);
    expect(followUps.get(id)).toMatchObject({ requestedAt: pushedAt });
  });
});
