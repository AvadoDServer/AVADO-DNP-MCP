/**
 * Sign-in with the Connect button (OAuth, MCP authorization spec 2026-07-28), driven by the
 * official SDK client: discovery, registration (DCR and Client ID Metadata Documents), the owner's
 * Allow on the PIN-protected page, PKCE, resource binding, refresh rotation and removal.
 */
import assert from "node:assert/strict";
import http from "node:http";
import { after, test } from "node:test";
import { forwardedBase } from "../src/http.js";
import { canonicalResource, isPrivateAddress, redirectMatches } from "../src/oauth.js";
import { jsonResponse, pageHeaders, servers, setPin, startHttp } from "./helpers.js";
import { TestProvider, decide, finishSignIn, startSignIn, waitStatus } from "./oauthClient.js";

after(() => servers.forEach((s) => s.close()));

const mcpHeaders = { "Content-Type": "application/json", Accept: "application/json, text/event-stream" };
const list = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" });

test("the 401 from /mcp points to the sign-in documents, and they describe this box", async () => {
  const { main } = await startHttp();
  const r = await fetch(`${main}/mcp`, { method: "POST", headers: mcpHeaders, body: list });
  assert.equal(r.status, 401);
  const challenge = r.headers.get("www-authenticate") ?? "";
  assert.match(challenge, new RegExp(`resource_metadata="${main}/.well-known/oauth-protected-resource/mcp"`));
  assert.match(challenge, /scope="avado"/);
  const prm = (await (await fetch(`${main}/.well-known/oauth-protected-resource/mcp`)).json()) as Record<string, unknown>;
  assert.equal(prm.resource, `${main}/mcp`);
  assert.deepEqual(prm.authorization_servers, [main]);
  const as = (await (await fetch(`${main}/.well-known/oauth-authorization-server`)).json()) as Record<string, unknown>;
  assert.equal(as.issuer, main);
  assert.deepEqual(as.code_challenge_methods_supported, ["S256"]);
  assert.equal(as.authorization_response_iss_parameter_supported, true);
  assert.equal(as.client_id_metadata_document_supported, true);
  assert.equal(as.token_endpoint, `${main}/oauth/token`);
  // a wrong token gets error="invalid_token"
  const bad = await fetch(`${main}/mcp`, { method: "POST", headers: { ...mcpHeaders, Authorization: "Bearer aic_at_nope" }, body: list });
  assert.match(bad.headers.get("www-authenticate") ?? "", /error="invalid_token"/);
});

test("Connect, then Allow on the page: the app is connected, listed, logged, and its token works only for this address", async () => {
  const { main, agent, w } = await startHttp();
  const session = await setPin(main);
  const s = await startSignIn(`${main}/mcp`);
  // the waiting page shows a code; the page (unlocked) shows the same request
  const waiting = await waitStatus(s);
  assert.equal(waiting.state, "waiting");
  assert.match(String(waiting.code), /^\d{4}$/);
  assert.equal(waiting.name, "ChatGPT");
  assert.equal(waiting.redirectHost, "chatgpt.com");
  const state = (await (await fetch(`${main}/api/state`, { headers: { Cookie: session } })).json()) as { connects: Array<{ code: string; name: string; redirectHost: string }> };
  assert.equal(state.connects.length, 1);
  assert.equal(state.connects[0]!.code, waiting.code);
  await decide(main, session, "allow");
  const { client, callback } = await finishSignIn(s, `${main}/mcp`);
  assert.equal(callback.origin + callback.pathname, "https://chatgpt.com/connector_platform_oauth_redirect");
  assert.equal(callback.searchParams.get("iss"), main, "RFC 9207 iss");
  const names = (await client.listTools()).tools.map((t) => t.name);
  assert.ok(names.includes("health_check") && names.includes("restart_app"));
  await client.close();

  const conns = w.tokens.list().filter((t) => t.oauth);
  assert.equal(conns.length, 1);
  assert.equal(conns[0]!.name, "ChatGPT");
  assert.equal(conns[0]!.client, "chatgpt");
  assert.equal(conns[0]!.confirmActions, true, "ask me first is on for a new sign-in");
  assert.ok(!("refreshHash" in (conns[0]!.oauth as object)), "the page never sees token hashes");
  assert.ok(w.activity.list().some((e) => e.tool === "new connection" && e.who === "ChatGPT"));

  // the token is bound to this address (RFC 8707): the agent-only port refuses it
  const access = s.provider.stored!.access_token;
  const other = await fetch(`${agent}/mcp`, { method: "POST", headers: { ...mcpHeaders, Authorization: `Bearer ${access}` }, body: list });
  assert.equal(other.status, 401);
  // and never in the address
  const inLink = await fetch(`${main}/k/${access}/mcp`, { method: "POST", headers: mcpHeaders, body: list });
  assert.equal(inLink.status, 401);
});

