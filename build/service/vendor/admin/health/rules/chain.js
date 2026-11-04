import { clientsByRole, currentSlot, NETWORKS, ROLES } from "health/clients";
import { appTitle } from "./apps";

/** Installed consensus client packages matched to a metric sample. */
function matchSamples(packages, samples) {
  const cc = clientsByRole(packages, ROLES.CONSENSUS);
  return (samples || [])
    .map(s => ({ s, match: cc.find(({ client }) => client.promClient === s.client && client.network === s.network) }))
    .filter(x => x.match);
}

// chainData entries (services/chainData) aren't keyed by the full DNP name —
// DAPPMANAGER names them shortNameCapitalized(dnpName) (utils/format.js),
// e.g. "Nimbus", "Nimbus-holesky", "Teku-gnosis". Match the exact short
// name, case-insensitively; a *substring* match (e.g. "nimbus" inside
// "nimbus-holesky") would wrongly let one network's syncing chain suppress
// a same-client, different-network package's head-behind finding.
function chainEntryMatchesPkg(chainName, pkgName) {
  if (!chainName || !pkgName) return false;
  const name = String(chainName).toLowerCase();
  const short = String(pkgName).split(".")[0].toLowerCase();
  return name === short;
}

// Space-grouped thousands (e.g. 15273292 -> "15 273 292") for slot numbers in
// `detail` lines — a fixed, locale-independent grouping rather than
// `toLocaleString`, whose separator depends on the runtime's ICU data.
function formatSlot(n) {
  return String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, " ");
}

export function chainSyncing({ chainData }) {
  return (chainData || [])
    .filter(c => c && c.syncing)
    .map(c => {
      const pct = typeof c.progress === "number" ? ` (${Math.floor(c.progress * 100)}%)` : "";
      return {
        id: `chain-syncing:${c.name}`,
        severity: "info",
        topic: "sync",
        title: `${c.name} is syncing${pct}`,
        why: "Your client is catching up with the chain. Validators can only attest once it is synced.",
        fix: null,
      };
    });
}

// DAPPMANAGER (watchers/chains) reports a client whose API it can't reach as
// `{ name, error: true, message }` with no `syncing` field. Without this rule
// that entry would read as "nothing wrong" everywhere; it covers execution
// clients as well as consensus clients (any chainData entry).
export function chainError({ chainData, packages }) {
  return (chainData || [])
    .filter(c => c && c.error)
    .map(c => {
      const pkg = (packages || []).find(p => p && chainEntryMatchesPkg(c.name, p.name)) || null;
      const title = pkg ? appTitle(pkg) : c.name;
      return {
        id: `chain-error:${c.name}`,
        severity: "warning",
        topic: "sync",
        ...(pkg ? { appId: pkg.name } : {}),
        title: `${title} can't be reached`,
        why: "Your AVADO couldn't ask this client how far it has synced. If it isn't answering, your validators may miss attestations.",
        ...(c.message ? { detail: String(c.message) } : {}),
        fix: pkg
          ? { kind: "link", to: `/packages/${pkg.name}`, label: "Open the app" }
          : { kind: "link", to: "/packages", label: "Open My DApps" },
        steps: [
          "Open the app and check that it is running.",
          "If it was just started or updated, give it a few minutes to come up.",
          "Still can't be reached? Restart it and look at the last lines of its logs.",
        ],
      };
    });
}

export function headBehind({ packages, metrics, chainData, now }) {
  if (!metrics) return [];
  return matchSamples(packages, metrics.headSlot)
    .map(({ s, match }) => {
      const wall = currentSlot(s.network, now);
      const n = NETWORKS[s.network];
      if (wall === null || wall - s.value <= 2 * n.slotsPerEpoch) return null;
      // A client that chainData already reports as syncing is expected to
      // be behind the wall-clock head — that's normal catch-up, not a
      // problem, and chainSyncing already surfaces it as its own info finding.
      if ((chainData || []).some(c => c && c.syncing && chainEntryMatchesPkg(c.name, match.pkg.name))) return null;
      return {
        id: `head-behind:${match.pkg.name}`,
        severity: "warning",
        topic: "sync",
        appId: match.pkg.name,
        title: `${appTitle(match.pkg)} is ${wall - s.value} slots behind the chain`,
        why: "It is not keeping up with the network, so your validators may miss attestations.",
        detail: `Head slot ${formatSlot(s.value)}, wall-clock slot ${formatSlot(wall)} (${wall - s.value} behind)`,
        fix: { kind: "steps", label: "What to check" },
        steps: [
          "Check that your execution client is running and synced.",
          "Check the peer count: fewer than 10 peers makes a client fall behind.",
          "Restart the client; if it falls behind again, open its logs.",
        ],
      };
    })
    .filter(Boolean);
}

export function lowPeers({ packages, metrics }) {
  if (!metrics) return [];
  return matchSamples(packages, metrics.peers)
    .filter(({ s }) => s.value < 10)
    .map(({ s, match }) => {
      const peerWord = s.value === 1 ? "peer" : "peers";
      return {
        id: `low-peers:${match.pkg.name}`,
        severity: "warning",
        topic: "sync",
        appId: match.pkg.name,
        title: `${appTitle(match.pkg)} has only ${s.value} ${peerWord}`,
        why: "With few peers your client hears about new blocks late and can fall behind or miss attestations.",
        detail: `${s.value} ${peerWord} (Prometheus libp2p_peers)`,
        fix: { kind: "link", to: "/help/access", label: "Improve connectivity" },
      };
    });
}

export function missedAttestations({ packages, metrics }) {
  if (!metrics) return [];
  return matchSamples(packages, metrics.attesterMiss)
    .filter(({ s }) => s.value >= 1)
    .map(({ s, match }) => {
      const hit = (metrics.attesterHit || []).find(h => h.client === s.client && h.network === s.network);
      const total = s.value + ((hit && hit.value) || 0);
      const missed = Math.round(s.value);
      return {
        id: `missed-attestations:${match.pkg.name}`,
        severity: total > 0 && s.value / total > 0.5 ? "critical" : "warning",
        topic: "attestations",
        appId: match.pkg.name,
        title: `${missed} attestation${missed === 1 ? "" : "s"} missed in the last hour`,
        why: "Each missed attestation costs a small reward. A few are normal; a steady stream means something needs fixing.",
        fix: { kind: "link", to: "/help/attestations", label: "Find the cause" },
      };
    });
}

// These three rules can only evaluate anything with samples from their own
// Prometheus query; without them they return `[]`, which would otherwise be
// indistinguishable from "checked, found nothing wrong". Their `needs`
// predicates tell runChecksDetailed to skip (not count) them while that
// query has no samples: metrics unavailable, that one query failed (the
// others can still answer), or nothing reports it. The last is the normal
// case for missed attestations: no AVADO client package turns on the
// validator monitor those counters come from.
const hasSamples = key => s => Boolean(s.metrics && Array.isArray(s.metrics[key]) && s.metrics[key].length > 0);
headBehind.needs = hasSamples("headSlot");
lowPeers.needs = hasSamples("peers");
missedAttestations.needs = hasSamples("attesterMiss");
