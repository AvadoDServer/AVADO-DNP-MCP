/**
 * What the tools can see and do on the box, in plain shapes. Everything here goes through the
 * allow-listed DAPPMANAGER calls (dappmanager.ts) or the store catalogue (store.ts).
 *
 * Never returned: env values (listPackages appends every package's env file, which can hold
 * passwords), IP addresses, the node id, volume paths, validator keys, fee recipients.
 */
import semver from "semver";
import type { Config } from "./config.js";
import {
  DappmanagerError,
  fetchChainData,
  getDiagnostics,
  getParams,
  getStats,
  getVersionData,
  installPackage,
  listPackages,
  logPackage,
  restartPackage,
} from "./dappmanager.js";
import { fetchMetrics, parseChainDataMessage, runHealthCheck } from "./health.js";
import { errorMessage, type Logger } from "./log.js";
import { capLog } from "./redact.js";
import { fetchStorePackages, type FetchLike } from "./store.js";
import type { WampSession } from "./wamp.js";

export const SELF_NAME = "mcp.avado.dnp.dappnode.eth";
export const MAX_LOG_LINES = 500;
export const MAX_LOG_BYTES = 48 * 1024;

/** Store categories an owner does not normally see (same idea as the Admin's simple store view). */
export const HIDDEN_STORE_CATEGORIES = new Set(["sunset", "testnets", "aux", "avadosystem"]);

export class BoxError extends Error {
  /** "refused": the request is not allowed (never-list, unknown app, core app). */
  constructor(
    message: string,
    readonly kind: "refused" | "unavailable" | "failed" = "failed",
  ) {
    super(message);
  }
}

export interface BoxDeps {
  openWamp(): WampSession;
  fetch: FetchLike;
  now(): number;
}

export interface AppInfo {
  name: string;
  title: string;
  version: string | null;
  state: string;
  running: boolean;
  core: boolean;
  autoUpdate: boolean | null;
  dataSize: string | null;
  page: string | null;
}

interface RawPackage {
  name?: unknown;
  shortName?: unknown;
  version?: unknown;
  state?: unknown;
  running?: unknown;
  isCore?: unknown;
  volumes?: unknown;
  manifest?: { title?: unknown; autoupdate?: unknown; links?: unknown; type?: unknown } | null;
}

const NAME_RE = /^[a-z0-9][a-z0-9.-]{0,99}$/;

function str(x: unknown): string | null {
  return typeof x === "string" && x ? x : null;
}

function sumSizes(volumes: unknown): string | null {
  if (!Array.isArray(volumes)) return null;
  const units: Record<string, number> = { B: 1, kB: 1e3, KB: 1e3, MB: 1e6, GB: 1e9, TB: 1e12 };
  let total = 0;
  let any = false;
  for (const v of volumes) {
    const s = v && typeof v === "object" ? (v as { size?: unknown }).size : null;
    if (typeof s !== "string") continue;
    const m = /^([\d.]+)\s*([kKMGT]?B)$/.exec(s);
    if (!m) continue;
    total += Number(m[1]) * (units[m[2]!] ?? 1);
    any = true;
  }
  if (!any) return null;
  if (total >= 1e12) return `${(total / 1e12).toFixed(2)} TB`;
  if (total >= 1e9) return `${(total / 1e9).toFixed(1)} GB`;
  if (total >= 1e6) return `${(total / 1e6).toFixed(0)} MB`;
  return `${Math.max(1, Math.round(total / 1e3))} kB`;
}

function pageOf(links: unknown): string | null {
  if (!links || typeof links !== "object") return null;
  const l = links as Record<string, unknown>;
  for (const key of ["OnboardingWizard", "UI", "ui"]) {
    const v = l[key];
    if (typeof v === "string" && /^https?:\/\/[a-z0-9.-]+\.my\.ava\.do(?::\d+)?(\/|$)/i.test(v)) return v;
  }
  return null;
}

