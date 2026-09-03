# watch-pr

`watch-pr` is a remote MCP server for GitHub pull request lifecycle monitoring. It runs on Cloudflare Workers with a Durable Object hub and exposes Streamable HTTP at `/mcp`.

The server turns GitHub App webhook deliveries into MCP resource updates. It also refreshes every watched pull request once per minute, which covers state that GitHub does not expose as a dedicated webhook, including body/comment reactions, review-thread resolution, check rollups, and `mergeable`/`mergeable_state` changes.

## MCP surface
The server advertises dynamic OAuth client registration at `/oauth/register`. Registered redirect URIs must be HTTPS or loopback HTTP; S256 PKCE is required for every authorization request.
Authenticate with the OAuth 2.0 authorization-code + S256 PKCE flow advertised at `/.well-known/oauth-protected-resource` and `/.well-known/oauth-authorization-server`.

Tools:

- `watch_pr` — subscribe to `repository` (`owner/name`) and `number`.
- `unwatch_pr` — remove a subscription for the current GitHub account.
- `list_watched_prs` — list the current account's subscriptions.
- `get_pr` — read the durable snapshot and recent events for a watched PR.
- `list_pr_events` — read up to 100 recent webhook/snapshot events.

Each watched PR is also available as a resource at `watch-pr://owner/repository/pull/NUMBER`. A webhook or changed snapshot sends the standard `notifications/resources/updated` notification; clients can then call `resources/read`. The server also sends the event through `notifications/message` for clients that support logging notifications.

Snapshots include PR lifecycle and mergeability, base/head refs, checks and commit statuses, reviews, top-level comments and reactions, inline review comments and reactions, and GraphQL review-thread resolution state.

## GitHub integration

Configure the `watch-pr` GitHub App at <https://github.com/settings/apps/watch-pr>:

- OAuth callback URL: `https://watch-pr.vza.net/oauth/callback`.
- Webhook URL: `https://watch-pr.vza.net/webhooks/github`.
- Webhook secret: store the same value as the Cloudflare `GITHUB_WEBHOOK_SECRET` secret.
- User permissions: read-only access to repository metadata, pull requests, issues, checks, and commit statuses.
- Subscribe to `pull_request`, `pull_request_review`, `pull_request_review_comment`, `pull_request_review_thread`, `issue_comment`, `check_run`, `check_suite`, `status`, `push`, `deployment_status`, `merge_group`, and `commit_comment`.

The webhook handler verifies `X-Hub-Signature-256` and deduplicates `X-GitHub-Delivery` IDs. GitHub has no reaction-specific webhook, so the scheduled refresh is required for reaction parity.

## Cloudflare environments

The environment files intentionally pin both the account ID and Worker name:

| Environment | Account | Worker | Config |
|---|---|---|---|
| Production | `82fd9c2460271241c04b2401f16108db` (`pedro@vza.net`) | `watch-pr-vza-net-prod` | `wrangler.production.jsonc` |
| PPE | `a30acccb05b2f4058c1b13c249056b4c` (`pedro@vezza.com.br`) | `watch-pr-ppe-vza-net` | `wrangler.ppe.jsonc` |

Both Workers use the `WatchPrHub` SQLite Durable Object and a one-minute cron trigger. Set the runtime secrets before the first authenticated request:

```sh
npx wrangler secret put GITHUB_CLIENT_SECRET --config wrangler.production.jsonc
npx wrangler secret put GITHUB_WEBHOOK_SECRET --config wrangler.production.jsonc
npx wrangler secret put GITHUB_CLIENT_SECRET --config wrangler.ppe.jsonc
npx wrangler secret put GITHUB_WEBHOOK_SECRET --config wrangler.ppe.jsonc
```

The GitHub Actions workflows expect `cloudflare-production` and `cloudflare-ppe` environments with:

- variable `CLOUDFLARE_ACCOUNT_ID` matching the pinned account;
- secret `CLOUDFLARE_API_TOKEN` scoped to that account's Workers deployment;
- secrets `GITHUB_CLIENT_SECRET` and `GITHUB_WEBHOOK_SECRET`.

`deploy-production.yml` deploys on every push to `main`. `deploy-ppe.yml` is manual. `deploy-pr.yml` provisions `watch-pr-pr-N` in the PPE account for same-repository pull requests and deletes it when the PR closes. The PR workflow checks out the deployment files from `main` before invoking Wrangler and never deploys a fork with privileged credentials.

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
