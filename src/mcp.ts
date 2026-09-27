import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { CfWorkerJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/cfworker";
import { ReadResourceRequestSchema, SubscribeRequestSchema, UnsubscribeRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import * as z from "zod/v4";
import { parseResourceUri, watchKey } from "./events";
import type { GithubUser, PrMonitorRegistration, PullRequestSnapshot, WatchReadState } from "./types";

/**
 * One watched pull request as `list_watched_prs` reports it: session-scoped identity, its
 * resource URI, and the latest snapshot. `watch_pr` returns the same shape plus the
 * `monitor` capability object.
 */
export interface WatchRegistration {
  key: string;
  repository: string;
  number: number;
  resourceUri: string;
  snapshot: PullRequestSnapshot | null;
  refreshScheduled: boolean;
}

/** Session-scoped operations behind the MCP tools, implemented by the hub. */
export interface McpSessionContext {
  user: GithubUser;
  watches: Set<string>;
  watch(repository: string, number: number): Promise<WatchRegistration>;
  unwatch(repository: string, number: number): Promise<boolean>;
  listWatches(): Promise<WatchRegistration[]>;
  openMonitor(repository: string, number: number): Promise<PrMonitorRegistration>;
  readWatch(repository: string, number: number): Promise<WatchReadState>;
  subscribe(repository: string, number: number): Promise<void>;
  unsubscribe(repository: string, number: number): Promise<void>;
}

const pullRequestInputSchema = {
  repository: z.string()
    .regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9._-]+$/u, "repository must be a GitHub owner/name pair, such as octocat/hello-world")
    .describe("GitHub repository in owner/name form, such as octocat/hello-world"),
  number: z.number().int().positive().describe("Pull request number"),
};

/**
 * Builds the MCP server for one authenticated session: the five JSON tools and the pull
 * request resource. `watch_pr` is the single entry point for watching and monitoring;
 * every tool returns its result as one JSON text block.
 */
