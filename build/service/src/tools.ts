/**
 * The MCP tools. This file is the complete list of what an agent can do: there is no generic
 * "call the DAPPMANAGER", "run a command" or "read a file" tool, and none is ever built from input.
 *
 * Each tool needs one scope. A key without the scope does not see the tool in tools/list, and a
 * call to it anyway is refused here as well (runTool checks again) and written to the activity log.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ActivityLog } from "./activity.js";
import type { Approvals } from "./approvals.js";
import { BoxError, type Box } from "./box.js";
import { errorMessage, type Logger } from "./log.js";
import type { RateLimiter } from "./ratelimit.js";
import type { Scope, TokenRecord, TokenStore } from "./tokens.js";

export interface ToolContext {
  token: TokenRecord;
  box: Box;
  activity: ActivityLog;
  approvals: Approvals;
  tokens: TokenStore;
  actionLimiter: RateLimiter;
  approvalTimeoutMs: number;
  logger: Logger;
  version: string;
}

export interface ToolResult {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
  [key: string]: unknown;
}

type Args = Record<string, unknown>;

interface ToolDef {
  name: string;
  scope: Scope;
  title: string;
  description: string;
  input: z.ZodRawShape;
  readOnly: boolean;
  run(args: Args, ctx: ToolContext): Promise<ToolResult>;
}

const text = (body: unknown): ToolResult => ({
  content: [{ type: "text", text: typeof body === "string" ? body : JSON.stringify(body, null, 1) }],
});
const fail = (message: string): ToolResult => ({ content: [{ type: "text", text: message }], isError: true });

const appArg = z.string().min(1).max(100).describe("The app: its short name (e.g. “teku”), full name (teku.avado.dnp.dappnode.eth) or title.");

/** A read tool: runs, and logs the call. */
function read(name: string, scope: Scope, fn: (args: Args, ctx: ToolContext) => Promise<unknown>, target?: (a: Args) => string | undefined) {
  return async (args: Args, ctx: ToolContext): Promise<ToolResult> => {
    const t0 = Date.now();
    try {
      const out = await fn(args, ctx);
      ctx.activity.add({ who: ctx.token.name, tokenId: ctx.token.id, tool: name, target: target?.(args), outcome: "ok", ms: Date.now() - t0 });
      return text(out);
    } catch (e) {
      const refused = e instanceof BoxError && e.kind === "refused";
      ctx.activity.add({ who: ctx.token.name, tokenId: ctx.token.id, tool: name, target: target?.(args), outcome: refused ? "refused" : "error", detail: errorMessage(e), ms: Date.now() - t0 });
      void scope;
      return fail(e instanceof BoxError ? e.message : `Something went wrong: ${errorMessage(e)}`);
    }
  };
}

/**
 * An action: scope (checked by runTool), a per-key limit, the never-list (resolve), the owner's OK
 * when the key asks for it, then the action. Every step is logged.
 */
function action<T>(
  name: string,
  resolve: (args: Args, ctx: ToolContext) => Promise<T>,
  describe: (t: T) => { summary: string; target: string },
  perform: (t: T, ctx: ToolContext) => Promise<string>,
) {
  return async (args: Args, ctx: ToolContext): Promise<ToolResult> => {
    const who = ctx.token.name;
    const tokenId = ctx.token.id;
    const t0 = Date.now();
    if (!ctx.actionLimiter.take(tokenId)) {
      ctx.activity.add({ who, tokenId, tool: name, outcome: "refused", detail: "Too many actions in the last hour." });
      return fail(`This connection may run at most ${ctx.actionLimiter.limit} actions an hour. Try again later.`);
    }
    let resolved: T;
    try {
      resolved = await resolve(args, ctx);
    } catch (e) {
      const refused = e instanceof BoxError && e.kind === "refused";
      ctx.activity.add({ who, tokenId, tool: name, target: typeof args.app === "string" ? args.app : undefined, outcome: refused ? "refused" : "error", detail: errorMessage(e) });
      return fail(e instanceof BoxError ? e.message : `Something went wrong: ${errorMessage(e)}`);
    }
    const { summary, target } = describe(resolved);
    if (ctx.token.confirmActions) {
      const { item, decision } = ctx.approvals.request({ who, tokenId, summary, tool: name, target }, ctx.approvalTimeoutMs);
      ctx.activity.add({ who, tokenId, tool: name, target, outcome: "waiting", detail: summary });
      const d = await decision;
      if (d !== "allowed") {
        ctx.activity.add({ who, tokenId, tool: name, target, outcome: "declined", detail: d === "expired" ? "Nobody allowed it in time, so it did not run." : "You did not allow it." });
        return fail(
          d === "expired"
            ? `Nothing was done: the owner did not allow “${summary}” on the AI Connect page (http://mcp.my.ava.do) within ${Math.round(ctx.approvalTimeoutMs / 1000)} seconds. Ask them to open the page and try again.`
            : `Nothing was done: the owner did not allow “${summary}”.`,
        );
      }
      void item;
    }
    try {
      const message = await perform(resolved, ctx);
      ctx.activity.add({ who, tokenId, tool: name, target, outcome: message.startsWith("Started:") ? "started" : "ok", detail: message, ms: Date.now() - t0 });
      return text(message);
    } catch (e) {
      ctx.activity.add({ who, tokenId, tool: name, target, outcome: "error", detail: errorMessage(e), ms: Date.now() - t0 });
      return fail(e instanceof BoxError ? e.message : `${summary} did not work: ${errorMessage(e)}`);
    }
  };
}

