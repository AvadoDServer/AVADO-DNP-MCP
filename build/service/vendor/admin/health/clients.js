// Which installed AVADO package plays which role on which network.
// Names come from the DappStore manifest (verified 2026-09-22) and the
// Prometheus job list in AVADO-DNP-Prometheus. Unknown packages return null
// and are ignored by role-based checks.

export const ROLES = {
  EXECUTION: "execution",
  CONSENSUS: "consensus",
  VALIDATOR: "validator",
  MEV: "mev",
  MONITORING: "monitoring",
  REMOTE: "remote",
};

// testnet: no real money at stake, so its apps are the first ones an owner
// short of disk space can remove (see health/rules/storage.js).
export const NETWORKS = {
  mainnet: { label: "Ethereum mainnet", genesis: 1606824023, slotSeconds: 12, slotsPerEpoch: 32 },
  holesky: { label: "Holesky testnet", genesis: 1695902400, slotSeconds: 12, slotsPerEpoch: 32, testnet: true },
  // Retired: the chain no longer runs, so checks about live validators skip it.
  goerli: { label: "Goerli testnet (retired)", genesis: 1616508000, slotSeconds: 12, slotsPerEpoch: 32, retired: true, testnet: true },
  gnosis: { label: "Gnosis chain", genesis: 1638993340, slotSeconds: 5, slotsPerEpoch: 16 },
};

const EXECUTION_PRUNE =
  "Execution clients keep the whole chain state and grow over time. Resetting its data makes it sync again from scratch (several hours to a few days). No validator keys are stored in an execution client, so this is safe, but your validators cannot attest until it is synced again.";
const CONSENSUS_ADVICE =
  "Consensus clients normally stay under 200 GB. Free up space deletes only the chain data; your validator keys, slashing protection and settings stay, and the client downloads a recent checkpoint and is back in about 15 to 30 minutes.";
// The same row when there is no Free up space button: the installed
// DAPPMANAGER is older than 10.0.50 (the Admin updates on its own), or the
// app is Prysm's validator, which the core cannot reset.
export const CONSENSUS_ADVICE_UPDATE_NEEDED =
  "Consensus clients normally stay under 200 GB. Its data folder also holds your validator keys and slashing protection, so never delete it yourself. Update your AVADO system (System, Updates) to get the Free up space button, which deletes only the chain data.";
export const CONSENSUS_ADVICE_NO_RESET =
  "Consensus clients normally stay under 200 GB. Its data folder also holds your validator keys and slashing protection, so never delete it yourself. If it is much larger, contact support.";

// A consensus client normally stays under this (decimal bytes, like parseDockerSize).
export const CONSENSUS_SIZE_LIMIT = 200e9;

// The DAPPMANAGER that has the resetBeaconData call.
export const BEACON_RESET_SINCE = "10.0.50";
const DAPPMANAGER_PACKAGE = "dappmanager.dnp.dappnode.eth";

// "10.0.50" -> [10, 0, 50]; null when it is not a plain x.y.z version. No
// semver import: AVADO Care copies this file byte for byte.
const versionParts = v => {
  const m = typeof v === "string" ? v.trim().match(/^v?(\d+)\.(\d+)\.(\d+)/) : null;
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
};

// Packages whose beacon (chain) data the DAPPMANAGER's resetBeaconData can
// delete on its own, keeping the validator files. Keep in sync with its table
// (calls/resetBeaconData.js). eth2validator (Prysm's validator) is not one.
const canResetBeaconName = name =>
  /^(teku|lighthouse|nimbus)(-[a-z]+)?\.avado\.dnp\.dappnode\.eth$/.test(name) ||
  name === "prysm-beacon-chain-mainnet.avado.dnp.dappnode.eth";

/**
 * True when the installed DAPPMANAGER (it is in `packages`, as a core
 * package) is 10.0.50 or newer, the first one with resetBeaconData. An older
 * or unreadable version is false: the button must not call something the core
 * does not have.
 */
export function canResetBeaconData(packages) {
  const core = (packages || []).find(p => p && p.name === DAPPMANAGER_PACKAGE);
  const have = versionParts(core && core.version);
  const need = versionParts(BEACON_RESET_SINCE);
  if (!have) return false;
  for (let i = 0; i < 3; i++) if (have[i] !== need[i]) return have[i] > need[i];
  return true;
}

