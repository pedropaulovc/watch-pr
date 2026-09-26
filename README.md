# watch-pr

`watch-pr` is a hosted MCP server for monitoring GitHub pull requests. Its Streamable HTTP endpoint is `https://watch-pr.vza.net/mcp`.

The server combines GitHub App webhooks with a once-per-minute refresh. The refresh covers state without a dedicated webhook, including reactions, review-thread resolution, check rollups, and changes to `mergeable` and `mergeable_state`.

## Connect

The server advertises dynamic OAuth client registration at `/oauth/register`. Registered redirect URIs must use HTTPS or loopback HTTP. Every authorization request requires S256 PKCE.

Authenticate with the OAuth 2.0 authorization-code flow advertised at `/.well-known/oauth-protected-resource` and `/.well-known/oauth-authorization-server`.

## Tools

- `watch_pr`: Subscribe to `repository` (`owner/name`) and `number` and create its revocable, read-only SSE capability in one call. The JSON result adds `monitor: { monitorUrl, cursor, terminalState }`.
- `unwatch_pr`: Remove a subscription for the current GitHub account.
- `list_watched_prs`: List the current account's subscriptions.
- `get_pr`: Read the latest durable pull request snapshot.
- `list_pr_events`: Read up to 100 recent webhook and snapshot events.

Tool calls return JSON text. `watch_pr` returns the registration object plus its `monitor` capability, `unwatch_pr` returns `{ repository, number, removed }`, `list_watched_prs` returns an array of registration objects, `get_pr` returns the exact latest snapshot (or `null`), and `list_pr_events` returns `{ repository, number, events }`. There is no output mode parameter; callers that need lifecycle details can use the monitor feed or the full snapshot and event records. Tools also advertise MCP behavior hints: `watch_pr` is additive (`destructiveHint: false`), `unwatch_pr` is destructive, and `list_watched_prs`, `get_pr`, and `list_pr_events` are read-only.

Resource reads always return the full stored watch state. Snapshot and event payloads are not abbreviated by the MCP tool layer.


## Resources

Each watched PR is available at `watch-pr://owner/repository/pull/NUMBER`. A webhook or changed snapshot sends `notifications/resources/updated`, after which clients can call `resources/read`. Clients that support logging notifications also receive a compact event summary through `notifications/message`.

## Monitor feeds

A monitor URL is scoped to one OAuth session and PR and carries no GitHub credential. It expires no later than 12 hours after creation; an earlier OAuth-session expiry also revokes it. Repeated `watch_pr` calls reuse the same capability and deadline until it expires. The endpoint accepts only `GET /monitor/...`.

The feed replays events after the URL's `cursor` or the `Last-Event-ID` header, then stays open for live events and heartbeat comments. Events contain bounded non-body `details`: one physical record per named check state, one-line mergeability and deployment changes, active review-comment count changes, deletion and thread changes, and attributed reaction changes such as `reaction created: @actor THUMBS_UP on PR #7 @author https://...` or `reaction deleted: @actor HEART from feedback #456 @author https://...`. Changed comment, review, and feedback records retain their IDs, thread/location/author/state fields, omit GitHub URLs, and carry the complete body, including multiline text. Full body records are outside the non-body detail budget, so a long body cannot hide later actionable records. Failed and cancelled checks include their URLs. Routine partial check completions leave `details` empty until the wave reaches a terminal state.

An active watch reports a reaction even when the same refresh first reveals its target comment. Initial reconciliation omits reaction history. Removing a comment produces one deletion line for the comment instead of one line per reaction. A cursor older than the retained event history receives a reconciliation event from the current snapshot.

Scheduled polling removes expired capabilities. `unwatch_pr` revokes active capabilities. Merged and closed feeds emit a terminal event and close.

For an already-terminal PR, the issued URL's cursor precedes the terminal event (or is absent when that is the only event). The registration's `cursor` still identifies the newest stored event. Clients that put the issued URL cursor in their first `Last-Event-ID` header therefore receive the terminal event instead of an acknowledgement response.

The feed sends an SSE `retry: 60000` directive for EventSource-compatible clients; after a dropped connection, including one on a live watch, automatic reconnection waits one minute and replays from `Last-Event-ID`. A reconnect that acknowledges the latest terminal event with that header receives HTTP `204 No Content`, which stops automatic EventSource reconnection; the URL's `cursor` alone does not acknowledge delivery. Clients must stop after a terminal event and preserve event IDs across reconnects; callers that need the completed history can use `list_pr_events`.

## Snapshots

Snapshots include PR lifecycle and mergeability, base and head refs, checks and commit statuses, reviews, top-level and inline comments, GraphQL review-thread resolution state, and reactions.

## GitHub integration

- OAuth callback URLs: `https://watch-pr.vza.net/oauth/callback` and `https://watch-pr-ppe.vza.net/oauth/callback`.
- Webhook URL: `https://watch-pr.vza.net/webhooks/github`.
- Store the webhook secret as the production Cloudflare `GITHUB_WEBHOOK_SECRET` secret. The GitHub App has one webhook endpoint. PPE relies on its one-minute refresh and does not receive the production secret.
- Request read-only access to repository metadata, pull requests, issues, checks, commit statuses, deployments, and merge queues.
- Subscribe to `pull_request`, `pull_request_review`, `pull_request_review_comment`, `pull_request_review_thread`, `issue_comment`, `check_run`, `check_suite`, `status`, `push`, `deployment`, `deployment_status`, `merge_group`, and `commit_comment`.

