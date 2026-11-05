// Client metrics from the monitoring package. Queries are tried against the
// Admin's own same-origin nginx proxy first (build/nginx.conf `/metrics-api/`,
// same origin so no CORS/mixed-content concerns and it works through Remote
// Connect or an IP-address URL, where the direct hostname below never
// resolves from the browser). If the proxy itself is unreachable (nginx not
// yet updated, mid-upgrade, etc.) we fall back to querying Prometheus
// directly — it also answers the Admin's origin with
// Access-Control-Allow-Origin (verified on the test box). Labels `client`
// and `network` are set by the AVADO Prometheus scrape config.
export const PROMETHEUS_BASES = ["/metrics-api", "http://prometheus.my.ava.do:9090/api/v1"];

export const QUERIES = {
  headSlot: "max by (client, network) (beacon_head_slot)",
  peers: 'max by (client, network) (libp2p_peers or p2p_peer_count{state="Connected"})',
  attesterMiss:
    "sum by (client, network) (increase(validator_monitor_prev_epoch_on_chain_attester_miss_total[1h]))",
  attesterHit:
    "sum by (client, network) (increase(validator_monitor_prev_epoch_on_chain_attester_hit_total[1h]))",
};

// A stuck/unreachable Prometheus (e.g. through Remote Connect, or a network
// blip) must not hang a query indefinitely — the 60s poll interval in
// HealthProvider would otherwise pile up more in-flight requests behind it.
// Each base attempt below gets its own budget, so a fully-hung double
// failure (proxy then direct) takes up to 2x this, not indefinitely.
const PROMETHEUS_TIMEOUT_MS = 10000;

// Index into PROMETHEUS_BASES of the base that last answered successfully.
// Once one base is confirmed reachable it is tried first on every later
// query (within this page load), so a box that only reaches Prometheus one
// way (e.g. same-origin proxy but not the direct hostname) doesn't pay for a
// doomed attempt on every 60s poll. The four queries in fetchMetrics run
// concurrently, so this can be written by more than one in-flight query;
// that's fine — it just picks whichever base most recently won, and a wrong
// guess self-corrects on the next fallback. fetchDiskTrend shares it.
let workingBaseIndex = 0;

export function resetPrometheusBase() {
  workingBaseIndex = 0;
}

async function queryOnce(base, q, fetchImpl) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROMETHEUS_TIMEOUT_MS);
  try {
    const res = await fetchImpl(`${base}/query?query=${encodeURIComponent(q)}`, {
      signal: controller.signal,
    });
    if (!res.ok) throw Error(`Prometheus HTTP error`);
    const body = await res.json();
    if (body.status !== "success") throw Error(body.error || "Prometheus query failed");
    return body.data.result.map(({ metric, value }) => ({
      client: metric.client,
      network: metric.network,
      value: Number(value[1]),
    }));
  } finally {
    clearTimeout(timer);
  }
}

async function query(q, fetchImpl) {
  const order = workingBaseIndex === 0 ? [0, 1] : [1, 0];
  let lastError;
  for (const i of order) {
    try {
      const result = await queryOnce(PROMETHEUS_BASES[i], q, fetchImpl);
      workingBaseIndex = i;
      return result;
    } catch (e) {
      lastError = e;
    }
  }
  throw lastError;
}

/**
 * Every query in QUERIES, by key. One failing query must not take down the
 * others: a key whose query failed is null (rules that need it are skipped,
 * see health/rules/chain.js), and the whole result is null only when every
 * query failed, i.e. Prometheus itself is unreachable. A caller that carries
 * findings over while a source is down (AVADO Care) must treat a null key as
 * a failed read of that query, not as "no problem".
 */
export async function fetchMetrics(fetchImpl = fetch) {
  const keys = Object.keys(QUERIES);
  const settled = await Promise.allSettled(keys.map(key => query(QUERIES[key], fetchImpl)));
  const failed = settled.filter(r => r.status === "rejected");
  const reason = r => (r.reason && r.reason.message) || String(r.reason);
  if (failed.length === keys.length) {
    console.warn(`Prometheus unavailable: ${reason(failed[0])}`);
    return null;
  }
  if (failed.length) {
    const failedKeys = keys.filter((key, i) => settled[i].status === "rejected");
    console.warn(`Prometheus queries failed (${failedKeys.join(", ")}): ${reason(failed[0])}`);
  }
  return Object.fromEntries(keys.map((key, i) => [key, settled[i].status === "fulfilled" ? settled[i].value : null]));
}