const table = [
  // Execution
  ["ethchain-geth.public.dappnode.eth", ROLES.EXECUTION, "mainnet", "Geth", "geth"],
  ["avado-dnp-nethermind.public.dappnode.eth", ROLES.EXECUTION, "mainnet", "Nethermind", "nethermind"],
  ["holesky-geth.avado.dnp.dappnode.eth", ROLES.EXECUTION, "holesky", "Geth (Holesky)", "geth"],
  ["goerli-geth.avado.dnp.dappnode.eth", ROLES.EXECUTION, "goerli", "Geth (Goerli)", "geth"],
  ["nethermind-gnosis.avado.dnp.dappnode.eth", ROLES.EXECUTION, "gnosis", "Nethermind (Gnosis)", "nethermind"],
  // Consensus (beacon + validator in one package, except Prysm)
  ["nimbus.avado.dnp.dappnode.eth", ROLES.CONSENSUS, "mainnet", "Nimbus", "nimbus"],
  ["nimbus-holesky.avado.dnp.dappnode.eth", ROLES.CONSENSUS, "holesky", "Nimbus (Holesky)", "nimbus"],
  ["nimbus-prater.avado.dnp.dappnode.eth", ROLES.CONSENSUS, "goerli", "Nimbus (Prater)", "nimbus"],
  ["teku.avado.dnp.dappnode.eth", ROLES.CONSENSUS, "mainnet", "Teku", "teku"],
  ["lighthouse.avado.dnp.dappnode.eth", ROLES.CONSENSUS, "mainnet", "Lighthouse", "lighthouse"],
  ["teku-holesky.avado.dnp.dappnode.eth", ROLES.CONSENSUS, "holesky", "Teku (Holesky)", "teku"],
  ["teku-prater.avado.dnp.dappnode.eth", ROLES.CONSENSUS, "goerli", "Teku (Prater)", "teku"],
  ["teku-gnosis.avado.dnp.dappnode.eth", ROLES.CONSENSUS, "gnosis", "Teku (Gnosis)", "teku"],
  // Lighthouse holesky/gnosis: names from AVADO-DNP-Lighthouse's
  // dappnode_package-*.json, labels from the Prometheus lighthouse job.
  ["lighthouse-holesky.avado.dnp.dappnode.eth", ROLES.CONSENSUS, "holesky", "Lighthouse (Holesky)", "lighthouse"],
  ["lighthouse-gnosis.avado.dnp.dappnode.eth", ROLES.CONSENSUS, "gnosis", "Lighthouse (Gnosis)", "lighthouse"],
  ["prysm-beacon-chain-mainnet.avado.dnp.dappnode.eth", ROLES.CONSENSUS, "mainnet", "Prysm beacon chain", "prysm"],
  ["eth2validator.avado.dnp.dappnode.eth", ROLES.CONSENSUS, "mainnet", "Prysm", "prysm"],
  // Tooling
  ["mevboost.avado.dnp.dappnode.eth", ROLES.MEV, "mainnet", "MEV-Boost"],
  ["grafana.avado.dappnode.eth", ROLES.MONITORING, null, "Grafana"],
  ["prometheus.avado.dappnode.eth", ROLES.MONITORING, null, "Prometheus"],
  ["node-exporter.avado.dappnode.eth", ROLES.MONITORING, null, "Node exporter"],
  ["remoteconnect.avado.dnp.dappnode.eth", ROLES.REMOTE, null, "Remote Connect"],
  ["vpn.dnp.dappnode.eth", ROLES.REMOTE, null, "VPN"],
];

// Every consensus package runs a validator client and can hold validator
// keys, except Prysm's beacon chain: Prysm's validator is its own app
// (eth2validator).
const NO_VALIDATOR_CLIENT = new Set(["prysm-beacon-chain-mainnet.avado.dnp.dappnode.eth"]);

const byName = Object.fromEntries(
  table.map(([name, role, network, label, promClient]) => [
    name,
    {
      name,
      role,
      network,
      label,
      promClient,
      canResetData: role === ROLES.EXECUTION,
      canResetBeacon: role === ROLES.CONSENSUS && canResetBeaconName(name),
      holdsKeys: role === ROLES.CONSENSUS && !NO_VALIDATOR_CLIENT.has(name),
      pruneAdvice:
        role === ROLES.EXECUTION ? EXECUTION_PRUNE : role === ROLES.CONSENSUS ? CONSENSUS_ADVICE : null,
    },
  ])
);

export const PROMETHEUS_PACKAGE = "prometheus.avado.dappnode.eth";
export const GRAFANA_PACKAGE = "grafana.avado.dappnode.eth";
export const NODE_EXPORTER_PACKAGE = "node-exporter.avado.dappnode.eth";
// Rocket Pool keeps its validator keys inside its own node wallet.
export const ROCKET_POOL_PACKAGE = "rocketpool.avado.dnp.dappnode.eth";

export function getClient(name) {
  return (name && byName[name]) || null;
}

