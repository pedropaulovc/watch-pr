# watch-pr

`watch-pr` is a remote MCP server for GitHub pull request lifecycle monitoring. It runs on Cloudflare Workers with a Durable Object hub and exposes Streamable HTTP at `/mcp`.

The server turns GitHub App webhook deliveries into MCP resource updates. It also refreshes every watched pull request once per minute, which covers state that GitHub does not expose as a dedicated webhook, including individual reactions on the PR body and on comments, review-thread resolution, check rollups, and `mergeable`/`mergeable_state` changes.

## MCP surface
The server advertises dynamic OAuth client registration at `/oauth/register`. Registered redirect URIs must be HTTPS or loopback HTTP; S256 PKCE is required for every authorization request.
Authenticate with the OAuth 2.0 authorization-code + S256 PKCE flow advertised at `/.well-known/oauth-protected-resource` and `/.well-known/oauth-authorization-server`.

Tools:

- `watch_pr` — subscribe to `repository` (`owner/name`) and `number`.
- `open_pr_monitor` — create a revocable, read-only SSE capability for an already-watched PR; the JSON result includes `monitorUrl`, `cursor`, and `terminalState`.
- `unwatch_pr` — remove a subscription for the current GitHub account.
- `list_watched_prs` — list the current account's subscriptions.
- `get_pr` — read the latest durable pull request snapshot.
- `list_pr_events` — read up to 100 recent webhook/snapshot events.
- Tool outputs default to `mode: "brief"`, which returns newline-delimited watcher-style lifecycle lines for PR state, head revision, mergeability, checks, reviews, comments, reactions, and feedback. Reaction lines are attributed: `reaction @actor THUMBS_UP on comment #123 @author https://...` for every current reaction left by someone other than the authenticated account, matched on the actor's GitHub user ID so a renamed or recased login is still recognised as the account's own activity. One snapshot contributes at most 12 reaction lines and 1,000 characters of them to a listing; the rest are summarised as `+N more reactions`, and the kept lines are the first in sorted order so they are stable between refreshes. Pass `mode: "full"` to `get_pr` for the complete current snapshot or to `list_pr_events` for event payloads. Resource reads remain full snapshots.

Each watched PR is also available as a resource at `watch-pr://owner/repository/pull/NUMBER`. A webhook or changed snapshot sends the standard `notifications/resources/updated` notification; clients can then call `resources/read`. The server also sends a compact event summary through `notifications/message` for clients that support logging notifications.

The monitor URL is scoped to the current OAuth session and PR, carries no GitHub credential, and expires no later than 12 hours after it is first created; an earlier OAuth-session expiry also revokes it. Repeated `open_pr_monitor` calls reuse the same capability and original deadline until expiry. Only `GET /monitor/...` is accepted. The feed replays events after the URL's `cursor` (or the `Last-Event-ID` header), then remains open for live events and heartbeat comments. Each event includes size-bounded `details` for actionable state: one-line named check states, one-line mergeability and deployment changes, active review-comment count deltas, the bodies and IDs of changed comments and reviews, and attributed reaction changes such as `reaction created: @actor THUMBS_UP on PR #7 @author https://...` or `reaction deleted: @actor HEART from feedback #456 @author https://...`. Within an ongoing watch a reaction is reported even when its target is a comment the same refresh reveals, so nothing an author reacted to before the watcher saw it is silently dropped; only the initial reconciliation withholds reaction history. A removed comment reports its own deletion line instead of one line per reaction it carried. Failed and cancelled checks include their URLs. Routine partial check completions have empty details until the wave reaches a terminal state. A cursor older than the bounded event history receives a reconciliation event from the current snapshot. Scheduled polling removes expired capability records; `unwatch_pr` revokes active capabilities, and merged or closed feeds emit their terminal event and close naturally.

Snapshots include PR lifecycle and mergeability, base/head refs, checks and commit statuses, reviews, top-level comments, inline review comments, GraphQL review-thread resolution state, and reactions. Each reaction is stored individually with its GitHub reaction ID, content, actor login, actor user ID, and creation time, for the PR body, top-level comments, and inline review comments; the aggregate counts GitHub returns with each target are kept alongside them and decide whether a target is read at all. Every individual reaction read a snapshot needs runs in one wave with a single concurrency budget shared by the PR body, top-level comments, and inline review comments, and a target is only read when its aggregate counts changed: an unchanged summary over already-stored details costs no request, so the minute refresh does not re-read a quiet PR's reactions. The one thing the summary cannot express is a swap that leaves every count identical - one `heart` replaced by another actor's `heart` between two refreshes - which is therefore not detected until that target's counts move again. A reaction read that fails is isolated to its own target: that target keeps its previously stored details *and* its previously stored counts, so the next refresh sees the same aggregate delta and reads it again, while every other field of the snapshot still advances. A reaction detail array is absent when it is unknown - persisted before individual reactions existed, or never successfully read - which is distinct from a known-empty array, and the refresh that first learns an unknown target reports no reaction activity for it.

## GitHub integration

