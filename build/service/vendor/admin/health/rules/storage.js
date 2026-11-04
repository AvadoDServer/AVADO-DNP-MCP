import { getClient, NETWORKS, ROLES, CONSENSUS_SIZE_LIMIT, canResetBeaconData, storageMode } from "health/clients";
import { appTitle, joinNames } from "./apps";

export function parsePercent(value) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "string") return null;
  const m = value.match(/(\d+(?:\.\d+)?)\s*%?/);
  return m ? Number(m[1]) : null;
}

// Docker (`docker system df -v`, via DAPPMANAGER's parseDockerSystemDf) reports
// volume sizes as human strings in decimal (1000-based) units, e.g. "27.94GB",
// "1.572GB", "22.34MB", "17.3kB", "63B", "0B" — never raw bytes. Units are
// matched case-insensitively; a bare number (already bytes) passes through
// unchanged; anything unparseable is 0.
const SIZE_UNIT_MULTIPLIERS = {
  "": 1,
  b: 1,
  kb: 1e3,
  mb: 1e6,
  gb: 1e9,
  tb: 1e12,
};

export function parseDockerSize(value) {
  if (typeof value === "number") return Number.isFinite(value) ? value : 0;
  if (typeof value !== "string") return 0;
  const m = value.trim().match(/^(\d+(?:\.\d+)?)\s*([a-zA-Z]*)$/);
  if (!m) return 0;
  const n = Number(m[1]);
  const mult = SIZE_UNIT_MULTIPLIERS[m[2].toLowerCase()];
  return Number.isFinite(n) && mult !== undefined ? n * mult : 0;
}

const SIZE_UNITS = ["B", "kB", "MB", "GB", "TB", "PB"];

/**
 * The inverse of parseDockerSize: format a byte count using the same
 * decimal (1000-based) units docker itself reports, so a size shown in the
 * UI doesn't drift from "docker system df -v" (e.g. its "27.94GB" becomes
 * "27.9 GB" here — not `humanFileSize`'s binary/1024-based "26.0 GB", a
 * different number under the same "GB" label).
 */
export function formatDockerSize(bytes) {
  const n = Number(bytes);
  if (!Number.isFinite(n) || n <= 0) return "0 B";
  const i = Math.min(Math.floor(Math.log(n) / Math.log(1000)), SIZE_UNITS.length - 1);
  const value = n / Math.pow(1000, i);
  return `${value.toFixed(i === 0 ? 0 : 1)} ${SIZE_UNITS[i]}`;
}

export const appDiskUse = pkg =>
  ((pkg && pkg.volumes) || []).reduce((sum, v) => sum + parseDockerSize(v && v.size), 0);

// The apps using the most disk space, biggest first (their titles).
function biggestApps(packages, count = 2) {
  return [...(packages || [])]
    .map(p => ({ p, size: appDiskUse(p) }))
    .filter(x => x.size > 0)
    .sort((a, b) => b.size - a.size)
    .slice(0, count)
    .map(x => appTitle(x.p));
}

// Apps for a test network (Holesky, the retired Goerli/Prater) that use disk
// space: the quickest space to win back, with no real money at stake. Also
// on System > Storage's 4 TB kit card, as the free thing to try first.
export function testNetworkHint(packages) {
  const apps = (packages || [])
    .map(p => ({ p, client: getClient(p && p.name), size: appDiskUse(p) }))
    .filter(({ client, size }) => client && NETWORKS[client.network] && NETWORKS[client.network].testnet && size > 0);
  const sentence = (list, text) => {
    if (!list.length) return "";
    const it = list.length === 1 ? "it" : "them";
    const size = formatDockerSize(list.reduce((sum, x) => sum + x.size, 0));
    return text(joinNames(list.map(x => appTitle(x.p))), it, size);
  };
  const retired = apps.filter(({ client }) => NETWORKS[client.network].retired);
  const live = apps.filter(({ client }) => !NETWORKS[client.network].retired);
  return [
    sentence(retired, (names, it, size) => `${names} ${retired.length === 1 ? "is" : "are"} for a test network that has shut down: removing ${it} frees ${size}.`),
    sentence(live, (names, it, size) => `If you no longer test with ${names}, removing ${it} frees ${size}.`),
  ]
    .filter(Boolean)
    .join(" ");
}

