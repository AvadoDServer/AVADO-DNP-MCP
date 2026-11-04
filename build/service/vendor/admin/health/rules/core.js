// getDiagnoseOpenPorts reads the same `alertToOpenPorts` param as
// health/rules/access.js's portsClosed, which gives a more specific,
// actionable finding — no need to also surface the raw diagnose. (The core
// doesn't send that param at the moment, so neither can fire.)
const SKIP = new Set(["getDiagnoseDiskSpace", "getDiagnoseCoreDnpsRunning", "getDiagnoseOpenPorts"]);

export function diagnoseFailed({ diagnoses }) {
  return (diagnoses || [])
    .filter(d => d && !d.loading && d.ok === false && !SKIP.has(d.id))
    .map(d => ({
      id: `diagnose:${d.id}`,
      severity: "warning",
      topic: "core",
      title: d.msg,
      why: "A built-in system check failed. The steps below usually fix it.",
      fix: { kind: "steps", label: "How to fix it" },
      steps: d.solutions || [],
    }));
}
