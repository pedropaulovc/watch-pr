# watch-pr agent notes

## Documentation boundaries

- Keep `README.md` focused on the public service contract and operator setup.
- Put architecture, persistence, telemetry internals, and local validation in this file.
- Preserve the limits and failure behavior below when changing the implementation.

## Architecture

- The service runs on Cloudflare Workers. `WatchPrHub` is a SQLite Durable Object shared by the production and PPE deployments.
- GitHub App webhooks produce MCP resource updates. A one-minute cron performs reconciliation.
- A changed snapshot sends `notifications/resources/updated` and a compact summary through `notifications/message`.

### Monitor ingress guard

Production's `vza.net` Cloudflare zone (account `be2aff099f03e835047ba1f8cfd9aa81`) has an active WAF rate-limit rule `5fb1909d8a5b4a4bb0c9de97b6197a13` named `watch-pr monitor reconnect storm`: match `http.host eq "watch-pr.vza.net" and starts_with(http.request.uri.path, "/monitor/")`, block each source IP after two matching requests in 10 seconds for 10 seconds. This runs before the Worker and protects its daily invocation allowance against a reconnect loop from one IP. It does not cap aggregate traffic across IPs or requests sent directly to the Worker’s `workers.dev` hostname. Keep this rule aligned with the canonical monitor URL if the hostname changes.

### Webhook delivery

The webhook handler verifies `X-Hub-Signature-256` and deduplicates `X-GitHub-Delivery` IDs in memory during fanout. Each successfully published watch stores the delivery ID in its own watch state. The global `delivery:<id>` marker is written only after every matched watch succeeds.

Per-watch delivery IDs allow a manual GitHub redelivery to resume partial fanout without duplicating completed watches. GitHub receives the asynchronous handler's `202` before fanout finishes and will not automatically redeliver a later failure, so scheduled polling reconciles the snapshot. Delivery IDs that match no watch are not persisted. GitHub has no reaction-specific webhook; the scheduled refresh provides reaction parity.

### Reaction snapshots

Each reaction record contains the GitHub reaction ID, content, actor login, actor user ID, and creation time. Records cover the PR body, top-level comments, and inline review comments. GitHub's aggregate counts are stored beside each target and decide whether to read it.

All reaction detail reads for one snapshot run in one wave under a shared concurrency budget. A target is read only when its aggregate counts change. A quiet PR with unchanged counts spends no requests rereading known details.

Aggregate counts cannot detect a swap that leaves every count unchanged, such as one actor's `heart` replacing another actor's `heart` between refreshes. That change is detected only after the target's counts move again.

A failed reaction read is isolated to its target. That target keeps its prior details and prior counts, so the next refresh sees the same aggregate delta and retries it. Other snapshot fields continue to advance.

An absent reaction detail array means the target is unknown because it predates individual reaction storage or has never been read successfully. This differs from a known-empty array. The first refresh that learns an unknown target reports no reaction activity. That enrichment replaces the snapshot in place without appending an event, sending a monitor frame, or notifying the resource. This prevents the same target from being read on every later refresh.

A stale refresh that loses a race to a newer snapshot is dropped. Before any write, the snapshot copies details and matching aggregate counts for every unknown target from the currently stored snapshot. This makes reaction knowledge monotonic when concurrent refreshes learn different targets. A silent enrichment builds on the stored snapshot so it cannot revert a title, head revision, or check that landed while it ran. A published event builds on its own snapshot because that change is the event being recorded.

Numeric actor IDs determine actor identity when both records have one. Records created before actor IDs were stored fall back to normalized logins for diffing and filtering the watcher's own reactions.

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

- `watch_pr.poll` records each cron tick with `active_sessions`, `scheduled_watches`, and `refreshes_started`.
- Every authenticated webhook delivery emits one `watch_pr.webhook_admission` record. Its `outcome` is accepted, duplicate, unsupported, invalid-JSON, or admission-error. It contains no delivery ID or payload. Unsupported events omit `github_event`, which prevents an unrecognized request header from creating an Azure label.
- Every accepted, nonduplicate delivery emits one `watch_pr.webhook_fanout` record after processing, including a zero-route delivery. Its `outcome` is `completed` or `failed`.
- Every successful persisted watch-state append emits `watch_pr.do_storage`.
- `watch_pr.webhook_fanout` and `watch_pr.do_storage` use `sample_rate: 1` and `sample_reason: "all"`.

A fanout record counts target-state writes, including writes completed before a later append failure, the delivery marker, and session or monitor deletes caused by an invalid GitHub token. It excludes session-record refreshes and legacy-state migration performed during session reconciliation. State records include the per-watch serialized size, chunk count, event window, and predecessor-payload references.

For a rolling-hour report, count `watch_pr.webhook_admission` by `outcome`, use the newest `watch_pr.poll` record for the current watcher count, and sum `watch_pr.webhook_fanout.storage_key_writes` for tracked webhook work. Add `watch_pr.do_storage.storage_key_writes` only for `source: "refresh"` when the report includes snapshot refreshes. Restrict the query to `github_action: "poll"` for cron refreshes alone; `watch` and `read` also refresh snapshots. Webhook state records are already included in the fanout total.

These telemetry records do not count every Durable Object storage operation. They omit delivery IDs, repository names, tokens, snapshots, and webhook payloads. `watch_pr.webhook_failure` includes a SHA-256 delivery fingerprint for manual recovery without exposing the raw ID.

## Local validation

```sh
npm ci
npm test
npm run typecheck
```