- OAuth callback URLs: `https://watch-pr.vza.net/oauth/callback` and `https://watch-pr-ppe.vza.net/oauth/callback`.
- Webhook URL: `https://watch-pr.vza.net/webhooks/github`.
- Webhook secret: store it as the production Cloudflare `GITHUB_WEBHOOK_SECRET` secret. The GitHub App has one webhook endpoint; PPE intentionally relies on its one-minute refresh instead of receiving the production webhook secret.
- User permissions: read-only access to repository metadata, pull requests, issues, checks, commit statuses, deployments, and merge queues.
- Subscribe to `pull_request`, `pull_request_review`, `pull_request_review_comment`, `pull_request_review_thread`, `issue_comment`, `check_run`, `check_suite`, `status`, `push`, `deployment`, `deployment_status`, `merge_group`, and `commit_comment`.

The webhook handler verifies `X-Hub-Signature-256` and deduplicates `X-GitHub-Delivery` IDs in memory during fanout. Each successfully published watch persists its delivery ID in its own watch state; the global `delivery:<id>` marker is written only after every matched watch has been handled. These per-watch IDs make a manual GitHub redelivery resume a partial fanout without duplicating completed watches. Because GitHub has already received the asynchronous handler's `202`, it does not automatically redeliver a later fanout failure; scheduled polling reconciles the snapshot. It does not persist unmatched delivery IDs. GitHub has no reaction-specific webhook, so the scheduled refresh is required for reaction parity.

## Cloudflare environments

The environment files intentionally pin both the account ID and Worker name:

| Environment | Account | Worker | Config |
|---|---|---|---|
| Production | `82fd9c2460271241c04b2401f16108db` (`pedro@vza.net`) | `watch-pr-vza-net-prod` | `wrangler.production.jsonc` |
| PPE | `a30acccb05b2f4058c1b13c249056b4c` (`pedro@vezza.com.br`) | `watch-pr-ppe-vza-net` | `wrangler.ppe.jsonc` |

Both Workers use the `WatchPrHub` SQLite Durable Object and a one-minute cron trigger. Production receives the GitHub webhook; PPE intentionally has no webhook secret and uses the scheduled refresh path.
When an existing session first resumes, its predecessor `watch:<repository>:<number>` records are copied to `watch:<user-id>:<repository>:<number>` using that session's GitHub user ID; legacy records remain intact during the migration.

