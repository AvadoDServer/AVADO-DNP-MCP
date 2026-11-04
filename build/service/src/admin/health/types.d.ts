// Types for the vendored AVADO Admin health rules. The JavaScript is in vendor/admin (byte-for-byte
// copies of DNP_ADMIN) and is emitted next to the compiled service by scripts/vendor-build.mjs.
/** Shapes shared by the vendored Admin health modules (see DNP_ADMIN/build/src/src/health). */
export type Severity = "critical" | "warning" | "info";

export interface Finding {
  id: string;
  severity: Severity;
  topic: string;
  title: string;
  why?: string;
  detail?: string;
  appId?: string;
  dismissable?: boolean;
  [key: string]: unknown;
}

export interface MetricSample {
  client: string;
  network: string;
  value: number;
}

/**
 * One entry per Prometheus query (vendored QUERIES). A key is null when its own query failed
 * while others answered (fetchMetrics returns null only when every query failed).
 */
export interface Metrics {
  headSlot: MetricSample[] | null;
  peers: MetricSample[] | null;
  attesterMiss: MetricSample[] | null;
  attesterHit: MetricSample[] | null;
}

export type MetricKey = keyof Metrics;

export interface ChainDataEntry {
  name: string;
  syncing?: boolean;
  error?: boolean;
  message?: string;
  progress?: number;
  [key: string]: unknown;
}

export interface PackageInfo {
  name: string;
  version?: string;
  state?: string;
  running?: boolean;
  isCore?: boolean;
  autoupdate?: boolean;
  volumes?: Array<{ size?: string | number; [key: string]: unknown }>;
  manifest?: { title?: string; version?: string; [key: string]: unknown };
  [key: string]: unknown;
}

/** "partial": some Prometheus queries failed (their Metrics keys are null), the others answered. */
export type SourceStatus = "ok" | "partial" | "failed" | "loading" | "not-installed";

/** The snapshot the Admin's HealthProvider builds and every rule reads. */
export interface Snapshot {
  packages: PackageInfo[];
  stats: Record<string, unknown>;
  params: Record<string, unknown>;
  diagnoses: unknown[];
  chainData: ChainDataEntry[];
  updates: Record<string, { from: string; to: string; hash?: string }> | null;
  /** null while nothing has checked for a system update: coreUpdateAvailable is then skipped. */
  coreUpdate: { available: boolean } | null;
  metrics: Metrics | null;
  /** The disk forecast's inputs (Prometheus fetchDiskTrend); null without them: diskFillingUp is skipped and disk-high has no forecast. */
  diskTrend: Record<string, number | null> | null;
  /** Per validator package that could be read; null when unknown (the rule is then skipped). */
  feeRecipients: Record<string, { validators: number; checked: number; missing: number }> | null;
  /** First-seen time (ms) of each pending update; null when unknown. */
  updateAges: Record<string, number> | null;
  sources: { updates: SourceStatus; metrics: SourceStatus; [key: string]: unknown };
  now: number;
}

/** `needs`: a snapshot key that must be present, or a predicate over the snapshot; the rule is skipped (not counted) otherwise. */
export type Rule = ((snapshot: Snapshot) => Finding | Finding[] | null) & { needs?: keyof Snapshot | ((snapshot: Snapshot) => boolean) };