test("Don't allow: the app is sent back with access_denied and nothing is connected", async () => {
  const { main, w } = await startHttp();
  const session = await setPin(main);
  const s = await startSignIn(`${main}/mcp`);
  await decide(main, session, "deny");
  const st = await waitStatus(s);
  assert.equal(st.state, "declined");
  const back = new URL(String(st.redirect));
  assert.equal(back.searchParams.get("error"), "access_denied");
  assert.equal(back.searchParams.get("iss"), main);
  assert.equal(back.searchParams.get("state"), s.provider.lastState);
  assert.equal(w.tokens.list().filter((t) => t.oauth).length, 0);
});

test("a locked page shows only how many sign-ins wait, and deciding needs the PIN", async () => {
  const { main } = await startHttp();
  await setPin(main);
  await startSignIn(`${main}/mcp`);
  const locked = (await (await fetch(`${main}/api/state`)).json()) as Record<string, unknown>;
  assert.equal(locked.waitingConnects, 1);
  assert.equal(locked.connects, undefined);
  const r = await fetch(`${main}/api/connect/00000000-0000-4000-8000-000000000000`, { method: "POST", headers: pageHeaders, body: JSON.stringify({ decision: "allow" }) });
  assert.equal(r.status, 401);
});

test("refresh tokens rotate; the previous one works briefly; removing the connection ends both", async () => {
  const { main, w } = await startHttp();
  const session = await setPin(main);
  const s = await startSignIn(`${main}/mcp`);
  await decide(main, session, "allow");
  const { client } = await finishSignIn(s, `${main}/mcp`);
  await client.close();
  const clientId = (s.provider.creds.values().next().value as { client_id: string }).client_id;
  const first = s.provider.stored!.refresh_token!;
  const refresh = (rt: string) =>
    fetch(`${main}/oauth/token`, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: rt, client_id: clientId, resource: `${main}/mcp` }) });
  const r1 = await refresh(first);
  assert.equal(r1.status, 200);
  const t1 = (await r1.json()) as { access_token: string; refresh_token: string };
  assert.notEqual(t1.refresh_token, first, "rotated");
  assert.equal((await refresh(first)).status, 200, "the previous refresh token still works for a short while (a retry)");
  const ok = await fetch(`${main}/mcp`, { method: "POST", headers: { ...mcpHeaders, Authorization: `Bearer ${t1.access_token}` }, body: list });
  assert.equal(ok.status, 200);
  // another app's client_id cannot use it
  const stolen = await fetch(`${main}/oauth/token`, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: t1.refresh_token, client_id: "aic_client_other" }) });
  assert.equal(stolen.status, 401);
  // the owner removes the connection on the page
  const id = w.tokens.list().find((t) => t.oauth)!.id;
  assert.equal((await fetch(`${main}/api/tokens/${id}/revoke`, { method: "POST", headers: { ...pageHeaders, Cookie: session }, body: "{}" })).status, 200);
  assert.equal((await fetch(`${main}/mcp`, { method: "POST", headers: { ...mcpHeaders, Authorization: `Bearer ${t1.access_token}` }, body: list })).status, 401);
  assert.equal((await refresh(t1.refresh_token)).status, 400);
});

