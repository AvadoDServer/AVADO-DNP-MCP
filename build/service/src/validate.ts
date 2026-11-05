/**
 * validate_package: checks the files of an AVADO package someone is DEVELOPING, offline, before
 * it is built or uploaded anywhere. It reads only what the assistant sends; it never touches the
 * box, the store or IPFS.
 *
 * Borrowed from DAppNode's MCP tool `dappnode_validate_package` (dappnode/DNP_DAPPMANAGER,
 * packages/dappmanager/src/mcp/tools.ts, GPL-3.0, like this package): same idea and shape (pass
 * the raw manifest and docker-compose.yml, get back every problem in one list, call it on every
 * iteration). DAppNode runs its @dappnode/schemas checks; those describe DAppNode's current
 * package format, not AVADO's. AVADO's DAPPMANAGER builds the container from the manifest's
 * "image" section (DNP_DAPPMANAGER build/src/src/utils/generate.js), so the rules below follow
 * that generator, the AVADO store and the Admin's setupWizard support (Admin 10.0.70).
 *
 * The answer also says, in plain words, what the package would be given on a box (privileged
 * mode, host network, folders of the box itself, open ports), so an owner can be told before
 * anything is installed.
 *
 * DAppNode's "upload / install a dev package" tools were not borrowed: AVADO's DAPPMANAGER has no
 * install-without-the-store call, and AI Connect promises owners that assistants only ever install
 * apps from the AVADO store.
 */
import semver from "semver";
import { parse as parseYaml } from "yaml";

export const MAX_FILE_CHARS = 64 * 1024;

export interface ValidateResult {
  ok: boolean;
  /** must be fixed: the DAPPMANAGER, the store or the Admin would refuse or break on it */
  errors: string[];
  /** works, but against AVADO conventions or worth a second look */
  warnings: string[];
  /** what the package gets on a box, in plain words */
  wouldGet: string[];
  checked: { manifest: boolean; compose: boolean; setupWizard: boolean };
}

const NAME_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*\.dnp\.dappnode\.eth$/;
const ENV_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const RESTART = ["no", "always", "on-failure", "unless-stopped"];
const TYPES = ["service", "library", "dncore"];
const VOLUME_NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/;

type Obj = Record<string, unknown>;
const isObj = (x: unknown): x is Obj => !!x && typeof x === "object" && !Array.isArray(x);

function parseManifest(raw: unknown, errors: string[]): Obj | null {
  if (isObj(raw)) return raw;
  if (typeof raw !== "string") {
    errors.push("dappnode_package.json: send the file's text (or the parsed object).");
    return null;
  }
  if (raw.length > MAX_FILE_CHARS) {
    errors.push(`dappnode_package.json is longer than ${MAX_FILE_CHARS / 1024} kB.`);
    return null;
  }
  try {
    const v = JSON.parse(raw) as unknown;
    if (isObj(v)) return v;
    errors.push("dappnode_package.json must be a JSON object.");
  } catch (e) {
    errors.push(`dappnode_package.json is not valid JSON: ${(e as Error).message}`);
  }
  return null;
}

function strings(v: unknown): string[] | null {
  return Array.isArray(v) && v.every((x) => typeof x === "string") ? (v as string[]) : null;
}

function checkPorts(ports: unknown, errors: string[], wouldGet: string[]): void {
  if (ports === undefined) return;
  const list = strings(ports);
  if (!list) {
    errors.push('image.ports must be a list of texts such as "30303:30303/udp" or "8545".');
    return;
  }
  const seen = new Set<string>();
  for (const p of list) {
    const m = /^(?:(\d{1,5}):)?(\d{1,5})(?:\/(tcp|udp))?$/.exec(p.trim());
    if (!m) {
      errors.push(`image.ports: “${p}” is not a port. Use "host:container", optionally with /udp or /tcp.`);
      continue;
    }
    const nums = [m[1], m[2]].filter(Boolean).map(Number);
    if (nums.some((n) => n < 1 || n > 65535)) errors.push(`image.ports: “${p}” is outside 1 to 65535.`);
    if (m[1]) {
      const key = `${m[1]}/${m[3] ?? "tcp"}`;
      if (seen.has(key)) errors.push(`image.ports: host port ${key} is listed twice.`);
      seen.add(key);
      wouldGet.push(`Opens port ${m[1]}${m[3] === "udp" ? " (UDP)" : ""} on the box itself, reachable from your home network.`);
    }
  }
}