export function toApp(raw: unknown): AppInfo | null {
  if (!raw || typeof raw !== "object") return null;
  const p = raw as RawPackage;
  const name = str(p.name);
  if (!name) return null;
  const m = p.manifest && typeof p.manifest === "object" ? p.manifest : null;
  return {
    name,
    title: str(m?.title)?.trim() || str(p.shortName) || name.split(".")[0]!,
    version: str(p.version),
    state: str(p.state) ?? "unknown",
    running: p.running === true,
    core: p.isCore === true,
    autoUpdate: typeof m?.autoupdate === "boolean" ? m.autoupdate : null,
    dataSize: sumSizes(p.volumes),
    page: pageOf(m?.links),
  };
}

/** Finds an installed app by its full name, its short name ("teku") or its title. */
export function findApp(apps: AppInfo[], query: string): AppInfo {
  const q = (query || "").trim().toLowerCase();
  if (!q || q.length > 100) throw new BoxError("Say which app, for example “teku”.", "refused");
  const exact = apps.find((a) => a.name === q);
  if (exact) return exact;
  const short = apps.filter((a) => a.name.split(".")[0] === q);
  if (short.length === 1) return short[0]!;
  const titled = apps.filter((a) => a.title.toLowerCase() === q);
  if (titled.length === 1) return titled[0]!;
  const loose = apps.filter((a) => a.name.startsWith(q + ".") || a.title.toLowerCase().includes(q));
  if (loose.length === 1) return loose[0]!;
  if (loose.length > 1 || short.length > 1) {
    throw new BoxError(`More than one app matches “${query}”: ${[...short, ...loose].map((a) => a.name).join(", ")}. Use the full name.`, "refused");
  }
  throw new BoxError(`No installed app is called “${query}”. Use list_apps to see what is installed.`, "refused");
}

export interface StoreApp {
  name: string;
  title: string;
  version: string;
  description: string | null;
  category: string | null;
  manifestHash: string;
  core: boolean;
  installed: string | null;
  updateAvailable: boolean;
}

function toStoreApp(raw: unknown, installed: Map<string, string | null>): StoreApp | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as { manifest?: Record<string, unknown>; manifesthash?: unknown };
  const m = r.manifest;
  if (!m || typeof m.name !== "string" || typeof m.version !== "string") return null;
  if (typeof r.manifesthash !== "string" || !/^Qm[1-9A-HJ-NP-Za-km-z]{44}$|^b[a-z2-7]{20,}$/.test(r.manifesthash)) return null;
  const inst = installed.has(m.name) ? (installed.get(m.name) ?? "unknown") : null;
  const cmp = inst && semver.valid(inst) && semver.valid(m.version) ? semver.gt(m.version, inst) : false;
  return {
    name: m.name,
    title: typeof m.title === "string" ? m.title.trim() : m.name,
    version: m.version,
    description: typeof m.shortDescription === "string" ? m.shortDescription : typeof m.description === "string" ? m.description.slice(0, 400) : null,
    category: typeof m.avadocategory === "string" ? m.avadocategory : null,
    manifestHash: r.manifesthash,
    core: m.type === "dncore",
    installed: inst,
    updateAvailable: cmp,
  };
}

export interface Job {
  id: string;
  kind: "install" | "update";
  app: string;
  version: string;
  state: "running" | "done" | "failed";
  message: string;
  startedAt: string;
  finishedAt: string | null;
}

export class Box {
  private jobs = new Map<string, Job>();
  private nextJob = 1;

  constructor(
    private readonly config: Config,
    private readonly logger: Logger,
    private readonly deps: BoxDeps,
  ) {}

  private async withWamp<T>(fn: (w: WampSession) => Promise<T>): Promise<T> {
    const wamp = this.deps.openWamp();
    try {
      return await fn(wamp);
    } catch (e) {
      if (e instanceof DappmanagerError) {
        if (e.kind === "forbidden") throw new BoxError(e.message, "refused");
        if (e.kind === "unavailable") throw new BoxError("The AVADO system service (DAPPMANAGER) is not answering right now. Try again in a minute.", "unavailable");
        throw new BoxError(e.message, "failed");
      }
      throw e;
    } finally {
      wamp.close();
    }
  }

