/**
 * The HTTP side: a real MCP client (the official SDK) against the server, keys in headers and
 * links, the page API's guards, and the agent-only listener.
 */
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { after, test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createAgentApp, createApp, defaultLimits, type AppDeps } from "../src/http.js";
import { silentLogger } from "../src/log.js";
import { RateLimiter } from "../src/ratelimit.js";
import { makeWorld } from "./helpers.js";

const servers: http.Server[] = [];
after(() => servers.forEach((s) => s.close()));

async function start(scopes: Array<"read" | "restart" | "install"> = ["read"], limits = defaultLimits()) {
  const w = makeWorld();
  await w.tokens.load();
  const deps: AppDeps = {
    config: w.config,
    logger: silentLogger,
    box: w.box,
    tokens: w.tokens,
    activity: w.activity,
    approvals: w.approvals,
    fetch: (async () => new Response("no", { status: 404 })) as typeof fetch,
    httpsInfo: () => ({ on: false, validTo: null }),
  };
  const listen = async (app: http.RequestListener) => {
    const s = http.createServer(app);
    servers.push(s);
    await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
    return `http://127.0.0.1:${(s.address() as AddressInfo).port}`;
  };
  const main = await listen(createApp(deps, limits));
  const agent = await listen(createAgentApp(deps, limits));
  const { token } = await w.tokens.create({ name: "SDK client", client: "other", scopes, confirmActions: false });
  return { w, main, agent, token };
}

async function connect(url: string, headers: Record<string, string> = {}) {
  const client = new Client({ name: "test", version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers } }));
  return client;
}

test("an MCP client with a read key lists and calls the read tools", async () => {
  const { main, token, w } = await start();
  const client = await connect(`${main}/mcp`, { Authorization: `Bearer ${token}` });
  assert.equal(client.getServerVersion()?.name, "avado-ai-connect");
  assert.match(client.getInstructions() ?? "", /never/);
  const { tools } = await client.listTools();
  assert.deepEqual(
    tools.map((t) => t.name),
    ["box_overview", "list_apps", "health_check", "app_logs", "ethereum_status", "store_apps", "action_status"],
  );
  const res = (await client.callTool({ name: "list_apps", arguments: {} })) as { content: Array<{ text: string }> };
  assert.match(res.content[0]!.text, /teku\.avado\.dnp\.dappnode\.eth/);
  await client.close();
  assert.ok(w.activity.list().some((e) => e.tool === "list_apps" && e.who === "SDK client"));
});

test("an install key sees the action tools; calling restart without that scope is refused", async () => {
  const { main, token } = await start(["read", "install"]);
  const client = await connect(`${main}/mcp`, { Authorization: `Bearer ${token}` });
  const names = (await client.listTools()).tools.map((t) => t.name);
  assert.ok(names.includes("install_app") && names.includes("update_app") && !names.includes("restart_app"));
  const r = (await client.callTool({ name: "restart_app", arguments: { app: "teku" } })) as { isError?: boolean };
  assert.equal(r.isError, true);
  await client.close();
});

test("a call to a tool outside the key's scopes is refused and shows in the activity log", async () => {
  const { main, token, w } = await start(["read"]);
  const client = await connect(`${main}/mcp`, { Authorization: `Bearer ${token}` });
  const r = (await client.callTool({ name: "restart_app", arguments: { app: "teku" } }).catch((e: Error) => ({ isError: true, message: e.message }))) as { isError?: boolean };
  assert.equal(r.isError, true);
  await client.close();
  assert.equal(w.callsOf("restartPackage").length, 0);
  assert.ok(w.activity.list().some((e) => e.tool === "restart_app" && e.outcome === "refused" && /restart/.test(e.detail ?? "")));
});

test("the key also works inside the link (/k/<key>/mcp), for apps that only take an address", async () => {
  const { agent, token } = await start();
  const client = await connect(`${agent}/k/${token}/mcp`);
  assert.ok((await client.listTools()).tools.length > 0);
  await client.close();
});

const rpc = (body: unknown = { jsonrpc: "2.0", id: 1, method: "tools/list" }) => JSON.stringify(body);
const mcpHeaders = { "Content-Type": "application/json", Accept: "application/json, text/event-stream" };

