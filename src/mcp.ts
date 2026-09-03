import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { CfWorkerJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/cfworker";
import { ReadResourceRequestSchema, SubscribeRequestSchema, UnsubscribeRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import * as z from "zod/v4";
import { parseResourceUri, resourceUri, watchKey } from "./events";
import type { GithubUser, PullRequestSnapshot, StoredWatchState } from "./types";

export interface WatchRegistration {
  key: string;
  repository: string;
  number: number;
  resourceUri: string;
  snapshot: PullRequestSnapshot | null;
  refreshScheduled: boolean;
}

export interface McpSessionContext {
  user: GithubUser;
  watches: Set<string>;
  watch(repository: string, number: number): Promise<WatchRegistration>;
  unwatch(repository: string, number: number): Promise<boolean>;
  listWatches(): Promise<WatchRegistration[]>;
  readWatch(repository: string, number: number): Promise<StoredWatchState>;
  subscribe(repository: string, number: number): Promise<void>;
  unsubscribe(repository: string, number: number): Promise<void>;
}

const watchInputSchema = {
  repository: z.string().describe("GitHub repository in owner/name form"),
  number: z.number().int().positive().describe("Pull request number"),
};

function textResult(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value) }] };
}

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
      description: "Subscribe to a pull request and receive lifecycle changes as MCP resource updates.",
      inputSchema: watchInputSchema,
    },
    async ({ repository, number }) => textResult(await context.watch(repository, number)),
  );

  server.registerTool(
    "unwatch_pr",
    {
      title: "Unwatch pull request",
      description: "Stop receiving updates for a pull request.",
      inputSchema: watchInputSchema,
    },
    async ({ repository, number }) => textResult({
      repository,
      number,
      removed: await context.unwatch(repository, number),
    }),
  );

  server.registerTool(
    "list_watched_prs",
    {
      title: "List watched pull requests",
      description: "List pull requests watched by the authenticated GitHub account.",
    },
    async () => textResult(await context.listWatches()),
  );

  server.registerTool(
    "get_pr",
    {
      title: "Get pull request state",
      description: "Read the latest durable pull request snapshot. A refresh is scheduled after webhook or timer events.",
      inputSchema: watchInputSchema,
    },
    async ({ repository, number }) => textResult(await context.readWatch(repository, number)),
  );

  server.registerTool(
    "list_pr_events",
    {
      title: "List pull request events",
      description: "Read recent webhook and snapshot events for a watched pull request.",
      inputSchema: {
        ...watchInputSchema,
        limit: z.number().int().min(1).max(100).default(20).describe("Maximum number of events"),
      },
    },
    async ({ repository, number, limit }) => {
      const state = await context.readWatch(repository, number);
      return textResult({ repository, number, events: state.events.slice(-limit) });
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
      if (!parsed) throw new Error("invalid watch-pr resource URI");
      const key = watchKey(parsed.repository, parsed.number);
      if (!context.watches.has(key)) throw new Error("pull request is not watched by this session");
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
    if (!parsed) throw new Error("invalid watch-pr resource URI");
    await context.subscribe(parsed.repository, parsed.number);
    return {};
  });

  server.server.setRequestHandler(UnsubscribeRequestSchema, async ({ params }) => {
    const parsed = parseResourceUri(params.uri);
    if (!parsed) throw new Error("invalid watch-pr resource URI");
    await context.unsubscribe(parsed.repository, parsed.number);
    return {};
  });

  server.server.setRequestHandler(ReadResourceRequestSchema, async ({ params }, extra) => {
    const parsed = parseResourceUri(params.uri);
    if (!parsed) throw new Error("invalid watch-pr resource URI");
    const key = watchKey(parsed.repository, parsed.number);
    if (!context.watches.has(key)) throw new Error("pull request is not watched by this session");
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
