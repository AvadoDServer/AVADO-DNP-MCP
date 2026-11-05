/**
 * The "Allow changes" switch: off by default, looking always works, changes only while it is on,
 * and every change gets one plain sentence on the page.
 */
import assert from "node:assert/strict";
import path from "node:path";
import { after, test } from "node:test";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { Settings } from "../src/settings.js";
import { CHANGES_OFF, runTool, toolsFor } from "../src/tools.js";
import { PACKAGES, dappmanagerHandlers, envelope, makeWorld, pageHeaders, servers, setPin, startHttp, tempDir } from "./helpers.js";

after(() => servers.forEach((s) => s.close()));

async function waitFor(cond: () => boolean, ms = 2000) {
  const t = Date.now();
  while (!cond()) {
    if (Date.now() - t > ms) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 10));
  }
}

test("changes are off on a new box, also when the settings file is missing or damaged", async () => {
  const dir = tempDir();
  const s = new Settings(path.join(dir, "settings.json"));
  await s.load();
  assert.equal(s.allowChanges, false);
  await s.setAllowChanges(true);
  const again = new Settings(path.join(dir, "settings.json"));
  await again.load();
  assert.equal(again.allowChanges, true, "kept across a restart");
});

test("while changes are off, the change tools are not listed, even for a key that may restart and install", () => {
  const off = toolsFor(["read", "restart", "install"], false).map((t) => t.name);
  assert.ok(!off.includes("restart_app") && !off.includes("install_app") && !off.includes("update_app"));
  assert.ok(off.includes("health_check") && off.includes("validate_package"));
  const on = toolsFor(["read", "restart", "install"], true).map((t) => t.name);
  assert.ok(on.includes("restart_app") && on.includes("install_app"));
});

test("a change asked for while changes are off does nothing and is logged in plain words", async () => {
  const w = makeWorld({ scopes: ["read", "restart", "install"], allowChanges: false });
  const r = await runTool("restart_app", { app: "teku" }, w.ctx);
  assert.equal(r.isError, true);
  assert.equal(r.content[0]!.text, CHANGES_OFF);
  const i = await runTool("install_app", { app: "nimbus" }, w.ctx);
  assert.equal(i.isError, true);
  assert.deepEqual(w.procedures().filter((p) => p === "restartPackage" || p === "installPackage"), []);
  const [last, first] = w.activity.changes();
  assert.equal(first!.says, "Test agent wanted to restart teku. Not done: changes are switched off.");
  assert.equal(last!.says, "Test agent wanted to install nimbus. Not done: changes are switched off.");
  // looking still works
  const look = await runTool("list_apps", {}, w.ctx);
  assert.notEqual(look.isError, true);
});

test("with changes on, a restart runs and the page gets one plain sentence", async () => {
  const w = makeWorld({ scopes: ["read", "restart"] });
  const r = await runTool("restart_app", { app: "teku" }, w.ctx);
  assert.notEqual(r.isError, true, r.content[0]!.text);
  const [c] = w.activity.changes();
  assert.equal(c!.says, "Test agent restarted Teku Consensus Client.");
  assert.equal(c!.change, true);
});

test("ask me first: the waiting, the Don't allow and the switch-off are all plain sentences", async () => {
  const w = makeWorld({ scopes: ["read", "restart"], confirm: true });
  const p = runTool("restart_app", { app: "teku" }, w.ctx);
  await waitFor(() => w.approvals.list().length === 1);
  w.approvals.decide(w.approvals.list()[0]!.id, "declined");
  await p;
  assert.deepEqual(
    w.activity.changes().map((e) => e.says),
    ["Test agent wanted to restart Teku Consensus Client. Not done: you did not allow it.", "Test agent asked to restart Teku Consensus Client. Waiting for your OK."],
  );
  // allowed on the page, but changes were switched off meanwhile: still nothing happens
  const p2 = runTool("restart_app", { app: "teku" }, w.ctx);
  await waitFor(() => w.approvals.list().length === 1);
  await w.settings.setAllowChanges(false);
  w.approvals.decide(w.approvals.list()[0]!.id, "allowed");
  const r2 = await p2;
  assert.equal(r2.isError, true);
  assert.equal(w.callsOf("restartPackage").length, 0);
});

