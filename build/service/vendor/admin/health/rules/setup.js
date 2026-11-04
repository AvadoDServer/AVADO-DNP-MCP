import { clientsByRole, ROLES, NETWORKS, PROMETHEUS_PACKAGE, GRAFANA_PACKAGE } from "health/clients";

const networksOf = list => new Set(list.map(({ client }) => client.network));

// Keep the first matching package per network (a plain Map, not a Set
// mutated inside .filter(), so the dedupe pass is easy to read on its own).
const firstPerNetwork = list => {
  const byNetwork = new Map();
  for (const item of list) {
    if (!byNetwork.has(item.client.network)) byNetwork.set(item.client.network, item);
  }
  return [...byNetwork.values()];
};

export function consensusWithoutExecution({ packages }) {
  const cc = clientsByRole(packages, ROLES.CONSENSUS);
  const ecNetworks = networksOf(clientsByRole(packages, ROLES.EXECUTION));
  const missing = cc.filter(({ client }) => !ecNetworks.has(client.network));
  return firstPerNetwork(missing).map(({ pkg, client }) => ({
    id: `consensus-without-execution:${client.network}`,
    severity: "critical",
    topic: "setup",
    appId: pkg.name,
    title: `${client.label} has no execution client`,
    why: `A consensus client needs an execution client on ${NETWORKS[client.network]?.label || client.network} to follow the chain. Until you install one, it cannot attest and your validators miss rewards.`,
    fix: { kind: "link", to: "/installer?category=ethstaking", label: "Install an execution client" },
    // The docs page that walks through installing an execution client.
    learnMore: "https://docs.ava.do/staking-ethereum/setting-up-the-eth-clients",
  }));
}

export function executionWithoutConsensus({ packages }) {
  const ec = clientsByRole(packages, ROLES.EXECUTION);
  const ccNetworks = networksOf(clientsByRole(packages, ROLES.CONSENSUS));
  const missing = ec.filter(({ client }) => !ccNetworks.has(client.network));
  return firstPerNetwork(missing).map(({ pkg, client }) => ({
    id: `execution-without-consensus:${client.network}`,
    severity: "warning",
    topic: "setup",
    appId: pkg.name,
    title: `${client.label} has no consensus client`,
    why: "Since the Merge an execution client cannot follow the chain on its own. Install a consensus client for the same network.",
    fix: { kind: "link", to: "/installer?category=ethstaking", label: "Install a consensus client" },
  }));
}

// Prometheus is installed but the last scrape failed — distinct from
// monitoringMissing (no monitoring package at all). This also fires when
// the Admin is opened through Remote Connect or by IP address, since
// Prometheus is then unreachable from the browser even though it's running.
export function metricsUnavailable({ sources }) {
  if (!sources || sources.metrics !== "failed") return null;
  return {
    id: "metrics-unavailable",
    severity: "info",
    topic: "attestations",
    title: "Can't read your clients' metrics",
    why: "The monitoring package is installed but your AVADO couldn't reach Prometheus, so missed attestations, peers and sync can't be checked right now. This also happens when you open the Admin through Remote Connect or an IP address.",
    fix: { kind: "steps", label: "What to check" },
    steps: ["Open System and check that Prometheus is running.", "Restart Prometheus."],
  };
}

export function monitoringMissing({ packages }) {
  const hasConsensus = clientsByRole(packages, ROLES.CONSENSUS).length > 0;
  const hasPrometheus = (packages || []).some(p => p && p.name === PROMETHEUS_PACKAGE);
  if (!hasConsensus || hasPrometheus) return null;
  return {
    id: "monitoring-missing",
    severity: "info",
    topic: "attestations",
    title: "Install monitoring to check missed attestations",
    why: "The monitoring package records your clients' metrics, so your AVADO can warn you about missed attestations, low peers or falling behind the chain.",
    fix: { kind: "link", to: `/installer/${GRAFANA_PACKAGE}`, label: "Install monitoring" },
    dismissable: true,
  };
}

// Prometheus is installed but its container isn't running — distinct from
// metricsUnavailable (Prometheus running but unreachable/timing out) and
// monitoringMissing (no monitoring package at all). appStopped already
// covers this generically for every non-core package, but a stopped
// Prometheus specifically means missed attestations, peers and sync can't be
// checked, so it gets its own, more specific finding and title on this topic.
export function monitoringStopped({ packages }) {
  const prometheus = (packages || []).find(p => p && p.name === PROMETHEUS_PACKAGE);
  if (!prometheus || prometheus.running !== false) return null;
  return {
    id: "monitoring-stopped",
    severity: "warning",
    topic: "attestations",
    appId: PROMETHEUS_PACKAGE,
    title: "Monitoring has stopped",
    why: "The monitoring package isn't running, so missed attestations, peers and sync can't be checked right now.",
    fix: { kind: "action", action: "restartPackage", label: "Restart monitoring" },
  };
}
