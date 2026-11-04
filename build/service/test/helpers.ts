import { mkdtempSync } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { ActivityLog } from "../src/activity.js";
import { Approvals } from "../src/approvals.js";
import { Box } from "../src/box.js";
import { loadConfig, type Config } from "../src/config.js";
import { createAgentApp, createApp, defaultLimits, type AppDeps, type Limits } from "../src/http.js";
import { silentLogger } from "../src/log.js";
import { PinGuard, type PinOptions } from "../src/pin.js";
import { RateLimiter } from "../src/ratelimit.js";
import { TokenStore, type Scope, type TokenRecord } from "../src/tokens.js";
import type { ToolContext } from "../src/tools.js";
import { WampError, type EventHandler, type WampSession } from "../src/wamp.js";

export function tempDir(): string {
  return mkdtempSync(path.join(tmpdir(), "avado-mcp-test-"));
}

export function testConfig(overrides: Partial<Config> = {}): Config {
  return {
    ...loadConfig({
      STORE_RPC_URL: "https://rpc.test",
      IPFS_GATEWAY: "http://ipfs.test:8080/ipfs",
      IPFS_API: "http://ipfs.test:5001/api/v0",
      PACKAGE_VERSION: "0.1.0",
      STATE_DIR: tempDir(),
      PUBLIC_DIR: path.resolve(process.cwd(), "public"),
      INSTALL_WAIT_MS: "50",
      APPROVAL_TIMEOUT_MS: "2000",
    }),
    ...overrides,
  };
}

export const NODE_ID = "0x2c7536e3605d9c16a7a3d7b1898e529396a65c23";

export const pkg = (name: string, overrides: Record<string, unknown> = {}) => ({
  name,
  id: name,
  state: "running",
  running: true,
  isCore: false,
  version: "1.0.0",
  volumes: [],
  manifest: { name, title: name.split(".")[0], version: "1.0.0" },
  ...overrides,
});

export const envelope = (result: unknown) => JSON.stringify({ success: true, message: "ok", result });

export type Handler = (kwargs: Record<string, unknown>) => unknown;

/** A fake DAPPMANAGER over WAMP: procedures by short name, plus the chainData topic. */
export class FakeWamp implements WampSession {
  calls: Array<{ procedure: string; kwargs: Record<string, unknown> }> = [];
  closed = false;
  private subs = new Map<string, EventHandler>();

  constructor(
    public handlers: Record<string, Handler>,
    public chainData: unknown[] | null = [],
  ) {}

  async call(procedure: string, _args?: unknown[], kwargs: Record<string, unknown> = {}): Promise<unknown> {
    this.calls.push({ procedure, kwargs });
    const short = procedure.replace(".dappmanager.dnp.dappnode.eth", "");
    if (short === "requestChainData") {
      const data = this.chainData;
      if (data) setImmediate(() => this.subs.get("chainData.dappmanager.dnp.dappnode.eth")?.([data], {}));
      return envelope({ message: "ok" });
    }
    const h = this.handlers[short];
    if (!h) throw new WampError(`${procedure}: wamp.error.no_such_procedure`, "unavailable");
    return h(kwargs);
  }

  /** Publishes on the chainData topic, as the DAPPMANAGER does while an Admin tab is open. */
  publish(data: unknown[]): void {
    this.subs.get("chainData.dappmanager.dnp.dappnode.eth")?.([data], {});
  }

  async subscribe(topic: string, handler: EventHandler): Promise<void> {
    this.subs.set(topic, handler);
  }

  close(): void {
    this.closed = true;
  }
}

