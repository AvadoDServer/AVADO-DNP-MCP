import { readdirSync, readFileSync, statSync } from "node:fs";
import type { IncomingMessage, RequestListener, ServerResponse } from "node:http";
import path from "node:path";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { ActivityLog } from "./activity.js";
import type { Approvals } from "./approvals.js";
import type { Box } from "./box.js";
import type { Config } from "./config.js";
import { checkCsrf, isSafeMethod } from "./csrf.js";
import { isAllowedHost } from "./host.js";
import { errorMessage, type Logger } from "./log.js";
import { RateLimiter } from "./ratelimit.js";
import type { FetchLike } from "./store.js";
import { TokenError, type TokenRecord, type TokenStore } from "./tokens.js";
import { TOOLS, buildMcpServer, toolsFor, type ToolContext } from "./tools.js";

export const PAGE_CSP = [
  "default-src 'self'",
  "connect-src 'self'",
  "img-src 'self' data:",
  "style-src 'self'",
  "font-src 'self'",
  "script-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'self' http://my.ava.do https://my.ava.do",
].join("; ");

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

const MAX_BODY = 1024 * 1024;

export function sendJson(res: ServerResponse, statusCode: number, body: unknown, extra: Record<string, string> = {}): void {
  const text = JSON.stringify(body);
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(text),
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    ...extra,
  });
  res.end(text);
}

const sendError = (res: ServerResponse, code: number, message: string, extra: Record<string, string> = {}) => sendJson(res, code, { error: message }, extra);

/** JSON-RPC error for /mcp, so MCP clients show the message. */
function rpcError(res: ServerResponse, status: number, message: string, extra: Record<string, string> = {}) {
  sendJson(res, status, { jsonrpc: "2.0", error: { code: -32001, message }, id: null }, extra);
}

export function loadStaticFiles(dir: string): Map<string, { type: string; body: Buffer }> {
  const files = new Map<string, { type: string; body: Buffer }>();
  let names: string[] = [];
  try {
    names = readdirSync(dir);
  } catch {
    return files;
  }
  for (const name of names) {
    const type = MIME[path.extname(name).toLowerCase()];
    if (!type || name.startsWith(".")) continue;
    const file = path.join(dir, name);
    if (!statSync(file).isFile()) continue;
    files.set(`/${name}`, { type, body: readFileSync(file) });
  }
  const index = files.get("/index.html");
  if (index) files.set("/", index);
  return files;
}

function serveStatic(req: IncomingMessage, res: ServerResponse, pathname: string, files: Map<string, { type: string; body: Buffer }>): void {
  if (req.method !== "GET" && req.method !== "HEAD") {
    res.writeHead(405, { Allow: "GET, HEAD", "Content-Type": "text/plain; charset=utf-8" });
    res.end("Method not allowed");
    return;
  }
  const file = files.get(pathname);
  if (!file) {
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8", "X-Content-Type-Options": "nosniff", "Content-Security-Policy": PAGE_CSP });
    res.end("Not found");
    return;
  }
  res.writeHead(200, {
    "Content-Type": file.type,
    "Content-Length": file.body.length,
    "Cache-Control": "no-cache",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "Content-Security-Policy": PAGE_CSP,
  });
  res.end(req.method === "HEAD" ? undefined : file.body);
}

async function readBody(req: IncomingMessage, max = MAX_BODY): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const b = chunk as Buffer;
    size += b.length;
    if (size > max) throw new Error("too large");
    chunks.push(b);
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const raw = await readBody(req, 16 * 1024);
  if (!raw) return {};
  const v = JSON.parse(raw) as unknown;
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

export interface AppDeps {
  config: Config;
  logger: Logger;
  box: Box;
  tokens: TokenStore;
  activity: ActivityLog;
  approvals: Approvals;
  fetch: FetchLike;
  /** Whether HTTPS is up (for the page). */
  httpsInfo(): { on: boolean; validTo: string | null };
}

export interface Limits {
  /** MCP requests per key */
  requests: RateLimiter;
  /** actions per key */
  actions: RateLimiter;
  /** requests with a missing or wrong key, per client address */
  badAuth: RateLimiter;
}

export function defaultLimits(): Limits {
  return {
    requests: new RateLimiter(120, 60_000),
    actions: new RateLimiter(10, 60 * 60_000),
    badAuth: new RateLimiter(20, 5 * 60_000),
  };
}

/** /mcp or /k/<key>/mcp (for apps that can only take a link, such as ChatGPT). */
export function parseMcpPath(pathname: string): { match: boolean; key: string | null } {
  if (pathname === "/mcp" || pathname === "/mcp/") return { match: true, key: null };
  const m = /^\/k\/([A-Za-z0-9_-]{1,200})\/mcp\/?$/.exec(pathname);
  if (m) return { match: true, key: m[1]! };
  return { match: false, key: null };
}

