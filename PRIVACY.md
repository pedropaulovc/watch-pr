# watch-pr privacy policy

Effective 2026-09-27. This policy covers the hosted MCP server at `https://watch-pr.vza.net/mcp`, operated by Pedro Paulo Vezza Campos.

## What the service receives

- **GitHub identity and tokens.** Signing in through GitHub gives the service your GitHub user ID and login, plus a GitHub App user access token and refresh token. The app requests read-only access to repository metadata, pull requests, issues, checks, commit statuses, deployments, and merge queues. The service cannot write to GitHub.
- **Tool arguments.** The repository (`owner/name`) and pull request number you pass to a tool.
- **Pull request data.** For each watched pull request, the service reads GitHub and stores a snapshot: title, body, state, branches, head commit, mergeability, checks and statuses, reviews, review threads, comments, and reactions, including their authors. When the GitHub App is installed on a repository, GitHub also sends webhook deliveries for it.

The service never receives your conversation with Claude, your prompts, or files from your machine. From the Claude side it receives only tool arguments; everything else it holds is the GitHub data described above.

## How it is used

The data is used only to answer tool calls, resource reads, and monitor feeds for the account that watches the pull request. It is not sold, shared, or used for advertising or model training.

## Retention

- An OAuth session, and the GitHub tokens stored with it, lasts 30 days. An expired session, or one whose GitHub token GitHub rejects, is deleted.
- Monitor URLs expire 12 hours after creation, or earlier when the session ends or the pull request is unwatched.
- Each watch keeps its latest snapshot and its most recent 100 events. When a new event pushes one out of that window, its stored payload is deleted in the same write, or shortly after through a cleanup queue when the payload is large.
- Unwatching a pull request stops refreshes and notifications for it. Its stored snapshot and events remain until deleted on request.
- Webhook delivery IDs are kept to suppress duplicate deliveries.

## Telemetry

Operational logs and traces go to Azure Monitor Application Insights. Before export, a filter removes headers, URLs with query strings, client IP addresses and client geolocation (country, city, ASN), storage keys, log bodies, exception messages, credentials, and any unrecognized field. The Cloudflare data center and region that handled a request are kept. Telemetry does not contain tokens, repository names, snapshots, or webhook payloads.

## Infrastructure

The service runs on Cloudflare Workers and stores data in a Cloudflare Durable Object. GitHub, Cloudflare, and Microsoft Azure process data under their own policies.

## Your choices

- Revoke the service's access at any time in GitHub under **Settings → Applications → Authorized GitHub Apps**. The next refresh that GitHub rejects deletes the session.
- To delete your stored watches, snapshots, and events, email [pedro@vezza.com.br](mailto:pedro@vezza.com.br) from the address on your GitHub account, or open an issue at <https://github.com/pedropaulovc/watch-pr/issues>.

## Contact

Questions about this policy: [pedro@vezza.com.br](mailto:pedro@vezza.com.br).
