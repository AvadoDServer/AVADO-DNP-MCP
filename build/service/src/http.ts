import { readdirSync, readFileSync, statSync } from "node:fs";
import type { IncomingMessage, RequestListener, ServerResponse } from "node:http";
import { isIP } from "node:net";
import path from "node:path";
import type { TLSSocket } from "node:tls";
import { toNodeHandler } from "@modelcontextprotocol/node";
import { createMcpHandler, type AuthInfo } from "@modelcontextprotocol/server";
import type { ActivityLog } from "./activity.js";
import type { Approvals } from "./approvals.js";
import type { Box } from "./box.js";
import type { Config } from "./config.js";
import { checkCsrf, isSafeMethod } from "./csrf.js";
import { isAllowedHost } from "./host.js";
import { errorMessage, type Logger } from "./log.js";
import { ACCESS_TOKEN_PREFIX, bearerChallenge, OAuthError, resourceMetadata, serverMetadata, type OAuthServer } from "./oauth.js";
import { PinError, PinGuard } from "./pin.js";
import { RateLimiter } from "./ratelimit.js";
import type { Settings } from "./settings.js";
import type { FetchLike } from "./store.js";
import { TokenError, type TokenRecord, type TokenStore } from "./tokens.js";
import { TOOLS, VERBS, buildMcpServer, toolsFor, type ToolContext } from "./tools.js";

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
  /** The page PIN and its sessions. */
  pin: PinGuard;
  /** The "Allow changes" switch. */
  settings: Settings;
  /** Sign-in with the Connect button. */
  oauth: OAuthServer;
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
  /** sign-in requests (register, authorize, token), per listener: Funnel traffic shares one address */
  oauth: RateLimiter;
}

