/**
 * The page PIN. The owner chooses it the first time the AI Connect page is opened; after that the
 * page asks for it before keys can be made or removed, a connection's settings changed, a waiting
 * action allowed, or the activity list read. Assistants (MCP clients with a key) never need it.
 *
 * - Stored as scrypt (node:crypto, no native module) with a random salt in /data/pin.json (mode 600).
 * - Entering it gives a session cookie: random 256 bits, only its SHA-256 kept, in memory only (a
 *   restart locks the page). HttpOnly, SameSite=Strict, Path=/api, Secure over https, 30 minutes at
 *   most and 10 minutes without use.
 * - Wrong PINs are counted per device (the address the request comes from; see clientAddress in
 *   http.ts): 5 tries, then a wait that doubles from 1 minute up to 15 minutes. So one device that
 *   keeps guessing never locks the owner's other devices out. On top of that, the whole box: after
 *   more than 20 wrong PINs in an hour, every try (right or wrong, from any device) waits 3 seconds
 *   before it is checked. That slows down guessing from many addresses but never closes the page.
 *   Both counts are kept on disk, so a restart does not help a guesser. Tries from one device are
 *   checked one at a time; at most two PINs are hashed at once for the whole box.
 * - Forgot PIN: for 10 minutes after the owner presses Restart for AI Connect in the AVADO Admin,
 *   the page offers "Reset the PIN". That removes the PIN and every connection's key, so whoever
 *   resets it gets an empty AI Connect, never the owner's assistants. Only an Admin restart opens
 *   this window: it makes a new container (compose rm + up), while a power cut, a box reboot, a
 *   crash or Start after Pause keep the old one (see ownerRestarted below), and an update makes a
 *   new container with a new version. So the window does not open by itself.
 */
import { createHash, randomBytes, scrypt as scryptCb, timingSafeEqual, type ScryptOptions } from "node:crypto";
import { readFile, rm, writeFile } from "node:fs/promises";
import { writeFileAtomic } from "./files.js";

export const PIN_MIN = 6;
export const PIN_MAX = 12;
export const SESSION_COOKIE = "aic_session";

export const SESSION_MAX_MS = 30 * 60_000;
export const SESSION_IDLE_MS = 10 * 60_000;
export const RESET_WINDOW_MS = 10 * 60_000;
/** Wrong PINs one device may enter before it has to wait. */
export const FREE_TRIES = 5;
export const FIRST_WAIT_MS = 60_000;
export const MAX_WAIT_MS = 15 * 60_000;
/** More than this many wrong PINs in BOX_WINDOW_MS (all devices together) slows every try down. */
export const BOX_SLOW_AFTER = 20;
export const BOX_WINDOW_MS = 60 * 60_000;
export const BOX_DELAY_MS = 3_000;
const MAX_SESSIONS = 20;
/** Devices remembered in pin.json; the oldest are forgotten first. */
const MAX_DEVICES = 500;
/** PIN hashes running at once (32 MiB each). */
const MAX_HASHING = 2;

/** scrypt cost: N=2^15, r=8 -> 32 MiB and about 50-100 ms per try on a box. */
const SCRYPT = { N: 32768, r: 8, p: 1, keylen: 32 };

export class PinError extends Error {
  constructor(
    message: string,
    readonly status: number,
    /** seconds until another try is allowed */
    readonly retryAfter?: number,
    /** a PIN was checked and was wrong (the page logs it) */
    readonly wrong = false,
  ) {
    super(message);
  }
}

interface PinFile {
  v: 1;
  salt: string;
  hash: string;
  N: number;
  r: number;
  p: number;
  setAt: string;
  /** wrong tries per device (client address) since that device's last right one */
  devices: Record<string, DeviceTries>;
  /** epoch ms of each wrong PIN in the last hour, from any device */
  recentWrong: number[];
}

interface DeviceTries {
  failures: number;
  /** epoch ms; no try from this device is checked before this */
  lockedUntil: number;
  /** epoch ms of the last wrong try */
  last: number;
}

interface Session {
  created: number;
  last: number;
}

function scrypt(pin: string, salt: Buffer, keylen: number, opts: ScryptOptions): Promise<Buffer> {
  return new Promise((resolve, reject) => scryptCb(pin, salt, keylen, opts, (err, key) => (err ? reject(err) : resolve(key))));
}