function bearer(req: IncomingMessage): string | null {
  const h = req.headers.authorization;
  if (typeof h !== "string") return null;
  const m = /^Bearer\s+(\S+)\s*$/i.exec(h);
  return m ? m[1]! : null;
}

function clientAddress(req: IncomingMessage): string {
  return req.socket.remoteAddress ?? "unknown";
}

/** The MCP endpoint, shared by the main and the agent-only listener. */
export async function handleMcp(req: IncomingMessage, res: ServerResponse, pathKey: string | null, deps: AppDeps, limits: Limits): Promise<void> {
  const { config, activity, tokens } = deps;
  // MCP spec: validate Origin against DNS rebinding. Native agents send none.
  const origin = req.headers.origin;
  if (typeof origin === "string" && !config.allowedOrigins.includes(origin.toLowerCase())) {
    return rpcError(res, 403, "This address does not accept requests from web pages.");
  }
  if (req.method !== "POST") {
    // stateless server: no server-to-client stream, no sessions to delete
    res.setHeader("Allow", "POST");
    return rpcError(res, 405, "Use POST for MCP requests.");
  }
  const addr = clientAddress(req);
  if (limits.badAuth.blocked(addr)) {
    return rpcError(res, 429, "Too many requests with a wrong key. Wait a few minutes.", { "Retry-After": "300" });
  }
  const presented = pathKey ?? bearer(req);
  const token: TokenRecord | null = tokens.verify(presented);
  if (!token) {
    limits.badAuth.take(addr);
    activity.add({ who: null, tokenId: null, tool: "connect", outcome: "refused", detail: presented ? "A key that is not (or no longer) valid was used." : "A request without a key." });
    return rpcError(res, 401, presented ? "This key is not valid (it may have been removed). Make a new one on the AI Connect page." : "A key is needed. Make one on the AI Connect page (http://mcp.my.ava.do).", {
      "WWW-Authenticate": 'Bearer realm="AVADO AI Connect"',
    });
  }
  if (!limits.requests.take(token.id)) {
    return rpcError(res, 429, "Too many requests. Wait a minute.", { "Retry-After": "60" });
  }
  tokens.touch(token);

  let body: unknown;
  try {
    body = JSON.parse(await readBody(req));
  } catch {
    return rpcError(res, 400, "The request is not valid JSON (or larger than 1 MB).");
  }

  // A call to a tool this key cannot use never reaches a handler (the tool is not registered for
  // the key, so the SDK answers "not found"); log it here so the owner sees the attempt.
  const allowed = new Set(toolsFor(token.scopes).map((t) => t.name));
  for (const msg of Array.isArray(body) ? body : [body]) {
    const m = msg as { method?: unknown; params?: { name?: unknown } } | null;
    if (m?.method !== "tools/call" || typeof m.params?.name !== "string" || allowed.has(m.params.name)) continue;
    const known = TOOLS.find((t) => t.name === m.params!.name);
    activity.add({
      who: token.name,
      tokenId: token.id,
      tool: m.params.name.slice(0, 60),
      outcome: "refused",
      detail: known ? `This connection does not have the “${known.scope}” permission.` : "No such tool.",
    });
  }

  const ctx: ToolContext = {
    token,
    box: deps.box,
    activity,
    approvals: deps.approvals,
    tokens,
    actionLimiter: limits.actions,
    approvalTimeoutMs: config.approvalTimeoutMs,
    logger: deps.logger,
    version: config.version,
  };
  const server = buildMcpServer(ctx);
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  res.on("close", () => {
    void transport.close();
    void server.close();
  });
  await server.connect(transport);
  await transport.handleRequest(req, res, body);
}