Each watch stores its event history in versioned sidecar records: `watch:<user-id>:<repository>:<number>:sidecar` holds the ordered metadata index, `:sidecar:snapshot:<sequence>` holds one immutable pull request snapshot, and `:sidecar:event:<sequence>` holds one immutable raw webhook payload. Appending an event writes immutable records instead of rewriting every stored payload. Compact unreferenced records are deleted in the appending transaction, while `:sidecar:cleanup:<sequence>` records bounded deferred retirement for chunked records. Webhook routing, polling, and registration lists read the index and current snapshot without loading event payloads; monitor replay additionally loads the referenced payloads needed to hydrate event `details`. A watch that predates the sidecar keeps its single `watch:<user-id>:<repository>:<number>` record: the first append indexes those events by position rather than copying them, and after the 100-event window stops referencing it the root is retired immediately if compact or through the same bounded cleanup queue if chunked.
The regression suite drives 10,000 changing single-watch deliveries with a 4,000-byte pull request body, event-window eviction, and the durable delivery-deduplication write. It must remain below 60,000 logical writes: 60% of the [Workers Free 100,000 rows-written daily allowance](https://developers.cloudflare.com/durable-objects/platform/pricing/). This is a bounded workload contract, not a claim about unbounded GitHub payloads; `watch_pr.do_storage` reports the chunk count and logical writes for live oversized records.

## Observability

Both deployments export invocation logs and automatic traces to Azure Monitor Application Insights through account-scoped Cloudflare Observability destinations. Native logs and traces use a 100% head-sampling rate, redact query strings, and are not persisted in Cloudflare. The destinations send JSON OTLP to a dedicated gateway Worker; the gateway accepts logs and traces only, exchanges a signed OIDC assertion for an Entra workload token, and forwards protobuf OTLP to Azure. It does not persist telemetry payloads or log raw payloads, bearer values, or Azure tokens.

Before Azure forwarding, the gateway applies a schema-aware, drop-by-default filter to resource, scope, log, span, event, and link attributes. It retains bounded service and Cloudflare execution fields, method/status/protocol data, route templates, correlation IDs, exception types, and fields from enumerated internal `watch_pr.*` markers. It removes headers, full or query URLs, user agents, address/client/geo/ASN values, storage keys, arbitrary log bodies, exception messages, credentials, nested values, and unknown fields. `url.path` is forwarded only as an exact static route, `/monitor/{capability}`, or `/{unknown}`.

The gateway has bounded request and forwarding timeouts, accepts at most two ingest bearers during rotation, and rejects oversized payloads. It returns `404` for metrics because this deployment exports logs and traces only. Cloudflare delivery to Azure may take several minutes, so production verification must query both `OTelLogs` and `OTelSpans` over a multi-minute interval after a request such as `/health`.

The hub logs `watch_pr.poll` for each cron tick with the current `active_sessions`, `scheduled_watches`, and `refreshes_started` counts. Every authenticated webhook delivery emits one `watch_pr.webhook_admission` record. Its `outcome` distinguishes accepted, duplicate, unsupported, invalid-JSON, and admission-error deliveries without recording an ID or payload. Unsupported events omit `github_event`, so an unrecognized request header cannot create an Azure label.

Every accepted, nonduplicate delivery emits one `watch_pr.webhook_fanout` record after processing, including a zero-route delivery; `outcome` is `completed` or `failed`. Every successful persisted watch-state append emits `watch_pr.do_storage`. Both use `sample_rate: 1` and `sample_reason: "all"`. A fanout record counts target-state writes, including writes completed before a later append failure, the delivery marker, and session or monitor deletes caused by an invalid GitHub token. It excludes session-record refreshes and legacy-state migration performed while reconciling sessions. The state record includes the per-watch serialized size, chunk count, event window, and predecessor-payload references.

For a rolling-hour report, count `watch_pr.webhook_admission` by `outcome`, use the newest `watch_pr.poll` record for the current watcher count, and sum `watch_pr.webhook_fanout.storage_key_writes` for tracked webhook work. Add `watch_pr.do_storage.storage_key_writes` only for `source: "refresh"` when including snapshot refreshes. Restrict to `github_action: "poll"` when reporting cron refreshes alone; `watch` and `read` are also snapshot refreshes. Webhook state records are already part of their fanout total. These telemetry records do not claim to count every Durable Object storage operation. They omit delivery IDs, repository names, tokens, snapshots, and webhook payloads. A `watch_pr.webhook_failure` record includes a SHA-256 delivery fingerprint for manual recovery without exposing the raw ID.

Set the runtime secrets before the first authenticated request:

```sh
npx wrangler secret put GITHUB_CLIENT_SECRET --config wrangler.production.jsonc
npx wrangler secret put GITHUB_WEBHOOK_SECRET --config wrangler.production.jsonc
npx wrangler secret put GITHUB_CLIENT_SECRET --config wrangler.ppe.jsonc
```

The GitHub Actions workflows expect `cloudflare-production` and `cloudflare-ppe` environments with:

- variable `CLOUDFLARE_ACCOUNT_ID` matching the pinned account;
- secret `CLOUDFLARE_API_TOKEN` scoped to that account's Workers deployment;
- production Actions secrets `WATCH_PR_GITHUB_CLIENT_SECRET` and `WATCH_PR_GITHUB_WEBHOOK_SECRET`;
- PPE Actions secret `WATCH_PR_GITHUB_CLIENT_SECRET`. The workflows map these names to the Worker runtime secrets `GITHUB_CLIENT_SECRET` and `GITHUB_WEBHOOK_SECRET`; GitHub reserves the `GITHUB_` prefix for built-in variables.

Telemetry deployment also requires `TELEMETRY_AZURE_TENANT_ID`, `TELEMETRY_AZURE_APP_CLIENT_ID`, `TELEMETRY_OTLP_TRACES_ENDPOINT`, `TELEMETRY_OTLP_LOGS_ENDPOINT`, `TELEMETRY_OIDC_ISSUER_URL`, `TELEMETRY_GATEWAY_ORIGIN`, `TELEMETRY_OIDC_SIGNING_KID`, and `TELEMETRY_OIDC_PUBLIC_JWK` as environment variables. `TELEMETRY_OIDC_PREVIOUS_PUBLIC_JWK` is optional during signing-key rotation. Store `TELEMETRY_OIDC_SIGNING_KEY` and `TELEMETRY_GATEWAY_INGEST_BEARER` as environment secrets; their `*_PREVIOUS_*` counterparts are optional during rotation.

`CLOUDFLARE_OBSERVABILITY_API_TOKEN` is a separate environment secret used only to create and verify Cloudflare Observability destinations. Scope it to the target account with only `Workers Observability:Edit`; do not reuse the Worker deployment token. The workflow validates signing keys, Entra federation, bearer rotation, and generated telemetry configuration before configuring destinations and deploying the application Worker.

`deploy-production.yml` deploys on every push to `main`. `deploy-ppe.yml` is manual. `deploy-pr.yml` verifies same-repository pull request tests and types without Cloudflare credentials, then replaces and provisions `watch-pr-pr-N` in the PPE account for the verified source using Wrangler and configuration checked out from `main`; replacing the service removes any legacy preview secrets. Preview Workers receive only the public configuration and no runtime secrets. Fork PRs are skipped and never receive privileged credentials.
The preview bundle is built before the Cloudflare API token is exposed to the upload step; pull request source cannot read deployment credentials during bundling.

## Local checks

```sh
npm ci
npm test
npm run typecheck
```

Smoke checks after deployment:

```sh
curl -fsS https://watch-pr.vza.net/health
curl -fsS https://watch-pr.vza.net/.well-known/oauth-protected-resource
```