const sha = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");

/** Throws a PinError (400) with a plain sentence when the PIN cannot be used. */
export function checkNewPin(raw: unknown): string {
  const pin = typeof raw === "string" ? raw.trim() : "";
  if (!/^[0-9]+$/.test(pin)) throw new PinError(`Use digits only, at least ${PIN_MIN} of them.`, 400);
  if (pin.length < PIN_MIN) throw new PinError(`Use at least ${PIN_MIN} digits.`, 400);
  if (pin.length > PIN_MAX) throw new PinError(`Use ${PIN_MAX} digits at most.`, 400);
  const d = [...pin].map(Number);
  const same = d.every((x) => x === d[0]);
  const up = d.every((x, i) => i === 0 || x === (d[i - 1]! + 1) % 10);
  const down = d.every((x, i) => i === 0 || x === (d[i - 1]! + 9) % 10);
  if (same || up || down) throw new PinError("That PIN is too easy to guess. Please do not use the same digit or a row like 123456.", 400);
  return pin;
}

/** The wait after `failures` wrong tries in a row from one device, in ms (0 = none). */
export function waitAfter(failures: number): number {
  if (failures < FREE_TRIES) return 0;
  return Math.min(MAX_WAIT_MS, FIRST_WAIT_MS * 2 ** (failures - FREE_TRIES));
}

function readDevices(raw: unknown): Record<string, DeviceTries> {
  const out: Record<string, DeviceTries> = {};
  if (!raw || typeof raw !== "object") return out;
  const num = (x: unknown) => (typeof x === "number" && Number.isFinite(x) && x >= 0 ? x : 0);
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (k.length > 64 || !v || typeof v !== "object") continue;
    const d = v as Record<string, unknown>;
    const failures = Number.isInteger(d.failures) && (d.failures as number) > 0 ? (d.failures as number) : 0;
    if (failures) out[k] = { failures, lockedUntil: num(d.lockedUntil), last: num(d.last) };
  }
  return out;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    if (k && !(k in out)) out[k] = part.slice(i + 1).trim();
  }
  return out;
}

/**
 * Whether this start follows a Restart pressed in the AVADO Admin, i.e. the DAPPMANAGER removed the
 * container and made a new one from the same version:
 * - `marker` lives in the container's own files (not in a volume). It is missing in a new
 *   container and still there when the same container starts again (reboot, power cut, crash,
 *   Pause then Start).
 * - `versionFile` lives in the volume and holds the version that ran last. A new container with
 *   another version is an install or an update, not a restart.
 * Both files are written for the next start. Never throws: when in doubt, the answer is false.
 */
export async function ownerRestarted(marker: string, versionFile: string, version: string): Promise<boolean> {
  let fresh = false;
  try {
    await readFile(marker);
  } catch (e) {
    fresh = (e as NodeJS.ErrnoException).code === "ENOENT";
  }
  let previous: string | null = null;
  try {
    previous = (await readFile(versionFile, "utf8")).trim();
  } catch {
    previous = null;
  }
  try {
    await writeFile(marker, new Date().toISOString() + "\n", { mode: 0o600 });
    if (previous !== version) await writeFileAtomic(versionFile, version + "\n", 0o600);
  } catch {
    return false;
  }
  return fresh && previous === version;
}

export interface PinOptions {
  now?: () => number;
  /** when AI Connect started (the reset window starts here) */
  startedAt?: number;
  /** whether this start follows a Restart in the Admin (see ownerRestarted); default false */
  resetOpen?: boolean;
  resetWindowMs?: number;
  sessionMaxMs?: number;
  sessionIdleMs?: number;
  /** lower scrypt cost, for tests only */
  scryptN?: number;
  /** the box-wide slow-down per try (default 3 s), shorter in tests */
  boxDelayMs?: number;
}

export class PinGuard {
  private data: PinFile | null = null;
  private sessions = new Map<string, Session>();
  private queue: Promise<unknown> = Promise.resolve();
  /** one PIN check at a time per device */
  private deviceQueues = new Map<string, Promise<unknown>>();
  private hashing = 0;
  private hashWaiters: Array<() => void> = [];
  private readonly boxDelayMs: number;
  private resetUsed = false;
  private readonly resetOpen: boolean;
  private readonly now: () => number;
  private readonly startedAt: number;
  private readonly resetWindowMs: number;
  private readonly sessionMaxMs: number;
  private readonly sessionIdleMs: number;
  private readonly scryptN: number;

