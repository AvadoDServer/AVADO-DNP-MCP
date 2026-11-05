/**
 * Scope enforcement: a key sees and runs only the tools of its scopes; actions are limited,
 * logged, and wait for the owner when the key asks for that.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { runTool, toolsFor } from "../src/tools.js";
import { hashOf, makeWorld } from "./helpers.js";

const ACTIONS = ["restart_app", "install_app", "update_app"];

test("a read-only key lists no action tools", () => {
  const names = toolsFor(["read"]).map((t) => t.name);
  for (const a of ACTIONS) assert.ok(!names.includes(a), a);
  assert.ok(names.includes("health_check"));
});

test("restart scope adds only restart_app; install scope adds install_app and update_app", () => {
  assert.deepEqual(
    toolsFor(["read", "restart"]).map((t) => t.name).filter((n) => ACTIONS.includes(n)),
    ["restart_app"],
  );
  assert.deepEqual(
    toolsFor(["read", "install"]).map((t) => t.name).filter((n) => ACTIONS.includes(n)),
    ["install_app", "update_app"],
  );
});

test("a read-only key calling an action anyway is refused, logged, and nothing runs", async () => {
  const w = makeWorld({ scopes: ["read"] });
  for (const tool of ACTIONS) {
    const r = await runTool(tool, { app: "teku" }, w.ctx);
    assert.equal(r.isError, true, tool);
    assert.match(r.content[0]!.text, /not allowed/);
  }
  assert.deepEqual(
    w.procedures().filter((p) => p === "restartPackage" || p === "installPackage"),
    [],
  );
  const log = w.activity.list();
  assert.equal(log.length, 3);
  assert.ok(log.every((e) => e.outcome === "refused" && e.who === "Test agent"));
});

test("a restart key restarts an app, by short name, and it is logged", async () => {
  const w = makeWorld({ scopes: ["read", "restart"] });
  const r = await runTool("restart_app", { app: "teku" }, w.ctx);
  assert.equal(r.isError, undefined, r.content[0]!.text);
  assert.deepEqual(
    w.callsOf("restartPackage").map((c) => c.kwargs.id),
    ["teku.avado.dnp.dappnode.eth"],
  );
  const [entry] = w.activity.list();
  assert.equal(entry!.tool, "restart_app");
  assert.equal(entry!.outcome, "ok");
  assert.equal(entry!.target, "teku.avado.dnp.dappnode.eth");
});

test("a restart key cannot install", async () => {
  const w = makeWorld({ scopes: ["read", "restart"] });
  const r = await runTool("install_app", { app: "nimbus" }, w.ctx);
  assert.equal(r.isError, true);
  assert.equal(w.callsOf("installPackage").length, 0);
});

test("with “ask me first”, a restart waits; Don't allow means it never runs", async () => {
  const w = makeWorld({ scopes: ["read", "restart"], confirm: true });
  const pending = runTool("restart_app", { app: "teku" }, w.ctx);
  await waitFor(() => w.approvals.list().length === 1);
  const [item] = w.approvals.list();
  assert.equal(item!.summary, "Restart Teku Consensus Client");
  assert.equal(w.callsOf("restartPackage").length, 0);
  w.approvals.decide(item!.id, "declined");
  const r = await pending;
  assert.equal(r.isError, true);
  assert.equal(w.callsOf("restartPackage").length, 0);
  assert.deepEqual(
    w.activity.list().map((e) => e.outcome),
    ["declined", "waiting"],
  );
});

test("with “ask me first”, Allow runs the restart", async () => {
  const w = makeWorld({ scopes: ["read", "restart"], confirm: true });
  const pending = runTool("restart_app", { app: "teku" }, w.ctx);
  await waitFor(() => w.approvals.list().length === 1);
  w.approvals.decide(w.approvals.list()[0]!.id, "allowed");
  const r = await pending;
  assert.equal(r.isError, undefined, r.content[0]!.text);
  assert.equal(w.callsOf("restartPackage").length, 1);
});

test("with “ask me first”, no answer in time means nothing runs", async () => {
  const w = makeWorld({ scopes: ["read", "restart"], confirm: true });
  w.ctx.approvalTimeoutMs = 30;
  const r = await runTool("restart_app", { app: "teku" }, w.ctx);
  assert.equal(r.isError, true);
  assert.match(r.content[0]!.text, /did not allow/);
  assert.equal(w.callsOf("restartPackage").length, 0);
});

test("install uses the store's manifest hash for the app, with no other options", async () => {
  const w = makeWorld({ scopes: ["read", "install"] });
  const r = await runTool("install_app", { app: "Nimbus Consensus Client" }, w.ctx);
  assert.equal(r.isError, undefined, r.content[0]!.text);
  const calls = w.callsOf("installPackage");
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0]!.kwargs, { id: `nimbus.avado.dnp.dappnode.eth@${hashOf(3)}`, dontLogError: true });
});

test("install refuses an app that is already installed; update refuses one that is up to date", async () => {
  const w = makeWorld({ scopes: ["read", "install"] });
  assert.equal((await runTool("install_app", { app: "teku" }, w.ctx)).isError, true);
  assert.equal((await runTool("update_app", { app: "rotki" }, w.ctx)).isError, true);
  assert.equal(w.callsOf("installPackage").length, 0);
});

test("update installs the newer store version", async () => {
  const w = makeWorld({ scopes: ["read", "install"] });
  const r = await runTool("update_app", { app: "teku" }, w.ctx);
  assert.equal(r.isError, undefined, r.content[0]!.text);
  assert.deepEqual(
    w.callsOf("installPackage").map((c) => c.kwargs.id),
    [`teku.avado.dnp.dappnode.eth@${hashOf(1)}`],
  );
});

test("actions are limited per key (10 an hour)", async () => {
  const w = makeWorld({ scopes: ["read", "restart"] });
  for (let i = 0; i < 10; i++) assert.equal((await runTool("restart_app", { app: "rotki" }, w.ctx)).isError, undefined);
  const r = await runTool("restart_app", { app: "rotki" }, w.ctx);
  assert.equal(r.isError, true);
  assert.match(r.content[0]!.text, /at most 10 actions an hour/);
  assert.equal(w.callsOf("restartPackage").length, 10);
});

test("app_logs hides secrets and caps the number of lines asked for", async () => {
  const w = makeWorld();
  const r = await runTool("app_logs", { app: "teku", lines: 100000 }, w.ctx);
  const out = JSON.parse(r.content[0]!.text) as { log: string; lines: number };
  assert.equal(out.lines, 500);
  assert.doesNotMatch(out.log, /hunter2/);
  assert.deepEqual(
    w.callsOf("logPackage").map((c) => c.kwargs),
    [{ id: "teku.avado.dnp.dappnode.eth", options: { timestamps: true, tail: 500 }, dontLogError: true }],
  );
});

test("store_apps hides system, test-network and sunset entries unless asked", async () => {
  const w = makeWorld();
  const names = (JSON.parse((await runTool("store_apps", {}, w.ctx)).content[0]!.text) as { apps: Array<{ name: string; updateAvailable: boolean }> }).apps;
  assert.deepEqual(
    names.map((a) => a.name),
    ["teku.avado.dnp.dappnode.eth", "rotki.avado.dnp.dappnode.eth", "nimbus.avado.dnp.dappnode.eth"],
  );
  assert.equal(names[0]!.updateAvailable, true);
  const all = (JSON.parse((await runTool("store_apps", { include_all: true }, w.ctx)).content[0]!.text) as { apps: unknown[] }).apps;
  assert.equal(all.length, 5);
});

test("every tool call is in the activity log", async () => {
  const w = makeWorld();
  await runTool("list_apps", {}, w.ctx);
  await runTool("health_check", {}, w.ctx);
  await runTool("no_such_tool", {}, w.ctx);
  assert.deepEqual(
    w.activity.list().map((e) => `${e.tool}:${e.outcome}`),
    ["no_such_tool:refused", "health_check:ok", "list_apps:ok"],
  );
});

async function waitFor(cond: () => boolean, ms = 2000) {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error("timed out waiting");
    await new Promise((r) => setTimeout(r, 5));
  }
}