/** What the Tailscale package says about itself (when installed), for the page. */
async function tailscaleInfo(fetchImpl: FetchLike): Promise<Record<string, unknown> | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 2_000);
  try {
    const res = await fetchImpl("http://tailscale.my.ava.do/api/status", { signal: controller.signal, headers: { Accept: "application/json" } });
    if (!res.ok) return null;
    const s = (await res.json()) as Record<string, unknown>;
    const pick = (k: string) => (typeof s[k] === "string" || typeof s[k] === "boolean" ? s[k] : null);
    return {
      state: pick("state"),
      dnsName: pick("dnsName"),
      mcpUrl: pick("mcpUrl"),
      mcpShared: pick("mcpShared"),
      funnel: pick("funnel"),
      publicMcpUrl: pick("publicMcpUrl"),
    };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** The agent-only listener (Tailscale forwards here): /mcp and nothing else. */
export function createAgentApp(deps: AppDeps, limits: Limits): RequestListener {
  return (req, res) => {
    void (async () => {
      const pathname = new URL(req.url ?? "/", "http://localhost").pathname;
      const mcp = parseMcpPath(pathname);
      if (!mcp.match) {
        res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8", "X-Content-Type-Options": "nosniff" });
        res.end("AVADO AI Connect: only the MCP endpoint (/mcp) is reachable here.");
        return;
      }
      await handleMcp(req, res, mcp.key, deps, limits);
    })().catch((err: unknown) => {
      deps.logger.error(`agent request failed: ${errorMessage(err)}`);
      if (!res.headersSent) rpcError(res, 500, "Internal error");
      else res.destroy();
    });
  };
}

/** The page, its API and the MCP endpoint (http://mcp.my.ava.do and https://mcp.my.ava.do). */
export function createApp(deps: AppDeps, limits: Limits): RequestListener {
  const { config, logger, tokens, activity, approvals, box } = deps;
  const files = loadStaticFiles(config.publicDir);

  return (req, res) => {
    void (async () => {
      let url: URL;
      try {
        url = new URL(req.url ?? "/", "http://localhost");
      } catch {
        return sendError(res, 400, "Bad request");
      }
      const pathname = url.pathname;

      const mcp = parseMcpPath(pathname);
      if (mcp.match) return handleMcp(req, res, mcp.key, deps, limits);

      if (!pathname.startsWith("/api/")) return serveStatic(req, res, pathname, files);

      // DNS rebinding guard: the page's API only answers requests addressed to this box
      if (!isAllowedHost(req.headers.host, config.allowedHostnames)) {
        logger.warn(`${req.method} ${pathname} refused: Host not allowed`);
        return sendError(res, 421, "This page only answers requests addressed to your AVADO");
      }
      const csrf = checkCsrf(req);
      if (csrf) {
        logger.warn(`${req.method} ${pathname} refused: ${csrf}`);
        return sendError(res, 403, csrf);
      }

      if (pathname === "/api/state") {
        if (!isSafeMethod(req.method)) return sendError(res, 405, "Use GET for this route", { Allow: "GET" });
        return sendJson(res, 200, {
          version: config.version,
          https: deps.httpsInfo(),
          tokens: tokens.list(),
          approvals: approvals.list(),
          activity: activity.list(150),
          jobs: box.jobsList(),
          tailscale: await tailscaleInfo(deps.fetch),
        });
      }

      if (pathname === "/api/tokens") {
        if (req.method !== "POST") return sendError(res, 405, "Use POST for this route", { Allow: "POST" });
        try {
          const body = await readJson(req);
          const made = await tokens.create({ name: body.name, client: body.client, scopes: body.scopes, confirmActions: body.confirmActions });
          activity.add({ who: made.record.name, tokenId: made.record.id, tool: "new connection", outcome: "ok", detail: `Made on this page. Can: ${made.record.scopes.join(", ")}.` });
          return sendJson(res, 200, made);
        } catch (e) {
          if (e instanceof TokenError) return sendError(res, 400, e.message);
          if (e instanceof SyntaxError) return sendError(res, 400, "Bad request");
          throw e;
        }
      }

      const tok = /^\/api\/tokens\/([0-9a-f-]{36})\/(revoke|confirm)$/.exec(pathname);
      if (tok) {
        if (req.method !== "POST") return sendError(res, 405, "Use POST for this route", { Allow: "POST" });
        const [, id, op] = tok;
        const before = tokens.list().find((t) => t.id === id);
        if (!before) return sendError(res, 404, "That connection no longer exists.");
        if (op === "revoke") {
          await tokens.revoke(id!);
          approvals.dropToken(id!);
          activity.add({ who: before.name, tokenId: id!, tool: "remove connection", outcome: "ok", detail: "Removed on this page. Its key no longer works." });
          return sendJson(res, 200, { ok: true });
        }
        const body = await readJson(req).catch(() => ({}) as Record<string, unknown>);
        const on = body.confirmActions !== false;
        await tokens.setConfirm(id!, on);
        activity.add({ who: before.name, tokenId: id!, tool: "settings", outcome: "ok", detail: on ? "Actions now wait for your OK." : "Actions now run without asking." });
        return sendJson(res, 200, { ok: true });
      }

      const appr = /^\/api\/approvals\/([0-9a-f-]{36})$/.exec(pathname);
      if (appr) {
        if (req.method !== "POST") return sendError(res, 405, "Use POST for this route", { Allow: "POST" });
        const body = await readJson(req).catch(() => ({}) as Record<string, unknown>);
        const allow = body.decision === "allow";
        const item = approvals.list().find((a) => a.id === appr[1]);
        if (!item || !approvals.decide(appr[1]!, allow ? "allowed" : "declined")) return sendError(res, 404, "That request is no longer waiting.");
        return sendJson(res, 200, { ok: true });
      }

      return sendError(res, 404, "Unknown API route");
    })().catch((err: unknown) => {
      logger.error(`request failed: ${errorMessage(err)}`);
      if (!res.headersSent) sendError(res, 500, "Internal error");
      else res.destroy();
    });
  };
}