function checkVolumes(image: Obj, errors: string[], warnings: string[], wouldGet: string[]): Set<string> {
  const named = new Set<string>();
  const vols = image.volumes;
  if (vols !== undefined) {
    const list = strings(vols);
    if (!list) errors.push('image.volumes must be a list of texts such as "data:/data".');
    for (const v of list ?? []) {
      const parts = v.split(":");
      if (parts.length < 2 || parts.length > 3 || !parts[1]!.startsWith("/")) {
        errors.push(`image.volumes: “${v}” must be "name:/path/in/container" or "/folder/on/box:/path/in/container".`);
        continue;
      }
      const src = parts[0]!;
      if (src.startsWith("/") || src.startsWith("~")) {
        if (src === "/var/run/docker.sock" || src === "/run/docker.sock") {
          wouldGet.push("Full control of the box: it gets the Docker socket, so it can start, stop and change every app, including the AVADO system.");
        } else if (src === "/") {
          wouldGet.push("Can read and change every file on the box (the whole disk is mounted).");
        } else if (src.startsWith("/dev/")) {
          wouldGet.push(`Uses the device ${src} of the box.`);
        } else {
          wouldGet.push(`Can read and change the box's own folder ${src}.`);
        }
        if (src.startsWith("~")) warnings.push(`image.volumes: “${v}”: “~” depends on the user the DAPPMANAGER runs as; use a named volume instead.`);
      } else if (!VOLUME_NAME_RE.test(src)) {
        errors.push(`image.volumes: “${src}” is not a valid volume name.`);
      } else {
        named.add(src);
      }
      if (parts[2] !== undefined && !["ro", "rw"].includes(parts[2])) errors.push(`image.volumes: “${v}”: the last part may only be ro or rw.`);
    }
  }
  if (image.external_vol !== undefined) {
    const list = strings(image.external_vol);
    if (!list) errors.push("image.external_vol must be a list of texts.");
    for (const v of list ?? []) {
      const src = v.split(":")[0] ?? "";
      wouldGet.push(`Uses another app's data (volume ${src}).`);
    }
  }
  return named;
}

function checkSetupWizard(sw: unknown, envKeys: Set<string>, errors: string[], warnings: string[]): boolean {
  if (sw === undefined) return false;
  if (!isObj(sw)) {
    errors.push("setupWizard must be an object with version and fields.");
    return true;
  }
  if (String(sw.version) !== "2") errors.push('setupWizard.version must be "2" (the format the AVADO Admin shows).');
  if (!Array.isArray(sw.fields) || sw.fields.length === 0) {
    errors.push("setupWizard.fields must be a list with at least one field.");
    return true;
  }
  const ids = new Set<string>();
  sw.fields.forEach((f: unknown, i: number) => {
    const where = `setupWizard.fields[${i}]`;
    if (!isObj(f)) {
      errors.push(`${where} must be an object.`);
      return;
    }
    if (typeof f.id !== "string" || !f.id) errors.push(`${where}: id is missing.`);
    else if (ids.has(f.id)) errors.push(`${where}: id “${f.id}” is used twice.`);
    else ids.add(f.id);
    if (typeof f.title !== "string" || !f.title.trim()) errors.push(`${where}: title is missing (the Admin shows it as the field's label).`);
    const t = f.target;
    if (!isObj(t) || t.type !== "environment" || typeof t.name !== "string") {
      errors.push(`${where}: target must be {"type": "environment", "name": "<ENV NAME>"} (the Admin supports only environment fields).`);
    } else if (!envKeys.has(t.name)) {
      warnings.push(`${where}: ${t.name} is not in image.environment; add "${t.name}=" there so the app gets a default.`);
    }
    if (f.secret !== undefined && typeof f.secret !== "boolean") errors.push(`${where}: secret must be true or false.`);
    if (f.required !== undefined && typeof f.required !== "boolean") errors.push(`${where}: required must be true or false.`);
  });
  return true;
}

