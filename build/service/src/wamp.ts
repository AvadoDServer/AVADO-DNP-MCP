/**
 * A minimal WAMP v2 client over a JSON WebSocket, ported from AVADO-Client-UI src/api/wamp.ts
 * (via the Rocket Pool package backend) for Node 22's global WebSocket, plus SUBSCRIBE for the
 * DAPPMANAGER's chainData topic. The DAPPMANAGER router (realm dappnode_admin at
 * ws://wamp.my.ava.do:8080/ws) accepts anonymous sessions.
 *
 * Each health check opens one session and closes it afterwards; nothing stays open between checks.
 * When the router cannot be reached, the client does not try again: every later call on the same
 * client fails at once, so a check with the router down takes one connect timeout, not one per call.
 */

const HELLO = 1;
const WELCOME = 2;
const ABORT = 3;
const CHALLENGE = 4;
const GOODBYE = 6;
const ERROR = 8;
const SUBSCRIBE = 32;
const SUBSCRIBED = 33;
const EVENT = 36;
const CALL = 48;
const RESULT = 50;

export class WampError extends Error {
  constructor(
    message: string,
    /** "unavailable" means nobody can answer right now (router down, DAPPMANAGER restarting). */
    readonly kind: "unavailable" | "timeout" | "rejected",
  ) {
    super(message);
  }
}

/** While the DAPPMANAGER restarts its procedures are unregistered: that is "unavailable", not a refusal. */
const UNAVAILABLE_ERRORS = new Set(["wamp.error.no_such_procedure", "wamp.error.canceled", "wamp.error.timeout"]);

export interface WebSocketLike {
  readonly readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  onopen: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: ((ev: unknown) => void) | null;
  onerror: ((ev: unknown) => void) | null;
}
export type WebSocketCtor = new (url: string, protocols?: string | string[]) => WebSocketLike;

export interface WampOptions {
  url: string;
  realm: string;
  /** Defaults to Node's global WebSocket. */
  WebSocket?: WebSocketCtor;
  connectTimeoutMs?: number;
  callTimeoutMs?: number;
}

export type EventHandler = (args: unknown[], kwargs: Record<string, unknown>) => void;

export interface WampSession {
  call(procedure: string, args?: unknown[], kwargs?: Record<string, unknown>, timeoutMs?: number): Promise<unknown>;
  subscribe(topic: string, handler: EventHandler, timeoutMs?: number): Promise<void>;
  close(): void;
}

interface Pending {
  what: string;
  resolve: (v: unknown) => void;
  reject: (e: unknown) => void;
  timer: ReturnType<typeof setTimeout>;
}

const OPEN = 1;

export class WampClient implements WampSession {
  private readonly url: string;
  private readonly realm: string;
  private readonly Ctor: WebSocketCtor | undefined;
  private readonly connectTimeoutMs: number;
  private readonly callTimeoutMs: number;
  private session: Promise<WebSocketLike> | null = null;
  private connectError: WampError | null = null;
  private ws: WebSocketLike | null = null;
  private readonly pending = new Map<number, Pending>();
  private readonly pendingSubs = new Map<number, { topic: string; handler: EventHandler }>();
  private readonly subscriptions = new Map<number, EventHandler>();
  private nextId = 1;

  constructor(opts: WampOptions) {
    this.url = opts.url;
    this.realm = opts.realm;
    this.Ctor = opts.WebSocket ?? ((globalThis as { WebSocket?: unknown }).WebSocket as WebSocketCtor | undefined);
    this.connectTimeoutMs = opts.connectTimeoutMs ?? 10_000;
    this.callTimeoutMs = opts.callTimeoutMs ?? 30_000;
  }

  /** Resolves to the first positional result (or the keyword results), like autobahn. */
  call(procedure: string, args?: unknown[], kwargs?: Record<string, unknown>, timeoutMs?: number): Promise<unknown> {
    return this.send(procedure, timeoutMs, (id) => {
      const msg: unknown[] = [CALL, id, {}, procedure];
      if (args !== undefined || kwargs !== undefined) msg.push(args ?? []);
      if (kwargs !== undefined) msg.push(kwargs);
      return msg;
    });
  }

  /** Resolves once the router confirmed the subscription. */
  async subscribe(topic: string, handler: EventHandler, timeoutMs?: number): Promise<void> {
    await this.send(`subscribe ${topic}`, timeoutMs, (id) => {
      this.pendingSubs.set(id, { topic, handler });
      return [SUBSCRIBE, id, {}, topic];
    });
  }

  close(): void {
    const ws = this.ws;
    this.ws = null;
    this.session = null;
    this.subscriptions.clear();
    this.pendingSubs.clear();
    this.rejectAll("closed");
    try {
      if (ws && ws.readyState === OPEN) ws.send(JSON.stringify([GOODBYE, {}, "wamp.close.system_shutdown"]));
      ws?.close(1000);
    } catch {
      /* already closed */
    }
  }