  async apps(): Promise<AppInfo[]> {
    return this.withWamp(async (w) => (await listPackages(w)).map(toApp).filter((a): a is AppInfo => a !== null));
  }

  async overview(): Promise<Record<string, unknown>> {
    return this.withWamp(async (w) => {
      const [stats, version, params, packages, diag] = await Promise.all([
        getStats(w).catch(() => null),
        getVersionData(w).catch(() => null),
        getParams(w).catch(() => null),
        listPackages(w),
        getDiagnostics(w, { host: true }).catch(() => null),
      ]);
      const apps = packages.map(toApp).filter((a): a is AppInfo => a !== null);
      const core = Object.fromEntries(apps.filter((a) => a.core).map((a) => [a.name.split(".")[0], a.version]));
      const host = (diag?.host ?? null) as Record<string, unknown> | null;
      const disk = (host?.rootDisk ?? null) as Record<string, unknown> | null;
      return {
        boxName: typeof params?.name === "string" ? params.name : null,
        system: {
          avadoSystemVersion: typeof version?.version === "string" ? version.version : (core.dappmanager ?? null),
          coreApps: core,
          os: host?.os ?? null,
          kernel: host?.kernel ?? null,
          uptimeHours: typeof host?.uptimeSeconds === "number" ? Math.round(host.uptimeSeconds / 360) / 10 : null,
          cpu: { model: stats?.cpuName ?? null, cores: host?.cores ?? null, load: stats?.cpu ?? null, loadAverage: host?.loadavg ?? null },
          memory: { total: stats?.memTotal ?? null, used: stats?.memUsed ?? null, usedPercent: stats?.memory ?? null },
          disk: {
            total: stats?.diskTotal ?? null,
            used: stats?.diskUsed ?? null,
            usedPercent: stats?.disk ?? null,
            freeGB: disk?.availableGB ?? null,
          },
          temperatures: Array.isArray(host?.temperatures) ? host.temperatures : null,
          recentMemoryKills: Array.isArray((host?.dmesg as Record<string, unknown> | undefined)?.oom) ? ((host!.dmesg as { oom: unknown[] }).oom.length) : null,
        },
        apps: {
          note: "Counts the owner's apps and the AVADO system parts separately (list_apps lists both, with core: true for system parts).",
          ownerApps: apps.filter((a) => !a.core).length,
          ownerAppsRunning: apps.filter((a) => !a.core && a.running).length,
          ownerAppsNotRunning: apps.filter((a) => !a.core && !a.running).map((a) => a.title),
          systemParts: apps.filter((a) => a.core).length,
          systemPartsNotRunning: apps.filter((a) => a.core && !a.running).map((a) => a.title),
        },
        aiConnectVersion: this.config.version,
      };
    });
  }

