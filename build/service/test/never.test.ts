/**
 * The never-list: what AI Connect must never be able to do, whatever an agent sends.
 */
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { BoxError, assertActionAllowed } from "../src/box.js";
import { ALLOWED_PROCEDURES, DappmanagerError, callDappmanager } from "../src/dappmanager.js";
import { TOOLS, runTool } from "../src/tools.js";
import { FakeWamp, dappmanagerHandlers, makeWorld } from "./helpers.js";

/** Every DAPPMANAGER procedure on 10.0.55 (build/src/src/calls/index.js) that is not a read or a safe action. */
const FORBIDDEN = [
  "changeIpfsTimeout",
  "copyFileFrom",
  "copyFileTo",
  "diagnose",
  "diskSpaceAvailable",
  "findLostData",
  "fetchDirectory",
  "fetchPackageVersions",
  "fetchPackageData",
  "getIpfsHealth",
  "getUserActionLogs",
  "installPackageSafe",
  "listLostData",
  "managePorts",
  "notificationsGet",
  "notificationsRemove",
  "notificationsTest",
  "removePackage",
  "resolveRequest",
  "resetBeaconData",
  "resetIpfsData",
  "resyncPackage",
  "restartPackageVolumes",
  "togglePackage",
  "updatePackageEnv",
  "setAutoUpdate",
  "rebootHost",
  "recoverLostData",
  "runSignedCmd",
  "updateDNS",
  "setName",
  "createJWT",
  "signPrioritySupportRequest",
];

test("only the nine allow-listed DAPPMANAGER procedures can be called", () => {
  assert.deepEqual([...ALLOWED_PROCEDURES].sort(), [
    "getDiagnostics",
    "getParams",
    "getStats",
    "getVersionData",
    "installPackage",
    "listPackages",
    "logPackage",
    "requestChainData",
    "restartPackage",
  ]);
});

test("every other procedure is refused before anything is sent to the DAPPMANAGER", async () => {
  const wamp = new FakeWamp(dappmanagerHandlers([]));
  for (const proc of FORBIDDEN) {
    await assert.rejects(callDappmanager(wamp, proc, { id: "teku.avado.dnp.dappnode.eth" }), (e: unknown) => e instanceof DappmanagerError && e.kind === "forbidden", proc);
  }
  assert.equal(wamp.calls.length, 0);
});

test("the tool list is exactly the read tools and the three safe actions", () => {
  assert.deepEqual(
    TOOLS.map((t) => `${t.name}:${t.scope}`),
    [
      "box_overview:read",
      "list_apps:read",
      "health_check:read",
      "app_logs:read",
      "ethereum_status:read",
      "store_apps:read",
      "action_status:read",
      "validate_package:read",
      "restart_app:restart",
      "install_app:install",
      "update_app:install",
    ],
  );
  for (const t of TOOLS) {
    assert.doesNotMatch(t.name, /remove|delete|uninstall|key|wallet|seed|mnemonic|password|withdraw|fee|slash|shell|exec|command|docker|file|env/i, t.name);
  }
});

test("no source file builds a DAPPMANAGER call name from input, and none spawns processes", () => {
  const dir = path.resolve("src");
  for (const f of readdirSync(dir).filter((x) => x.endsWith(".ts"))) {
    const code = readFileSync(path.join(dir, f), "utf8");
    assert.doesNotMatch(code, /child_process|node:child_process|\bexecSync\b|\bspawn\(/, `${f} must not run processes`);
    if (f !== "dappmanager.ts" && f !== "wamp.ts") assert.doesNotMatch(code, /\.call\(`/, `${f} must call the DAPPMANAGER only through dappmanager.ts`);
  }
});

test("system parts are never restarted, installed or updated; AI Connect does not restart itself", () => {
  for (const name of ["dappmanager.dnp.dappnode.eth", "admin.dnp.dappnode.eth", "bind.dnp.dappnode.eth", "ipfs.dnp.dappnode.eth", "wamp.dnp.dappnode.eth", "wifi.dnp.dappnode.eth"]) {
    for (const kind of ["restart", "install", "update"] as const) assert.throws(() => assertActionAllowed(name, false, kind), BoxError, `${kind} ${name}`);
  }
  assert.throws(() => assertActionAllowed("remoteconnect.avado.dnp.dappnode.eth", true, "restart"), BoxError);
  assert.throws(() => assertActionAllowed("mcp.avado.dnp.dappnode.eth", false, "restart"), /does not restart itself/);
  assert.throws(() => assertActionAllowed("../../etc", false, "restart"), BoxError);
  assert.doesNotThrow(() => assertActionAllowed("teku.avado.dnp.dappnode.eth", false, "restart"));
  assert.doesNotThrow(() => assertActionAllowed("ethchain-geth.public.dappnode.eth", false, "update"));
});

test("restarting a core app through the tool is refused and nothing is restarted", async () => {
  const w = makeWorld({ scopes: ["read", "restart"] });
  for (const app of ["dappmanager", "remoteconnect", "mcp"]) {
    const r = await runTool("restart_app", { app }, w.ctx);
    assert.equal(r.isError, true, app);
  }
  assert.equal(w.callsOf("restartPackage").length, 0);
  assert.ok(w.activity.list().every((e) => e.outcome === "refused"));
});

test("an install can only name a store app: no IPFS hashes, URLs or versions from the agent", async () => {
  const w = makeWorld({ scopes: ["read", "install"] });
  for (const app of ["/ipfs/QmZt7fwZL2xH2PBg6Yer9wSaV7Un51ZN5HS1QVRXSzzB6C", "nimbus.avado.dnp.dappnode.eth@/ipfs/QmEvil", "https://evil.example/pkg", "dappmanager"]) {
    const r = await runTool("install_app", { app }, w.ctx);
    assert.equal(r.isError, true, app);
  }
  assert.equal(w.callsOf("installPackage").length, 0);
});

test("list_apps never returns env values (they can hold passwords)", async () => {
  const w = makeWorld();
  const r = await runTool("list_apps", {}, w.ctx);
  assert.doesNotMatch(r.content[0]!.text, /hunter2|PASSWORD|envs/);
});

test("box_overview never returns IP addresses or the node id", async () => {
  const w = makeWorld();
  const r = await runTool("box_overview", {}, w.ctx);
  assert.doesNotMatch(r.content[0]!.text, /85\.84\.83\.82|192\.168\.1\.20|0x2c7536/);
});