// "Most space is used by X and Y." plus the test-network apps, if any.
function spaceHints(packages) {
  const biggest = biggestApps(packages);
  return [biggest.length ? `Most space is used by ${biggest.join(" and ")}.` : "", testNetworkHint(packages)].filter(Boolean).join(" ");
}

/*
 * Disk-full forecast, from the Prometheus disk trend (fetchDiskTrend in
 * health/prometheus.js: bytes free, the 7-day, 2-day, median hourly and
 * recent slopes, and how many hours of data there are). A forecast that
 * cries wolf is worse than none, so it only gives a number when the data can
 * back it:
 *  - at least 2 days of data for "more than a year" or "at least N months",
 *    and a week for a date ("filling"). With less than about 4 days the 2-day
 *    and 7-day windows hold the same samples, and a sync that fills more than
 *    half the hours moves the hourly median too, so all three agree on the
 *    sync's pace (a false "full in 2 days" the day after a first sync). A
 *    date that would be under 60 days waits for the week ("collecting");
 *  - no client syncing (a sync fills hundreds of GB in a day or two). The
 *    core only flags execution clients, and only until 60 blocks behind;
 *  - the 7-day, 2-day and median hourly slopes agree within 3x. A client
 *    that synced again, a big image pull or a clean-up shows as a burst that
 *    moves the 7-day trend but not the median; pruning (slow fill, sudden
 *    drop) does the opposite; a new pace shows in the 2-day slope first;
 *  - the recent pace (the median of the last 12 hourly slopes) is not more
 *    than 3x gentler: a long fill that has stopped still fills every longer
 *    window. It only counts when it is the gentlest: a faster recent pace
 *    would only make the date later, never earlier, so it can't cry wolf;
 *  - bytes, not the core's whole-number "disk" percentage, whose 1 % steps
 *    (about 20 GB on a 2 TB disk) would make a trend jump.
 * When every slope says the disk lasts more than a year, the numbers don't
 * need to agree: that is "stable". When they disagree (or there is under a
 * week of data) but even the fastest leaves 60 days or more, that lower
 * bound is "roomy" (nothing to act on).
 *
 * Only "filling" makes a finding (diskFillingUp, disk-high's "At this rate")
 * or offers the 4 TB kit, so all of those have a week of data behind them.
 *
 * "Full" is 5 GB left, when the core (watchers/diskUsage) stops the apps.
 */
export const DISK_STOP_BYTES = 5e9;
export const DISK_HIGH_PCT = 80;
export const FORECAST_MIN_HOURS = 48;
// "A week of data", with a few hours of gaps allowed.
export const FORECAST_WEEK_HOURS = 156;
export const FORECAST_WARN_DAYS = 30;
export const FORECAST_CRITICAL_DAYS = 7;
export const FORECAST_CRITICAL_FREE_BYTES = 50e9;
const FORECAST_YEAR_DAYS = 365;
const FORECAST_ROOMY_DAYS = 60;
const SLOPES_AGREE_WITHIN = 3;
const DAY_SECONDS = 86400;

const finite = v => (typeof v === "number" && Number.isFinite(v) ? v : null);

/**
 * @returns {{ state: "none"|"collecting"|"syncing"|"unsettled"|"roomy"|"stable"|"filling"|"full",
 *   free?: number, hours?: number, days?: number, bytesPerDay?: number }}
 *   "filling" (a week of data or more): `days` until 5 GB are left at the
 *   7-day pace, and `bytesPerDay`. "roomy": `days` at the fastest pace, 60
 *   or more. "stable": more than a year at every pace. "collecting": under
 *   2 days of data, or under a week for a date under 60 days (`hours` says
 *   which).
 */