test("no key or a wrong key: 401, logged, and too many wrong keys from one address: 429", async () => {
  const limits = { ...defaultLimits(), badAuth: new RateLimiter(3, 60_000) };
  const { main, w } = await start(["read"], limits);
  const none = await fetch(`${main}/mcp`, { method: "POST", headers: mcpHeaders, body: rpc() });
  assert.equal(none.status, 401);
  assert.match(none.headers.get("www-authenticate") ?? "", /Bearer/);
  const wrong = await fetch(`${main}/mcp`, { method: "POST", headers: { ...mcpHeaders, Authorization: "Bearer avado_wrong" }, body: rpc() });
  assert.equal(wrong.status, 401);
  await fetch(`${main}/mcp`, { method: "POST", headers: mcpHeaders, body: rpc() });
  const blocked = await fetch(`${main}/mcp`, { method: "POST", headers: mcpHeaders, body: rpc() });
  assert.equal(blocked.status, 429);
  assert.ok(w.activity.list().filter((e) => e.tool === "connect" && e.outcome === "refused").length >= 3);
});

test("a web page on another site cannot call /mcp (Origin check)", async () => {
  const { main, token } = await start();
  const r = await fetch(`${main}/mcp`, { method: "POST", headers: { ...mcpHeaders, Authorization: `Bearer ${token}`, Origin: "https://evil.example" }, body: rpc() });
  assert.equal(r.status, 403);
});

test("the agent-only port serves nothing but /mcp: no page, no key management", async () => {
  const { agent } = await start();
  for (const p of ["/", "/index.html", "/api/state", "/api/tokens"]) {
    const r = await fetch(`${agent}${p}`, { method: p === "/api/tokens" ? "POST" : "GET", headers: { "X-Avado-Request": "1", "Content-Type": "application/json" }, body: p === "/api/tokens" ? "{}" : undefined });
    assert.equal(r.status, 404, p);
  }
});

test("the page API needs the box's own host name and the X-Avado-Request header", async () => {
  const { main } = await start();
  // fetch cannot set Host; a raw request can (as a DNS-rebinding page's browser would send it)
  const evilHost = await new Promise<number>((resolve, reject) => {
    const u = new URL(`${main}/api/state`);
    http.get({ host: u.hostname, port: u.port, path: u.pathname, headers: { Host: "evil.example" } }, (res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
    }).on("error", reject);
  });
  assert.equal(evilHost, 421);
  const noHeader = await fetch(`${main}/api/tokens`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: "x" }) });
  assert.equal(noHeader.status, 403);
  const crossSite = await fetch(`${main}/api/tokens`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Avado-Request": "1", Origin: "https://evil.example" },
    body: JSON.stringify({ name: "x" }),
  });
  assert.equal(crossSite.status, 403);
});

test("the page makes, lists and removes a key; a removed key stops working at once", async () => {
  const { main } = await start();
  const h = { "Content-Type": "application/json", "X-Avado-Request": "1" };
  const made = (await (await fetch(`${main}/api/tokens`, { method: "POST", headers: h, body: JSON.stringify({ name: "Cursor", client: "cursor", scopes: ["read", "restart"] }) })).json()) as {
    token: string;
    record: { id: string };
  };
  const ok = await fetch(`${main}/mcp`, { method: "POST", headers: { ...mcpHeaders, Authorization: `Bearer ${made.token}` }, body: rpc({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "t", version: "1" } } }) });
  assert.equal(ok.status, 200);
  const state = (await (await fetch(`${main}/api/state`)).json()) as { tokens: Array<{ id: string; hash?: string }> };
  assert.ok(state.tokens.some((t) => t.id === made.record.id));
  assert.ok(state.tokens.every((t) => t.hash === undefined));
  assert.equal((await fetch(`${main}/api/tokens/${made.record.id}/revoke`, { method: "POST", headers: h, body: "{}" })).status, 200);
  const gone = await fetch(`${main}/mcp`, { method: "POST", headers: { ...mcpHeaders, Authorization: `Bearer ${made.token}` }, body: rpc() });
  assert.equal(gone.status, 401);
});

test("GET and DELETE on /mcp answer 405 (stateless server, no streams or sessions)", async () => {
  const { main, token } = await start();
  for (const method of ["GET", "DELETE"]) {
    const r = await fetch(`${main}/mcp`, { method, headers: { Authorization: `Bearer ${token}`, Accept: "text/event-stream" } });
    assert.equal(r.status, 405, method);
  }
});