export function createMcpServer(context: McpSessionContext): McpServer {
  const server = new McpServer(
    { name: "watch-pr", version: "0.1.0" },
    {
      capabilities: {
        resources: { subscribe: true, listChanged: true },
        tools: {},
      },
      instructions: "Watch GitHub pull request lifecycle, checks, reviews, comments, reactions, threads, and mergeability over MCP resources.",
      jsonSchemaValidator: new CfWorkerJsonSchemaValidator(),
    },
  );

  server.registerTool(
    "watch_pr",
    {
      title: "Watch pull request",
      description: "Subscribe to a pull request and open its read-only SSE monitor capability in one call. The JSON result is the watch registration plus `monitor: { monitorUrl, cursor, terminalState }`. Repeated calls reuse or renew the same capability.",
      annotations: {
        title: "Watch pull request",
        readOnlyHint: false,
        destructiveHint: false,
      },
      inputSchema: pullRequestInputSchema,
    },
    async ({ repository, number }) => {
      const registration = await context.watch(repository, number);
      const monitor = await context.openMonitor(repository, number);
      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({ ...registration, monitor }),
        }],
      };
    },
  );

  server.registerTool(
    "unwatch_pr",
    {
      title: "Unwatch pull request",
      description: "Stop receiving updates for a pull request.",
      annotations: {
        title: "Unwatch pull request",
        readOnlyHint: false,
        destructiveHint: true,
      },
      inputSchema: pullRequestInputSchema,
    },
    async ({ repository, number }) => {
      const removed = await context.unwatch(repository, number);
      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({ repository, number, removed }),
        }],
      };
    },
  );

  server.registerTool(
    "list_watched_prs",
    {
      title: "List watched pull requests",
      description: "List the pull requests the authenticated GitHub account watches, one summary each: title, state, head commit, mergeability, and when the stored snapshot last changed. Use `get_pr` for a pull request's checks, reviews, and comments.",
      annotations: {
        title: "List watched pull requests",
        readOnlyHint: true,
      },
      inputSchema: {},
    },
    async () => ({
      content: [{
        type: "text" as const,
        text: JSON.stringify((await context.listWatches()).map(({ snapshot, ...watch }) => ({
          ...watch,
          pullRequest: snapshot && {
            url: snapshot.url,
            title: snapshot.title,
            state: snapshot.state,
            draft: snapshot.draft,
            merged: snapshot.merged,
            headSha: snapshot.headSha,
            mergeableState: snapshot.mergeableState,
            fetchedAt: snapshot.fetchedAt,
          },
        }))),
      }],
    }),
  );

  server.registerTool(
    "get_pr",
    {
      title: "Get pull request state",
      description: "Read the latest durable pull request snapshot, or null before the first one. `polledAt` is when GitHub was last read successfully and stored; `fetchedAt` is when the stored snapshot last changed, from a GitHub read or a webhook payload applied without one, so `fetchedAt` can be newer than `polledAt`, and a quiet pull request keeps an old `fetchedAt` while `polledAt` advances. `updatedAt` is GitHub's own last-update time for the pull request. `coverage` is `webhook` when the repository's GitHub webhooks reach the server, which applies them as they arrive and reads GitHub about hourly, or `polling`, when it reads GitHub every minute.",
      annotations: {
        title: "Get pull request state",
        readOnlyHint: true,
      },
      inputSchema: pullRequestInputSchema,
    },
    async ({ repository, number }) => {
      const state = await context.readWatch(repository, number);
      if (!state.snapshot) return { content: [{ type: "text" as const, text: "null" }] };
      // Validators are request bookkeeping for the next refresh, not pull request state.
      const { githubValidators: _validators, ...snapshot } = state.snapshot;
      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({ ...snapshot, polledAt: state.polledAt, coverage: state.coverage }),
        }],
      };
    },
  );

  server.registerTool(
    "list_pr_events",
    {
      title: "List pull request events",
      description: "Read recent webhook and snapshot events for a watched pull request.",
      annotations: {
        title: "List pull request events",
        readOnlyHint: true,
      },
      inputSchema: {
        ...pullRequestInputSchema,
        limit: z.number().int().min(1).max(100).default(20).describe("Maximum number of events"),
      },
    },
    async ({ repository, number, limit }) => {
      const state = await context.readWatch(repository, number);
      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({ repository, number, events: state.events.slice(-limit) }),
        }],
      };
    },
  );


  server.registerResource(
    "pull_request",
    new ResourceTemplate("watch-pr://{owner}/{repo}/pull/{number}", {
      list: async () => ({
        resources: (await context.listWatches()).map((watch) => ({
          uri: watch.resourceUri,
          name: watch.key,
          description: `Live GitHub pull request resource for ${watch.key}`,
          mimeType: "application/json",
        })),
      }),
    }),
    {
      description: "Latest snapshot and event history for a watched pull request.",
      mimeType: "application/json",
    },
    async (uri) => {
      const parsed = parseResourceUri(uri.href);
      if (!parsed) throw new Error(`${uri.href} is not a watch-pr resource; expected watch-pr://OWNER/REPO/pull/NUMBER`);
      const key = watchKey(parsed.repository, parsed.number);
      if (!context.watches.has(key)) throw new Error(`${key} is not watched by this account; call watch_pr with this repository and number first`);
      return {
        contents: [{
          uri: uri.href,
          mimeType: "application/json",
          text: JSON.stringify(await context.readWatch(parsed.repository, parsed.number)),
        }],
      };
    },
  );

  server.server.setRequestHandler(SubscribeRequestSchema, async ({ params }) => {
    const parsed = parseResourceUri(params.uri);
    if (!parsed) throw new Error(`${params.uri} is not a watch-pr resource; expected watch-pr://OWNER/REPO/pull/NUMBER`);
    await context.subscribe(parsed.repository, parsed.number);
    return {};
  });

  server.server.setRequestHandler(UnsubscribeRequestSchema, async ({ params }) => {
    const parsed = parseResourceUri(params.uri);
    if (!parsed) throw new Error(`${params.uri} is not a watch-pr resource; expected watch-pr://OWNER/REPO/pull/NUMBER`);
    await context.unsubscribe(parsed.repository, parsed.number);
    return {};
  });

  server.server.setRequestHandler(ReadResourceRequestSchema, async ({ params }, extra) => {
    const parsed = parseResourceUri(params.uri);
    if (!parsed) throw new Error(`${params.uri} is not a watch-pr resource; expected watch-pr://OWNER/REPO/pull/NUMBER`);
    const key = watchKey(parsed.repository, parsed.number);
    if (!context.watches.has(key)) throw new Error(`${key} is not watched by this account; call watch_pr with this repository and number first`);
    return {
      contents: [{
        uri: params.uri,
        mimeType: "application/json",
        text: JSON.stringify(await context.readWatch(parsed.repository, parsed.number)),
      }],
    };
  });

  return server;
}