export function diskForecast(trend, chainData) {
  const t = trend || {};
  const free = finite(t.free);
  if (free === null) return { state: "none" };
  if (free <= DISK_STOP_BYTES) return { state: "full", free };
  const hours = finite(t.hoursOfData) || 0;
  if (hours < FORECAST_MIN_HOURS) return { state: "collecting", free, hours };
  if ((chainData || []).some(c => c && c.syncing)) return { state: "syncing", free, hours };
  const slopes = [t.slope7d, t.slope2d, t.slopeHourly].map(finite);
  const recent = finite(t.slopeRecent);
  if (slopes.some(s => s === null) || recent === null) return { state: "none", free };
  const room = free - DISK_STOP_BYTES;
  const daysAt = slope => (slope < 0 ? room / -slope / DAY_SECONDS : Infinity);
  const soonest = Math.min(...slopes.map(daysAt));
  if (soonest > FORECAST_YEAR_DAYS) return { state: "stable", free, hours };
  // All filling, the steepest at most 3x the gentlest; the recent pace
  // counts only as the gentlest (a fill that has stopped).
  const gentlest = Math.max(...slopes, recent);
  const agree = gentlest < 0 && Math.min(...slopes) / gentlest <= SLOPES_AGREE_WITHIN;
  if (agree && hours >= FORECAST_WEEK_HOURS) {
    return { state: "filling", free, hours, days: daysAt(slopes[0]), bytesPerDay: -slopes[0] * DAY_SECONDS };
  }
  if (soonest >= FORECAST_ROOMY_DAYS) return { state: "roomy", free, hours, days: soonest };
  // The paces agree on a date under 60 days, but under a week of data can't back it.
  if (agree) return { state: "collecting", free, hours };
  return { state: "unsettled", free, hours };
}

/** "at least 2 months" .. "at least 11 months", for a "roomy" forecast (60 days or more). */
export function atLeast(days) {
  const n = Math.max(2, Math.floor(days / 30.4));
  return `at least ${n} months`;
}

/** "in about 5 days", "in about 3 weeks", "in about 4 months": whole steps, so the words don't change on every poll. */
export function inAbout(days) {
  if (!(days >= 1)) return "within a day";
  if (days < 14) {
    const n = Math.round(days);
    return `in about ${n} day${n === 1 ? "" : "s"}`;
  }
  if (days < 60) return `in about ${Math.round(days / 7)} weeks`;
  if (days <= FORECAST_YEAR_DAYS) {
    const n = Math.round(days / 30.4);
    return `in about ${n} month${n === 1 ? "" : "s"}`;
  }
  return "in more than a year";
}

/**
 * Bytes in the units the core's own disk figures use (getStats: 1024-based,
 * labelled "TB"), so free space sits next to "0.86 TB used / 1.82 TB total"
 * without adding up to a different disk. Under 1 TB it is "GB".
 */
export function formatDiskSize(bytes) {
  const n = Number(bytes);
  if (!Number.isFinite(n) || n <= 0) return "0 GB";
  const tb = n / 1024 ** 4;
  if (tb >= 1) return `${tb.toFixed(2)} TB`;
  const gb = n / 1024 ** 3;
  return gb >= 10 ? `${Math.round(gb)} GB` : `${gb.toFixed(1)} GB`;
}

// Critical only when it is close AND little is left, after a week of data
// (which "filling" already needs; checked again here for the reader).
const forecastIsCritical = f =>
  f.state === "filling" &&
  f.days < FORECAST_CRITICAL_DAYS &&
  f.free < FORECAST_CRITICAL_FREE_BYTES &&
  f.hours >= FORECAST_WEEK_HOURS;

// Advanced mode's `detail` line.
const forecastDetail = f =>
  `${formatDiskSize(f.free)} free, filling about ${formatDiskSize(f.bytesPerDay)} a day (trend over the last ${Math.min(7, Math.floor(f.hours / 24))} days)`;