  async health(): Promise<Record<string, unknown>> {
    return this.withWamp(async (w) => {
      const result = await runHealthCheck(
        {
          listPackages: () => listPackages(w),
          getStats: () => getStats(w),
          getParams: () => getParams(w),
          fetchChainData: () => fetchChainData(w),
          fetchStorePackages: (nodeid, pkgs) => fetchStorePackages(this.config, nodeid, pkgs, this.deps.fetch),
          fetchMetrics: () => fetchMetrics(this.deps.fetch),
          // never read: needs the validator keymanager and its token
          fetchFeeRecipients: async () => null,
          updateAges: () => null,
          now: this.deps.now,
        },
        this.logger,
      );
      // Processes inside apps (DAPPMANAGER 10.0.53+): what is down, out of memory or restarting.
      let problems: unknown[] | null = null;
      try {
        const d = await getDiagnostics(w, {});
        problems = containerProblems(d.containers);
      } catch {
        problems = null;
      }
      return {
        verdict: result.verdict,
        summary:
          result.verdict === "ok"
            ? result.findings.length
              ? `Nothing needs attention; ${result.findings.length} note(s) below.`
              : "Everything the AVADO health check looks at is fine."
            : result.verdict === "checking"
              ? "The health check could not read the list of apps, so it cannot say yet."
              : `${result.findings.length} thing(s) need attention.`,
        findings: result.findings.map((f) => ({
          severity: f.severity,
          topic: f.topic,
          title: f.title,
          ...(f.why ? { why: f.why } : {}),
          ...(f.detail ? { detail: f.detail } : {}),
          ...(f.appId ? { app: f.appId } : {}),
        })),
        appProblems: problems,
        notChecked: [
          "fee recipients of validators (AI Connect does not read validator settings)",
          ...(result.sources.updates === "failed" ? ["available updates (the AVADO store could not be reached)"] : []),
          ...(result.sources.chainData === "failed" ? ["chain sync (no chain data arrived in time)"] : []),
        ],
        checkedAt: result.at,
      };
    });
  }

  async logs(app: string, lines: number): Promise<Record<string, unknown>> {
    const n = Math.max(1, Math.min(MAX_LOG_LINES, Math.floor(Number.isFinite(lines) ? lines : 100)));
    return this.withWamp(async (w) => {
      const apps = (await listPackages(w)).map(toApp).filter((a): a is AppInfo => a !== null);
      const target = findApp(apps, app);
      if (!NAME_RE.test(target.name)) throw new BoxError("That app name cannot be used.", "refused");
      const raw = await logPackage(w, target.name, n);
      const { text, cut } = capLog(raw, MAX_LOG_BYTES);
      return {
        app: target.name,
        title: target.title,
        lines: n,
        note:
          "Secret-looking text (keys, passwords, recovery phrases, long hex strings) is replaced by [hidden by AVADO]." +
          (cut ? ` The log was longer than ${MAX_LOG_BYTES / 1024} kB, so only the newest part is shown.` : ""),
        log: text,
      };
    });
  }

  async ethereum(): Promise<Record<string, unknown>> {
    return this.withWamp(async (w) => {
      try {
        const d = await getDiagnostics(w, { clients: true });
        const clients = Array.isArray(d.clients) ? d.clients : [];
        return {
          source: "diagnostics",
          clients: clients.map((c) => cleanClient(c)),
          ...(clients.length ? {} : { note: "No Ethereum (or other) node app with a known API is installed and running." }),
        };
      } catch (e) {
        // DAPPMANAGER before 10.0.53: fall back to the chain summary the Admin shows
        this.logger.warn(`getDiagnostics failed, using chainData: ${errorMessage(e)}`);
        const raw = await fetchChainData(w);
        return {
          source: "chainData",
          chains: (raw ?? []).map(parseChainDataMessage).filter(Boolean),
        };
      }
    });
  }

  async store(includeAll: boolean): Promise<Record<string, unknown>> {
    return this.withWamp(async (w) => {
      const [params, packages] = await Promise.all([getParams(w), listPackages(w)]);
      const apps = packages.map(toApp).filter((a): a is AppInfo => a !== null);
      const nodeid = typeof params.nodeid === "string" ? params.nodeid : "";
      if (!nodeid) throw new BoxError("The box did not say which store it uses.", "unavailable");
      let catalogue: unknown[];
      try {
        catalogue = await fetchStorePackages(this.config, nodeid, apps.map((a) => ({ name: a.name, version: a.version ?? undefined })), this.deps.fetch);
      } catch (e) {
        throw new BoxError(`The AVADO store could not be reached: ${errorMessage(e)}`, "unavailable");
      }
      const installed = new Map(apps.map((a) => [a.name, a.version]));
      const all = catalogue.map((r) => toStoreApp(r, installed)).filter((s): s is StoreApp => s !== null);
      const visible = includeAll ? all : all.filter((s) => !s.core && !(s.category && HIDDEN_STORE_CATEGORIES.has(s.category)));
      return {
        apps: visible.map(({ manifestHash: _h, ...rest }) => rest),
        ...(includeAll ? {} : { note: "Old, test-network and system entries are left out. Ask with include_all to see them." }),
      };
    });
  }

