import { getClient, ROLES } from "health/clients";
import { appTitle } from "./apps";

export function updatesAvailable({ updates }) {
  const n = Object.keys(updates || {}).length;
  if (!n) return null;
  return {
    id: "updates-available",
    severity: "warning",
    topic: "updates",
    title: n === 1 ? "1 app update is available" : `${n} app updates are available`,
    why: "Updates fix bugs and keep your clients compatible with network upgrades. Clients that fall behind a hard fork stop following the chain.",
    fix: { kind: "link", to: "/system/updates", label: "Review updates" },
  };
}

export function coreUpdateAvailable({ coreUpdate }) {
  if (!coreUpdate || !coreUpdate.available) return null;
  return {
    id: "core-update-available",
    severity: "warning",
    topic: "updates",
    title: "An AVADO system update is available",
    why: "System updates improve how your AVADO installs, updates and monitors your apps.",
    fix: { kind: "link", to: "/system/updates", label: "Review the update" },
  };
}
// `coreUpdate` is null while nothing has actually checked for a system update
// (the Admin's core-update check is currently disabled), so this is skipped
// rather than counted as a check that passed.
coreUpdateAvailable.needs = "coreUpdate";

/**
 * Whether automatic updates are on for an installed package. The core
 * (DAPPMANAGER listPackages) reports the switch as `manifest.autoupdate`,
 * true unless the owner turned it off; that value wins. A top-level
 * `autoupdate` is only a fallback for data without it. Anything else
 * counts as on, the core's own default.
 */
export function isAutoUpdateOn(p) {
  if (!p) return false;
  if (p.manifest && typeof p.manifest.autoupdate === "boolean") return p.manifest.autoupdate;
  return p.autoupdate !== false;
}

export function autoupdateOff({ packages }) {
  return (packages || [])
    .filter(p => p && !isAutoUpdateOn(p))
    .filter(p => {
      const c = getClient(p.name);
      return c && (c.role === ROLES.EXECUTION || c.role === ROLES.CONSENSUS);
    })
    .map(p => ({
      id: `autoupdate-off:${p.name}`,
      severity: "info",
      topic: "updates",
      appId: p.name,
      title: `Automatic updates are off for ${appTitle(p)}`,
      why: "Clients need updates before network upgrades. With automatic updates off you have to install them yourself in time.",
      fix: { kind: "link", to: "/packages", label: "Turn on automatic updates" },
      dismissable: true,
    }));
}

export function storeUnreachable({ sources }) {
  if (!sources || sources.updates !== "failed") return null;
  return {
    id: "store-unreachable",
    severity: "info",
    topic: "updates",
    title: "Can't check for updates",
    why: "Your AVADO could not reach the AVADO store. Check that it is connected to the internet; your apps keep running meanwhile.",
    fix: { kind: "steps", label: "What to check" },
    steps: [
      "Check that the network cable is plugged in and your router has internet.",
      "Restart your router if other devices on your network are offline too.",
      "Reload this page. The check runs again every 10 minutes.",
    ],
  };
}

// An update that has been available for this long and is still not installed
// counts as blocked (see health/updateAges.js for why this is measured from
// the outside).
export const UPDATE_BLOCKED_AFTER_MS = 48 * 60 * 60 * 1000;

export function updateBlocked({ updates, updateAges, packages, now }) {
  return Object.entries(updates || {})
    .filter(([name]) => updateAges && Number.isFinite(updateAges[name]) && now - updateAges[name] >= UPDATE_BLOCKED_AFTER_MS)
    .map(([name, u]) => {
      const pkg = (packages || []).find(p => p && p.name === name);
      const label = pkg ? appTitle(pkg) : name.split(".")[0];
      const manual = Boolean(pkg && !isAutoUpdateOn(pkg));
      return {
        id: `update-blocked:${name}`,
        severity: manual ? "warning" : "critical",
        topic: "updates",
        appId: name,
        title: manual ? `${label} has not been updated for more than 2 days` : `${label} can't update`,
        why: manual
          ? "Automatic updates are off for this app, and a newer version has been waiting for more than 2 days. Updates carry fixes and support for network upgrades."
          : "A newer version has been available for more than 2 days, but your AVADO has not installed it. An app that misses a network upgrade can stop working.",
        detail: `Installed ${u.from}, available ${u.to}`,
        // Two version numbers are plain enough to show in Simple mode too.
        detailInSimple: true,
        fix: { kind: "link", to: "/system/updates", label: "Review updates" },
        steps: manual
          ? ["Open System → Updates and install the update, or turn automatic updates back on."]
          : [
              "Open System → Updates and install the update by hand.",
              "If it fails, download the diagnostics report in Help and send it to AVADO support.",
            ],
      };
    });
}
updateBlocked.needs = "updateAges";