/** A DAPPMANAGER with the read calls and the two actions AI Connect uses. */
export function dappmanagerHandlers(packages: unknown[], stats: Record<string, unknown> = { disk: "42%" }): Record<string, Handler> {
  return {
    listPackages: () => envelope(packages),
    getStats: () => envelope(stats),
    getParams: () => envelope({ nodeid: NODE_ID, ip: "85.84.83.82", internalip: "192.168.1.20", name: "AVADO" }),
    getVersionData: () => envelope({ version: "10.0.54", branch: "pr", commit: "abc" }),
    getDiagnostics: () => envelope({ host: { os: "Debian GNU/Linux 11 (bullseye)", kernel: "5.10.0-18-amd64", cores: 16 }, containers: [], clients: [], errors: [] }),
    logPackage: () => envelope("line one\npassword=hunter2\n"),
    restartPackage: () => envelope(null),
    installPackage: () => envelope(null),
    // present on a real DAPPMANAGER; AI Connect must never call them
    removePackage: () => envelope(null),
    updatePackageEnv: () => envelope(null),
    copyFileFrom: () => envelope("secret file"),
    runSignedCmd: () => envelope(null),
  };
}

export interface FetchCall {
  url: string;
  init: RequestInit | undefined;
}

export function fakeFetch(route: (url: string, init: RequestInit | undefined) => Response | Promise<Response>): { fetch: typeof fetch; calls: FetchCall[] } {
  const calls: FetchCall[] = [];
  const f = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    calls.push({ url, init });
    return route(url, init);
  }) as typeof fetch;
  return { fetch: f, calls };
}

export const jsonResponse = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

// ---- AI Connect fixtures ----

export const STORE_HASH = "QmZt7fwZL2xH2PBg6Yer9wSaV7Un51ZN5HS1QVRXSzzB6C";
export const hashOf = (n: number) => "Qm" + "a".repeat(43) + String(n % 10);

export const storeEntry = (name: string, version: string, extra: Record<string, unknown> = {}, n = 1) => ({
  manifest: { name, version, title: name.split(".")[0], type: "service", avadocategory: "ethstaking", shortDescription: `${name} app`, ...extra },
  manifesthash: hashOf(n),
});

export function storeFetch(entries: unknown[]) {
  return fakeFetch((url) => {
    if (url.startsWith("https://rpc.test")) return jsonResponse(200, { jsonrpc: "2.0", id: 0, result: JSON.stringify({ hash: STORE_HASH, ipfsHostNodes: [] }) });
    if (url.startsWith(`http://ipfs.test:8080/ipfs/${STORE_HASH}`)) return jsonResponse(200, { packages: entries });
    if (url.includes("swarm/connect")) return jsonResponse(200, {});
    return new Response("no", { status: 404 });
  });
}

export const PACKAGES = [
  pkg("teku.avado.dnp.dappnode.eth", { version: "0.0.79", manifest: { name: "teku.avado.dnp.dappnode.eth", title: "Teku Consensus Client", version: "0.0.79" }, envs: { PASSWORD: "hunter2" } }),
  pkg("rotki.avado.dnp.dappnode.eth", { version: "0.0.26", running: false, state: "exited" }),
  pkg("dappmanager.dnp.dappnode.eth", { isCore: true, version: "10.0.54" }),
  pkg("remoteconnect.avado.dnp.dappnode.eth", { isCore: true, version: "0.0.53" }),
  pkg("mcp.avado.dnp.dappnode.eth", { version: "0.1.0" }),
];

export const STORE = [
  storeEntry("teku.avado.dnp.dappnode.eth", "0.0.80", {}, 1),
  storeEntry("rotki.avado.dnp.dappnode.eth", "0.0.26", {}, 2),
  storeEntry("nimbus.avado.dnp.dappnode.eth", "0.0.53", { title: "Nimbus Consensus Client" }, 3),
  storeEntry("dappmanager.dnp.dappnode.eth", "10.0.55", { type: "dncore", avadocategory: "avadosystem" }, 4),
  storeEntry("goerli-geth.avado.dnp.dappnode.eth", "10.4.52", { avadocategory: "testnets" }, 5),
];

