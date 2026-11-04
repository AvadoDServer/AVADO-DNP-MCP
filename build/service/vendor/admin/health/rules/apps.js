import { getClient, keyHolders, ROLES, PROMETHEUS_PACKAGE } from "health/clients";

const shortName = (name = "") => name.split(".")[0];
export const appTitle = pkg => (pkg && pkg.manifest && pkg.manifest.title) || shortName(pkg && pkg.name);
const isClient = pkg => {
  const c = getClient(pkg.name);
  return Boolean(c && (c.role === ROLES.EXECUTION || c.role === ROLES.CONSENSUS));
};
const logsLink = name => `/packages/${name}?tab=logs`;

// "Nimbus and Teku", "Nimbus, Teku and Lighthouse"
export const joinNames = names =>
  names.length < 2 ? names.join("") : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;

// Other apps that can hold validator keys and run on the same network as a
// stopped one. The owner may have moved the validators there, so a one-click
// "Start it" could sign with the same keys twice (see twoValidatorClients):
// such an app gets a link to its page instead. It stays critical, so AVADO
// Care still emails about it: the running app may have none of its keys.
const runningKeyHolders = (p, packages) => {
  const c = getClient(p.name);
  if (!c || !c.holdsKeys) return [];
  return keyHolders(packages)
    .filter(({ pkg, client }) => pkg.name !== p.name && client.network === c.network && pkg.state === "running")
    .map(({ pkg }) => pkg);
};

export function appStopped({ packages }) {
  return (packages || [])
    // Prometheus gets its own, more specific finding (monitoringStopped, in
    // health/rules/setup.js) so a stopped monitoring package surfaces once,
    // not as a generic "X is stopped" here as well.
    .filter(p => p && !p.isCore && p.name !== PROMETHEUS_PACKAGE && (p.state === "exited" || p.state === "dead"))
    .map(p => {
      const others = runningKeyHolders(p, packages);
      const careful = others.length > 0;
      return {
        id: `app-stopped:${p.name}`,
        severity: isClient(p) ? "critical" : "warning",
        topic: "sync",
        appId: p.name,
        title: `${appTitle(p)} is stopped`,
        why: careful
          ? `While it is stopped, any validators it has miss attestations and rewards. Start it only if they were not moved to ${joinNames(others.map(appTitle))}: a validator key that runs in two apps gets slashed.`
          : isClient(p)
            ? "While it is stopped it does not follow the chain, so your validators miss attestations and rewards."
            : "Anything that depends on it will not work until it runs again.",
        fix: careful
          ? { kind: "link", to: `/packages/${p.name}`, label: "Open the app" }
          : { kind: "action", action: "restartPackage", label: "Start it" },
        secondary: { kind: "link", to: logsLink(p.name), label: "See why in the logs" },
      };
    });
}

export function appRestarting({ packages }) {
  return (packages || [])
    .filter(p => p && p.state === "restarting")
    .map(p => ({
      id: `app-restarting:${p.name}`,
      severity: "critical",
      topic: "sync",
      appId: p.name,
      title: `${appTitle(p)} keeps restarting`,
      why: "It starts, fails and starts again. The reason is almost always in the last lines of its logs.",
      fix: { kind: "link", to: logsLink(p.name), label: "Open the logs" },
      steps: [
        "Open the logs and look at the last error before the restart.",
        "If it says the disk is full, free space in System → Storage.",
        "If it mentions a setting you changed, switch to Advanced mode (bottom of the sidebar) and undo it in the app's Settings tab.",
        "Still restarting? Download the diagnostics report in Help and send it to support.",
      ],
    }));
}

export function coreAppDown({ packages }) {
  return (packages || [])
    .filter(p => p && p.isCore && p.running === false)
    .map(p => ({
      id: `core-app-down:${p.name}`,
      severity: "critical",
      topic: "core",
      appId: p.name,
      title: `System service ${appTitle(p)} is not running`,
      why: "Your AVADO needs its system services to install, update and reach apps.",
      fix: { kind: "link", to: "/system", label: "Open System" },
    }));
}
