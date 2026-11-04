/**
 * The only way this package talks to the DAPPMANAGER (WAMP, realm dappnode_admin, same as the
 * Admin and the Care package). The DAPPMANAGER router accepts anonymous sessions and would run
 * any of its procedures, so the limit lives here: ALLOWED_PROCEDURES is the complete list, every
 * call goes through callDappmanager(), and the kwargs of each call are built by the wrappers below,
 * never passed through from an agent.
 *
 * Deliberately absent (the never-list, see test/never.test.ts): removePackage,
 * restartPackageVolumes, resetBeaconData, resetIpfsData, resyncPackage, updatePackageEnv,
 * copyFileFrom, copyFileTo, runSignedCmd, rebootHost, setName, createJWT, managePorts,
 * signPrioritySupportRequest, recoverLostData, togglePackage, setAutoUpdate, installPackageSafe, ...
 */
import { WampError, type WampSession } from "./wamp.js";

const SUFFIX = ".dappmanager.dnp.dappnode.eth";
export const CHAIN_DATA_TOPIC = `chainData${SUFFIX}`;

export const ALLOWED_PROCEDURES: ReadonlySet<string> = new Set([
  // read
  "listPackages",
  "getStats",
  "getParams",
  "getVersionData",
  "getDiagnostics",
  "logPackage",
  "requestChainData",
  // safe actions, each behind its own scope (tools.ts)
  "restartPackage",
  "installPackage",
]);

export class DappmanagerError extends Error {
  constructor(
    message: string,
    readonly kind: "unavailable" | "rejected" | "forbidden",
  ) {
    super(message);
  }
}

export async function callDappmanager(wamp: WampSession, method: string, kwargs: Record<string, unknown> = {}, timeoutMs?: number): Promise<unknown> {
  if (!ALLOWED_PROCEDURES.has(method)) {
    throw new DappmanagerError(`${method} is not something AI Connect is allowed to do`, "forbidden");
  }
  let raw: unknown;
  try {
    // dontLogError keeps a failed read out of the Admin's activity log (ignored by procedures)
    raw = await wamp.call(`${method}${SUFFIX}`, [], { ...kwargs, dontLogError: true }, timeoutMs);
  } catch (e) {
    if (e instanceof WampError) throw new DappmanagerError(e.message, e.kind === "rejected" ? "rejected" : "unavailable");
    throw e;
  }
  let env: unknown = raw;
  if (typeof raw === "string") {
    try {
      env = JSON.parse(raw);
    } catch {
      throw new DappmanagerError(`${method}: the reply is not JSON`, "rejected");
    }
  }
  const { success, message, result } = (env ?? {}) as { success?: unknown; message?: unknown; result?: unknown };
  if (success !== true) throw new DappmanagerError(`${method}: ${typeof message === "string" ? message : "failed"}`, "rejected");
  return result;
}

export async function listPackages(wamp: WampSession): Promise<unknown[]> {
  // listPackages runs `docker system df`, which can take a while on a busy box
  const result = await callDappmanager(wamp, "listPackages", {}, 90_000);
  if (!Array.isArray(result)) throw new DappmanagerError("listPackages: the result is not a list", "rejected");
  return result;
}

export async function getStats(wamp: WampSession): Promise<Record<string, unknown>> {
  const result = await callDappmanager(wamp, "getStats");
  if (!result || typeof result !== "object") throw new DappmanagerError("getStats: no stats", "rejected");
  return result as Record<string, unknown>;
}

export async function getParams(wamp: WampSession): Promise<Record<string, unknown>> {
  const result = await callDappmanager(wamp, "getParams");
  if (!result || typeof result !== "object") throw new DappmanagerError("getParams: no params", "rejected");
  return result as Record<string, unknown>;
}

export async function getVersionData(wamp: WampSession): Promise<Record<string, unknown>> {
  const result = await callDappmanager(wamp, "getVersionData");
  return result && typeof result === "object" ? (result as Record<string, unknown>) : {};
}

/** DAPPMANAGER 10.0.53+. Never asks for container logs (logs: false): those go through logPackage and the redactor. */
export async function getDiagnostics(wamp: WampSession, parts: { host?: boolean; network?: boolean; clients?: boolean }): Promise<Record<string, unknown>> {
  const result = await callDappmanager(
    wamp,
    "getDiagnostics",
    { host: parts.host === true, network: parts.network === true, clients: parts.clients === true, logs: false },
    30_000,
  );
  if (!result || typeof result !== "object") throw new DappmanagerError("getDiagnostics: no result", "rejected");
  return result as Record<string, unknown>;
}

export async function logPackage(wamp: WampSession, id: string, tail: number): Promise<string> {
  const result = await callDappmanager(wamp, "logPackage", { id, options: { timestamps: true, tail } }, 30_000);
  return typeof result === "string" ? result : "";
}

export async function restartPackage(wamp: WampSession, id: string): Promise<void> {
  // the DAPPMANAGER waits up to 180 s for the app to stop before it recreates it
  await callDappmanager(wamp, "restartPackage", { id }, 240_000);
}

/**
 * Installs or updates `name` to the store version `manifestHash` (the same id the Admin's store
 * page installs: "<name>@<manifest hash>"). No env, port or volume overrides are ever passed.
 */
export async function installPackage(wamp: WampSession, name: string, manifestHash: string, timeoutMs: number): Promise<void> {
  await callDappmanager(wamp, "installPackage", { id: `${name}@${manifestHash}` }, timeoutMs);
}

/**
 * chainData is pushed, not returned (same as the Care package): wait for a push, else ask once.
 */
export async function fetchChainData(wamp: WampSession, pushWaitMs = 6_000, waitMs = 15_000): Promise<unknown[] | null> {
  let resolveFirst!: (v: unknown[] | null) => void;
  const first = new Promise<unknown[] | null>((r) => (resolveFirst = r));
  await wamp.subscribe(CHAIN_DATA_TOPIC, (args) => {
    const data = args[0];
    if (Array.isArray(data)) resolveFirst(data);
  });
  const timers: Array<ReturnType<typeof setTimeout>> = [];
  const wait = (ms: number) => new Promise<null>((r) => timers.push(setTimeout(() => r(null), ms)));
  try {
    const pushed = await Promise.race([first, wait(pushWaitMs)]);
    if (pushed) return pushed;
    await callDappmanager(wamp, "requestChainData");
    return await Promise.race([first, wait(waitMs)]);
  } finally {
    for (const t of timers) clearTimeout(t);
  }
}