export function makeWorld(opts: { scopes?: Scope[]; confirm?: boolean; handlers?: Record<string, Handler> } = {}) {
  const config = testConfig();
  const wamps: FakeWamp[] = [];
  const handlers = opts.handlers ?? dappmanagerHandlers(PACKAGES);
  const { fetch, calls: fetchCalls } = storeFetch(STORE);
  const box = new Box(config, silentLogger, {
    openWamp: () => {
      const w = new FakeWamp(handlers);
      wamps.push(w);
      return w;
    },
    fetch,
    now: () => Date.now(),
  });
  const activity = new ActivityLog(null);
  const approvals = new Approvals();
  const tokens = new TokenStore(path.join(config.stateDir, "tokens.json"));
  const token: TokenRecord = {
    id: "11111111-1111-4111-8111-111111111111",
    name: "Test agent",
    client: "claude-code",
    scopes: opts.scopes ?? ["read"],
    hash: "0".repeat(64),
    hint: "avado_xxxx",
    createdAt: new Date().toISOString(),
    lastUsedAt: null,
    confirmActions: opts.confirm ?? false,
  };
  const ctx: ToolContext = {
    token,
    box,
    activity,
    approvals,
    tokens,
    actionLimiter: new RateLimiter(10, 60 * 60_000),
    approvalTimeoutMs: config.approvalTimeoutMs,
    logger: silentLogger,
    version: "0.1.0",
  };
  const procedures = () => wamps.flatMap((w) => w.calls.map((c) => c.procedure.replace(".dappmanager.dnp.dappnode.eth", "")));
  const callsOf = (name: string) => wamps.flatMap((w) => w.calls.filter((c) => c.procedure === `${name}.dappmanager.dnp.dappnode.eth`));
  return { config, box, activity, approvals, tokens, token, ctx, wamps, procedures, callsOf, fetchCalls };
}

// ---- the HTTP side (page, its API, /mcp) ----

export const servers: http.Server[] = [];

/** Low scrypt cost for tests (the real one takes ~100 ms per try). */
export const TEST_SCRYPT_N = 1024;
export const GOOD_PIN = "482915";

/** The page app and the agent-only app on random ports, with one key made directly in the store. */
export async function startHttp(scopes: Scope[] = ["read"], limits: Limits = defaultLimits(), pinOpts: PinOptions = {}, fetchImpl?: typeof fetch) {
  const w = makeWorld();
  await w.tokens.load();
  const pin = new PinGuard(path.join(w.config.stateDir, "pin.json"), { scryptN: TEST_SCRYPT_N, ...pinOpts });
  await pin.load();
  const deps: AppDeps = {
    config: w.config,
    logger: silentLogger,
    box: w.box,
    tokens: w.tokens,
    activity: w.activity,
    approvals: w.approvals,
    pin,
    fetch: fetchImpl ?? ((async () => new Response("no", { status: 404 })) as typeof fetch),
    httpsInfo: () => ({ on: false, validTo: null }),
  };
  const listen = async (app: http.RequestListener) => {
    const s = http.createServer(app);
    servers.push(s);
    await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
    return `http://127.0.0.1:${(s.address() as AddressInfo).port}`;
  };
  const main = await listen(createApp(deps, limits));
  const agent = await listen(createAgentApp(deps, limits));
  const { token } = await w.tokens.create({ name: "SDK client", client: "other", scopes, confirmActions: false });
  return { w, main, agent, token, pin, deps };
}

/** Headers the page sends on every change. */
export const pageHeaders = { "Content-Type": "application/json", "X-Avado-Request": "1" };

/** "aic_session=..." from a Set-Cookie header, ready for a Cookie header. */
export function sessionFrom(res: Response): string {
  const set = res.headers.get("set-cookie") ?? "";
  const m = /aic_session=([^;]*)/.exec(set);
  if (!m || !m[1]) throw new Error(`no session cookie in: ${set}`);
  return `aic_session=${m[1]}`;
}

/** Chooses the first PIN through the page API; returns the Cookie header of the session it gives. */
export async function setPin(main: string, pin = GOOD_PIN): Promise<string> {
  const r = await fetch(`${main}/api/pin/set`, { method: "POST", headers: pageHeaders, body: JSON.stringify({ pin }) });
  if (r.status !== 200) throw new Error(`set PIN: ${r.status} ${await r.text()}`);
  return sessionFrom(r);
}