The webhook handler verifies `X-Hub-Signature-256`. A manual GitHub redelivery resumes a partial fanout without duplicating completed watches. GitHub does not automatically redeliver a fanout failure that occurs after the handler returns `202`, so scheduled polling reconciles the snapshot. Reactions have no dedicated webhook, so the scheduled refresh supplies them.

## Cloudflare environments

The environment files pin both the account ID and Worker name:

| Environment | Account | Worker | Config |
|---|---|---|---|
| Production | `82fd9c2460271241c04b2401f16108db` (`pedro@vza.net`) | `watch-pr-vza-net-prod` | `wrangler.production.jsonc` |
| PPE | `a30acccb05b2f4058c1b13c249056b4c` (`pedro@vezza.com.br`) | `watch-pr-ppe-vza-net` | `wrangler.ppe.jsonc` |

Both Workers run a one-minute cron trigger. Production receives the GitHub webhook. PPE has no webhook secret and uses scheduled refreshes.

## Observability

Production and PPE export invocation logs and automatic traces to Azure Monitor Application Insights through account-scoped Cloudflare Observability destinations. Native logs and traces use 100% head sampling, redact query strings, and are not persisted in Cloudflare. The destinations send OTLP to a dedicated gateway Worker, which does not persist payloads or log raw payloads, bearer values, or Azure tokens.

The telemetry gateway returns `404` for `/v1/metrics` because the deployment exports logs and traces only. Cloudflare delivery to Azure may take several minutes. To verify production after a request such as `/health`, query both `OTelLogs` and `OTelSpans` over a multi-minute interval.

## Deployment

Set the runtime secrets before the first authenticated request:

```sh
npx wrangler secret put GITHUB_CLIENT_SECRET --config wrangler.production.jsonc
npx wrangler secret put GITHUB_WEBHOOK_SECRET --config wrangler.production.jsonc
npx wrangler secret put GITHUB_CLIENT_SECRET --config wrangler.ppe.jsonc
```

The GitHub Actions workflows require `cloudflare-production` and `cloudflare-ppe` environments with:

- `CLOUDFLARE_ACCOUNT_ID` as a variable matching the pinned account;
- `CLOUDFLARE_API_TOKEN` as a secret scoped to that account's Workers deployment;
- `WATCH_PR_GITHUB_CLIENT_SECRET` and `WATCH_PR_GITHUB_WEBHOOK_SECRET` as production Actions secrets;
- `WATCH_PR_GITHUB_CLIENT_SECRET` as a PPE Actions secret.

The workflows map these Actions secret names to the Worker runtime secrets `GITHUB_CLIENT_SECRET` and `GITHUB_WEBHOOK_SECRET`. GitHub reserves the `GITHUB_` prefix for built-in variables.

Telemetry deployment requires these environment variables:

- `TELEMETRY_AZURE_TENANT_ID`
- `TELEMETRY_AZURE_APP_CLIENT_ID`
- `TELEMETRY_OTLP_TRACES_ENDPOINT`
- `TELEMETRY_OTLP_LOGS_ENDPOINT`
- `TELEMETRY_OIDC_ISSUER_URL`
- `TELEMETRY_GATEWAY_ORIGIN`
- `TELEMETRY_OIDC_SIGNING_KID`
- `TELEMETRY_OIDC_PUBLIC_JWK`

`TELEMETRY_OIDC_PREVIOUS_PUBLIC_JWK` is optional during signing-key rotation. Store `TELEMETRY_OIDC_SIGNING_KEY` and `TELEMETRY_GATEWAY_INGEST_BEARER` as environment secrets. Their `*_PREVIOUS_*` counterparts are optional during rotation.

`CLOUDFLARE_OBSERVABILITY_API_TOKEN` is a separate environment secret used only to create and verify Cloudflare Observability destinations. Scope it to the target account with only `Workers Observability:Edit`. Do not reuse the Worker deployment token. The workflow validates signing keys, Entra federation, bearer rotation, and generated telemetry configuration before configuring destinations and deploying the application Worker.

`deploy-production.yml` deploys every push to `main`. `deploy-ppe.yml` runs manually. `deploy-pr.yml` verifies same-repository PR tests and types without Cloudflare credentials, then replaces and provisions `watch-pr-pr-N` in the PPE account from the verified source using Wrangler and configuration checked out from `main`.

Replacing a preview service removes its legacy preview secrets. Preview Workers receive public configuration only and no runtime secrets. Fork PRs are skipped and never receive privileged credentials. The workflow builds the preview bundle before exposing the Cloudflare API token to the upload step so PR source cannot read deployment credentials during bundling.

## Deployment verification

```sh
curl -fsS https://watch-pr.vza.net/health
curl -fsS https://watch-pr.vza.net/.well-known/oauth-protected-resource
```