export function diskHigh({ stats, packages, diskTrend, chainData }) {
  const pct = parsePercent(stats && stats.disk);
  if (pct === null || pct < DISK_HIGH_PCT) return null;
  // The forecast folds in here rather than showing as a second disk finding.
  const f = diskForecast(diskTrend, chainData);
  const forecast = f.state === "filling" && f.days <= FORECAST_YEAR_DAYS ? f : null;
  const critical = pct >= 90 || Boolean(forecast && forecastIsCritical(forecast));
  // Full within 30 days is already urgent in words, even while the severity
  // stays a warning (critical needs under 7 days AND under 50 GB): the same
  // words diskFillingUp uses for that forecast under 80 %.
  const urgent = critical || Boolean(forecast && forecast.days < FORECAST_WARN_DAYS);
  const hints = spaceHints(packages);
  return {
    id: "disk-high",
    severity: critical ? "critical" : "warning",
    topic: "storage",
    title: `Your disk is ${Math.round(pct)}% full`,
    why:
      (urgent
        ? "When the disk is full your clients stop and your validators go offline. "
        : "Clients keep growing; plan some space now before it becomes urgent. ") +
      (forecast ? `At this rate it is full ${inAbout(forecast.days)}. ` : "") +
      hints,
    ...(forecast ? { detail: forecastDetail(forecast) } : {}),
    fix: { kind: "link", to: "/system/storage", label: "Free up space" },
  };
}

// Disk not (yet) 80 % full, but filling up fast enough to be full within 30 days.
export function diskFillingUp({ packages, diskTrend, chainData }) {
  const f = diskForecast(diskTrend, chainData);
  if (f.state !== "filling" || f.days >= FORECAST_WARN_DAYS) return null;
  return {
    id: "disk-filling-up",
    severity: forecastIsCritical(f) ? "critical" : "warning",
    topic: "storage",
    title: `Your disk will be full ${inAbout(f.days)}`,
    why: `${formatDiskSize(f.free)} is left. When the disk is full your clients stop and your validators go offline. ${spaceHints(packages)}`.trim(),
    detail: forecastDetail(f),
    fix: { kind: "link", to: "/system/storage", label: "Free up space" },
  };
}
// Runs (and counts as a check) only with a forecast it can trust: "stable"
// and "roomy" pass, "filling" passes or warns. Skipped without monitoring
// data, while collecting, syncing or unsettled, and when disk-high already
// carries the forecast (80 % or more).
diskFillingUp.needs = s => {
  const pct = parsePercent(s.stats && s.stats.disk);
  if (pct !== null && pct >= DISK_HIGH_PCT) return false;
  const state = diskForecast(s.diskTrend, s.chainData).state;
  return state === "stable" || state === "roomy" || state === "filling";
};

// A consensus client far past its normal size (an archive or never-pruned
// database). The fix clears just its chain data (DAPPMANAGER 10.0.50 and
// newer; see resetBeaconData); on an older core it points to System >
// Storage, which says what the client keeps.
export function consensusTooBig({ packages }) {
  return (packages || [])
    .map(p => ({ p, client: getClient(p && p.name), size: appDiskUse(p) }))
    .filter(({ client, size }) => client && client.role === ROLES.CONSENSUS && size > CONSENSUS_SIZE_LIMIT)
    .map(({ p, client, size }) => {
      const mode = storageMode(p);
      const base = {
        id: `consensus-too-big:${p.name}`,
        severity: "warning",
        topic: "storage",
        appId: p.name,
        title: `${appTitle(p)} is using ${formatDockerSize(size)}`,
        ...(mode ? { detail: `Storage mode: ${mode.label}` } : {}),
      };
      // An archive setting uses this much space on purpose: a reset would
      // only help until the history is downloaded again.
      if (mode && mode.key === "archive") {
        return {
          ...base,
          why: "It is set to keep the full chain history, which uses this much space on purpose. Free up space would only help until the history is downloaded again. Remove that setting in its Settings tab first; then Free up space keeps it small.",
          fix: { kind: "link", to: `/packages/${p.name}?tab=settings`, label: "Open settings" },
        };
      }
      return {
        ...base,
        why: "Normal is under 200 GB. Free up space deletes only its chain data and downloads a recent checkpoint instead. Your validator keys, slashing protection and settings stay. Your validators are offline for about 15 to 30 minutes while it syncs again.",
        fix:
          client.canResetBeacon && canResetBeaconData(packages)
            ? { kind: "action", action: "resetBeaconData", label: "Free up space" }
            : { kind: "link", to: "/system/storage", label: "See storage" },
      };
    });
}