function checkCompose(raw: string, manifest: Obj | null, named: Set<string>, errors: string[], warnings: string[]): void {
  if (raw.length > MAX_FILE_CHARS) {
    errors.push(`docker-compose.yml is longer than ${MAX_FILE_CHARS / 1024} kB.`);
    return;
  }
  let doc: unknown;
  try {
    doc = parseYaml(raw, { maxAliasCount: 50 });
  } catch (e) {
    errors.push(`docker-compose.yml is not valid YAML: ${(e as Error).message.split("\n")[0]}`);
    return;
  }
  if (!isObj(doc) || !isObj(doc.services)) {
    errors.push("docker-compose.yml needs a services section.");
    return;
  }
  const names = Object.keys(doc.services);
  if (names.length !== 1) errors.push(`docker-compose.yml must have exactly one service (it has ${names.length}); the AVADO SDK builds one image per package.`);
  if (!manifest || typeof manifest.name !== "string") return;
  const svc = (doc.services as Obj)[manifest.name];
  if (!isObj(svc)) {
    errors.push(`docker-compose.yml: the service must be named exactly like the package, “${manifest.name}”.`);
    return;
  }
  const want = `${manifest.name}:${String(manifest.version)}`;
  if (svc.image !== want) errors.push(`docker-compose.yml: image must be “${want}” (the DAPPMANAGER loads the image under that name), not “${String(svc.image)}”.`);
  if (svc.build === undefined) warnings.push("docker-compose.yml: no build section, so the AVADO SDK cannot build the image.");
  const composeVols = new Set(
    (strings(svc.volumes) ?? [])
      .map((v) => v.split(":")[0]!)
      .filter((v) => !v.startsWith("/") && !v.startsWith("~") && !v.startsWith(".")),
  );
  for (const v of named) if (!composeVols.has(v)) warnings.push(`docker-compose.yml does not mount the volume “${v}” from the manifest.`);
  for (const v of composeVols) if (!named.has(v)) warnings.push(`docker-compose.yml mounts “${v}”, which the manifest's image.volumes does not have. On a box only the manifest counts.`);
  for (const key of ["privileged", "network_mode", "cap_add", "devices", "pid", "ipc"]) {
    const image = isObj(manifest.image) ? manifest.image : {};
    if (svc[key] !== undefined && (key === "devices" || image[key] === undefined)) {
      warnings.push(`docker-compose.yml sets ${key}, but the manifest does not. On a box the DAPPMANAGER builds the container from the manifest only${key === "devices" ? " (it does not support devices; mount the device as a volume instead)" : ""}.`);
    }
  }
}