export function defaultLimits(): Limits {
  return {
    requests: new RateLimiter(120, 60_000),
    actions: new RateLimiter(10, 60 * 60_000),
    badAuth: new RateLimiter(20, 5 * 60_000),
    oauth: new RateLimiter(60, 10 * 60_000),
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

const plainAddress = (a: string) => (a.startsWith("::ffff:") && isIP(a.slice(7)) === 4 ? a.slice(7) : a);

/**
 * The device a request comes from, for the wrong-PIN count: the address of the connection. The
 * X-Forwarded-For header is used only when the connection comes from one of `trustedProxies`
 * (the rightmost address in it that is not itself a trusted proxy); otherwise any device could
 * send a made-up header and pass for another device.
 *
 * On an AVADO no proxy sits in front of the page today, so the list is empty: ZeroTier Remote
 * Access, the AVADO Wi-Fi and Tailscale pass connections on at the network level (each under its
 * own address on the AVADO network, without the header). All devices behind one of those share
 * one count; devices on different ways in, and other apps on the box, do not.
 */
export function clientAddress(req: IncomingMessage, trustedProxies: readonly string[] = []): string {
  const remote = plainAddress(req.socket.remoteAddress ?? "unknown");
  if (!trustedProxies.includes(remote)) return remote;
  const header = req.headers["x-forwarded-for"];
  const raw = Array.isArray(header) ? header.join(",") : header;
  if (!raw) return remote;
  const hops = raw.split(",").map((h) => plainAddress(h.trim()));
  for (let i = hops.length - 1; i >= 0; i--) {
    const hop = hops[i]!;
    if (!isIP(hop)) return remote;
    if (!trustedProxies.includes(hop)) return hop;
  }
  return remote;
}

/** What the agent-only port says about itself, so the Tailscale relay can check it reached AI Connect. */
export const IDENTITY_PATH = "/identity";
export const PACKAGE_NAME = "mcp.avado.dnp.dappnode.eth";

/**
 * The MCP endpoint, shared by the main and the agent-only listener. `base` is where this listener
 * is reached as an OAuth resource (https://mcp.my.ava.do, or the Tailscale address), or null when
 * unknown (then only keys work here).
 */
export async function handleMcp(req: IncomingMessage, res: ServerResponse, pathKey: string | null, deps: AppDeps, limits: Limits, base: string | null): Promise<void> {
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
  const presented = pathKey ?? bearer(req);
  // a key (avado_...) or an access token from the Connect button (aic_at_..., only in the header)
  const token: TokenRecord | null =
    !pathKey && presented?.startsWith(ACCESS_TOKEN_PREFIX) ? deps.oauth.verify(presented, base ? `${base}/mcp` : null) : tokens.verify(presented);
  if (!token) {
    // The wrong-key limit only ever stops requests without a valid key. Everything that comes in
    // through the Tailscale package (Serve, and Funnel from the internet) shares one client address,
    // so blocking the address itself would let any stranger lock the owner's assistants out.
    // A blocked address is not logged again either, so it cannot flood the activity list.
    if (limits.badAuth.blocked(addr)) {
      return rpcError(res, 429, "Too many requests with a wrong key. Wait a few minutes.", { "Retry-After": "300" });
    }
    limits.badAuth.take(addr);
    activity.add({ who: null, tokenId: null, tool: "connect", outcome: "refused", detail: presented ? "A key that is not (or no longer) valid was used." : "A request without a key." });
    return rpcError(res, 401, presented ? "This key is not valid (it may have been removed). Make a new one on the AI Connect page." : "A key is needed. Make one on the AI Connect page (http://mcp.my.ava.do).", {
      "WWW-Authenticate": bearerChallenge(base, presented ? "invalid_token" : undefined),
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
  const allowed = new Set(toolsFor(token.scopes, deps.settings.allowChanges).map((t) => t.name));
  for (const msg of Array.isArray(body) ? body : [body]) {
    const m = msg as { method?: unknown; params?: { name?: unknown } } | null;
    if (m?.method !== "tools/call" || typeof m.params?.name !== "string" || allowed.has(m.params.name)) continue;
    const known = TOOLS.find((t) => t.name === m.params!.name);
    const app = (m.params as { arguments?: { app?: unknown } }).arguments?.app;
    const changesOff = known && !known.readOnly && token.scopes.includes(known.scope);
    activity.add({
      who: token.name,
      tokenId: token.id,
      tool: m.params.name.slice(0, 60),
      ...(typeof app === "string" ? { target: app.slice(0, 100) } : {}),
      outcome: "refused",
      detail: changesOff ? "Changes are switched off." : known ? `This connection does not have the “${known.scope}” permission.` : "No such tool.",
      ...(changesOff
        ? { change: true, says: `${token.name} wanted to ${VERBS[known.name] ?? "change"} ${typeof app === "string" ? app.slice(0, 100) : "an app"}. Not done: changes are switched off.` }
        : {}),
    });
  }

  const ctx: ToolContext = {
    token,
    box: deps.box,
    activity,
    approvals: deps.approvals,
    tokens,
    settings: deps.settings,
    actionLimiter: limits.actions,
    approvalTimeoutMs: config.approvalTimeoutMs,
    logger: deps.logger,
    version: config.version,
  };
  // The SDK's per-request handler builds a fresh server for this request from the context of the
  // key that was checked above (it never reads keys or tokens itself). JSON answers only: an
  // ask-first action simply keeps the request open until the owner decides.
  const auth: AuthInfo = { token: token.id, clientId: token.oauth?.clientId ?? token.id, scopes: token.scopes, extra: { ctx } };
  (req as IncomingMessage & { auth?: AuthInfo }).auth = auth;
  await mcpNodeHandler(req as IncomingMessage & { auth?: AuthInfo }, res, body);
}

const mcpNodeHandler = toNodeHandler(
  createMcpHandler(({ authInfo }) => buildMcpServer(authInfo!.extra!.ctx as ToolContext), { responseMode: "json" }),
  { maxRequestBodySize: MAX_BODY },
);

// ---- sign-in with the Connect button (oauth.ts) ----

/** Files of the "Approve on your AVADO" page, served under /oauth/ on both listeners. */
const WAIT_FILES: Record<string, string> = {
  "/oauth/wait": "/connect.html",
  "/oauth/connect.js": "/connect.js",
  "/oauth/theme.css": "/theme.css",
  "/oauth/base.css": "/base.css",
  "/oauth/style.css": "/style.css",
  "/oauth/favicon.png": "/favicon.png",
};

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, MCP-Protocol-Version",
  "Access-Control-Max-Age": "600",
};

/** The Tailscale name the relay passed on (X-Forwarded-Host), as an https base; null when absent or odd. */
export function forwardedBase(req: IncomingMessage): string | null {
  const raw = req.headers["x-forwarded-host"];
  const host = (Array.isArray(raw) ? raw[0] : raw)?.split(",")[0]?.trim().toLowerCase().replace(/:443$/, "");
  if (!host || host.length > 253 || isIP(host)) return null;
  return /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(host) ? `https://${host}` : null;
}

async function readForm(req: IncomingMessage): Promise<URLSearchParams> {
  const raw = await readBody(req, 16 * 1024);
  const type = String(req.headers["content-type"] ?? "").toLowerCase();
  if (type.startsWith("application/json")) {
    const v = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
    return new URLSearchParams(Object.entries(v).flatMap(([k, x]) => (typeof x === "string" ? [[k, x]] : [])));
  }
  return new URLSearchParams(raw);
}

function problemPage(res: ServerResponse, status: number, text: string): void {
  const esc = text.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
  const body = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>AVADO AI Connect</title><link rel="stylesheet" href="/oauth/theme.css"><link rel="stylesheet" href="/oauth/base.css"><link rel="stylesheet" href="/oauth/style.css"></head><body><main class="shell"><section class="card"><h1>Connecting did not work</h1><p>${esc}</p></section></main></body></html>`;
  res.writeHead(status, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", "Content-Security-Policy": PAGE_CSP, "Referrer-Policy": "no-referrer" });
  res.end(body);
}

/**
 * The sign-in routes: metadata, registration, the authorize redirect, the token endpoint and the
 * waiting page. Returns false when the path is not one of them. `base` null: the listener does not
 * know its own address (agent port without the relay), so there is no sign-in there.
 */
async function handleOAuth(req: IncomingMessage, res: ServerResponse, url: URL, base: string | null, deps: AppDeps, limits: Limits, files: Map<string, { type: string; body: Buffer }>, kind: "main" | "agent"): Promise<boolean> {
  const p = url.pathname;
  const isWellKnown = p === "/.well-known/oauth-protected-resource" || p === "/.well-known/oauth-protected-resource/mcp" || p === "/.well-known/oauth-authorization-server";
  if (!isWellKnown && !p.startsWith("/oauth/")) return false;
  if (!base) {
    sendJson(res, 404, { error: "not_found", error_description: "Sign-in is not available on this address." });
    return true;
  }
  if (req.method === "OPTIONS") {
    res.writeHead(204, CORS);
    res.end();
    return true;
  }
  if (isWellKnown) {
    if (!isSafeMethod(req.method)) {
      sendError(res, 405, "Use GET", { Allow: "GET", ...CORS });
      return true;
    }
    sendJson(res, 200, p === "/.well-known/oauth-authorization-server" ? serverMetadata(base) : resourceMetadata(base), CORS);
    return true;
  }
  const asset = WAIT_FILES[p];
  if (asset) {
    serveStatic(req, res, asset, files);
    return true;
  }
  const oauthError = (e: OAuthError) =>
    sendJson(res, e.status, { error: e.code, error_description: e.message }, { ...CORS, ...(e.status === 401 ? { "WWW-Authenticate": 'Basic realm="AVADO AI Connect"' } : {}) });
  const limited = () => {
    if (limits.oauth.take(kind)) return false;
    sendJson(res, 429, { error: "slow_down", error_description: "Too many sign-in requests. Wait a few minutes." }, { "Retry-After": "120", ...CORS });
    return true;
  };

  if (p === "/oauth/wait/status") {
    const st = isSafeMethod(req.method) ? deps.oauth.waitStatus(url.searchParams.get("r") ?? "") : null;
    if (!isSafeMethod(req.method)) sendError(res, 405, "Use GET", { Allow: "GET" });
    else if (!st) sendJson(res, 404, { error: "This sign-in is no longer waiting. Go back to your app and press Connect again." });
    else sendJson(res, 200, { ...st, avadoPage: `${deps.config.localBase}/` });
    return true;
  }
  if (p === "/oauth/authorize") {
    if (!isSafeMethod(req.method)) {
      sendError(res, 405, "Use GET", { Allow: "GET" });
      return true;
    }
    if (limited()) return true;
    const out = await deps.oauth.authorize(url.searchParams, base);
    if ("problem" in out) {
      problemPage(res, 400, out.problem);
      return true;
    }
    res.writeHead(303, { Location: out.location, "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" });
    res.end();
    return true;
  }
  if (p === "/oauth/register" || p === "/oauth/token") {
    if (req.method !== "POST") {
      sendError(res, 405, "Use POST", { Allow: "POST", ...CORS });
      return true;
    }
    if (limited()) return true;
    try {
      if (p === "/oauth/register") {
        const body = await readJson(req);
        sendJson(res, 201, await deps.oauth.register(body), CORS);
      } else {
        const form = await readForm(req);
        sendJson(res, 200, await deps.oauth.token(form, req.headers.authorization), { ...CORS, Pragma: "no-cache" });
      }
    } catch (e) {
      if (e instanceof OAuthError) oauthError(e);
      else if (e instanceof SyntaxError) oauthError(new OAuthError("invalid_request", "The request body is not valid."));
      else throw e;
    }
    return true;
  }
  sendJson(res, 404, { error: "not_found" });
  return true;
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
  const files = loadStaticFiles(deps.config.publicDir);
  return (req, res) => {
    void (async () => {
      let url: URL;
      try {
        url = new URL(req.url ?? "/", "http://localhost");
      } catch {
        return sendError(res, 400, "Bad request");
      }
      const pathname = url.pathname;
      // The relay passes on the box's Tailscale name; that address is where apps sign in here.
      const base = deps.config.agentBase || forwardedBase(req);
      // No key and nothing private: a fixed name and the version. The Tailscale relay asks this
      // first, so it never sends an assistant's key to another app that took over the address.
      if (pathname === IDENTITY_PATH && (req.method === "GET" || req.method === "HEAD")) {
        return sendJson(res, 200, { name: PACKAGE_NAME, version: deps.config.version });
      }
      const mcp = parseMcpPath(pathname);
      if (mcp.match) return handleMcp(req, res, mcp.key, deps, limits, base);
      if (await handleOAuth(req, res, url, base, deps, limits, files, "agent")) return;
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8", "X-Content-Type-Options": "nosniff" });
      res.end("AVADO AI Connect: only the MCP endpoint (/mcp) and its sign-in are reachable here.");
    })().catch((err: unknown) => {
      deps.logger.error(`agent request failed: ${errorMessage(err)}`);
      if (!res.headersSent) rpcError(res, 500, "Internal error");
      else res.destroy();
    });
  };
}

/** The page, its API and the MCP endpoint (http://mcp.my.ava.do and https://mcp.my.ava.do). */
export function createApp(deps: AppDeps, limits: Limits): RequestListener {
  const { config, logger, tokens, activity, approvals, box, pin, settings, oauth } = deps;
  const files = loadStaticFiles(config.publicDir);

  const pinState = (cookie: string | undefined, unlocked: boolean, client: string) => ({
    set: pin.isSet(),
    unlocked,
    expiresAt: unlocked ? pin.expiresAt(cookie) : null,
    // for this device only
    retryAfter: pin.retryAfter(client),
    // many wrong PINs on the box in the last hour: each try takes a few seconds
    slow: pin.slow(),
    resetUntil: pin.resetUntil(),
  });

  // What the Tailscale package says, refreshed in the background at most every 10 seconds, so the
  // page (and its PIN form) never waits for it: without Tailscale the lookup takes up to 2 seconds.
  let tsInfo: Record<string, unknown> | null = null;
  let tsAt = 0;
  let tsBusy: Promise<void> | null = null;
  const refreshTailscale = (): Promise<void> => {
    tsBusy ??= tailscaleInfo(deps.fetch)
      .then((v) => {
        tsInfo = v;
      })
      .catch(() => {})
      .finally(() => {
        tsAt = Date.now();
        tsBusy = null;
      });
    return tsBusy;
  };
  void refreshTailscale();

  const pinError = (res: ServerResponse, e: PinError) =>
    sendError(res, e.status, e.message, e.retryAfter ? { "Retry-After": String(e.retryAfter) } : {});

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
      if (mcp.match) return handleMcp(req, res, mcp.key, deps, limits, config.localBase);

      if (pathname.startsWith("/oauth/") || pathname.startsWith("/.well-known/")) {
        if (!isAllowedHost(req.headers.host, config.allowedHostnames)) return sendError(res, 421, "This address only answers requests addressed to your AVADO");
        if (await handleOAuth(req, res, url, config.localBase, deps, limits, files, "main")) return;
      }

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

      const cookie = req.headers.cookie;
      const secure = (req.socket as TLSSocket).encrypted === true;
      const client = clientAddress(req, config.trustedProxies);

      if (pathname === "/api/state") {
        if (!isSafeMethod(req.method)) return sendError(res, 405, "Use GET for this route", { Allow: "GET" });
        if (Date.now() - tsAt > 10_000) void refreshTailscale();
        // The page asks every few seconds; that alone does not keep the session alive.
        const unlocked = pin.check(cookie, false);
        const connects = oauth.waiting();
        const open = {
          version: config.version,
          https: deps.httpsInfo(),
          tailscale: tsInfo,
          pin: pinState(cookie, unlocked, client),
          allowChanges: settings.allowChanges,
        };
        // Locked (or no PIN yet): no connections, no activity, no waiting actions; only how many wait.
        if (!unlocked) return sendJson(res, 200, { ...open, waiting: approvals.list().length, waitingConnects: connects.length });
        return sendJson(res, 200, {
          ...open,
          tokens: tokens.list(),
          approvals: approvals.list(),
          connects,
          activity: activity.list(150),
          changes: activity.changes(10),
          jobs: box.jobsList(),
        });
      }

      // ---- the PIN (these routes work without a session) ----
      if (pathname === "/api/pin/set" || pathname === "/api/pin/unlock") {
        if (req.method !== "POST") return sendError(res, 405, "Use POST for this route", { Allow: "POST" });
        const body = await readJson(req).catch(() => ({}) as Record<string, unknown>);
        const first = pathname === "/api/pin/set";
        try {
          const id = first ? await pin.set(body.pin) : await pin.unlock(body.pin, client);
          if (first) activity.add({ who: null, tokenId: null, tool: "pin set", outcome: "ok", detail: "A PIN was chosen for this page." });
          return sendJson(res, 200, { ok: true }, { "Set-Cookie": pin.cookie(id, secure) });
        } catch (e) {
          if (!(e instanceof PinError)) throw e;
          if (e.wrong) {
            activity.add({ who: null, tokenId: null, tool: "wrong pin", outcome: "refused", detail: "A wrong PIN was entered on this page." });
          }
          return pinError(res, e);
        }
      }

      if (pathname === "/api/pin/lock") {
        if (req.method !== "POST") return sendError(res, 405, "Use POST for this route", { Allow: "POST" });
        pin.lock(cookie);
        return sendJson(res, 200, { ok: true }, { "Set-Cookie": PinGuard.clearCookie(secure) });
      }

      if (pathname === "/api/pin/reset") {
        if (req.method !== "POST") return sendError(res, 405, "Use POST for this route", { Allow: "POST" });
        // Whoever resets the PIN gets an empty AI Connect: every key stops working at once, before
        // the PIN is removed (so nobody can choose a new PIN while the keys still exist).
        let removed: number;
        try {
          removed = await pin.reset(async () => {
            const n = await tokens.revokeAll();
            approvals.dropAll();
            oauth.dropWaiting();
            return n;
          });
        } catch (e) {
          if (e instanceof PinError) return pinError(res, e);
          throw e;
        }
        activity.add({
          who: null,
          tokenId: null,
          tool: "pin reset",
          outcome: "ok",
          detail: `The PIN was reset after a restart. ${removed === 1 ? "1 connection was" : `${removed} connections were`} removed; their keys no longer work.`,
        });
        logger.warn(`page PIN reset; ${removed} key(s) removed`);
        return sendJson(res, 200, { ok: true, removed }, { "Set-Cookie": PinGuard.clearCookie(secure) });
      }

      // ---- everything below needs the PIN ----
      if (!pin.check(cookie)) {
        return sendError(res, 401, pin.isSet() ? "Enter your PIN first." : "Choose a PIN for this page first.", { "Set-Cookie": PinGuard.clearCookie(secure) });
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

      if (pathname === "/api/settings") {
        if (req.method !== "POST") return sendError(res, 405, "Use POST for this route", { Allow: "POST" });
        const body = await readJson(req).catch(() => ({}) as Record<string, unknown>);
        if (typeof body.allowChanges !== "boolean") return sendError(res, 400, "Bad request");
        const on = body.allowChanges;
        if (on !== settings.allowChanges) {
          await settings.setAllowChanges(on);
          // switched off: whatever waits for an OK will not run
          if (!on) approvals.dropAll();
          activity.add({
            who: null,
            tokenId: null,
            tool: "allow changes",
            change: true,
            outcome: "ok",
            detail: on ? "Changes switched on." : "Changes switched off.",
            says: on
              ? "You switched changes on: assistants you allowed may now restart, install and update apps."
              : "You switched changes off: assistants can only look.",
          });
        }
        return sendJson(res, 200, { ok: true, allowChanges: settings.allowChanges });
      }

      const conn = /^\/api\/connect\/([0-9a-f-]{36})$/.exec(pathname);
      if (conn) {
        if (req.method !== "POST") return sendError(res, 405, "Use POST for this route", { Allow: "POST" });
        const body = await readJson(req).catch(() => ({}) as Record<string, unknown>);
        if (!oauth.decide(conn[1]!, body.decision === "allow")) return sendError(res, 404, "That sign-in is no longer waiting. Press Connect in your app again.");
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