  private send(what: string, timeoutMs: number | undefined, build: (id: number) => unknown[]): Promise<unknown> {
    return this.connect().then(
      (ws) =>
        new Promise((resolve, reject) => {
          if (ws.readyState !== OPEN) {
            reject(new WampError(`${what}: session closed`, "unavailable"));
            return;
          }
          const id = this.nextId++;
          const timer = setTimeout(() => {
            this.pending.delete(id);
            this.pendingSubs.delete(id);
            reject(new WampError(`${what}: no answer in time`, "timeout"));
          }, timeoutMs ?? this.callTimeoutMs);
          this.pending.set(id, { what, resolve, reject, timer });
          ws.send(JSON.stringify(build(id)));
        }),
    );
  }

  private rejectAll(detail: string) {
    for (const [id, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new WampError(`${p.what}: ${detail}`, "unavailable"));
      this.pending.delete(id);
    }
  }

  private settle(id: number): Pending | undefined {
    const p = this.pending.get(id);
    if (!p) return undefined;
    this.pending.delete(id);
    clearTimeout(p.timer);
    return p;
  }

  private connect(): Promise<WebSocketLike> {
    if (this.session) return this.session;
    if (this.connectError) return Promise.reject(this.connectError);
    const { url, realm, Ctor } = this;

    const session = new Promise<WebSocketLike>((resolve, reject) => {
      if (!Ctor) {
        reject(new WampError("WebSocket is not available in this runtime", "unavailable"));
        return;
      }
      let ws: WebSocketLike;
      try {
        ws = new Ctor(url, ["wamp.2.json"]);
      } catch (e) {
        this.connectError = new WampError(`cannot open ${url}: ${e instanceof Error ? e.message : String(e)}`, "unavailable");
        reject(this.connectError);
        return;
      }
      this.ws = ws;
      let settled = false;
      const fail = (err: WampError) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.connectError = err;
        reject(err);
      };
      const timer = setTimeout(() => {
        fail(new WampError(`no WELCOME from ${url}`, "timeout"));
        try {
          ws.close();
        } catch {
          /* ignore */
        }
      }, this.connectTimeoutMs);

      ws.onopen = () => {
        ws.send(
          JSON.stringify([HELLO, realm, { roles: { caller: { features: {} }, subscriber: { features: {} } }, agent: "avado-ai-connect" }]),
        );
      };
      ws.onerror = () => {
        /* onclose follows */
      };
      ws.onclose = () => {
        fail(new WampError(`connection to ${url} closed`, "unavailable"));
        if (this.ws !== ws) return;
        this.ws = null;
        this.session = null;
        this.rejectAll("connection closed");
      };
      ws.onmessage = (ev) => {
        let msg: unknown;
        try {
          msg = JSON.parse(String(ev.data));
        } catch {
          return;
        }
        if (!Array.isArray(msg)) return;
        switch (msg[0]) {
          case WELCOME:
            if (!settled) {
              settled = true;
              clearTimeout(timer);
              resolve(ws);
            }
            break;
          case ABORT: {
            const details = (msg[1] ?? {}) as { message?: string };
            fail(new WampError(`router refused the session: ${[msg[2], details.message].filter(Boolean).join(": ")}`, "rejected"));
            ws.close();
            break;
          }
          case CHALLENGE:
            fail(new WampError("the router asked for authentication", "rejected"));
            ws.close();
            break;
          case GOODBYE:
            ws.send(JSON.stringify([GOODBYE, {}, "wamp.close.goodbye_and_out"]));
            ws.close();
            break;
          case RESULT: {
            const p = this.settle(msg[1] as number);
            if (!p) return;
            const args = msg[3] as unknown[] | undefined;
            p.resolve(Array.isArray(args) && args.length > 0 ? args[0] : msg[4]);
            break;
          }
          case SUBSCRIBED: {
            const req = this.pendingSubs.get(msg[1] as number);
            this.pendingSubs.delete(msg[1] as number);
            const p = this.settle(msg[1] as number);
            if (!p || !req) return;
            this.subscriptions.set(msg[2] as number, req.handler);
            p.resolve(undefined);
            break;
          }
          case EVENT: {
            const handler = this.subscriptions.get(msg[1] as number);
            if (!handler) return;
            const args = Array.isArray(msg[4]) ? (msg[4] as unknown[]) : [];
            const kwargs = msg[5] && typeof msg[5] === "object" ? (msg[5] as Record<string, unknown>) : {};
            try {
              handler(args, kwargs);
            } catch {
              /* a handler bug must not kill the session */
            }
            break;
          }
          case ERROR: {
            if (msg[1] !== CALL && msg[1] !== SUBSCRIBE) return;
            this.pendingSubs.delete(msg[2] as number);
            const p = this.settle(msg[2] as number);
            if (!p) return;
            const uri = String(msg[4]);
            const args = msg[5] as unknown[] | undefined;
            const text = Array.isArray(args) && typeof args[0] === "string" ? `: ${args[0]}` : "";
            p.reject(new WampError(`${p.what}: ${uri}${text}`, UNAVAILABLE_ERRORS.has(uri) ? "unavailable" : "rejected"));
            break;
          }
        }
      };
    });

    this.session = session;
    session.catch(() => {
      if (this.session === session) this.session = null;
    });
    return session;
  }
}