export function validatePackage(input: { manifest: unknown; compose?: string }): ValidateResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  const wouldGet: string[] = [];
  const m = parseManifest(input.manifest, errors);
  let named = new Set<string>();
  let sw = false;
  if (m) {
    if (typeof m.name !== "string" || !NAME_RE.test(m.name)) {
      errors.push('name must be lowercase and end in .dnp.dappnode.eth, for example "myapp.avado.dnp.dappnode.eth".');
    } else if (!m.name.endsWith(".avado.dnp.dappnode.eth") && !m.name.endsWith(".public.dappnode.eth")) {
      warnings.push(`name “${m.name}”: AVADO apps are named <app>.avado.dnp.dappnode.eth. Names without “.avado.” are treated as AVADO system parts.`);
    }
    if (typeof m.version !== "string" || !semver.valid(m.version)) errors.push(`version must be a version number like 0.1.0 (got “${String(m.version)}”).`);
    if (m.type !== undefined && !TYPES.includes(String(m.type))) errors.push(`type must be one of ${TYPES.join(", ")}.`);
    if (m.type === "dncore") warnings.push("type dncore marks an AVADO system part: only AVADO itself publishes those.");
    if (typeof m.title !== "string" || !m.title.trim()) warnings.push("title is missing: the store and the Admin show the name instead.");
    if (typeof m.description !== "string" || !m.description.trim()) warnings.push("description is missing: the store shows it on the app's page.");
    if (m.autoupdate !== undefined && typeof m.autoupdate !== "boolean") errors.push("autoupdate must be true or false.");
    if (m.avadocategory !== undefined && typeof m.avadocategory !== "string") errors.push("avadocategory must be a text, for example \"thelab\".");
    if (m.dependencies !== undefined) {
      if (!isObj(m.dependencies)) errors.push("dependencies must be an object of package name to version.");
      else
        for (const [dep, range] of Object.entries(m.dependencies)) {
          if (!NAME_RE.test(dep)) errors.push(`dependencies: “${dep}” is not a package name.`);
          if (typeof range !== "string" || !(range === "latest" || range.startsWith("/ipfs/") || semver.validRange(range))) {
            errors.push(`dependencies: the version for ${dep} must be a version range, "latest" or /ipfs/<hash>.`);
          }
        }
    }
    if (m.links !== undefined && (!isObj(m.links) || Object.values(m.links).some((v) => typeof v !== "string"))) errors.push("links must be an object of texts.");

    const image = m.image;
    if (!isObj(image)) {
      errors.push("image is missing: AVADO's DAPPMANAGER builds the container from the manifest's image section (volumes, ports, environment, restart).");
    } else {
      named = checkVolumes(image, errors, warnings, wouldGet);
      checkPorts(image.ports, errors, wouldGet);
      if (image.restart !== undefined && !RESTART.includes(String(image.restart))) errors.push(`image.restart must be one of ${RESTART.join(", ")}.`);
      if (image.restart === undefined) warnings.push('image.restart is not set, so the app does not start again after a reboot. Most AVADO apps use "always".');
      const env = image.environment;
      const envKeys = new Set<string>();
      if (env !== undefined) {
        const list = strings(env);
        if (!list) errors.push('image.environment must be a list of texts such as "NETWORK=mainnet".');
        for (const e of list ?? []) {
          const key = e.split("=")[0]!;
          if (!e.includes("=") || !ENV_RE.test(key)) errors.push(`image.environment: “${e}” must look like NAME=value.`);
          else if (envKeys.has(key)) errors.push(`image.environment: ${key} is listed twice.`);
          else envKeys.add(key);
        }
      }
      if (image.privileged === true) wouldGet.push("Full control of the box (privileged mode): it can change the system, other apps and their data.");
      else if (image.privileged !== undefined && typeof image.privileged !== "boolean") errors.push("image.privileged must be true or false.");
      if (image.network_mode !== undefined) {
        if (typeof image.network_mode !== "string") errors.push("image.network_mode must be a text.");
        else if (image.network_mode === "host") wouldGet.push("Uses the box's own network directly (host network): it sees all traffic and can open any port.");
        else warnings.push(`image.network_mode “${image.network_mode}”: apps normally stay on the AVADO network.`);
      }
      for (const key of ["cap_add", "cap_drop"]) {
        if (image[key] === undefined) continue;
        const caps = strings(image[key]);
        if (!caps) errors.push(`image.${key} must be a list of texts such as "NET_ADMIN".`);
        else if (key === "cap_add" && caps.length) wouldGet.push(`Extra system rights: ${caps.join(", ")}.`);
      }
      if (image.ipv4_address !== undefined) {
        const ip = String(image.ipv4_address);
        if (!/^172\.33\.(\d{1,3})\.(\d{1,3})$/.test(ip)) errors.push("image.ipv4_address must be an address in the AVADO network, 172.33.x.y.");
        else warnings.push("image.ipv4_address: a fixed address can clash with another app; only system parts use one.");
      }
      if (image.command !== undefined && typeof image.command !== "string" && !strings(image.command)) errors.push("image.command must be a text or a list of texts.");
      for (const key of ["devices", "sysctls", "pid", "ipc", "security_opt"]) {
        if (image[key] !== undefined) warnings.push(`image.${key} is ignored: AVADO's DAPPMANAGER does not pass it on to the container.`);
      }
      sw = checkSetupWizard(m.setupWizard, envKeys, errors, warnings);
    }
  }
  const hasCompose = typeof input.compose === "string" && input.compose.trim() !== "";
  if (hasCompose) checkCompose(input.compose!, m, named, errors, warnings);
  if (wouldGet.length === 0 && m && isObj(m.image)) wouldGet.push("Nothing beyond its own data: it runs on the AVADO network with no open ports and no access to the box itself.");
  return { ok: errors.length === 0, errors, warnings, wouldGet, checked: { manifest: m !== null, compose: hasCompose, setupWizard: sw } };
}