export const TOOLS: readonly ToolDef[] = [
  {
    name: "box_overview",
    scope: "read",
    title: "Box overview",
    description: "The AVADO box at a glance: system version, operating system, uptime, CPU, memory, disk use and space left, temperatures, and how many apps are installed and running.",
    input: {},
    readOnly: true,
    run: read("box_overview", "read", (_a, ctx) => ctx.box.overview()),
  },
  {
    name: "list_apps",
    scope: "read",
    title: "Installed apps",
    description: "Every app installed on the box with its version, whether it is running, whether it is a system part, whether it updates itself, its data size and its web page.",
    input: {},
    readOnly: true,
    run: read("list_apps", "read", async (_a, ctx) => ({ apps: await ctx.box.apps() })),
  },
  {
    name: "health_check",
    scope: "read",
    title: "Health check",
    description:
      "Runs the same health check as the AVADO Admin's Home page and returns what needs attention, in plain language (each finding has a title and why it matters), plus apps whose processes are down, out of memory or restarting.",
    input: {},
    readOnly: true,
    run: read("health_check", "read", (_a, ctx) => ctx.box.health()),
  },
  {
    name: "app_logs",
    scope: "read",
    title: "App log",
    description:
      "The newest lines of one app's log (100 by default, at most 500, at most 48 kB). Secret-looking text such as keys, passwords and recovery phrases is hidden before it is returned.",
    input: { app: appArg, lines: z.number().int().min(1).max(500).optional().describe("How many of the newest lines (default 100, at most 500).") },
    readOnly: true,
    run: read("app_logs", "read", (a, ctx) => ctx.box.logs(String(a.app), typeof a.lines === "number" ? a.lines : 100), (a) => String(a.app)),
  },
  {
    name: "ethereum_status",
    scope: "read",
    title: "Node sync and peers",
    description: "For each Ethereum (and other chain) node app on the box: whether it is reachable, syncing or in sync, how far behind it is, its peer count, client version, and how many validators it runs (a count only, never keys).",
    input: {},
    readOnly: true,
    run: read("ethereum_status", "read", (_a, ctx) => ctx.box.ethereum()),
  },
  {
    name: "store_apps",
    scope: "read",
    title: "AVADO store",
    description: "The apps in the AVADO store this box uses, with their latest version, whether each is installed here and whether an update is available.",
    input: { include_all: z.boolean().optional().describe("Also list old, test-network and system entries (default false).") },
    readOnly: true,
    run: read("store_apps", "read", (a, ctx) => ctx.box.store(a.include_all === true)),
  },
  {
    name: "action_status",
    scope: "read",
    title: "Install progress",
    description: "Whether the installs and updates started through AI Connect have finished.",
    input: {},
    readOnly: true,
    run: read("action_status", "read", async (_a, ctx) => ({ jobs: ctx.box.jobsList() })),
  },
  {
    name: "restart_app",
    scope: "restart",
    title: "Restart an app",
    description:
      "Restarts one installed app (stops it and starts it again; its data stays). System parts of AVADO and AI Connect itself cannot be restarted. The owner may have to allow it on the AI Connect page first.",
    input: { app: appArg },
    readOnly: false,
    run: action(
      "restart_app",
      (a, ctx) => ctx.box.resolveRestart(String(a.app)),
      (t) => ({ summary: `Restart ${t.title}`, target: t.name }),
      (t, ctx) => ctx.box.restart(t),
    ),
  },
  {
    name: "install_app",
    scope: "install",
    title: "Install an app from the AVADO store",
    description:
      "Installs an app from the AVADO store with its default settings (nothing else can be installed). Takes from a minute to much longer for big apps; use action_status to follow it. The owner may have to allow it on the AI Connect page first.",
    input: { app: z.string().min(1).max(100).describe("The store app's short name, full name or title (see store_apps).") },
    readOnly: false,
    run: action(
      "install_app",
      (a, ctx) => ctx.box.resolveInstall(String(a.app), "install"),
      (e) => ({ summary: `Install ${e.title} ${e.version}`, target: e.name }),
      async (e, ctx) => jobMessage(await ctx.box.install(e, "install")),
    ),
  },
  {
    name: "update_app",
    scope: "install",
    title: "Update an app",
    description:
      "Updates an installed app to the latest version in the AVADO store, keeping its data and settings. System parts update themselves and cannot be updated here. The owner may have to allow it on the AI Connect page first.",
    input: { app: appArg },
    readOnly: false,
    run: action(
      "update_app",
      (a, ctx) => ctx.box.resolveInstall(String(a.app), "update"),
      (e) => ({ summary: `Update ${e.title} from ${e.installed} to ${e.version}`, target: e.name }),
      async (e, ctx) => jobMessage(await ctx.box.install(e, "update")),
    ),
  },
];