export function clientsByRole(packages, role) {
  return (packages || [])
    .map(pkg => ({ pkg, client: getClient(pkg && pkg.name) }))
    .filter(({ client }) => client && client.role === role);
}

// Installed apps that can hold validator keys on a network that still runs.
// Stopped apps count too: they start again by themselves after a reboot or
// an update (restart "always", and every update runs the app).
export function keyHolders(packages) {
  return clientsByRole(packages, ROLES.CONSENSUS).filter(
    ({ client }) => client.holdsKeys && !(NETWORKS[client.network] && NETWORKS[client.network].retired)
  );
}

export function currentSlot(network, nowMs) {
  const n = NETWORKS[network];
  if (!n) return null;
  return Math.floor((nowMs / 1000 - n.genesis) / n.slotSeconds);
}

/*
 * How much chain history a beacon node keeps, in plain words, from the
 * package's own settings (`pkg.envs`) and, for Teku mainnet, its version: the
 * 0.0.76 package template switched Teku's default to "minimal". Lives here,
 * not in its own module, because health/rules/storage.js uses it and AVADO
 * Care copies this file and the rules byte for byte (no semver there).
 */
const STORAGE_MODE_LABELS = {
  minimal: "Recent data only (minimal)",
  pruned: "All blocks (pruned)",
  archive: "Full history (archive)",
};

// Per package: the first version whose template runs Teku in minimal mode.
// Only mainnet is known; the other networks' packages have their own version
// lines and keep "pruned" until their release is listed here.
export const TEKU_MINIMAL_SINCE = { "teku.avado.dnp.dappnode.eth": "0.0.76" };

// Prysm keeps a full state every N slots; 2048 is its default. A smaller
// spacing stores more history (an archive node uses 32), a larger one less.
const PRYSM_DEFAULT_ARCHIVE_POINT = 2048;

const modeResult = (key, detail) => ({ key, label: STORAGE_MODE_LABELS[key], detail });
const envOf = (pkg, name) => {
  const v = pkg && pkg.envs && pkg.envs[name];
  return typeof v === "string" ? v : "";
};
const versionAtLeast = (version, since) => {
  const have = versionParts(version);
  const need = versionParts(since);
  if (!have || !need) return false;
  for (let i = 0; i < 3; i++) if (have[i] !== need[i]) return have[i] > need[i];
  return true;
};

function tekuStorageMode(pkg) {
  const m = envOf(pkg, "EXTRA_OPTS").match(/--data-storage-mode(?:=|\s+)(archive|prune|minimal)\b/i);
  if (m) {
    const mode = m[1].toLowerCase();
    return modeResult(mode === "prune" ? "pruned" : mode, "Set by EXTRA_OPTS");
  }
  const since = TEKU_MINIMAL_SINCE[pkg.name];
  if (!since) return modeResult("pruned", "Teku default for this package");
  return versionAtLeast(pkg.version, since)
    ? modeResult("minimal", `Teku default for package ${since} and newer`)
    : modeResult("pruned", `Teku default for packages older than ${since}`);
}

function prysmStorageMode(pkg) {
  const m = envOf(pkg, "EXTRA_OPTS").match(/--slots-per-archive-point(?:=|\s+)(\d+)\b/);
  const n = m ? Number(m[1]) : null;
  if (n !== null && n < PRYSM_DEFAULT_ARCHIVE_POINT) {
    return modeResult("archive", `Set by EXTRA_OPTS (--slots-per-archive-point=${n})`);
  }
  return modeResult("pruned", "Prysm default: no archive points");
}

/**
 * @returns {{ key: "minimal"|"pruned"|"archive", label: string, detail: string } | null}
 *   null for anything that is not a beacon node (execution clients, tools,
 *   Prysm's validator app, unknown packages).
 */
export function storageMode(pkg) {
  const client = getClient(pkg && pkg.name);
  if (!client || client.role !== ROLES.CONSENSUS || !client.canResetBeacon) return null;
  switch (client.promClient) {
    case "teku":
      return tekuStorageMode(pkg);
    case "lighthouse":
      return /--reconstruct-historic-states/.test(envOf(pkg, "EXTRA_OPTS_BEACON_NODE"))
        ? modeResult("archive", "Set by EXTRA_OPTS_BEACON_NODE (--reconstruct-historic-states)")
        : modeResult("pruned", "Lighthouse default: old states are pruned");
    case "nimbus":
      return /--history[=:\s]+archive\b/i.test(envOf(pkg, "EXTRA_OPTS"))
        ? modeResult("archive", "Set by EXTRA_OPTS (--history=archive)")
        : modeResult("pruned", "Nimbus default: history is pruned");
    case "prysm":
      return prysmStorageMode(pkg);
    default:
      return null;
  }
}
