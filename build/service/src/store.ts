/**
 * The store update check, as the Admin does it (DNP_ADMIN services/store/fetchStore.js):
 * rpc.ava.do decides which catalogue (production or staging) this box sees, the catalogue
 * itself comes from the box's IPFS node. Rejects when either step fails (e.g. no internet).
 */
import type { Config } from "./config.js";

export type FetchLike = typeof fetch;

const TIMEOUT_MS = 20_000;

async function withTimeout<T>(fn: (signal: AbortSignal) => Promise<T>, ms = TIMEOUT_MS): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    return await fn(controller.signal);
  } finally {
    clearTimeout(timer);
  }
}

function peerConnect(config: Config, fetchImpl: FetchLike, peers: unknown): void {
  if (!Array.isArray(peers)) return;
  for (const peer of peers) {
    if (typeof peer !== "string" || !peer.startsWith("/")) continue;
    // best effort, like the Admin: helps the box's IPFS node find the catalogue
    void withTimeout((signal) => fetchImpl(`${config.ipfsApi}/swarm/connect?arg=${encodeURIComponent(peer)}`, { method: "POST", signal }), 10_000)
      .then((r) => r.body?.cancel())
      .catch(() => {});
  }
}

export async function fetchStorePackages(
  config: Config,
  nodeid: string,
  packages: Array<{ name: string; version?: string }>,
  fetchImpl: FetchLike = fetch,
): Promise<unknown[]> {
  const rpc = await withTimeout(async (signal) => {
    const res = await fetchImpl(config.storeRpcUrl, {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 0,
        method: "store.getUpdates",
        params: [{ nodeid, packages: packages.map((p) => ({ name: p.name, version: p.version })) }],
      }),
      signal,
    });
    if (res.status < 200 || res.status > 400) throw new Error(`store.getUpdates HTTP ${res.status}`);
    return (await res.json()) as { result?: unknown; error?: unknown };
  });
  if (rpc.error) throw new Error("store.getUpdates failed");
  const storeRes = (typeof rpc.result === "string" ? JSON.parse(rpc.result) : rpc.result) as { hash?: unknown; ipfsHostNodes?: unknown } | null;
  if (!storeRes || typeof storeRes.hash !== "string" || !/^[A-Za-z0-9]+$/.test(storeRes.hash)) {
    throw new Error("store.getUpdates returned no catalogue hash");
  }
  peerConnect(config, fetchImpl, storeRes.ipfsHostNodes);

  const catalogue = await withTimeout(async (signal) => {
    const res = await fetchImpl(`${config.ipfsGateway}/${storeRes.hash}`, { signal });
    if (!res.ok) throw new Error(`store catalogue HTTP ${res.status}`);
    return (await res.json()) as { packages?: unknown; ipfsHostNodes?: unknown };
  });
  peerConnect(config, fetchImpl, catalogue.ipfsHostNodes);
  return Array.isArray(catalogue.packages) ? catalogue.packages : [];
}