function jobMessage(job: { id: string; state: string; message: string }): string {
  if (job.state === "running") return `Started: ${job.message} It is still running; check again with action_status (job ${job.id}).`;
  if (job.state === "failed") throw new BoxError(job.message, "failed");
  return job.message;
}

export function toolsFor(scopes: readonly Scope[]): ToolDef[] {
  return TOOLS.filter((t) => scopes.includes(t.scope));
}

/** Runs a tool by name for a key, checking the scope again (a tool not listed for the key may still be called). */
export async function runTool(name: string, args: Args, ctx: ToolContext): Promise<ToolResult> {
  const tool = TOOLS.find((t) => t.name === name);
  if (!tool) {
    ctx.activity.add({ who: ctx.token.name, tokenId: ctx.token.id, tool: name.slice(0, 60), outcome: "refused", detail: "No such tool." });
    return fail(`There is no tool called ${name}.`);
  }
  if (!ctx.token.scopes.includes(tool.scope)) {
    ctx.activity.add({ who: ctx.token.name, tokenId: ctx.token.id, tool: name, target: typeof args.app === "string" ? args.app : undefined, outcome: "refused", detail: `This connection does not have the “${tool.scope}” permission.` });
    return fail(`This connection is not allowed to ${tool.title.toLowerCase()}. The owner can make a new connection with that permission on the AI Connect page.`);
  }
  return tool.run(args, ctx);
}

export const INSTRUCTIONS = [
  "You are connected to the owner's AVADO box (a home server for Ethereum staking and other apps) through AVADO AI Connect.",
  "Start with health_check or box_overview. Explain findings in plain language: the owner is usually not technical.",
  "Some connections may restart, install or update apps; the owner may have to click Allow on the AI Connect page first, so tell them when you start one.",
  "AI Connect can never: read validator keys or their passwords, export slashing protection, change withdrawal or fee-recipient settings, read wallet recovery phrases, Rocket Pool or other wallets, the Admin password, run commands, or remove apps or data. Do not ask the owner to paste any of those to you either.",
].join(" ");

export function buildMcpServer(ctx: ToolContext): McpServer {
  const server = new McpServer({ name: "avado-ai-connect", title: "AVADO AI Connect", version: ctx.version }, { instructions: INSTRUCTIONS });
  // registerTool's generic zod typing is too deep for tsc with a list of tools; the shapes are plain zod raw shapes
  const register = server.registerTool.bind(server) as unknown as (name: string, config: Record<string, unknown>, cb: (args: Args) => Promise<ToolResult>) => unknown;
  for (const tool of toolsFor(ctx.token.scopes)) {
    register(
      tool.name,
      {
        title: tool.title,
        description: tool.description,
        inputSchema: tool.input,
        annotations: { title: tool.title, readOnlyHint: tool.readOnly, destructiveHint: false, idempotentHint: tool.readOnly, openWorldHint: false },
      },
      async (args: Args) => runTool(tool.name, args ?? {}, ctx),
    );
  }
  return server;
}
