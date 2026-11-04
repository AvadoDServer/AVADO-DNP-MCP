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

export const CLIENTS = ["claude-code", "claude-desktop", "chatgpt", "codex", "cursor", "other"] as const;
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
}

export type PublicToken = Omit<TokenRecord, "hash">;

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
    return this.tokens.map(({ hash: _hash, ...rest }) => rest);
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
    const { hash: _hash, ...pub } = record;
    return { token, record: pub };
  }

  async revoke(id: string): Promise<boolean> {
    const before = this.tokens.length;
    this.tokens = this.tokens.filter((t) => t.id !== id);
    if (this.tokens.length === before) return false;
    this.reindex();
    await this.save();
    return true;
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
    if (!hit) return null;
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

function isRecord(x: unknown): x is TokenRecord {
  if (!x || typeof x !== "object") return false;
  const t = x as Record<string, unknown>;
  return (
    typeof t.id === "string" &&
    typeof t.name === "string" &&
    typeof t.hash === "string" &&
    /^[0-9a-f]{64}$/.test(t.hash) &&
    Array.isArray(t.scopes) &&
    t.scopes.every((s) => (SCOPES as readonly unknown[]).includes(s))
  );
}