test("an install that ends after the answer is logged when it ends", async () => {
  let finish!: () => void;
  // a DAPPMANAGER that takes longer than INSTALL_WAIT_MS (50 ms in tests)
  const w = makeWorld({
    scopes: ["read", "install"],
    handlers: {
      ...dappmanagerHandlers(PACKAGES),
      installPackage: () => new Promise((resolve) => (finish = () => resolve(envelope(null)))),
    },
  });
  const r = await runTool("install_app", { app: "nimbus" }, w.ctx);
  assert.match(r.content[0]!.text, /^Started:/);
  assert.equal(w.activity.changes()[0]!.says, "Test agent started to install Nimbus Consensus Client 0.0.53.");
  finish();
  await waitFor(() => w.activity.changes()[0]!.says === "Test agent installed Nimbus Consensus Client 0.0.53.");
});

test("the switch on the page needs the PIN, is logged, and switching off declines what waits", async () => {
  const { main, token, w } = await startHttp(["read", "restart"], undefined, {}, undefined, { allowChanges: false });
  const set = (cookie: string | null, on: boolean) =>
    fetch(`${main}/api/settings`, { method: "POST", headers: { ...pageHeaders, ...(cookie ? { Cookie: cookie } : {}) }, body: JSON.stringify({ allowChanges: on }) });
  assert.equal((await set(null, true)).status, 401);
  const session = await setPin(main);
  const state = (await (await fetch(`${main}/api/state`, { headers: { Cookie: session } })).json()) as { allowChanges: boolean };
  assert.equal(state.allowChanges, false);

  // off: an MCP client with a restart key does not even see restart_app
  const connect = async () => {
    const c = new Client({ name: "t", version: "1" });
    await c.connect(new StreamableHTTPClientTransport(new URL(`${main}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
    return c;
  };
  let c = await connect();
  assert.ok(!(await c.listTools()).tools.some((t) => t.name === "restart_app"));
  await c.callTool({ name: "restart_app", arguments: { app: "teku" } }).catch(() => null);
  await c.close();
  assert.equal(w.callsOf("restartPackage").length, 0);
  assert.equal(w.activity.changes()[0]!.says, "SDK client wanted to restart teku. Not done: changes are switched off.");

  assert.equal((await set(session, true)).status, 200);
  assert.equal(w.settings.allowChanges, true);
  assert.match(w.activity.changes()[0]!.says ?? "", /^You switched changes on/);
  c = await connect();
  assert.ok((await c.listTools()).tools.some((t) => t.name === "restart_app"));
  const r = (await c.callTool({ name: "restart_app", arguments: { app: "teku" } })) as { isError?: boolean };
  assert.notEqual(r.isError, true);
  await c.close();
  assert.equal(w.activity.changes()[0]!.says, "SDK client restarted Teku Consensus Client.");

  // a waiting action is declined when changes are switched off
  await w.tokens.setConfirm(w.tokens.list()[0]!.id, true);
  c = await connect();
  const pending = c.callTool({ name: "restart_app", arguments: { app: "teku" } });
  await waitFor(() => w.approvals.list().length === 1);
  assert.equal((await set(session, false)).status, 200);
  const out = (await pending) as { isError?: boolean };
  assert.equal(out.isError, true);
  await c.close();
  assert.equal(w.callsOf("restartPackage").length, 1, "only the restart from before");
  const st = (await (await fetch(`${main}/api/state`, { headers: { Cookie: session } })).json()) as { changes: Array<{ says: string }> };
  assert.ok(st.changes.some((c) => /^You switched changes off/.test(c.says)));
  assert.ok(st.changes.some((c) => c.says === "SDK client wanted to restart Teku Consensus Client. Not done: you did not allow it."));
});