// Free space on the host's root filesystem, which also holds /var/lib/docker
// (every app's data). node-exporter 0.0.2+ runs with --path.rootfs=/host, so
// the host root is mountpoint "/" (checked on the test box: node-exporter
// 0.0.3, /dev/mapper/rootvg-root, ext4). The 2023 node-exporter 0.0.1 had no
// rootfs flag: there the host root is "/host" and "/" is the container's own
// overlay. The /etc/hostname, /etc/hosts and /etc/resolv.conf bind mounts
// repeat the root device under other mountpoints and are left out.
export const DISK_SERIES = 'node_filesystem_avail_bytes{mountpoint=~"/|/host",fstype!~"tmpfs|overlay|vfat"}';

// The disk forecast's inputs, one number each (see diskForecast in
// health/rules/storage.js). Slopes are in bytes per second, negative while
// the disk fills up.
export const DISK_QUERIES = {
  // Bytes free now.
  free: `max(${DISK_SERIES})`,
  // Least-squares trend over the last 7 days (or all the data there is).
  slope7d: `min(deriv(${DISK_SERIES}[7d]))`,
  // The same over the last 2 days: a recent change of pace shows here first.
  slope2d: `min(deriv(${DISK_SERIES}[2d]))`,
  // The median of the hourly trends over 7 days. One burst (a client
  // syncing again, a big image pull) moves the 7-day trend a lot but the
  // median hardly at all; pruning (slow fill, sudden drop) does the opposite.
  slopeHourly: `min(quantile_over_time(0.5, deriv(${DISK_SERIES}[1h])[7d:1h]))`,
  // The median of the last 12 hourly trends: the pace now. When a long fill
  // (a sync) has just stopped, every longer window still shows it; this one
  // is back at the normal pace within about 7 hours. A median, so one
  // clean-up or image pull doesn't move it (a 6-hour deriv jumps on those:
  // +8.7 GB a day on the test box after 2.8 GB were freed).
  slopeRecent: `min(quantile_over_time(0.5, deriv(${DISK_SERIES}[1h])[12h:1h]))`,
  // Hours with data in the last 7 days (gaps while Prometheus was off don't count).
  hoursOfData: `min(count_over_time(deriv(${DISK_SERIES}[1h])[7d:1h]))`,
};

// A value or null: an empty answer (no node-exporter, not scraped yet) or a
// value that isn't a finite number (NaN, +Inf) means "no data".
const firstValue = samples => {
  const v = samples && samples.length ? samples[0].value : null;
  return typeof v === "number" && Number.isFinite(v) ? v : null;
};

/**
 * The disk forecast's inputs (DISK_QUERIES), one number each, or null for a
 * query Prometheus answered without data (no node-exporter, not scraped yet).
 * Fetched apart from fetchMetrics, so a slow or failing disk query never
 * holds up or blanks the chain metrics (head slot, peers, attestations), and
 * it can run less often.
 *
 * Unlike fetchMetrics, the whole result is null when ANY query failed: the
 * forecast needs all of them together, and one lost slope would read as "no
 * forecast" (or a lost hour count as "still collecting"). A null read lets
 * the caller keep its last complete one (HealthProvider keeps it for an
 * hour), so one lost request doesn't make a disk finding come and go.
 */
export async function fetchDiskTrend(fetchImpl = fetch) {
  const keys = Object.keys(DISK_QUERIES);
  const settled = await Promise.allSettled(keys.map(key => query(DISK_QUERIES[key], fetchImpl)));
  const failed = keys.filter((key, i) => settled[i].status === "rejected");
  if (failed.length) {
    const r = settled[keys.indexOf(failed[0])];
    console.warn(`Prometheus disk queries failed (${failed.join(", ")}): ${(r.reason && r.reason.message) || String(r.reason)}`);
    return null;
  }
  return Object.fromEntries(keys.map((key, i) => [key, firstValue(settled[i].value)]));
}
