# watch-pr agent notes

## Documentation boundaries

- Keep `README.md` focused on the public service contract and operator setup.
- Put architecture, persistence, telemetry internals, and local validation in this file.
- Preserve the limits and failure behavior below when changing the implementation.

## Architecture

- The service runs on Cloudflare Workers. `WatchPrHub` is a SQLite Durable Object shared by the production and PPE deployments.
- GitHub App webhooks produce MCP resource updates. A one-minute cron reads a due index (`poll-schedule`) and refreshes only the watches it names: `polling` watches every tick, `webhook` watches at an hourly reconcile, and mergeability follow-ups after a push. See [Poll schedule and webhook coverage](#poll-schedule-and-webhook-coverage).
- A changed snapshot sends `notifications/resources/updated` and a compact summary through `notifications/message`.

### Monitor ingress guard

Production's `vza.net` Cloudflare zone (account `be2aff099f03e835047ba1f8cfd9aa81`) has an active WAF rate-limit rule `5fb1909d8a5b4a4bb0c9de97b6197a13` named `watch-pr monitor reconnect storm`: match `http.host eq "watch-pr.vza.net" and starts_with(http.request.uri.path, "/monitor/")`, block a source IP after 20 matching requests in 10 seconds for 10 seconds. This runs before the Worker and admits the observed 14-capability simultaneous reconnect burst, while reducing a fast single-IP loop. The Free plan's 10-second counting period cannot guarantee the 100,000/day Worker allowance against a sustained or distributed storm; a blocked EventSource connection does not automatically recover. The canonical hostname is routed through `vza-net-router` in this zone to the production Worker in account `82fd9c2460271241c04b2401f16108db` over its `workers.dev` origin. Direct requests to that origin bypass the zone's WAF, so `workers_dev` must remain enabled for the router but is not protected by this rule. Keep the rule aligned with the canonical monitor URL if the hostname changes.

### Webhook delivery

The webhook handler verifies `X-Hub-Signature-256` and deduplicates `X-GitHub-Delivery` IDs in memory during fanout. Each successfully published watch stores the delivery ID in its own watch state. The global `delivery:<id>` marker is written only after every matched watch succeeds.

Per-watch delivery IDs allow a manual GitHub redelivery to resume partial fanout without duplicating completed watches. GitHub receives the asynchronous handler's `202` before fanout finishes and will not automatically redeliver a later failure, so the scheduled refresh reconciles the snapshot: within a minute for a `polling` repository, within the hour for a `webhook` one. Delivery IDs that match no watch are not persisted. GitHub has no reaction-specific webhook; the scheduled refresh provides reaction parity on the same cadence.

`installation` and `installation_repositories` deliveries only update the coverage record; they are answered `202` after that write, with no fanout and no `delivery:<id>` marker, because applying one again is harmless.

Webhook payloads are data, not just triggers. For each routed watch, `applyWebhook` (`src/reducers.ts`) applies the delivery to the committed snapshot inside the watch's storage transaction, with no GitHub request. Payload objects have the REST shapes, so the reducers reuse the normalizers in `src/github.ts`. Each call returns one outcome:

- `applied`: the snapshot changed. A change `snapshotChanges` announces is appended as the delivery's event, exactly like a refetched one. A change nothing announces, such as a moved `updatedAt`, is stored silently.
- `applied_mergeability_unknown`: a `pull_request` delivery moved the head or base but carried no mergeability. GitHub computes it asynchronously, so the snapshot stores `mergeable: null` and `mergeableState: "unknown"`, and a mergeability follow-up learns the result (see below). A dropped pull validator makes that read a `200`. No read is made immediately, because it usually finds the computation still pending.
- `refetch`: the reducer cannot apply the payload. This covers an event without a reducer, a payload missing the fields the reducer needs, a review thread the snapshot does not know, a watch without a stored snapshot, and every event other than resolve or unresolve for threads. The conditional `pullRequestSnapshot` read runs as before.
- `ignored`: nothing is written, and no event or monitor frame is produced. Examples are an out-of-order delivery older than the stored item (`updated_at` for pulls and comments, `submitted_at` for reviews, `completed_at` for checks, newest-per-context for statuses), a dismissed review that a stale submission would revive, checks for a head SHA other than the stored one, and a payload the snapshot already reflects.

Reducer rules:

- A `pull_request` delivery that keeps the head and base keeps the stored mergeability unless the payload computed it.
- A new head clears `checks`. The new head's checks arrive through their own `check_run`, `check_suite`, and `status` deliveries.
- A deleted comment is removed whatever its timestamps.
- A `check_run` removes the awaiting-approval placeholder of its own suite.
- A reduced snapshot's `fetchedAt` is the delivery's receipt time.
- Every REST slice the delivery changed loses its validator through `coherentRequestKnowledge`, so the next conditional read of that slice returns `200` and reconciles anything the payload could not express. Untouched slices keep their validators, and `threadsReadAt` is kept.

### Poll schedule and webhook coverage

The GitHub App is installed per account, so a watched repository owned by someone who has not installed it (for example `can1357/oh-my-pi`) never produces deliveries and depends entirely on reads. The Worker holds no App private key, so it cannot ask GitHub which installations exist; coverage is learned instead (`src/schedule.ts`).

`webhook-coverage` is one Durable Object key holding `{ accounts, repositories }`, each mapping a lowercased login or `owner/name` to `{ coverage: "webhook" | "polling", evidence, at }`. A repository's coverage is whichever of its own record and its account's record was observed last; a repository record wins a tie. Nothing known means `polling`. Sources, by `evidence`:

- `installation_created`, `installation_unsuspend`: `repository_selection: "all"` writes an account record, otherwise each listed repository is `webhook`.
- `installation_deleted`, `installation_suspend`: the account becomes `polling`.
- `installation_repositories_added`, `installation_repositories_removed`: listed repositories become `webhook` or `polling`; `repository_selection: "all"` makes the account `webhook`.
- An account-level installation event drops that account's repository records, which it supersedes.
- `delivery`: any signature-valid delivery routed to a watch of the repository proves coverage. It is written only when coverage is not already `webhook`, so steady-state deliveries add no write.
- `user_installations`, `user_installations_failed`: when a user watches a repository no webhook has reported on, the hub reads `GET /user/installations` and, for the owner's `selected` installation, `GET /user/installations/{id}/repositories` with the user's token. Both are conditional; the lists and ETags live in `installation-lookup:<user-id>`, so a repeat is two `304`s that write nothing. Suspended installations and installations on other accounts do not count. A failed lookup writes `polling` only when nothing is known. Webhook evidence is never overwritten by a lookup. Each lookup logs `watch_pr.coverage_lookup`.

`poll-schedule` is one key mapping `<user-id>:<owner/name>#<number>` to `{ state: "active", dueAt }` or `{ state: "stopped" }`. A cron tick lists sessions (they hold the credentials and the watch sets), reads the coverage record and this index, and reads no watch record or snapshot. It writes the index only when an hourly reconcile is claimed, an entry is added, or an entry no session holds is dropped. For each watch a live session holds:

- No entry: due now. Entries no session holds any more are dropped.
- `stopped`: skipped. A poll or registration read that finds the pull request merged or closed stops it; registering a merged watch stores it stopped. A delivery that requests a mergeability follow-up (below), such as `reopened`, resumes it with an hourly `dueAt`.
- `dueAt` within 30 s of now: due, and the entry claims `dueAt = now + 1 h`, the hourly reconcile that picks up reactions, drift, and missed deliveries. If that read, or a registration read, fails, `dueAt` is brought forward to 5 min after the failure (one put, skipped when the entry is already due sooner), so a transient GitHub error does not leave a `webhook` watch stale for the hour.
- A pending mergeability follow-up due within 30 s: due.
- Otherwise a `polling` watch is due on every tick; a `webhook` watch waits.

`watch` registers an entry an hour out (its own registration read runs now) and leaves an existing active entry alone. `get_pr`, resource reads, and other `read` refreshes do not touch the index.

A `pull_request` `opened`, `reopened`, or `synchronize` delivery the reducer did not ignore, or any delivery applied as `applied_mergeability_unknown`, requests a mergeability follow-up for that watch: a read due 60 s later. Follow-ups are held in the hub's memory (`mergeabilityFollowUps`), not in storage, so a push adds no write; the delivery budget has about 100 writes of headroom and one put per push would exceed it. A follow-up lost to an eviction or deploy only defers the read to the hourly reconcile. The read marks the follow-up running and settles it when it finishes: still `unknown` or failed retries attempt 2 at `+2 min` and attempt 3 at `+4 min`, so reads land at about 1, 3, and 7 minutes after the push; a known result, a merged or closed pull request, or a spent third attempt drops it. Settling only applies when the map still holds the follow-up that ran, so a push during a running read restarts the sequence, while a push while one is already due within 60 s keeps the sooner one. A follow-up that finds a read already in flight settles as failed and retries on its backoff. One push therefore costs at most three extra conditional reads and no write.

### Reaction snapshots

Each reaction record contains the GitHub reaction ID, content, actor login, actor user ID, and creation time. Records cover the PR body, top-level comments, and inline review comments. GitHub's aggregate counts are stored beside each target and decide whether to read it.

All reaction detail reads for one snapshot run in one wave under a shared concurrency budget. A target is read only when its aggregate counts change. A quiet PR with unchanged counts spends no requests rereading known details. A comment webhook moves only a comment's aggregate counts and keeps its stored details. A refresh borrows stored details only when they still add up to the new counts, so the next refresh reads that comment's reactions and announces the difference.

Aggregate counts cannot detect a swap that leaves every count unchanged, such as one actor's `heart` replacing another actor's `heart` between refreshes. That change is detected only after the target's counts move again.

A failed reaction read is isolated to its target. That target keeps its prior details and prior counts, so the next refresh sees the same aggregate delta and retries it. Other snapshot fields continue to advance.

An absent reaction detail array means the target is unknown because it predates individual reaction storage or has never been read successfully. This differs from a known-empty array. The first refresh that learns an unknown target reports no reaction activity. That enrichment replaces the snapshot in place without appending an event, sending a monitor frame, or notifying the resource. This prevents the same target from being read on every later refresh.

A stale refresh that loses a race to a newer snapshot is dropped. Before any write, the snapshot copies details and matching aggregate counts for every unknown target from the currently stored snapshot. This makes reaction knowledge monotonic when concurrent refreshes learn different targets. A silent enrichment builds on the stored snapshot so it cannot revert a title, head revision, or check that landed while it ran. A published event builds on its own snapshot because that change is the event being recorded.

Numeric actor IDs determine actor identity when both records have one. Records created before actor IDs were stored fall back to normalized logins for diffing and filtering the watcher's own reactions.

### Conditional requests

A snapshot's `githubValidators` maps each REST request URL to the ETag of the response its content came from: the object URL for the pull and issue reads, and the `per_page=100` first-page URL for lists. Check URLs contain the head SHA, so a new head never sends an old validator. A refresh sends `If-None-Match` for each stored ETag, and a `304` reuses the matching slice of the stored snapshot: core fields (pull), `bodyReactions` (issue), `comments`, `reviews`, `reviewComments`, or the checks of one kind (check runs, statuses, check suites). A list that runs past one page stores no validator, because one page's ETag cannot vouch for the whole. Reaction detail reads stay unconditional.

A validator is only as good as the content it describes. Whenever the hub stores a snapshot assembled from more than one source, such as a silent enrichment on the stored snapshot or a published event that merges stored reaction knowledge, `coherentRequestKnowledge` keeps a validator only when the stored content holds exactly the slice (compared as JSON) that the validator's source snapshot held for that URL. Comment slices are compared without reaction bookkeeping, which the list response does not carry. A dropped validator costs the next refresh one full read. It never makes a `304` return content that GitHub did not send.

GraphQL review threads cannot be revalidated. A refresh reuses the stored `threads` only when the review comments returned `304` and `threadsReadAt` is less than 15 minutes old. Otherwise, or when a `pull_request_review_thread` webhook the reducer could not apply triggered the refresh, it reads the threads again. A failed threads read keeps the stored threads and drops `threadsReadAt`, so the next refresh retries.

A refresh that announces nothing but carries different validators, or a threads read that replaces a stale one, is stored silently like a reaction enrichment: no event, monitor frame, or notification, and a newer stored `fetchedAt` wins. `snapshotChanges` ignores both fields. `fetchedAt` therefore records the last stored change, whether it came from a GitHub read or a reduced webhook. `watch:<user-id>:<repository>:<number>:polled` records the last successful GitHub read from any source (poll, watch, read, or a webhook the reducer could not apply). A reduced webhook makes no read and does not advance it. It is written in its own transaction only when newer, and webhook fanout counts it in `storage_key_puts`. `get_pr` adds it as `polledAt` and omits `githubValidators`. Resource reads return `{ snapshot, events, polledAt }`.

### Event storage

Each watch stores event history in versioned sidecar records:

- `watch:<user-id>:<repository>:<number>:sidecar` contains the ordered metadata index.
- `:sidecar:snapshot:<sequence>` contains one immutable pull request snapshot.
- `:sidecar:event:<sequence>` contains one immutable raw webhook payload.
- `:sidecar:cleanup:<sequence>` contains bounded deferred retirement work for chunked records.

Appending an event writes immutable records instead of rewriting stored payloads. Compact unreferenced records are deleted in the append transaction. Webhook routing, polling, and registration lists read the index and current snapshot without loading event payloads. Monitor replay loads only the referenced payloads needed for event `details`.

A watch created before sidecars keeps its single `watch:<user-id>:<repository>:<number>` record. The first append indexes those events by position without copying them. Once the 100-event window stops referencing the root, the root is retired immediately when compact or through the cleanup queue when chunked.

When an existing session first resumes, its `watch:<repository>:<number>` records are copied to `watch:<user-id>:<repository>:<number>` using the session's GitHub user ID. Legacy records remain during migration.

The regression suite drives 10,000 changing single-watch deliveries with a 4,000-byte PR body, event-window eviction, and the durable delivery-deduplication write. It must stay below 60,000 logical writes, which is 60% of the [Workers Free 100,000 rows-written daily allowance](https://developers.cloudflare.com/durable-objects/platform/pricing/). The contract covers this bounded workload only. It says nothing about unbounded GitHub payloads. `watch_pr.do_storage` reports chunk count and logical writes for oversized live records.

## Observability

Both deployments export invocation logs and automatic traces to Azure Monitor Application Insights through account-scoped Cloudflare Observability destinations. Native logs and traces use 100% head sampling, redact query strings, and are not persisted in Cloudflare.

The destinations send JSON OTLP to a dedicated gateway Worker. The gateway accepts logs and traces only, exchanges a signed OIDC assertion for an Entra workload token, and forwards protobuf OTLP to Azure. It does not persist telemetry payloads or log raw payloads, bearer values, or Azure tokens.

Before forwarding, the gateway applies a schema-aware, drop-by-default filter to resource, scope, log, span, event, and link attributes. It retains bounded service and Cloudflare execution fields, method, status, and protocol data, route templates, correlation IDs, exception types, and fields from enumerated internal `watch_pr.*` markers. It removes headers, full or query URLs, user agents, address, client, geo, and ASN values, storage keys, arbitrary log bodies, exception messages, credentials, nested values, and unknown fields. `url.path` is forwarded only as an exact static route, `/monitor/{capability}`, or `/{unknown}`.

The gateway has bounded request and forwarding timeouts, accepts at most two ingest bearers during rotation, and rejects oversized payloads.

### Operational telemetry

- `watch_pr.poll` records each cron tick with `active_sessions`, `scheduled_watches` (watches the due index still schedules, neither merged nor closed), `due_watches` (watches this tick refreshes, including ones skipped because a refresh is already in flight), `coverage_webhook` and `coverage_polling` (scheduled watches by repository coverage), `refreshes_started`, and `expired_monitors_revoked`. It also reports refresh work finished since the previous tick in the same object instance, from every refresh source: `refreshes_completed`, `refresh_failures`, and GitHub usage fields. Totals held in memory are lost when the object is evicted, so they are a lower bound.
- Every watch-time installation lookup emits one `watch_pr.coverage_lookup` record with `outcome` (`account`, `repository`, `none`, or `failed`), the lookup's GitHub usage fields, and `error_kind`, `error_name`, and `github_status` when it failed.
- Every authenticated webhook delivery emits one `watch_pr.webhook_admission` record. Its `outcome` is accepted, duplicate, unsupported, invalid-JSON, or admission-error. It contains no delivery ID or payload. Unsupported events omit `github_event`, which prevents an unrecognized request header from creating an Azure label.
- Every accepted, nonduplicate delivery emits one `watch_pr.webhook_fanout` record after processing, including a zero-route delivery. Its `outcome` is `completed` or `failed`. It includes `snapshot_failures` and the GitHub usage fields for that delivery's snapshot reads. `reducer_applied`, `reducer_applied_mergeability_unknown`, `reducer_refetch`, and `reducer_ignored` count the routed, nonduplicate watches by reducer outcome. Only `reducer_refetch` watches spend GitHub requests.
- Every failed snapshot read emits one `watch_pr.snapshot_failure` record with `source` (`poll`, `watch`, `read`, or `webhook`), `error_kind`, `error_name`, and `github_status` for GitHub API errors. The watch keeps its previous snapshot, and a later refresh retries it.
- The GitHub usage fields are `github_rest_requests` (REST responses other than `304`; these consume the user's primary rate limit), `github_not_modified` (`304` responses, which do not), `github_graphql_requests` (separate point budget), and `github_core_remaining_min` (the lowest `core` rate-limit remaining observed; omitted when no response reported it).
- Every successful persisted watch-state append emits `watch_pr.do_storage`.
- `watch_pr.webhook_fanout`, `watch_pr.do_storage`, and `watch_pr.snapshot_failure` use `sample_rate: 1` and `sample_reason: "all"`.

A fanout record counts target-state writes, including writes completed before a later append failure, the delivery marker, the `webhook-coverage` put when a delivery first proves a repository's coverage, the `poll-schedule` put when a delivery reopens a stopped watch, and session or monitor deletes caused by an invalid GitHub token. It excludes session-record refreshes and legacy-state migration performed during session reconciliation. State records include the per-watch serialized size, chunk count, event window, and predecessor-payload references.

For a rolling-hour report, count `watch_pr.webhook_admission` by `outcome`, use the newest `watch_pr.poll` record for the current watcher count, and sum `watch_pr.webhook_fanout.storage_key_writes` for tracked webhook work. Add `watch_pr.do_storage.storage_key_writes` only for `source: "refresh"` when the report includes snapshot refreshes. Restrict the query to `github_action: "poll"` for cron refreshes alone; `watch` and `read` also refresh snapshots. Webhook state records are already included in the fanout total.

These telemetry records do not count every Durable Object storage operation. They omit delivery IDs, repository names, tokens, snapshots, and webhook payloads. `watch_pr.webhook_failure` includes a SHA-256 delivery fingerprint for manual recovery without exposing the raw ID.

## Local validation

```sh
npm ci
npm test
npm run typecheck
```

