import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { CfWorkerJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/cfworker";
import { ReadResourceRequestSchema, SubscribeRequestSchema, UnsubscribeRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import * as z from "zod/v4";
import { parseResourceUri, reactionStateLine, resourceUri, snapshotReactions, watchKey } from "./events";
import type { GithubUser, PrMonitorRegistration, PullRequestCheck, PullRequestComment, PullRequestSnapshot, PullRequestThread, StoredWatchState, WatchEvent } from "./types";

export type McpOutputMode = "brief" | "full";

/** A brief snapshot spends at most this many lines, and this many characters, on reactions. */
const MAX_BRIEF_REACTION_LINES = 12;
const MAX_BRIEF_REACTION_LENGTH = 1_000;

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
  openMonitor(repository: string, number: number): Promise<PrMonitorRegistration>;
  readWatch(repository: string, number: number): Promise<StoredWatchState>;
  subscribe(repository: string, number: number): Promise<void>;
  unsubscribe(repository: string, number: number): Promise<void>;
}

const outputModeSchema = z.enum(["brief", "full"]).default("brief").describe("Output detail: watcher-style lines or the full JSON record");

const pullRequestInputSchema = {
  repository: z.string().describe("GitHub repository in owner/name form"),
  number: z.number().int().positive().describe("Pull request number"),
};

const watchInputSchema = {
  ...pullRequestInputSchema,
  mode: outputModeSchema,
};

function textResult(value: unknown, mode: McpOutputMode, briefLines: string[]) {
  return {
    content: [{
      type: "text" as const,
      text: mode === "full" ? JSON.stringify(value) : briefLines.join("\n"),
    }],
  };
}

function checkBucket(check: PullRequestCheck): string {
  if (check.status?.toLowerCase() !== "completed") return "pending";
  switch (check.conclusion?.toLowerCase()) {
    case "success":
    case "neutral":
      return "pass";
    case "skipped":
      return "skipping";
    case "cancelled":
    case "canceled":
      return "cancel";
    case "pending":
      return "pending";
    default:
      return check.conclusion ? "fail" : "pending";
  }
}

function checkLines(checks: PullRequestCheck[]): string[] {
  return checks.map((check) => {
    const bucket = checkBucket(check);
    const completedAt = bucket === "pending" ? "" : check.completedAt ?? "";
    return `check ${check.name}: ${bucket}${completedAt ? ` @${completedAt}` : ""}`;
  });
}

function commentLocation(comment: PullRequestComment): string {
  if (!comment.path) return "?";
  const start = comment.startLine ?? comment.line;
  const end = comment.line ?? start;
  if (!start) return `${comment.path}:`;
  return `${comment.path}:${start}${end && end !== start ? `-${end}` : ""}`;
}

function stripXmlComments(value: string): string {
  return value.replace(/<!--[\s\S]*?-->/gu, "");
}

function feedbackLines(threads: PullRequestThread[], comments: PullRequestComment[]): string[] {
  const commentsById = new Map(comments.map((comment) => [comment.id, comment]));
  return threads
    .filter((thread) => !thread.isResolved)
    .map((thread) => thread.commentIds.map((id) => commentsById.get(id)).find((comment) => comment))
    .filter((comment): comment is PullRequestComment => Boolean(comment))
    .map((comment) => {
      const thread = threads.find((candidate) => candidate.commentIds.includes(comment.id));
      const title = stripXmlComments(comment.body).split(/\r?\n/u).map((line) => line.trim()).find(Boolean)?.slice(0, 100) ?? "";
      return `feedback [${thread?.id ?? comment.id}] ${commentLocation(comment)} @${comment.author ?? "unknown"}${title ? ` ${title}` : ""}`;
    });
}

/**
 * A brief listing summarises many PRs at once, so the attributed reaction lines of one
 * snapshot are bounded; the overflow is reported as a count rather than dropped silently.
 */
function briefReactionLines(snapshot: PullRequestSnapshot, user: GithubUser): string[] {
  // Reactions the watcher left are their own activity; everyone else's is the signal.
  // The actor's numeric ID is the identity: a renamed or recased login must still be theirs.
  const lines = snapshotReactions(snapshot)
    .filter((entry) => (entry.reaction.authorId === null
      ? entry.reaction.author !== user.login
      : entry.reaction.authorId !== user.id))
    .map(reactionStateLine)
    .sort();
  const kept: string[] = [];
  let length = 0;
  for (const line of lines) {
    if (kept.length === MAX_BRIEF_REACTION_LINES || length + line.length > MAX_BRIEF_REACTION_LENGTH) break;
    kept.push(line);
    length += line.length;
  }
  if (kept.length < lines.length) kept.push(`+${lines.length - kept.length} more reactions`);
  return kept;
}

function briefSnapshotLines(snapshot: PullRequestSnapshot, user: GithubUser): string[] {
  const comments = snapshot.comments.filter((comment) => comment.author !== user.login);
  const reviewComments = snapshot.reviewComments.filter((comment) => comment.author !== user.login);
  const reviews = snapshot.reviews.filter((review) => review.author !== user.login);
  const mergeableState = snapshot.mergeableState?.toUpperCase();
  const mergeable = snapshot.mergeable === null ? "unknown" : snapshot.mergeable ? "yes" : "no";
  const lines = [
    `PR ${snapshot.number}: ${snapshot.state.toUpperCase()}${snapshot.draft ? " DRAFT" : ""}`,
    `head: ${snapshot.headRefName}@${snapshot.headSha}`,
    `mergeable: ${mergeable}${mergeableState ? ` (${mergeableState})` : ""}`,
    ...checkLines(snapshot.checks),
    ...briefReactionLines(snapshot, user),
    ...reviews.map((review) => `review ${review.author ?? "unknown"}: ${review.state}${review.submittedAt ? ` @${review.submittedAt}` : ""}`),
    `reviews: ${reviews.length}`,
    `comments: ${comments.length}`,
    `review-comments: ${reviewComments.length}`,
  ];
  if (mergeableState === "BEHIND" || mergeableState === "DIRTY") lines.push(`rebase: ${mergeableState}`);
  if (snapshot.merged) lines.push(`PR ${snapshot.number} finished: MERGED`);
  else if (snapshot.state.toUpperCase() === "CLOSED") lines.push(`PR ${snapshot.number} finished: CLOSED`);
  return [...lines.sort(), ...feedbackLines(snapshot.threads, snapshot.reviewComments)];
}


function briefRegistration(registration: WatchRegistration, user: GithubUser): string[] {
  const lines = [`watching ${registration.key}`, `resource: ${registration.resourceUri}`];
  if (registration.snapshot) lines.push(...briefSnapshotLines(registration.snapshot, user));
  else if (registration.refreshScheduled) lines.push("snapshot: refresh scheduled");
  return lines;
}

function briefEventLines(events: WatchEvent[]): string[] {
  return events.map((event) => {
    const action = event.action ? ` ${event.action}` : "";
    const changes = event.changes.length ? ` (${event.changes.join(", ")})` : "";
    return `event ${event.githubEvent}${action}${changes} @${event.receivedAt}`;
  });
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
    async ({ repository, number, mode }) => {
      const registration = await context.watch(repository, number);
      return textResult(registration, mode, briefRegistration(registration, context.user));
    },
  );

  server.registerTool(
    "unwatch_pr",
    {
      title: "Unwatch pull request",
      description: "Stop receiving updates for a pull request.",
      inputSchema: watchInputSchema,
    },
    async ({ repository, number, mode }) => {
      const removed = await context.unwatch(repository, number);
      return textResult({ repository, number, removed }, mode, [
        `${removed ? "unwatched" : "not watching"} ${repository}#${number}`,
      ]);
    },
  );

  server.registerTool(
    "open_pr_monitor",
    {
      title: "Open pull request monitor",
      description: "Create a revocable read-only SSE capability for an already-watched pull request.",
      inputSchema: pullRequestInputSchema,
    },
    async ({ repository, number }) => ({
      content: [{
        type: "text" as const,
        text: JSON.stringify(await context.openMonitor(repository, number)),
      }],
    }),
  );

  server.registerTool(
    "list_watched_prs",
    {
      title: "List watched pull requests",
      description: "List pull requests watched by the authenticated GitHub account.",
      inputSchema: { mode: outputModeSchema },
    },
    async ({ mode }) => {
      const registrations = await context.listWatches();
      return textResult(
        registrations,
        mode,
        registrations.flatMap((registration) => briefRegistration(registration, context.user)),
      );
    },
  );

  server.registerTool(
    "get_pr",
    {
      title: "Get pull request state",
      description: "Read the latest durable pull request snapshot. A refresh is scheduled after webhook or timer events.",
      inputSchema: watchInputSchema,
    },
    async ({ repository, number, mode }) => {
      const state = await context.readWatch(repository, number);
      const lines = state.snapshot
        ? briefSnapshotLines(state.snapshot, context.user)
        : ["snapshot: unavailable"];
      return textResult(state.snapshot, mode, lines);
    },
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
    async ({ repository, number, limit, mode }) => {
      const state = await context.readWatch(repository, number);
      const events = state.events.slice(-limit);
      return textResult({ repository, number, events }, mode, briefEventLines(events));
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
