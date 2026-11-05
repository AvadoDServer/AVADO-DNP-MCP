/**
 * Per-agent access keys. A key is shown once, when it is made; only its SHA-256 is kept
 * (a key has 256 random bits, so a plain hash is enough: there is nothing to guess).
 * Every key can read; "restart" and "install" are extra permissions the owner ticks.
 */
import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import { writeFileAtomic } from "./files.js";

export const SCOPES = ["read", "restart", "install"] as const;
export type Scope = (typeof SCOPES)[number];

export const CLIENTS = ["claude-code", "claude-desktop", "claude-web", "chatgpt", "codex", "cursor", "other"] as const;
export type ClientKind = (typeof CLIENTS)[number];

export const MAX_TOKENS = 25;
export const TOKEN_PREFIX = "avado_";

export interface TokenRecord {
  id: string;
  name: string;
  client: ClientKind;
  scopes: Scope[];
  /** sha256 hex of the key */
  hash: string;
  /** the first characters of the key, so the owner can tell keys apart */
  hint: string;
  createdAt: string;
  lastUsedAt: string | null;
  /** Actions (restart/install/update) wait for the owner's OK on the page. */
  confirmActions: boolean;
  /**
   * Set for a connection made with the Connect button (OAuth, oauth.ts) instead of a key. Its
   * `hash` is then of a random value nobody has, so no key ever matches it.
   */
  oauth?: OAuthGrant;
}

export interface OAuthGrant {
  /** the OAuth client (a registered id, or the https address of its metadata document) */
  clientId: string;
  /** where the sign-in sends the browser back to, e.g. chatgpt.com */
  redirectHost: string;
  /** the MCP address the tokens are for (RFC 8707), e.g. https://mcp.my.ava.do/mcp */
  resource: string;
  /** sha256 of the current refresh token */
  refreshHash: string;
  /** the refresh token before the last rotation, accepted for a short while (a retried request) */
  previousHash: string | null;
  previousUntil: number;
  refreshedAt: string;
}

export type PublicToken = Omit<TokenRecord, "hash" | "oauth"> & { oauth?: { redirectHost: string; resource: string } };

/** How long the previous refresh token still works after a rotation (a client retrying a lost answer). */
export const REFRESH_GRACE_MS = 2 * 60_000;
/** A connection that has not refreshed for this long has to connect again. */
export const REFRESH_IDLE_MS = 90 * 24 * 60 * 60_000;

export function hashToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

export function newTokenString(): string {
  return TOKEN_PREFIX + randomBytes(32).toString("base64url");
}

export class TokenError extends Error {}

export function cleanName(raw: unknown): string {
  const name = typeof raw === "string" ? raw.replace(/[\u0000-\u001f\u007f<>]/g, "").trim() : "";
  if (!name) throw new TokenError("Give the connection a name, for example “Claude on my laptop”.");
  if (name.length > 60) throw new TokenError("Please use a shorter name (60 characters at most).");
  return name;
}

export function cleanScopes(raw: unknown): Scope[] {
  const wanted = new Set<Scope>(["read"]);
  if (Array.isArray(raw)) {
    for (const s of raw) {
      if (typeof s !== "string" || !(SCOPES as readonly string[]).includes(s)) throw new TokenError(`Unknown permission: ${String(s)}`);
      wanted.add(s as Scope);
    }
  }
  return SCOPES.filter((s) => wanted.has(s));
}

export class TokenStore {
  private tokens: TokenRecord[] = [];
  private byHash = new Map<string, TokenRecord>();
  private dirty: Promise<void> = Promise.resolve();

  constructor(
    private readonly file: string,
    private readonly now: () => number = Date.now,
  ) {}

  async load(): Promise<void> {
    try {
      const data = JSON.parse(await readFile(this.file, "utf8")) as { tokens?: unknown };
      const list = Array.isArray(data.tokens) ? data.tokens : [];
      this.tokens = list.filter(isRecord);
    } catch {
      this.tokens = [];
    }
    this.reindex();
  }

  private reindex() {
    this.byHash = new Map(this.tokens.map((t) => [t.hash, t]));
  }

  private save(): Promise<void> {
    const body = JSON.stringify({ tokens: this.tokens }, null, 1);
    this.dirty = this.dirty.then(() => writeFileAtomic(this.file, body, 0o600)).catch(() => {});
    return this.dirty;
  }

  list(): PublicToken[] {
    return this.tokens.map(publicToken);
  }

  /** The OAuth apps that have a connection (their registration must stay). */
  oauthClientIds(): string[] {
    return this.tokens.flatMap((t) => (t.oauth ? [t.oauth.clientId] : []));
  }

  get(id: string): TokenRecord | null {
    return this.tokens.find((t) => t.id === id) ?? null;
  }