  private async storeEntry(w: WampSession, name: string): Promise<{ entry: StoreApp; apps: AppInfo[] }> {
    const [params, packages] = await Promise.all([getParams(w), listPackages(w)]);
    const apps = packages.map(toApp).filter((a): a is AppInfo => a !== null);
    const nodeid = typeof params.nodeid === "string" ? params.nodeid : "";
    const catalogue = await fetchStorePackages(this.config, nodeid, apps.map((a) => ({ name: a.name, version: a.version ?? undefined })), this.deps.fetch).catch((e) => {
      throw new BoxError(`The AVADO store could not be reached: ${errorMessage(e)}`, "unavailable");
    });
    const installed = new Map(apps.map((a) => [a.name, a.version]));
    const all = catalogue.map((r) => toStoreApp(r, installed)).filter((s): s is StoreApp => s !== null);
    const q = name.trim().toLowerCase();
    const hits = all.filter((s) => s.name === q || s.name.split(".")[0] === q || s.title.toLowerCase() === q);
    if (hits.length === 0) throw new BoxError(`The AVADO store has no app called “${name}”. Use store_apps to see what is there.`, "refused");
    if (hits.length > 1) throw new BoxError(`More than one store app matches “${name}”: ${hits.map((h) => h.name).join(", ")}. Use the full name.`, "refused");
    return { entry: hits[0]!, apps };
  }

  /** Checks a restart before it is asked for or run. Throws BoxError("refused") when not allowed. */
  async resolveRestart(app: string): Promise<AppInfo> {
    const apps = await this.apps();
    const target = findApp(apps, app);
    assertActionAllowed(target.name, target.core, "restart");
    return target;
  }

  async restart(target: AppInfo): Promise<string> {
    assertActionAllowed(target.name, target.core, "restart");
    await this.withWamp((w) => restartPackage(w, target.name));
    return `${target.title} was restarted.`;
  }

  /** Checks an install or update and finds the store version. Throws BoxError("refused") when not allowed. */
  async resolveInstall(app: string, kind: "install" | "update"): Promise<StoreApp> {
    return this.withWamp(async (w) => {
      const { entry } = await this.storeEntry(w, app);
      assertActionAllowed(entry.name, entry.core, kind);
      if (kind === "install" && entry.installed) throw new BoxError(`${entry.title} is already installed (version ${entry.installed}). Use update_app to update it.`, "refused");
      if (kind === "update") {
        if (!entry.installed) throw new BoxError(`${entry.title} is not installed. Use install_app to install it.`, "refused");
        if (!entry.updateAvailable) throw new BoxError(`${entry.title} is up to date (version ${entry.installed}).`, "refused");
      }
      if (this.runningJob()) throw new BoxError(`Another install is still running (${this.runningJob()!.app}). Wait for it to finish.`, "refused");
      return entry;
    });
  }

  /** Starts the install and waits up to installWaitMs for it. */
  async install(entry: StoreApp, kind: "install" | "update"): Promise<Job> {
    assertActionAllowed(entry.name, entry.core, kind);
    if (this.runningJob()) throw new BoxError(`Another install is still running (${this.runningJob()!.app}).`, "refused");
    const job: Job = {
      id: String(this.nextJob++),
      kind,
      app: entry.name,
      version: entry.version,
      state: "running",
      message: `${kind === "install" ? "Installing" : "Updating"} ${entry.title} ${entry.version}…`,
      startedAt: new Date(this.deps.now()).toISOString(),
      finishedAt: null,
    };
    this.jobs.set(job.id, job);
    if (this.jobs.size > 50) this.jobs.delete([...this.jobs.keys()][0]!);
    const run = this.withWamp((w) => installPackage(w, entry.name, entry.manifestHash, 60 * 60_000)).then(
      () => {
        job.state = "done";
        job.message = `${entry.title} ${entry.version} is ${kind === "install" ? "installed" : "updated"}.`;
        job.finishedAt = new Date(this.deps.now()).toISOString();
      },
      (e: unknown) => {
        job.state = "failed";
        job.message = `${kind === "install" ? "Installing" : "Updating"} ${entry.title} did not work: ${errorMessage(e)}`;
        job.finishedAt = new Date(this.deps.now()).toISOString();
      },
    );
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([run, new Promise((r) => (timer = setTimeout(r, this.config.installWaitMs)))]);
    clearTimeout(timer);
    return { ...job };
  }

