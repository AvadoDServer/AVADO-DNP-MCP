/**
 * Sign in with the Connect button: a small OAuth 2.1 authorization server inside AI Connect, so
 * ChatGPT, Claude and other apps can connect without a key in the address. It follows the MCP
 * authorization spec (2026-07-28 revision):
 *  - protected resource metadata (RFC 9728) and authorization server metadata (RFC 8414)
 *  - client registration by Client ID Metadata Document (the spec's preferred way) and by Dynamic
 *    Client Registration (RFC 7591, kept for the apps that still use it)
 *  - authorization code with PKCE S256 only, the `resource` parameter (RFC 8707) binding every
 *    token to one MCP address, `iss` in every authorization response (RFC 9207)
 *  - short access tokens (1 hour), refresh tokens rotated on every use
 *
 * The owner's part is one click: the app opens a page that says "Approve on your AVADO" and shows
 * a short code; the AI Connect page (PIN-protected, also inside the Admin) shows the same code with
 * Allow / Don't allow. Nothing is approved by visiting a link, and the page that the internet can
 * reach (through Tailscale Funnel) never asks for the PIN.
 *
 * Kept on disk (/data/oauth.json): registered apps only. Connections live in tokens.json (a
 * TokenRecord with `oauth`), so the page lists, limits and removes them like keys, and a PIN reset
 * removes them too. Waiting requests, codes and access tokens are kept in memory only: after a
 * restart an app uses its refresh token.
 */
import { createHash, randomBytes, randomInt, randomUUID, timingSafeEqual } from "node:crypto";
import { lookup as dnsLookup } from "node:dns/promises";
import { readFile } from "node:fs/promises";
import { isIP } from "node:net";
import type { ActivityLog } from "./activity.js";
import { writeFileAtomic } from "./files.js";
import { errorMessage, type Logger } from "./log.js";
import type { FetchLike } from "./store.js";
import type { ClientKind, TokenRecord, TokenStore } from "./tokens.js";

export const OAUTH_SCOPE = "avado";
export const ACCESS_TOKEN_PREFIX = "aic_at_";
export const REFRESH_TOKEN_PREFIX = "aic_rt_";
export const ACCESS_TTL_MS = 60 * 60_000;
/** how long the owner has to press Allow */
export const REQUEST_TTL_MS = 10 * 60_000;
/** how long the app has to use the code after the owner allowed it */
export const CODE_TTL_MS = 10 * 60_000;
/** at most this many sign-ins wait for the owner at once (the oldest gives way) */
export const MAX_WAITING = 5;
export const MAX_CLIENTS = 100;
const MAX_DOC_BYTES = 10 * 1024;
const DOC_CACHE_MS = 60 * 60_000;

const sha256 = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");
const b64url = (b: Buffer) => b.toString("base64url");
const randomToken = (prefix: string) => prefix + b64url(randomBytes(32));

export class OAuthError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status = 400,
  ) {
    super(message);
  }
}

export interface ClientInfo {
  clientId: string;
  name: string;
  redirectUris: string[];
  /** sha256 of the client secret; null for a public client (PKCE only) */
  secretHash: string | null;
  /** registered here (RFC 7591) or described by a document at its https client_id */
  via: "registration" | "document";
}

interface StoredClient extends ClientInfo {
  createdAt: string;
}

export interface ConnectRequest {
  id: string;
  /** the code shown on the app's waiting page and on the AI Connect page */
  code: string;
  clientId: string;
  /** what to call the app: “ChatGPT”, or the name it registered with */
  name: string;
  /** the host the browser goes back to (shown to the owner, MCP spec) */
  redirectHost: string;
  /** the app goes back to this computer (localhost): anything running there could pretend to be it */
  local: boolean;
  createdAt: string;
  expiresAt: string;
}

interface Pending extends ConnectRequest {
  secretHash: string;
  redirectUri: string;
  state: string | null;
  challenge: string;
  resource: string;
  issuer: string;
  kind: ClientKind;
  status: "waiting" | "allowed" | "declined" | "expired";
  /** where the waiting page sends the browser once decided */
  redirect: string | null;
  decidedAt: number;
}

