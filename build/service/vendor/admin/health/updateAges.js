// How long each available update has been waiting. The AVADO DAPPMANAGER's
// auto-updater (watchers/autoupdate) checks the store every hour and installs
// one pending package per run, and it keeps no record of failed installs; the
// store has no "blocked" flag either. So "blocked" is measured from the
// outside: an update that has been available for 48 hours and is still not
// installed. `since` is kept per package (not per target version), so a newer
// release published while the first one is stuck does not restart the clock.

/**
 * @param {object|null} previous { [pkgName]: sinceMs } from the last run
 * @param {object|null} updates computeUpdates() result, or null when the store
 *   could not be read (then the previous ages are kept unchanged)
 * @param {number} now ms
 * @returns {object|null} { [pkgName]: sinceMs } for every package with an update pending
 */
export function trackUpdateAges(previous, updates, now) {
  if (updates == null) return previous || null;
  const out = {};
  for (const name of Object.keys(updates)) {
    const since = previous && Number.isFinite(previous[name]) ? previous[name] : now;
    out[name] = Math.min(since, now);
  }
  return out;
}
