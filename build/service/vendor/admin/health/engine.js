export const SEVERITIES = ["critical", "warning", "info"];
export const TOPICS = ["setup", "sync", "attestations", "updates", "access", "storage", "core"];

const rank = (list, value) => {
  const i = list.indexOf(value);
  return i === -1 ? list.length : i;
};

// `rule.needs`: a snapshot key that must be present, or a predicate over the
// snapshot (see runChecksDetailed).
function hasWhatItNeeds(rule, snapshot) {
  if (!rule.needs) return true;
  if (typeof rule.needs === "function") {
    try {
      return Boolean(rule.needs(snapshot));
    } catch (e) {
      return false;
    }
  }
  return snapshot[rule.needs] != null;
}

/**
 * Run every rule over the snapshot. A rule returns a finding, an array of
 * findings, or null. One failing rule must never hide the others.
 *
 * A rule can set a static `rule.needs = "<snapshot key>"` (e.g. "metrics",
 * "feeRecipients", "updateAges") to declare that it cannot evaluate anything
 * meaningful without that part of the snapshot (it would otherwise just
 * return `[]`/null and get counted as "passed" — a check that never actually
 * ran). Such a rule is skipped entirely, and doesn't count towards `total`,
 * whenever `snapshot[rule.needs]` is null or missing.
 *
 * For data deeper than a top-level key (e.g. one Prometheus query inside
 * `metrics`), `rule.needs` can instead be a predicate
 * `(snapshot) => boolean`; the rule is skipped the same way whenever it
 * returns false. A predicate that throws also skips the rule.
 *
 * A rule must never return null just to mean "skipped": null and `[]` are
 * counted as passed. Only `needs` skips a rule.
 *
 * @returns {{ findings: array, passed: number, total: number }}
 *   `passed` counts rules that ran and returned null or an empty array
 *   (i.e. the check ran and found nothing wrong). A rule that throws counts
 *   towards neither `passed` nor a finding — its check could not be
 *   evaluated. `total` is `rules.length` minus any rules skipped because
 *   the snapshot part they need is unavailable.
 */
export function runChecksDetailed(snapshot, rules) {
  const findings = [];
  let passed = 0;
  let total = 0;
  for (const rule of rules) {
    if (!hasWhatItNeeds(rule, snapshot)) continue;
    total++;
    try {
      const out = rule(snapshot);
      if (Array.isArray(out)) {
        const clean = out.filter(Boolean);
        if (clean.length) findings.push(...clean);
        else passed++;
      } else if (out) {
        findings.push(out);
      } else {
        passed++;
      }
    } catch (e) {
      console.error(`Health rule ${rule.name || "(anonymous)"} failed`, e);
    }
  }
  const sorted = findings.sort(
    (a, b) =>
      rank(SEVERITIES, a.severity) - rank(SEVERITIES, b.severity) ||
      rank(TOPICS, a.topic) - rank(TOPICS, b.topic) ||
      String(a.title).localeCompare(String(b.title))
  );
  return { findings: sorted, passed, total };
}

/** Back-compat wrapper: just the sorted findings array. */
export function runChecks(snapshot, rules) {
  return runChecksDetailed(snapshot, rules).findings;
}

export function verdictOf(findings) {
  if (findings.some(f => f.severity === "critical")) return { level: "critical", label: "Action required" };
  if (findings.some(f => f.severity === "warning")) return { level: "warning", label: "Needs attention" };
  return { level: "ok", label: "All good" };
}