  /**
   * A connection made with the Connect button. An earlier connection of the same client for the
   * same address is replaced (a client that connects again must not pile up connections).
   */
  async createOAuth(input: { name: string; client: ClientKind; grant: Omit<OAuthGrant, "previousHash" | "previousUntil" | "refreshedAt"> }): Promise<{ record: TokenRecord; replaced: number }> {
    const before = this.tokens.length;
    this.tokens = this.tokens.filter((t) => !(t.oauth && t.oauth.clientId === input.grant.clientId && t.oauth.resource === input.grant.resource));
    const replaced = before - this.tokens.length;
    if (this.tokens.length >= MAX_TOKENS) throw new TokenError(`You already have ${MAX_TOKENS} connections. Remove one you no longer use first.`);
    const now = new Date(this.now()).toISOString();
    const record: TokenRecord = {
      id: randomUUID(),
      name: cleanName(input.name),
      client: input.client,
      scopes: [...SCOPES],
      hash: hashToken(randomBytes(32).toString("hex")),
      hint: "",
      createdAt: now,
      lastUsedAt: null,
      confirmActions: true,
      oauth: { ...input.grant, previousHash: null, previousUntil: 0, refreshedAt: now },
    };
    this.tokens.push(record);
    this.reindex();
    await this.save();
    return { record, replaced };
  }

  /** The connection a refresh token belongs to (also the one before the last rotation, briefly). */
  byRefresh(hash: string): TokenRecord | null {
    const now = this.now();
    for (const t of this.tokens) {
      const g = t.oauth;
      if (!g) continue;
      if (now - Date.parse(g.refreshedAt) > REFRESH_IDLE_MS) continue;
      if (g.refreshHash === hash || (g.previousHash === hash && now < g.previousUntil)) return t;
    }
    return null;
  }

  /** A new refresh token for the connection; the old one keeps working for REFRESH_GRACE_MS. */
  async rotateRefresh(id: string, newHash: string): Promise<boolean> {
    const t = this.tokens.find((x) => x.id === id);
    if (!t?.oauth) return false;
    const now = this.now();
    t.oauth = { ...t.oauth, previousHash: t.oauth.refreshHash, previousUntil: now + REFRESH_GRACE_MS, refreshHash: newHash, refreshedAt: new Date(now).toISOString() };
    await this.save();
    return true;
  }

  async create(input: { name: unknown; client: unknown; scopes: unknown; confirmActions?: unknown }): Promise<{ token: string; record: PublicToken }> {
    if (this.tokens.length >= MAX_TOKENS) throw new TokenError(`You already have ${MAX_TOKENS} connections. Remove one you no longer use first.`);
    const name = cleanName(input.name);
    const client = (CLIENTS as readonly unknown[]).includes(input.client) ? (input.client as ClientKind) : "other";
    const scopes = cleanScopes(input.scopes);
    const token = newTokenString();
    const record: TokenRecord = {
      id: randomUUID(),
      name,
      client,
      scopes,
      hash: hashToken(token),
      hint: token.slice(0, TOKEN_PREFIX.length + 4),
      createdAt: new Date(this.now()).toISOString(),
      lastUsedAt: null,
      confirmActions: input.confirmActions !== false,
    };
    this.tokens.push(record);
    this.reindex();
    await this.save();
    return { token, record: publicToken(record) };
  }

  async revoke(id: string): Promise<boolean> {
    const before = this.tokens.length;
    this.tokens = this.tokens.filter((t) => t.id !== id);
    if (this.tokens.length === before) return false;
    this.reindex();
    await this.save();
    return true;
  }

  /** Removes every key (used when the page PIN is reset). Returns how many there were. */
  async revokeAll(): Promise<number> {
    const n = this.tokens.length;
    this.tokens = [];
    this.reindex();
    await this.save();
    return n;
  }

  async setConfirm(id: string, confirmActions: boolean): Promise<boolean> {
    const t = this.tokens.find((x) => x.id === id);
    if (!t) return false;
    t.confirmActions = confirmActions;
    await this.save();
    return true;
  }

  /** The key's record, or null. Compares hashes in constant time. */
  verify(token: string | undefined | null): TokenRecord | null {
    if (!token || !token.startsWith(TOKEN_PREFIX) || token.length > 200) return null;
    const h = hashToken(token);
    const hit = this.byHash.get(h);
    if (!hit || hit.oauth) return null;
    if (!timingSafeEqual(Buffer.from(hit.hash, "hex"), Buffer.from(h, "hex"))) return null;
    return hit;
  }

  /** Records use, at most once a minute per key (no disk write per call). */
  touch(t: TokenRecord): void {
    const now = this.now();
    const last = t.lastUsedAt ? Date.parse(t.lastUsedAt) : 0;
    if (now - last < 60_000) return;
    t.lastUsedAt = new Date(now).toISOString();
    void this.save();
  }

  flush(): Promise<void> {
    return this.dirty;
  }
}

function publicToken(t: TokenRecord): PublicToken {
  const { hash: _hash, oauth, ...rest } = t;
  return oauth ? { ...rest, oauth: { redirectHost: oauth.redirectHost, resource: oauth.resource } } : rest;
}

function isGrant(g: unknown): boolean {
  if (g === undefined) return true;
  if (!g || typeof g !== "object") return false;
  const x = g as Record<string, unknown>;
  return typeof x.clientId === "string" && typeof x.resource === "string" && typeof x.refreshHash === "string" && /^[0-9a-f]{64}$/.test(x.refreshHash) && typeof x.refreshedAt === "string";
}

function isRecord(x: unknown): x is TokenRecord {
  if (!x || typeof x !== "object") return false;
  const t = x as Record<string, unknown>;
  return (
    typeof t.id === "string" &&
    typeof t.name === "string" &&
    typeof t.hash === "string" &&
    /^[0-9a-f]{64}$/.test(t.hash) &&
    Array.isArray(t.scopes) &&
    t.scopes.every((s) => (SCOPES as readonly unknown[]).includes(s)) &&
    isGrant(t.oauth)
  );
}