interface CodeRecord {
  pendingId: string;
  clientId: string;
  redirectUri: string;
  challenge: string;
  resource: string;
  name: string;
  kind: ClientKind;
  redirectHost: string;
  expiresAt: number;
  used: boolean;
  tokenId: string | null;
}

export interface WaitStatus {
  state: "waiting" | "allowed" | "declined" | "expired";
  code: string;
  name: string;
  redirectHost: string;
  expiresAt: string;
  redirect: string | null;
}

export interface OAuthDeps {
  file: string | null;
  tokens: TokenStore;
  activity: ActivityLog;
  logger: Logger;
  fetch: FetchLike;
  /** hostname -> its addresses (default: the system resolver) */
  lookup?: (hostname: string) => Promise<string[]>;
  now?: () => number;
}

/** The apps we know by the host they send the browser back to: they get their real name. */
const KNOWN_HOSTS: Array<{ test: (h: string) => boolean; name: string; kind: ClientKind }> = [
  { test: (h) => h === "chatgpt.com" || h.endsWith(".chatgpt.com") || h === "openai.com" || h.endsWith(".openai.com"), name: "ChatGPT", kind: "chatgpt" },
  { test: (h) => h === "claude.ai" || h.endsWith(".claude.ai") || h === "claude.com" || h.endsWith(".claude.com") || h.endsWith(".anthropic.com"), name: "Claude", kind: "claude-web" },
];

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

/** https, or http on this computer (MCP spec: redirect URIs are localhost or https). No fragments. */
export function isAllowedRedirect(raw: unknown): raw is string {
  if (typeof raw !== "string" || raw.length > 500) return false;
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return false;
  }
  if (u.hash || u.username || u.password) return false;
  if (u.protocol === "https:") return true;
  return u.protocol === "http:" && LOOPBACK.has(u.hostname);
}

/**
 * Exact match, except that a loopback address may use any port (RFC 8252 section 7.3: apps on
 * the owner's computer pick a free port each time).
 */
export function redirectMatches(registered: readonly string[], asked: string): boolean {
  if (registered.includes(asked)) return true;
  let a: URL;
  try {
    a = new URL(asked);
  } catch {
    return false;
  }
  if (a.protocol !== "http:" || !LOOPBACK.has(a.hostname)) return false;
  return registered.some((r) => {
    try {
      const u = new URL(r);
      return u.protocol === "http:" && u.hostname === a.hostname && u.pathname === a.pathname && u.search === a.search;
    } catch {
      return false;
    }
  });
}

/** "https://Mcp.My.Ava.Do/mcp/" -> "https://mcp.my.ava.do/mcp"; null when not a resource URI. */
export function canonicalResource(raw: string): string | null {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  if (u.hash || (u.protocol !== "https:" && u.protocol !== "http:")) return null;
  return `${u.protocol}//${u.host}${u.pathname.replace(/\/+$/, "")}${u.search}`;
}

/** The documents a client reads to find out how to sign in (RFC 9728, RFC 8414). */
export function resourceMetadata(base: string): Record<string, unknown> {
  return {
    resource: `${base}/mcp`,
    authorization_servers: [base],
    scopes_supported: [OAUTH_SCOPE],
    bearer_methods_supported: ["header"],
    resource_name: "AVADO AI Connect",
  };
}