  constructor(
    private readonly file: string | null,
    opts: PinOptions = {},
  ) {
    this.now = opts.now ?? Date.now;
    this.startedAt = opts.startedAt ?? this.now();
    this.resetOpen = opts.resetOpen ?? false;
    this.resetWindowMs = opts.resetWindowMs ?? RESET_WINDOW_MS;
    this.sessionMaxMs = opts.sessionMaxMs ?? SESSION_MAX_MS;
    this.sessionIdleMs = opts.sessionIdleMs ?? SESSION_IDLE_MS;
    this.scryptN = opts.scryptN ?? SCRYPT.N;
    this.boxDelayMs = opts.boxDelayMs ?? BOX_DELAY_MS;
  }

  /**
   * Reads pin.json. Returns "damaged" when the file is there but cannot be used: the page then asks
   * for a new PIN, so the caller must also remove every key (server.ts does), or anyone could
   * choose a PIN and reach the owner's connections.
   */
  async load(): Promise<"ok" | "none" | "damaged"> {
    if (!this.file) return "none";
    let raw: string;
    try {
      raw = await readFile(this.file, "utf8");
    } catch (e) {
      this.data = null;
      return (e as NodeJS.ErrnoException).code === "ENOENT" ? "none" : "damaged";
    }
    try {
      const d = JSON.parse(raw) as Partial<PinFile>;
      const int = (x: unknown) => Number.isInteger(x) && (x as number) > 0;
      if (d && d.v === 1 && typeof d.salt === "string" && typeof d.hash === "string" && d.hash.length > 0 && int(d.N) && int(d.r) && int(d.p)) {
        this.data = {
          v: 1,
          salt: d.salt,
          hash: d.hash,
          N: d.N!,
          r: d.r!,
          p: d.p!,
          setAt: typeof d.setAt === "string" ? d.setAt : new Date(0).toISOString(),
          devices: readDevices(d.devices),
          recentWrong: Array.isArray(d.recentWrong) ? d.recentWrong.filter((t): t is number => typeof t === "number" && Number.isFinite(t)).slice(-200) : [],
        };
        return "ok";
      }
    } catch {
      /* not JSON */
    }
    this.data = null;
    await rm(this.file, { force: true }).catch(() => {});
    return "damaged";
  }

  isSet(): boolean {
    return this.data !== null;
  }