  job(id: string): Job | null {
    const j = this.jobs.get(id);
    return j ? { ...j } : null;
  }

  jobsList(): Job[] {
    return [...this.jobs.values()].map((j) => ({ ...j })).reverse();
  }

  private runningJob(): Job | undefined {
    return [...this.jobs.values()].find((j) => j.state === "running");
  }
}

/**
 * The never-list for actions. Core (system) apps are never restarted, installed or updated by an
 * agent (they update themselves); AI Connect does not restart itself.
 */
export function assertActionAllowed(name: string, core: boolean, kind: "restart" | "install" | "update"): void {
  if (!NAME_RE.test(name)) throw new BoxError("That app name cannot be used.", "refused");
  // core flag from the box/store, plus the core naming (<x>.dnp.dappnode.eth without .avado./.public.)
  const coreName = name.endsWith(".dnp.dappnode.eth") && !name.includes(".avado.") && !name.includes(".public.");
  if (core || coreName) {
    throw new BoxError(`${name} is part of the AVADO system. AI Connect never ${kind === "restart" ? "restarts" : kind === "install" ? "installs" : "updates"} system parts; they update themselves.`, "refused");
  }
  if (name === SELF_NAME && kind === "restart") throw new BoxError("AI Connect does not restart itself.", "refused");
}

function cleanClient(c: unknown): Record<string, unknown> {
  if (!c || typeof c !== "object") return {};
  const x = c as Record<string, unknown>;
  const api = (x.api ?? {}) as Record<string, unknown>;
  const v = x.validators as { count?: unknown } | null | undefined;
  return {
    app: x.name ?? x.id ?? null,
    role: x.role ?? null,
    network: x.network ?? null,
    reachable: api.reachable ?? null,
    syncing: api.syncing ?? null,
    peers: api.peers ?? null,
    version: api.version ?? null,
    ...(api.error ? { error: api.error } : {}),
    ...(v && typeof v.count === "number" ? { validatorCount: v.count } : {}),
  };
}

function containerProblems(containers: unknown): unknown[] {
  if (!Array.isArray(containers)) return [];
  const out: unknown[] = [];
  for (const c of containers) {
    if (!c || typeof c !== "object") continue;
    const x = c as Record<string, unknown>;
    const procs = Array.isArray(x.processes) ? (x.processes as Array<Record<string, unknown>>) : [];
    // supervisord states (DAPPMANAGER modules/diagnostics/containers.js); RUNNING and STARTING are fine
    const down = procs.filter((p) => p && typeof p.state === "string" && !["RUNNING", "STARTING"].includes(p.state)).map((p) => `${String(p.name)} (${String(p.state).toLowerCase()})`);
    const problems: string[] = [];
    if (x.oomKilled === true) problems.push("it was stopped because the box ran out of memory");
    if (typeof x.restartCount === "number" && x.restartCount >= 3) problems.push(`it restarted ${x.restartCount} times`);
    if (typeof x.state === "string" && x.state !== "running") problems.push(`it is ${x.state}`);
    if (down.length) problems.push(`process(es) not running inside it: ${down.join(", ")}`);
    if (problems.length) out.push({ app: x.id ?? x.name, problems });
  }
  return out;
}