export function serverMetadata(base: string): Record<string, unknown> {
  return {
    issuer: base,
    authorization_endpoint: `${base}/oauth/authorize`,
    token_endpoint: `${base}/oauth/token`,
    registration_endpoint: `${base}/oauth/register`,
    response_types_supported: ["code"],
    response_modes_supported: ["query"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none", "client_secret_post", "client_secret_basic"],
    scopes_supported: [OAUTH_SCOPE],
    client_id_metadata_document_supported: true,
    authorization_response_iss_parameter_supported: true,
    service_documentation: "https://ava.do",
  };
}

/** The WWW-Authenticate value of a 401 from /mcp (MCP spec: it starts the sign-in). */
export function bearerChallenge(base: string | null, error?: "invalid_token"): string {
  const parts = ['Bearer realm="AVADO AI Connect"'];
  if (base) parts.push(`resource_metadata="${base}/.well-known/oauth-protected-resource/mcp"`, `scope="${OAUTH_SCOPE}"`);
  if (error) parts.push(`error="${error}"`);
  return parts.join(", ");
}

function cleanText(raw: unknown, max: number): string {
  return typeof raw === "string" ? raw.replace(/[\u0000-\u001f\u007f<>"]/g, "").trim().slice(0, max) : "";
}

/**
 * No sign-in document is fetched from the box's own network or from other private addresses
 * (172.33.0.0/16 is the AVADO network: public by the RFCs, but every app on the box lives there).
 */
export function isPrivateAddress(ip: string): boolean {
  const v = isIP(ip);
  if (v === 4) {
    const [a, b] = ip.split(".").map(Number) as [number, number];
    return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 172 && b === 33) || (a === 192 && b === 168) || a >= 224;
  }
  if (v === 6) {
    const x = ip.toLowerCase();
    if (x === "::" || x === "::1") return true;
    if (x.startsWith("::ffff:")) return isPrivateAddress(x.slice(7));
    return /^f[cd]/.test(x) || /^fe[89ab]/.test(x) || x.startsWith("ff");
  }
  return true;
}

export class OAuthServer {
  private clients = new Map<string, StoredClient>();
  private docs = new Map<string, { info: ClientInfo | null; until: number }>();
  private pending = new Map<string, Pending>();
  private codes = new Map<string, CodeRecord>();
  private access = new Map<string, { tokenId: string; resource: string; expiresAt: number }>();
  private writing: Promise<void> = Promise.resolve();
  private readonly now: () => number;
  private readonly lookup: (hostname: string) => Promise<string[]>;

  constructor(private readonly deps: OAuthDeps) {
    this.now = deps.now ?? Date.now;
    this.lookup = deps.lookup ?? (async (h) => (await dnsLookup(h, { all: true })).map((a) => a.address));
  }

  async load(): Promise<void> {
    if (!this.deps.file) return;
    try {
      const data = JSON.parse(await readFile(this.deps.file, "utf8")) as { clients?: unknown };
      for (const c of Array.isArray(data.clients) ? data.clients : []) {
        const x = c as StoredClient;
        if (x && typeof x.clientId === "string" && Array.isArray(x.redirectUris) && x.redirectUris.every(isAllowedRedirect)) {
          this.clients.set(x.clientId, { ...x, via: "registration", secretHash: typeof x.secretHash === "string" ? x.secretHash : null });
        }
      }
    } catch {
      /* none yet */
    }
  }

  private save(): Promise<void> {
    if (!this.deps.file) return Promise.resolve();
    const file = this.deps.file;
    const body = JSON.stringify({ clients: [...this.clients.values()] }, null, 1);
    this.writing = this.writing.catch(() => {}).then(() => writeFileAtomic(file, body, 0o600));
    return this.writing;
  }

  flush(): Promise<void> {
    return this.writing.catch(() => {});
  }

  // ---- registration ----

  /** RFC 7591. Public clients by default; a secret only when the app asks for one. */
  async register(body: Record<string, unknown>): Promise<Record<string, unknown>> {
    const uris = body.redirect_uris;
    if (!Array.isArray(uris) || uris.length === 0 || uris.length > 5) throw new OAuthError("invalid_redirect_uri", "Give one to five redirect_uris.");
    if (!uris.every(isAllowedRedirect)) throw new OAuthError("invalid_redirect_uri", "Redirect URIs must use https, or http on localhost.");
    const method = body.token_endpoint_auth_method ?? "none";
    if (!["none", "client_secret_post", "client_secret_basic"].includes(String(method))) {
      throw new OAuthError("invalid_client_metadata", "token_endpoint_auth_method must be none, client_secret_post or client_secret_basic.");
    }
    const grants = body.grant_types ?? ["authorization_code", "refresh_token"];
    if (!Array.isArray(grants) || !grants.every((g) => g === "authorization_code" || g === "refresh_token")) {
      throw new OAuthError("invalid_client_metadata", "Only the authorization_code and refresh_token grants are supported.");
    }
    const responses = body.response_types ?? ["code"];
    if (!Array.isArray(responses) || !responses.every((r) => r === "code")) throw new OAuthError("invalid_client_metadata", "Only response_type code is supported.");
    this.prune();
    const clientId = "aic_client_" + b64url(randomBytes(16));
    const secret = method === "none" ? null : "aic_cs_" + b64url(randomBytes(32));
    const name = cleanText(body.client_name, 60);
    const issuedAt = Math.floor(this.now() / 1000);
    this.clients.set(clientId, {
      clientId,
      name,
      redirectUris: uris as string[],
      secretHash: secret ? sha256(secret) : null,
      via: "registration",
      createdAt: new Date(this.now()).toISOString(),
    });
    await this.save();
    return {
      client_id: clientId,
      client_id_issued_at: issuedAt,
      ...(secret ? { client_secret: secret, client_secret_expires_at: 0 } : {}),
      client_name: name || undefined,
      redirect_uris: uris,
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: method,
      scope: OAUTH_SCOPE,
    };
  }

  /** Room for a new app: drop the oldest registrations that no connection uses. */
  private prune(): void {
    if (this.clients.size < MAX_CLIENTS) return;
    const used = new Set(this.deps.tokens.oauthClientIds());
    const unused = [...this.clients.values()].filter((c) => !used.has(c.clientId)).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    while (this.clients.size >= MAX_CLIENTS && unused.length) this.clients.delete(unused.shift()!.clientId);
    if (this.clients.size >= MAX_CLIENTS) throw new OAuthError("invalid_client_metadata", "Too many apps are registered. Remove a connection on the AI Connect page first.");
  }

  /** A registered app, or the document at an https client_id (fetched, checked, cached for an hour). */
  async client(clientId: string): Promise<ClientInfo | null> {
    const reg = this.clients.get(clientId);
    if (reg) return reg;
    if (!clientId.startsWith("https://")) return null;
    const hit = this.docs.get(clientId);
    if (hit && hit.until > this.now()) return hit.info;
    const info = await this.fetchDocument(clientId).catch((e: unknown) => {
      this.deps.logger.warn(`sign-in document ${clientId.slice(0, 120)} not usable: ${errorMessage(e)}`);
      return null;
    });
    if (this.docs.size > 50) this.docs.delete([...this.docs.keys()][0]!);
    this.docs.set(clientId, { info, until: this.now() + (info ? DOC_CACHE_MS : 60_000) });
    return info;
  }

  /** Client ID Metadata Document: the client_id is an https address of a JSON document about the app. */
  private async fetchDocument(clientId: string): Promise<ClientInfo> {
    let u: URL;
    try {
      u = new URL(clientId);
    } catch {
      throw new Error("not a URL");
    }
    if (u.protocol !== "https:" || u.username || u.password || u.hash || u.pathname === "/" || clientId.length > 500) throw new Error("must be an https address with a path");
    const host = u.hostname.replace(/^\[|\]$/g, "");
    const addresses = isIP(host) ? [host] : await this.lookup(host);
    if (addresses.length === 0 || addresses.some(isPrivateAddress)) throw new Error("points into a private network");
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5_000);
    let text: string;
    try {
      const res = await this.deps.fetch(clientId, { headers: { Accept: "application/json" }, redirect: "error", signal: controller.signal });
      if (!res.ok) throw new Error(`answered ${res.status}`);
      const len = Number(res.headers.get("content-length") ?? "0");
      if (len > MAX_DOC_BYTES) throw new Error("too large");
      text = await res.text();
    } finally {
      clearTimeout(timer);
    }
    if (text.length > MAX_DOC_BYTES) throw new Error("too large");
    const doc = JSON.parse(text) as Record<string, unknown>;
    if (!doc || typeof doc !== "object" || doc.client_id !== clientId) throw new Error("client_id in the document does not match its address");
    const uris = doc.redirect_uris;
    if (!Array.isArray(uris) || uris.length === 0 || !uris.every(isAllowedRedirect)) throw new Error("redirect_uris missing or not https/localhost");
    const method = doc.token_endpoint_auth_method ?? "none";
    if (method !== "none") throw new Error(`token_endpoint_auth_method ${String(method)} is not supported (only none)`);
    return { clientId, name: cleanText(doc.client_name, 60), redirectUris: uris.slice(0, 10) as string[], secretHash: null, via: "document" };
  }

  // ---- the browser part ----

  /**
   * GET /oauth/authorize. Either a page error (a bad app or redirect: the browser is never sent
   * anywhere then), or where to send the browser: the waiting page, or back to the app with an error.
   */
  async authorize(params: URLSearchParams, base: string): Promise<{ location: string } | { problem: string }> {
    const clientId = params.get("client_id") ?? "";
    const client = clientId ? await this.client(clientId) : null;
    if (!client) return { problem: "This sign-in link is from an app AI Connect does not know. Go back to your app and press Connect again." };
    const asked = params.get("redirect_uri");
    const redirectUri = asked ?? (client.redirectUris.length === 1 ? client.redirectUris[0]! : null);
    if (!redirectUri || !redirectMatches(client.redirectUris, redirectUri)) {
      return { problem: "This sign-in link does not say where to go back to, or the address does not belong to the app. Go back to your app and press Connect again." };
    }
    const state = params.get("state");
    const back = (error: string, description: string) => ({ location: withParams(redirectUri, { error, error_description: description, state, iss: base }) });
    if (params.get("response_type") !== "code") return back("unsupported_response_type", "Only response_type=code is supported.");
    const challenge = params.get("code_challenge") ?? "";
    if (params.get("code_challenge_method") !== "S256" || !/^[A-Za-z0-9_-]{43}$/.test(challenge)) return back("invalid_request", "PKCE with code_challenge_method=S256 is required.");
    const resource = this.checkResource(params.get("resource"), base);
    if (!resource) return back("invalid_target", `The resource must be ${base}/mcp.`);
    if (state && state.length > 500) return back("invalid_request", "state is too long.");

    this.expire();
    const waiting = [...this.pending.values()].filter((p) => p.status === "waiting");
    while (waiting.length >= MAX_WAITING) this.finish(waiting.shift()!, "expired");

    const host = new URL(redirectUri).hostname;
    const known = KNOWN_HOSTS.find((k) => k.test(host));
    const local = LOOPBACK.has(host);
    const name = known?.name ?? (client.name || (client.via === "document" ? new URL(client.clientId).hostname : local ? "An app on your computer" : host));
    const secret = b64url(randomBytes(24));
    const t = this.now();
    const p: Pending = {
      id: randomUUID(),
      code: String(randomInt(0, 10_000)).padStart(4, "0"),
      clientId: client.clientId,
      name,
      redirectHost: local ? "this computer (localhost)" : host,
      local,
      createdAt: new Date(t).toISOString(),
      expiresAt: new Date(t + REQUEST_TTL_MS).toISOString(),
      secretHash: sha256(secret),
      redirectUri,
      state,
      challenge,
      resource,
      issuer: base,
      kind: known?.kind ?? "other",
      status: "waiting",
      redirect: null,
      decidedAt: 0,
    };
    this.pending.set(p.id, p);
    this.deps.activity.add({ who: name, tokenId: null, tool: "connect request", outcome: "waiting", detail: `Wants to connect (code ${p.code}). It goes back to ${p.redirectHost}.` });
    return { location: `/oauth/wait?r=${secret}` };
  }

  private checkResource(raw: string | null, base: string): string | null {
    const want = `${base}/mcp`;
    if (raw === null || raw === "") return want;
    const c = canonicalResource(raw);
    return c === want || c === base ? want : null;
  }

  /** What the waiting page shows; it finds its request by the secret in its own address. */
  waitStatus(secret: string): WaitStatus | null {
    this.expire();
    if (!/^[A-Za-z0-9_-]{32}$/.test(secret)) return null;
    const h = sha256(secret);
    const p = [...this.pending.values()].find((x) => x.secretHash === h);
    if (!p) return null;
    return { state: p.status, code: p.code, name: p.name, redirectHost: p.redirectHost, expiresAt: p.expiresAt, redirect: p.status === "waiting" ? null : p.redirect };
  }

  /** The sign-ins waiting for the owner, for the AI Connect page. */
  waiting(): ConnectRequest[] {
    this.expire();
    return [...this.pending.values()]
      .filter((p) => p.status === "waiting")
      .map(({ id, code, clientId, name, redirectHost, local, createdAt, expiresAt }) => ({ id, code, clientId, name, redirectHost, local, createdAt, expiresAt }));
  }

  /** The owner's Allow / Don't allow on the page. */
  decide(id: string, allow: boolean): boolean {
    this.expire();
    const p = this.pending.get(id);
    if (!p || p.status !== "waiting") return false;
    this.finish(p, allow ? "allowed" : "declined");
    this.deps.activity.add({
      who: p.name,
      tokenId: null,
      tool: "connect request",
      outcome: allow ? "ok" : "declined",
      detail: allow ? "You allowed it on this page." : "You did not allow it.",
    });
    return true;
  }

  /** Every waiting sign-in is declined (the page PIN was reset). */
  dropWaiting(): void {
    for (const p of this.pending.values()) if (p.status === "waiting") this.finish(p, "declined");
  }

  private finish(p: Pending, status: "allowed" | "declined" | "expired"): void {
    p.status = status;
    p.decidedAt = this.now();
    if (status === "allowed") {
      const code = b64url(randomBytes(32));
      this.codes.set(sha256(code), {
        pendingId: p.id,
        clientId: p.clientId,
        redirectUri: p.redirectUri,
        challenge: p.challenge,
        resource: p.resource,
        name: p.name,
        kind: p.kind,
        redirectHost: p.local ? "localhost" : p.redirectHost,
        expiresAt: this.now() + CODE_TTL_MS,
        used: false,
        tokenId: null,
      });
      p.redirect = withParams(p.redirectUri, { code, state: p.state, iss: p.issuer });
    } else {
      p.redirect = withParams(p.redirectUri, {
        error: "access_denied",
        error_description: status === "expired" ? "The owner did not allow it in time." : "The owner did not allow it.",
        state: p.state,
        iss: p.issuer,
      });
    }
  }

  private expire(): void {
    const t = this.now();
    for (const p of [...this.pending.values()]) {
      if (p.status === "waiting" && Date.parse(p.expiresAt) <= t) this.finish(p, "expired");
      // decided requests stay a while, so the waiting page can still go back to the app
      if (p.status !== "waiting" && t - p.decidedAt > REQUEST_TTL_MS) this.pending.delete(p.id);
    }
    for (const [k, c] of this.codes) if (c.expiresAt <= t - CODE_TTL_MS) this.codes.delete(k);
    if (this.access.size > 200) for (const [k, a] of this.access) if (a.expiresAt <= t) this.access.delete(k);
  }

  // ---- the token endpoint ----

  /** POST /oauth/token. Throws OAuthError for every refusal (the caller turns it into JSON). */
  async token(params: URLSearchParams, authorization: string | undefined): Promise<Record<string, unknown>> {
    this.expire();
    const client = await this.authenticate(params, authorization);
    const grant = params.get("grant_type");
    if (grant === "authorization_code") return this.exchangeCode(client, params);
    if (grant === "refresh_token") return this.refresh(client, params);
    throw new OAuthError("unsupported_grant_type", "Use authorization_code or refresh_token.");
  }

  private async authenticate(params: URLSearchParams, authorization: string | undefined): Promise<ClientInfo> {
    let id = params.get("client_id");
    let secret = params.get("client_secret");
    const basic = /^Basic\s+([A-Za-z0-9+/=]+)\s*$/i.exec(authorization ?? "");
    if (basic) {
      const decoded = Buffer.from(basic[1]!, "base64").toString("utf8");
      const i = decoded.indexOf(":");
      if (i < 0) throw new OAuthError("invalid_client", "Bad client credentials.", 401);
      id = decodeURIComponent(decoded.slice(0, i));
      secret = decodeURIComponent(decoded.slice(i + 1));
    }
    const client = id ? await this.client(id) : null;
    if (!client) throw new OAuthError("invalid_client", "Unknown app. Connect again from your app.", 401);
    if (client.secretHash) {
      const ok = typeof secret === "string" && secret.length < 200 && timingSafeEqual(Buffer.from(sha256(secret), "hex"), Buffer.from(client.secretHash, "hex"));
      if (!ok) throw new OAuthError("invalid_client", "Bad client credentials.", 401);
    }
    return client;
  }

  private async exchangeCode(client: ClientInfo, params: URLSearchParams): Promise<Record<string, unknown>> {
    const code = params.get("code") ?? "";
    const rec = this.codes.get(sha256(code));
    if (!rec || rec.clientId !== client.clientId) throw new OAuthError("invalid_grant", "This sign-in code is not valid. Connect again.");
    if (rec.used) {
      // a code used twice may have been stolen: the connection made with it goes too
      if (rec.tokenId) await this.deps.tokens.revoke(rec.tokenId);
      throw new OAuthError("invalid_grant", "This sign-in code was already used.");
    }
    if (rec.expiresAt <= this.now()) throw new OAuthError("invalid_grant", "This sign-in code has expired. Connect again.");
    const redirect = params.get("redirect_uri");
    if (redirect !== null && redirect !== rec.redirectUri) throw new OAuthError("invalid_grant", "redirect_uri does not match the sign-in.");
    const verifier = params.get("code_verifier") ?? "";
    if (!/^[A-Za-z0-9._~-]{43,128}$/.test(verifier) || b64url(createHash("sha256").update(verifier, "ascii").digest()) !== rec.challenge) {
      throw new OAuthError("invalid_grant", "code_verifier does not match (PKCE).");
    }
    const resource = params.get("resource");
    if (resource && canonicalResource(resource) !== rec.resource && canonicalResource(resource) !== rec.resource.replace(/\/mcp$/, "")) {
      throw new OAuthError("invalid_target", "The resource does not match the sign-in.");
    }
    rec.used = true;
    const refresh = randomToken(REFRESH_TOKEN_PREFIX);
    const { record, replaced } = await this.deps.tokens.createOAuth({
      name: rec.name,
      client: rec.kind,
      grant: { clientId: rec.clientId, redirectHost: rec.redirectHost, resource: rec.resource, refreshHash: sha256(refresh) },
    });
    rec.tokenId = record.id;
    this.deps.activity.add({
      who: record.name,
      tokenId: record.id,
      tool: "new connection",
      outcome: "ok",
      detail: `Connected with the Connect button; it goes back to ${rec.redirectHost}.${replaced ? " It replaces its earlier connection." : ""}`,
    });
    return this.tokenAnswer(record, refresh);
  }

  private async refresh(client: ClientInfo, params: URLSearchParams): Promise<Record<string, unknown>> {
    const token = params.get("refresh_token") ?? "";
    const record = token.startsWith(REFRESH_TOKEN_PREFIX) ? this.deps.tokens.byRefresh(sha256(token)) : null;
    if (!record?.oauth || record.oauth.clientId !== client.clientId) throw new OAuthError("invalid_grant", "This connection was removed or has expired. Connect again.");
    const resource = params.get("resource");
    if (resource && canonicalResource(resource) !== record.oauth.resource && canonicalResource(resource) !== record.oauth.resource.replace(/\/mcp$/, "")) {
      throw new OAuthError("invalid_target", "The resource does not match this connection.");
    }
    const next = randomToken(REFRESH_TOKEN_PREFIX);
    await this.deps.tokens.rotateRefresh(record.id, sha256(next));
    return this.tokenAnswer(record, next);
  }

  private tokenAnswer(record: TokenRecord, refresh: string): Record<string, unknown> {
    const access = randomToken(ACCESS_TOKEN_PREFIX);
    this.access.set(sha256(access), { tokenId: record.id, resource: record.oauth!.resource, expiresAt: this.now() + ACCESS_TTL_MS });
    return { access_token: access, token_type: "Bearer", expires_in: ACCESS_TTL_MS / 1000, refresh_token: refresh, scope: OAUTH_SCOPE };
  }

  // ---- /mcp ----

  /** The connection an access token belongs to, if it is valid for this MCP address. */
  verify(token: string, resource: string | null): TokenRecord | null {
    if (!token.startsWith(ACCESS_TOKEN_PREFIX) || token.length > 200 || !resource) return null;
    const hit = this.access.get(sha256(token));
    if (!hit || hit.expiresAt <= this.now()) return null;
    if (hit.resource !== resource) return null;
    const record = this.deps.tokens.get(hit.tokenId);
    return record?.oauth ? record : null;
  }
}

function withParams(uri: string, params: Record<string, string | null>): string {
  const u = new URL(uri);
  for (const [k, v] of Object.entries(params)) if (v !== null && v !== undefined) u.searchParams.set(k, v);
  return u.toString();
}