  /** Runs one PIN operation at a time, so parallel guesses are counted one by one. */
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn);
    this.queue = run.catch(() => {});
    return run;
  }

  /** Runs one PIN check at a time per device, so parallel guesses from it are counted one by one. */
  private perDevice<T>(client: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.deviceQueues.get(client) ?? Promise.resolve();
    const run = prev.then(fn, fn);
    const tail = run.catch(() => {});
    this.deviceQueues.set(client, tail);
    void tail.then(() => {
      if (this.deviceQueues.get(client) === tail) this.deviceQueues.delete(client);
    });
    return run;
  }

  /** scrypt with at most MAX_HASHING running at once (each takes 32 MiB). */
  private async hash(pin: string, salt: Buffer, keylen: number, opts: ScryptOptions): Promise<Buffer> {
    while (this.hashing >= MAX_HASHING) await new Promise<void>((r) => this.hashWaiters.push(r));
    this.hashing += 1;
    try {
      return await scrypt(pin, salt, keylen, opts);
    } finally {
      this.hashing -= 1;
      this.hashWaiters.shift()?.();
    }
  }

  private prune(d: PinFile): void {
    const from = this.now() - BOX_WINDOW_MS;
    d.recentWrong = d.recentWrong.filter((t) => t > from).slice(-200);
    const day = this.now() - 24 * 60 * 60_000;
    for (const [k, v] of Object.entries(d.devices)) if (v.lockedUntil <= this.now() && v.last < day) delete d.devices[k];
    const keys = Object.keys(d.devices);
    if (keys.length > MAX_DEVICES) {
      keys.sort((a, b) => d.devices[a]!.last - d.devices[b]!.last);
      for (const k of keys.slice(0, keys.length - MAX_DEVICES)) delete d.devices[k];
    }
  }

  /** Whether more than BOX_SLOW_AFTER wrong PINs came in the last hour (every try then waits). */
  slow(): boolean {
    if (!this.data) return false;
    const from = this.now() - BOX_WINDOW_MS;
    return this.data.recentWrong.filter((t) => t > from).length > BOX_SLOW_AFTER;
  }

  private async save(): Promise<void> {
    if (!this.file) return;
    if (!this.data) {
      await rm(this.file, { force: true });
      return;
    }
    await writeFileAtomic(this.file, JSON.stringify(this.data), 0o600);
  }

  /** Seconds this device must wait before its next try is checked (0 = may try now). */
  retryAfter(client: string): number {
    const dev = this.data?.devices[client];
    if (!dev) return 0;
    const ms = dev.lockedUntil - this.now();
    return ms > 0 ? Math.ceil(ms / 1000) : 0;
  }

  /** First PIN. Only while none is set. Returns a session id (the page is unlocked right away). */
  set(raw: unknown): Promise<string> {
    return this.serial(async () => {
      if (this.data) throw new PinError("A PIN is already set. Enter it to unlock the page.", 409);
      const pin = checkNewPin(raw);
      const salt = randomBytes(16);
      const opts = { N: this.scryptN, r: SCRYPT.r, p: SCRYPT.p, maxmem: 64 * 1024 * 1024 };
      const hash = await this.hash(pin, salt, SCRYPT.keylen, opts);
      this.data = {
        v: 1,
        salt: salt.toString("base64"),
        hash: hash.toString("base64"),
        N: opts.N,
        r: opts.r,
        p: opts.p,
        setAt: new Date(this.now()).toISOString(),
        devices: {},
        recentWrong: [],
      };
      await this.save();
      return this.newSession();
    });
  }

  /**
   * Checks a PIN from one device (`client`, its address). Right: a session id. Wrong or waiting:
   * PinError (401 / 429).
   */
  unlock(raw: unknown, client: string): Promise<string> {
    return this.perDevice(client, async () => {
      if (!this.data) throw new PinError("No PIN is set yet. Choose one first.", 409);
      const wait = this.retryAfter(client);
      if (wait > 0) throw new PinError(waitWords(wait), 429, wait);
      // many wrong PINs on the whole box: every try is slowed down, none is refused
      if (this.slow()) await sleep(this.boxDelayMs);
      const d = this.data;
      if (!d) throw new PinError("No PIN is set yet. Choose one first.", 409);
      const pin = typeof raw === "string" ? raw.trim() : "";
      let ok = false;
      if (/^[0-9]{1,32}$/.test(pin)) {
        const want = Buffer.from(d.hash, "base64");
        const got = await this.hash(pin, Buffer.from(d.salt, "base64"), want.length, { N: d.N, r: d.r, p: d.p, maxmem: 64 * 1024 * 1024 });
        ok = got.length === want.length && timingSafeEqual(got, want);
      }
      // a reset may have removed the PIN while this one was being checked
      if (this.data !== d) throw new PinError("No PIN is set yet. Choose one first.", 409);
      if (ok) {
        if (d.devices[client]) {
          delete d.devices[client];
          await this.save();
        }
        return this.newSession();
      }
      const t = this.now();
      const dev = (d.devices[client] ??= { failures: 0, lockedUntil: 0, last: t });
      dev.failures += 1;
      dev.last = t;
      const ms = waitAfter(dev.failures);
      dev.lockedUntil = ms ? t + ms : 0;
      d.recentWrong.push(t);
      this.prune(d);
      await this.save();
      if (ms) throw new PinError(`That PIN is not right. ${waitWords(Math.ceil(ms / 1000))}`, 429, Math.ceil(ms / 1000), true);
      const left = FREE_TRIES - dev.failures;
      throw new PinError(`That PIN is not right. ${left === 1 ? "1 try left" : `${left} tries left`}.`, 401, undefined, true);
    });
  }

  private newSession(): string {
    const id = randomBytes(32).toString("base64url");
    const t = this.now();
    this.sessions.set(sha(id), { created: t, last: t });
    while (this.sessions.size > MAX_SESSIONS) this.sessions.delete(this.sessions.keys().next().value!);
    return id;
  }

  /**
   * Whether the cookie holds a live session. With `touch` (the default) it counts as used now; the
   * page's own refresh every few seconds passes false, so an open tab alone does not keep it alive.
   */
  check(cookieHeader: string | undefined, touch = true): boolean {
    if (!this.data) return false;
    const id = parseCookies(cookieHeader)[SESSION_COOKIE];
    if (!id || id.length > 100) return false;
    const key = sha(id);
    const s = this.sessions.get(key);
    if (!s) return false;
    const t = this.now();
    if (t - s.created > this.sessionMaxMs || t - s.last > this.sessionIdleMs) {
      this.sessions.delete(key);
      return false;
    }
    if (touch) s.last = t;
    return true;
  }

  /** When the session in the cookie ends at the latest (for the page), or null. */
  expiresAt(cookieHeader: string | undefined): string | null {
    const id = parseCookies(cookieHeader)[SESSION_COOKIE];
    const s = id ? this.sessions.get(sha(id)) : undefined;
    return s ? new Date(Math.min(s.created + this.sessionMaxMs, s.last + this.sessionIdleMs)).toISOString() : null;
  }

  lock(cookieHeader: string | undefined): void {
    const id = parseCookies(cookieHeader)[SESSION_COOKIE];
    if (id) this.sessions.delete(sha(id));
  }

  /** Until when "Reset the PIN" works (ISO), or null when it does not now. */
  resetUntil(): string | null {
    if (!this.data || this.resetUsed || !this.resetOpen) return null;
    const until = this.startedAt + this.resetWindowMs;
    return this.now() < until ? new Date(until).toISOString() : null;
  }

  /**
   * Removes every key (`removeKeys`, first), then the PIN, and ends every session. Only in the
   * window after a start, once per start. The keys go first and inside the same step, so no new
   * PIN can be chosen while the owner's keys still exist, even if removing pin.json fails.
   * Returns what `removeKeys` returned.
   */
  reset<T>(removeKeys: () => Promise<T>): Promise<T> {
    return this.serial(async () => {
      if (!this.data) throw new PinError("No PIN is set, so there is nothing to reset.", 409);
      if (!this.resetUntil()) {
        throw new PinError("Resetting the PIN only works in the first 10 minutes after you restart AI Connect in the AVADO Admin. Restart it there, then try again.", 403);
      }
      this.resetUsed = true;
      const removed = await removeKeys();
      this.data = null;
      this.sessions.clear();
      await this.save();
      return removed;
    });
  }

  /** Set-Cookie value for a new session. */
  cookie(id: string, secure: boolean): string {
    return `${SESSION_COOKIE}=${id}; Path=/api; Max-Age=${Math.floor(this.sessionMaxMs / 1000)}; HttpOnly; SameSite=Strict${secure ? "; Secure" : ""}`;
  }

  static clearCookie(secure: boolean): string {
    return `${SESSION_COOKIE}=; Path=/api; Max-Age=0; HttpOnly; SameSite=Strict${secure ? "; Secure" : ""}`;
  }
}

/**
 * Keys can only be made with the PIN, so keys without a PIN mean something stopped half-way: a
 * damaged pin.json, or a reset that removed the PIN but could not save the empty key list (power
 * cut, full disk: the key store does not report a failed save). Whoever chooses the next PIN must
 * not find the owner's keys, so they are removed at start. Returns how many were removed (0 when
 * a PIN is set or there were none). Never throws: the keys are gone from memory either way.
 */
export async function removeKeysWithoutPin(pin: PinGuard, tokens: { list(): unknown[]; revokeAll(): Promise<number> }): Promise<number> {
  if (pin.isSet()) return 0;
  const n = tokens.list().length;
  if (n === 0) return 0;
  await tokens.revokeAll().catch(() => {});
  return n;
}

/** "Too many wrong PINs from this device. Try again in 4 minutes." (the page uses the same words) */
export function waitWords(seconds: number): string {
  const m = Math.ceil(seconds / 60);
  const when = seconds <= 60 ? (seconds === 1 ? "1 second" : `${seconds} seconds`) : m === 1 ? "1 minute" : `${m} minutes`;
  return `Too many wrong PINs from this device. Try again in ${when}.`;
}