test("a sign-in code works once, needs the right PKCE verifier, and a second use removes the connection", async () => {
  const { main, w } = await startHttp();
  const session = await setPin(main);
  const s = await startSignIn(`${main}/mcp`);
  await decide(main, session, "allow");
  const st = await waitStatus(s);
  const cb = new URL(String(st.redirect));
  const code = cb.searchParams.get("code")!;
  const clientId = (s.provider.creds.values().next().value as { client_id: string }).client_id;
  const exchange = (verifier: string) =>
    fetch(`${main}/oauth/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "authorization_code", code, client_id: clientId, code_verifier: verifier, redirect_uri: String(s.provider.redirectUrl), resource: `${main}/mcp` }),
    });
  const wrong = await exchange("x".repeat(43));
  assert.equal(wrong.status, 400);
  assert.equal(((await wrong.json()) as { error: string }).error, "invalid_grant");
  const good = await exchange(s.provider.verifier!);
  assert.equal(good.status, 200);
  assert.equal(w.tokens.list().filter((t) => t.oauth).length, 1);
  const again = await exchange(s.provider.verifier!);
  assert.equal(again.status, 400);
  assert.equal(w.tokens.list().filter((t) => t.oauth).length, 0, "a reused code removes what it made");
});

test("bad sign-in links never send the browser anywhere: unknown app, foreign redirect, no PKCE", async () => {
  const { main } = await startHttp();
  const reg = (await (
    await fetch(`${main}/oauth/register`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ client_name: "X", redirect_uris: ["https://app.example/cb"] }) })
  ).json()) as { client_id: string };
  const auth = (q: Record<string, string>) => fetch(`${main}/oauth/authorize?${new URLSearchParams(q)}`, { redirect: "manual" });
  const pkce = { code_challenge: "a".repeat(43), code_challenge_method: "S256", response_type: "code" };
  assert.equal((await auth({ client_id: "nobody", redirect_uri: "https://app.example/cb", ...pkce })).status, 400);
  const foreign = await auth({ client_id: reg.client_id, redirect_uri: "https://evil.example/cb", ...pkce });
  assert.equal(foreign.status, 400);
  assert.match(await foreign.text(), /does not belong to the app/);
  const noPkce = await auth({ client_id: reg.client_id, redirect_uri: "https://app.example/cb", response_type: "code", state: "s1" });
  assert.equal(noPkce.status, 303);
  const back = new URL(noPkce.headers.get("location")!);
  assert.equal(back.origin, "https://app.example");
  assert.equal(back.searchParams.get("error"), "invalid_request");
  assert.equal(back.searchParams.get("state"), "s1");
  const plain = await auth({ client_id: reg.client_id, redirect_uri: "https://app.example/cb", response_type: "code", code_challenge: "a".repeat(43), code_challenge_method: "plain" });
  assert.equal(new URL(plain.headers.get("location")!).searchParams.get("error"), "invalid_request");
  const otherResource = await auth({ client_id: reg.client_id, redirect_uri: "https://app.example/cb", ...pkce, resource: "https://other.example/mcp" });
  assert.equal(new URL(otherResource.headers.get("location")!).searchParams.get("error"), "invalid_target");
});

test("registration takes only https or localhost redirects", async () => {
  const { main } = await startHttp();
  const reg = (uris: unknown) => fetch(`${main}/oauth/register`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ redirect_uris: uris }) });
  assert.equal((await reg(["http://app.example/cb"])).status, 400);
  assert.equal((await reg(["cursor://anysphere/cb"])).status, 400);
  assert.equal((await reg(["https://app.example/cb#x"])).status, 400);
  assert.equal((await reg([])).status, 400);
  assert.equal((await reg(["http://127.0.0.1:33418/callback"])).status, 201);
  const secret = (await (
    await fetch(`${main}/oauth/register`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ redirect_uris: ["https://a.example/cb"], token_endpoint_auth_method: "client_secret_basic" }) })
  ).json()) as { client_secret?: string };
  assert.match(secret.client_secret ?? "", /^aic_cs_/);
});

test("an app on this computer (localhost) may use any port, and the page warns about it", async () => {
  assert.ok(redirectMatches(["http://127.0.0.1:1234/callback"], "http://127.0.0.1:5555/callback"));
  assert.ok(!redirectMatches(["http://127.0.0.1:1234/callback"], "http://127.0.0.1:5555/other"));
  assert.ok(!redirectMatches(["https://a.example/cb"], "https://a.example:444/cb"));
  const { main } = await startHttp();
  const session = await setPin(main);
  await startSignIn(`${main}/mcp`, new TestProvider("http://localhost:43123/callback", undefined, "Claude Code"));
  const state = (await (await fetch(`${main}/api/state`, { headers: { Cookie: session } })).json()) as { connects: Array<{ name: string; local: boolean; redirectHost: string }> };
  assert.equal(state.connects[0]!.name, "Claude Code");
  assert.equal(state.connects[0]!.local, true);
  assert.match(state.connects[0]!.redirectHost, /localhost/);
});

test("Client ID Metadata Document: the app is described by an https document, checked and fetched safely", async () => {
  const docUrl = "https://claude.ai/oauth/mcp-oauth-client-metadata";
  const doc = { client_id: docUrl, client_name: "Claude", redirect_uris: ["https://claude.ai/api/mcp/auth_callback"], token_endpoint_auth_method: "none" };
  const seen: string[] = [];
  const fetchDoc = (async (u: string | URL | Request) => {
    if (!String(u).includes("tailscale.my.ava.do")) seen.push(String(u));
    return String(u) === docUrl ? jsonResponse(200, doc) : new Response("no", { status: 404 });
  }) as typeof fetch;
  const { main, w } = await startHttp(["read"], undefined, {}, fetchDoc);
  const session = await setPin(main);
  const s = await startSignIn(`${main}/mcp`, new TestProvider("https://claude.ai/api/mcp/auth_callback", docUrl, "Claude"));
  assert.deepEqual(seen, [docUrl]);
  // no registration: the client_id is the document's address
  assert.ok([...s.provider.creds.values()].every((c) => (c as { client_id: string }).client_id === docUrl));
  await decide(main, session, "allow");
  const { client } = await finishSignIn(s, `${main}/mcp`);
  await client.close();
  const conn = w.tokens.list().find((t) => t.oauth)!;
  assert.equal(conn.name, "Claude");
  assert.equal(conn.client, "claude-web");
});

test("a sign-in document is never fetched from a private address, and must name itself", async () => {
  const docUrl = "https://intranet.example/client.json";
  const fetchDoc = (async () => jsonResponse(200, { client_id: docUrl, redirect_uris: ["https://intranet.example/cb"] })) as typeof fetch;
  const { main } = await startHttp(["read"], undefined, {}, fetchDoc, { lookup: async () => ["192.168.1.10"] });
  const q = new URLSearchParams({ client_id: docUrl, redirect_uri: "https://intranet.example/cb", response_type: "code", code_challenge: "a".repeat(43), code_challenge_method: "S256" });
  assert.equal((await fetch(`${main}/oauth/authorize?${q}`, { redirect: "manual" })).status, 400);
  const liar = (async () => jsonResponse(200, { client_id: "https://other.example/c.json", redirect_uris: ["https://x.example/cb"] })) as typeof fetch;
  const b = await startHttp(["read"], undefined, {}, liar);
  const q2 = new URLSearchParams({ client_id: "https://x.example/c.json", redirect_uri: "https://x.example/cb", response_type: "code", code_challenge: "a".repeat(43), code_challenge_method: "S256" });
  assert.equal((await fetch(`${b.main}/oauth/authorize?${q2}`, { redirect: "manual" })).status, 400);
  for (const ip of ["10.1.2.3", "172.33.0.5", "127.0.0.1", "169.254.1.1", "100.64.0.1", "::1", "fd00::1", "::ffff:192.168.0.1"]) assert.ok(isPrivateAddress(ip), ip);
  assert.ok(!isPrivateAddress("93.184.215.14"));
});

test("the Tailscale address: the relay's X-Forwarded-Host becomes the sign-in address of the agent-only port", async () => {
  assert.equal(forwardedBase({ headers: { "x-forwarded-host": "avado.tail1234.ts.net" } } as unknown as http.IncomingMessage), "https://avado.tail1234.ts.net");
  assert.equal(forwardedBase({ headers: { "x-forwarded-host": "avado.tail1234.ts.net:443" } } as unknown as http.IncomingMessage), "https://avado.tail1234.ts.net");
  assert.equal(forwardedBase({ headers: { "x-forwarded-host": "1.2.3.4" } } as unknown as http.IncomingMessage), null);
  assert.equal(forwardedBase({ headers: { "x-forwarded-host": "bad host" } } as unknown as http.IncomingMessage), null);
  assert.equal(forwardedBase({ headers: {} } as unknown as http.IncomingMessage), null);
  const { agent, w } = await startHttp();
  w.config.agentBase = "";
  const get = (path: string, headers: Record<string, string> = {}) =>
    new Promise<{ status: number; body: string }>((resolve, reject) => {
      const u = new URL(agent + path);
      http.get({ host: u.hostname, port: u.port, path: u.pathname, headers }, (res) => {
        let body = "";
        res.on("data", (c) => (body += c));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
      }).on("error", reject);
    });
  assert.equal((await get("/.well-known/oauth-authorization-server")).status, 404, "no address known: no sign-in here");
  const md = await get("/.well-known/oauth-authorization-server", { "X-Forwarded-Host": "avado.tail1234.ts.net" });
  assert.equal(md.status, 200);
  assert.equal((JSON.parse(md.body) as { issuer: string }).issuer, "https://avado.tail1234.ts.net");
  // the agent-only port still has no page and no page API
  assert.equal((await get("/api/state", { "X-Forwarded-Host": "avado.tail1234.ts.net" })).status, 404);
  assert.equal((await get("/", { "X-Forwarded-Host": "avado.tail1234.ts.net" })).status, 404);
  // but it serves the waiting page and its files
  assert.equal((await get("/oauth/wait", { "X-Forwarded-Host": "avado.tail1234.ts.net" })).status, 200);
  assert.equal((await get("/oauth/connect.js", { "X-Forwarded-Host": "avado.tail1234.ts.net" })).status, 200);
});

test("signing in through the agent-only port (the Tailscale address) works end to end", async () => {
  const { main, agent } = await startHttp();
  const session = await setPin(main);
  const s = await startSignIn(`${agent}/mcp`);
  assert.equal(new URL(s.waitUrl).origin, agent, "the waiting page is on the address the app used");
  await decide(main, session, "allow");
  const { client, callback } = await finishSignIn(s, `${agent}/mcp`);
  assert.equal(callback.searchParams.get("iss"), agent);
  assert.ok((await client.listTools()).tools.length > 0);
  await client.close();
});

test("a PIN reset declines waiting sign-ins and removes connected apps", async () => {
  const { main, w, deps } = await startHttp(["read"], undefined, { resetOpen: true });
  const session = await setPin(main);
  const s1 = await startSignIn(`${main}/mcp`);
  await decide(main, session, "allow");
  const { client } = await finishSignIn(s1, `${main}/mcp`);
  await client.close();
  const s2 = await startSignIn(`${main}/mcp`, new TestProvider("https://claude.ai/api/mcp/auth_callback", undefined, "Claude"));
  assert.equal(deps.oauth.waiting().length, 1);
  const r = await fetch(`${main}/api/pin/reset`, { method: "POST", headers: pageHeaders, body: "{}" });
  assert.equal(r.status, 200);
  assert.equal(w.tokens.list().length, 0);
  assert.equal((await waitStatus(s2)).state, "declined");
});

test("at most five sign-ins wait at once: the oldest gives way", async () => {
  const { main, deps } = await startHttp();
  const first = await startSignIn(`${main}/mcp`);
  for (let i = 0; i < 5; i++) await startSignIn(`${main}/mcp`);
  assert.equal(deps.oauth.waiting().length, 5);
  assert.equal((await waitStatus(first)).state, "expired");
});

test("resource identifiers are compared in their canonical form", () => {
  assert.equal(canonicalResource("https://MCP.my.ava.do/mcp/"), "https://mcp.my.ava.do/mcp");
  assert.equal(canonicalResource("https://mcp.my.ava.do/mcp#x"), null);
  assert.equal(canonicalResource("mcp.my.ava.do"), null);
});
