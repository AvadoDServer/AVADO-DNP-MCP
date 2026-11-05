/**
 * The page PIN: first-open flow, every page route locked without a session, the wrong-PIN wait,
 * "Forgot PIN" (only after an Admin restart, and it removes every key), and assistants with a key
 * never needing the PIN.
 */
import assert from "node:assert/strict";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { after, test } from "node:test";
import type { IncomingMessage } from "node:http";
import { clientAddress } from "../src/http.js";
import { PinError, PinGuard, checkNewPin, ownerRestarted, removeKeysWithoutPin, waitAfter, waitWords } from "../src/pin.js";
import { TokenStore } from "../src/tokens.js";
import { GOOD_PIN, TEST_SCRYPT_N, pageHeaders, servers, sessionFrom, setPin, startHttp, tempDir } from "./helpers.js";

after(() => servers.forEach((s) => s.close()));

const mcpHeaders = { "Content-Type": "application/json", Accept: "application/json, text/event-stream" };
const listTools = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" });
const ID = "11111111-1111-4111-8111-111111111111";

/** Every page route that changes or reveals something, as the page calls it. */
const PROTECTED: Array<{ path: string; body: unknown }> = [
  { path: "/api/tokens", body: { name: "Intruder", client: "other", scopes: ["read", "restart", "install"], confirmActions: false } },
  { path: `/api/tokens/${ID}/revoke`, body: {} },
  { path: `/api/tokens/${ID}/confirm`, body: { confirmActions: false } },
  { path: `/api/approvals/${ID}`, body: { decision: "allow" } },
];

type State = { pin: { set: boolean; unlocked: boolean; retryAfter: number; resetUntil: string | null }; tokens?: unknown[]; activity?: unknown[]; approvals?: unknown[]; jobs?: unknown[]; waiting?: number };

async function state(main: string, cookie?: string): Promise<State> {
  const r = await fetch(`${main}/api/state`, { headers: cookie ? { Cookie: cookie } : {} });
  assert.equal(r.status, 200);
  return (await r.json()) as State;
}

const post = (main: string, p: string, body: unknown, cookie?: string) =>
  fetch(`${main}${p}`, { method: "POST", headers: { ...pageHeaders, ...(cookie ? { Cookie: cookie } : {}) }, body: JSON.stringify(body) });

// ---- first open: no PIN -> choose one ----

test("first open: no PIN yet, the page shows nothing private and asks for one; choosing it unlocks the page", async () => {
  const { main } = await startHttp();
  const before = await state(main);
  assert.equal(before.pin.set, false);
  assert.equal(before.pin.unlocked, false);
  for (const k of ["tokens", "activity", "approvals", "jobs"] as const) assert.equal(before[k], undefined, k);

  // weak or malformed PINs are refused in plain words
  for (const bad of ["12345", "111111", "123456", "987654", "12ab56", "", "1234567890123"]) {
    const r = await post(main, "/api/pin/set", { pin: bad });
    assert.equal(r.status, 400, bad);
    assert.match(((await r.json()) as { error: string }).error, /digit|guess/);
  }
  assert.equal((await state(main)).pin.set, false);

  const r = await post(main, "/api/pin/set", { pin: GOOD_PIN });
  assert.equal(r.status, 200);
  const setCookie = r.headers.get("set-cookie") ?? "";
  assert.match(setCookie, /HttpOnly/);
  assert.match(setCookie, /SameSite=Strict/);
  assert.match(setCookie, /Path=\/api/);
  assert.match(setCookie, /Max-Age=1800/);
  const cookie = sessionFrom(r);

  const after = await state(main, cookie);
  assert.equal(after.pin.set, true);
  assert.equal(after.pin.unlocked, true);
  assert.ok(Array.isArray(after.tokens) && after.tokens.length === 1);
  assert.ok(Array.isArray(after.activity));

  // a second "first PIN" is refused: it cannot be used to replace the owner's PIN
  const again = await post(main, "/api/pin/set", { pin: "735102" });
  assert.equal(again.status, 409);
  // and without the cookie the page is locked again
  assert.equal((await state(main)).pin.unlocked, false);
});

test("the PIN is stored only as a slow scrypt hash, in a file only AI Connect can read", async () => {
  const { main, w } = await startHttp();
  await setPin(main);
  const file = path.join(w.config.stateDir, "pin.json");
  const raw = readFileSync(file, "utf8");
  assert.ok(!raw.includes(GOOD_PIN));
  const d = JSON.parse(raw) as { hash: string; salt: string; N: number };
  assert.ok(d.hash.length >= 40 && d.salt.length >= 20);
  assert.equal(d.N, TEST_SCRYPT_N);
  // the real cost (N = 2^15, 32 MiB) is used unless a test lowers it
  const realFile = path.join(tempDir(), "pin.json");
  const real = new PinGuard(realFile);
  const t = Date.now();
  await real.set(GOOD_PIN);
  assert.equal((JSON.parse(readFileSync(realFile, "utf8")) as { N: number }).N, 32768);
  assert.ok(Date.now() - t >= 5, "scrypt should take a noticeable time");
});

test("checkNewPin explains what is wrong", () => {
  assert.equal(checkNewPin(" 482915 "), "482915");
  assert.throws(() => checkNewPin("48291"), /at least 6/);
  assert.throws(() => checkNewPin("000000"), /easy to guess/);
  assert.throws(() => checkNewPin("890123"), /easy to guess/);
  assert.throws(() => checkNewPin(482915), /digits only/);
});

// ---- every protected route refuses without the session ----

test("without a PIN session every page route that changes or reveals something is refused, before and after a PIN is set", async () => {
  const { main, w, token } = await startHttp(["read", "restart"]);
  const real = w.tokens.list()[0]!.id;
  const routes = PROTECTED.map((r) => ({ ...r, path: r.path.replace(ID, real) }));

  const check = async (cookie: string | undefined, label: string) => {
    for (const r of routes) {
      const res = await post(main, r.path, r.body, cookie);
      assert.equal(res.status, 401, `${label}: ${r.path}`);
      assert.match(((await res.json()) as { error: string }).error, /PIN/);
    }
    const s = await state(main, cookie);
    assert.equal(s.pin.unlocked, false, label);
    for (const k of ["tokens", "activity", "approvals", "jobs"] as const) assert.equal(s[k], undefined, `${label}: ${k}`);
  };

  await check(undefined, "no PIN yet");
  const good = await setPin(main);
  await check(undefined, "no cookie");
  await check("aic_session=forged-value-that-was-never-issued", "forged cookie");
  await check(`${good}x`, "altered cookie");

  // nothing changed: the one key is still there, still read+restart, and still works for the assistant
  assert.equal(w.tokens.list().length, 1);
  assert.deepEqual(w.tokens.list()[0]!.scopes, ["read", "restart"]);
  assert.equal(w.tokens.list()[0]!.confirmActions, false);
  const mcp = await fetch(`${main}/mcp`, { method: "POST", headers: { ...mcpHeaders, Authorization: `Bearer ${token}` }, body: listTools });
  assert.equal(mcp.status, 200);

  // with the session the same routes work
  const made = await post(main, "/api/tokens", PROTECTED[0]!.body, good);
  assert.equal(made.status, 200);
  assert.equal((await post(main, `/api/tokens/${real}/confirm`, { confirmActions: true }, good)).status, 200);
  assert.equal((await post(main, `/api/tokens/${real}/revoke`, {}, good)).status, 200);

  // locking ends the session at once
  assert.equal((await post(main, "/api/pin/lock", {}, good)).status, 200);
  assert.equal((await post(main, "/api/tokens", PROTECTED[0]!.body, good)).status, 401);
});

test("the PIN routes keep the cross-site guard: no X-Avado-Request header or another site's Origin -> 403", async () => {
  const { main } = await startHttp();
  for (const p of ["/api/pin/set", "/api/pin/unlock", "/api/pin/reset", "/api/pin/lock"]) {
    const noHeader = await fetch(`${main}${p}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ pin: GOOD_PIN }) });
    assert.equal(noHeader.status, 403, p);
    const cross = await fetch(`${main}${p}`, { method: "POST", headers: { ...pageHeaders, Origin: "https://evil.example" }, body: JSON.stringify({ pin: GOOD_PIN }) });
    assert.equal(cross.status, 403, p);
  }
  assert.equal((await state(main)).pin.set, false);
});

test("assistants with a key never need the PIN, also while the page is locked", async () => {
  const { main, agent, token } = await startHttp();
  await setPin(main);
  for (const base of [main, agent]) {
    const r = await fetch(`${base}/mcp`, { method: "POST", headers: { ...mcpHeaders, Authorization: `Bearer ${token}` }, body: listTools });
    assert.equal(r.status, 200, base);
  }
});

test("a waiting action is only counted while locked; allowing it needs the PIN", async () => {
  const { main, w } = await startHttp();
  const cookie = await setPin(main);
  const pending = w.approvals.request({ tokenId: "t", who: "Claude", tool: "restart_app", target: "teku", summary: "restart Teku" }, 60_000).decision;
  const locked = await state(main);
  assert.equal(locked.waiting, 1);
  assert.equal(locked.approvals, undefined);
  const id = (await state(main, cookie)).approvals![0] as { id: string };
  assert.equal((await post(main, `/api/approvals/${id.id}`, { decision: "allow" })).status, 401);
  assert.equal((await post(main, `/api/approvals/${id.id}`, { decision: "allow" }, cookie)).status, 200);
  assert.equal(await pending, "allowed");
});

// ---- wrong PINs: per device, plus a slow-down for the whole box ----

const A = "172.33.1.20";
const B = "172.33.0.9";

test("wrong PINs: 5 tries per device, then a wait that doubles from 1 minute up to 15 minutes; the right PIN is not checked while waiting", async () => {
  let now = 1_800_000_000_000;
  const file = path.join(tempDir(), "pin.json");
  const g = new PinGuard(file, { now: () => now, scryptN: TEST_SCRYPT_N });
  await g.load();
  await g.set(GOOD_PIN);

  for (let i = 1; i <= 4; i++) {
    await assert.rejects(g.unlock("000001", A), (e: PinError) => e.status === 401 && e.wrong && /not right/.test(e.message));
  }
  await assert.rejects(
    g.unlock("000001", A),
    (e: PinError) => e.status === 429 && e.retryAfter === 60 && e.message === "That PIN is not right. Too many wrong PINs from this device. Try again in 60 seconds.",
  );
  // while waiting, even the right PIN is not looked at
  await assert.rejects(g.unlock(GOOD_PIN, A), (e: PinError) => e.status === 429 && !e.wrong && /from this device/.test(e.message));
  now += 59_000;
  await assert.rejects(g.unlock(GOOD_PIN, A), (e: PinError) => e.status === 429);
  now += 1_000;
  // the next wrong try doubles the wait
  await assert.rejects(g.unlock("000001", A), (e: PinError) => e.status === 429 && e.retryAfter === 120 && /Try again in 2 minutes\./.test(e.message));

  // a restart does not forget the count
  const again = new PinGuard(file, { now: () => now, scryptN: TEST_SCRYPT_N });
  assert.equal(await again.load(), "ok");
  assert.equal(again.retryAfter(A), 120);
  now += 120_000;
  const id = await again.unlock(GOOD_PIN, A);
  assert.ok(id.length > 30);
  assert.equal(again.retryAfter(A), 0);
  // a right PIN starts that device's count again
  await assert.rejects(again.unlock("000001", A), (e: PinError) => e.status === 401 && /4 tries left/.test(e.message));

  assert.deepEqual([4, 5, 6, 7, 8, 9, 10, 20].map(waitAfter), [0, 60_000, 120_000, 240_000, 480_000, 900_000, 900_000, 900_000]);
});

test("one device that keeps guessing never locks the owner's other devices out", async () => {
  let now = 1_800_000_000_000;
  const g = new PinGuard(path.join(tempDir(), "pin.json"), { now: () => now, scryptN: TEST_SCRYPT_N, boxDelayMs: 1 });
  await g.set(GOOD_PIN);
  // a stranger guesses for hours
  for (let i = 0; i < 12; i++) {
    await g.unlock("000001", A).catch(() => {});
    now += 16 * 60_000;
  }
  await assert.rejects(g.unlock("000001", A), (e: PinError) => e.status === 429);
  assert.equal(g.retryAfter(A), 900);
  // the owner on another device is not held up at all
  assert.equal(g.retryAfter(B), 0);
  assert.ok((await g.unlock(GOOD_PIN, B)).length > 30);
  // and has the full 5 tries
  for (let i = 0; i < 4; i++) await assert.rejects(g.unlock("000002", B), (e: PinError) => e.status === 401);
  assert.ok((await g.unlock(GOOD_PIN, B)).length > 30);
});

test("more than 20 wrong PINs in an hour slow every try down by a few seconds, but never close the page", async () => {
  let now = 1_800_000_000_000;
  const file = path.join(tempDir(), "pin.json");
  const g = new PinGuard(file, { now: () => now, scryptN: TEST_SCRYPT_N, boxDelayMs: 300 });
  await g.set(GOOD_PIN);
  // 20 wrong PINs from 20 addresses: not slow yet
  for (let i = 0; i < 20; i++) await assert.rejects(g.unlock("000001", `10.0.0.${i}`), (e: PinError) => e.status === 401);
  assert.equal(g.slow(), false);
  let t = Date.now();
  await assert.rejects(g.unlock("000001", "10.0.1.1"), (e: PinError) => e.status === 401);
  assert.ok(Date.now() - t < 250, "the 21st try is not slowed yet");
  assert.equal(g.slow(), true);

  // now every try waits, from any device, right or wrong, and none is refused for it
  t = Date.now();
  await assert.rejects(g.unlock("000001", "10.0.1.2"), (e: PinError) => e.status === 401);
  assert.ok(Date.now() - t >= 280, "a wrong try waits");
  t = Date.now();
  assert.ok((await g.unlock(GOOD_PIN, B)).length > 30);
  assert.ok(Date.now() - t >= 280, "the right PIN waits too");

  // devices wait side by side, not one after the other: 6 devices at once take about one delay
  t = Date.now();
  const codes = await Promise.all(Array.from({ length: 6 }, (_, i) => g.unlock(i === 0 ? GOOD_PIN : "000001", `10.0.2.${i}`).then(() => 200, (e: PinError) => e.status)));
  assert.deepEqual(codes, [200, 401, 401, 401, 401, 401]);
  assert.ok(Date.now() - t < 1_200, `took ${Date.now() - t} ms`);

  // kept across a restart, and it ends an hour after the wrong PINs
  const again = new PinGuard(file, { now: () => now, scryptN: TEST_SCRYPT_N, boxDelayMs: 300 });
  await again.load();
  assert.equal(again.slow(), true);
  now += 61 * 60_000;
  assert.equal(again.slow(), false);
  t = Date.now();
  assert.ok((await again.unlock(GOOD_PIN, B)).length > 30);
  assert.ok(Date.now() - t < 250);
});

test("an old pin.json with the earlier box-wide count still loads, without the old wait", async () => {
  const now = 1_800_000_000_000;
  const file = path.join(tempDir(), "pin.json");
  const g = new PinGuard(file, { now: () => now, scryptN: TEST_SCRYPT_N });
  await g.set(GOOD_PIN);
  const d = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
  delete d.devices;
  delete d.recentWrong;
  writeFileSync(file, JSON.stringify({ ...d, failures: 9, lockedUntil: now + 600_000 }));
  const old = new PinGuard(file, { now: () => now, scryptN: TEST_SCRYPT_N });
  assert.equal(await old.load(), "ok");
  assert.equal(old.retryAfter(A), 0);
  assert.ok((await old.unlock(GOOD_PIN, A)).length > 30);
});

test("wrong PINs over HTTP: 401, then 429 with Retry-After for this device, and listed in the activity", async () => {
  const { main, w } = await startHttp();
  await setPin(main);
  const codes: number[] = [];
  for (let i = 0; i < 7; i++) codes.push((await post(main, "/api/pin/unlock", { pin: "000001" })).status);
  assert.deepEqual(codes, [401, 401, 401, 401, 429, 429, 429]);
  const r = await post(main, "/api/pin/unlock", { pin: GOOD_PIN });
  assert.equal(r.status, 429);
  assert.equal(((await r.json()) as { error: string }).error, "Too many wrong PINs from this device. Try again in 60 seconds.");
  assert.ok(Number(r.headers.get("retry-after")) > 0);
  assert.equal(r.headers.get("set-cookie"), null);
  assert.equal((await state(main)).pin.retryAfter > 0, true);
  assert.equal(w.activity.list().filter((e) => e.tool === "wrong pin").length, 5);
});

test("a made-up X-Forwarded-For header does not make a new device; it counts only from a trusted proxy", async () => {
  const { main, w } = await startHttp();
  await setPin(main);
  const as = (ip: string, pin: string) =>
    fetch(`${main}/api/pin/unlock`, { method: "POST", headers: { ...pageHeaders, "X-Forwarded-For": ip }, body: JSON.stringify({ pin }) }).then((r) => r.status);
  // no proxy is trusted (the AVADO default): every made-up address is still this one device
  const codes: number[] = [];
  for (let i = 0; i < 6; i++) codes.push(await as(`10.9.9.${i}`, "000001"));
  assert.deepEqual(codes, [401, 401, 401, 401, 429, 429]);

  // with 127.0.0.1 as a trusted proxy, the header names the device
  w.config.trustedProxies = ["127.0.0.1"];
  assert.equal(await as("10.9.9.50", GOOD_PIN), 200);
  for (let i = 0; i < 4; i++) assert.equal(await as("10.9.9.51", "000001"), 401);
  assert.equal(await as("10.9.9.51", "000001"), 429);
  assert.equal(await as("10.9.9.52", GOOD_PIN), 200);
  // without the header the proxy itself is the device, and it is still waiting
  assert.equal((await post(main, "/api/pin/unlock", { pin: GOOD_PIN })).status, 429);
});

test("clientAddress: the connection's address, or the X-Forwarded-For hop just before the trusted proxies", () => {
  const req = (remote: string, xff?: string | string[]) => ({ socket: { remoteAddress: remote }, headers: xff === undefined ? {} : { "x-forwarded-for": xff } }) as unknown as IncomingMessage;
  assert.equal(clientAddress(req("::ffff:172.33.1.20")), "172.33.1.20");
  assert.equal(clientAddress(req("172.33.1.20", "1.2.3.4")), "172.33.1.20");
  assert.equal(clientAddress(req("172.33.1.20", "1.2.3.4"), ["172.33.0.5"]), "172.33.1.20");
  const proxy = ["172.33.0.5"];
  assert.equal(clientAddress(req("172.33.0.5", "1.2.3.4"), proxy), "1.2.3.4");
  // the client can put anything in front; only the hop the proxy added counts
  assert.equal(clientAddress(req("172.33.0.5", "9.9.9.9, 1.2.3.4"), proxy), "1.2.3.4");
  assert.equal(clientAddress(req("172.33.0.5", ["9.9.9.9", "1.2.3.4"]), proxy), "1.2.3.4");
  assert.equal(clientAddress(req("172.33.0.5", "1.2.3.4, 172.33.0.5"), proxy), "1.2.3.4");
  assert.equal(clientAddress(req("172.33.0.5", "not-an-ip"), proxy), "172.33.0.5");
  assert.equal(clientAddress(req("172.33.0.5"), proxy), "172.33.0.5");
});

test("waitWords: plain words, as the page shows them", () => {
  assert.equal(waitWords(240), "Too many wrong PINs from this device. Try again in 4 minutes.");
  assert.equal(waitWords(61), "Too many wrong PINs from this device. Try again in 2 minutes.");
  assert.equal(waitWords(60), "Too many wrong PINs from this device. Try again in 60 seconds.");
  assert.equal(waitWords(1), "Too many wrong PINs from this device. Try again in 1 second.");
  assert.equal(waitWords(900), "Too many wrong PINs from this device. Try again in 15 minutes.");
});

test("parallel guesses from one device are checked one at a time", async () => {
  const { main } = await startHttp();
  await setPin(main);
  const codes = await Promise.all(Array.from({ length: 12 }, () => post(main, "/api/pin/unlock", { pin: "000001" }).then((r) => r.status)));
  assert.equal(codes.filter((c) => c === 401).length, 4);
  assert.equal(codes.filter((c) => c === 429).length, 8);
});

test("the agent-only port tells the Tailscale relay what it is, without a key and without anything private", async () => {
  const { agent, main } = await startHttp();
  const r = await fetch(`${agent}/identity`);
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { name: "mcp.avado.dnp.dappnode.eth", version: "0.1.0" });
  assert.equal((await fetch(`${agent}/identity`, { method: "POST" })).status, 404);
  assert.equal((await fetch(`${main}/identity`)).status, 404);
});

// ---- sessions are short ----

test("a session ends after 10 minutes without a click or 30 minutes at most; the page's own refresh does not keep it alive", async () => {
  let now = 1_800_000_000_000;
  const g = new PinGuard(null, { now: () => now, scryptN: TEST_SCRYPT_N });
  const cookie = `aic_session=${await g.set(GOOD_PIN)}`;
  now += 9 * 60_000;
  assert.equal(g.check(cookie, false), true); // a page refresh
  now += 2 * 60_000;
  assert.equal(g.check(cookie), false); // 11 minutes without a click

  const c2 = `aic_session=${await g.unlock(GOOD_PIN, A)}`;
  for (let i = 0; i < 5; i++) {
    now += 6 * 60_000;
    assert.equal(g.check(c2), true, `click ${i}`);
  }
  now += 1 * 60_000;
  assert.equal(g.check(c2), false); // 31 minutes after the PIN
});

// ---- Forgot PIN: reset ----

test("reset is refused unless AI Connect was just restarted from the Admin; then it removes every key and every session", async () => {
  // no Admin restart: refused, nothing removed
  {
    const { main, token, w } = await startHttp();
    const cookie = await setPin(main);
    assert.equal((await state(main)).pin.resetUntil, null);
    const r = await post(main, "/api/pin/reset", {});
    assert.equal(r.status, 403);
    assert.match(((await r.json()) as { error: string }).error, /Restart/);
    assert.equal(w.tokens.list().length, 1);
    assert.equal((await fetch(`${main}/mcp`, { method: "POST", headers: { ...mcpHeaders, Authorization: `Bearer ${token}` }, body: listTools })).status, 200);
    assert.equal((await state(main, cookie)).pin.unlocked, true);
  }

  // right after an Admin restart
  const { main, token, w } = await startHttp(["read", "install"], undefined, { resetOpen: true });
  const cookie = await setPin(main);
  const second = (await (await post(main, "/api/tokens", { name: "Codex", client: "codex", scopes: ["read", "restart"] }, cookie)).json()) as { token: string };
  const waiting = w.approvals.request({ tokenId: "t", who: "Codex", tool: "restart_app", target: "teku", summary: "restart Teku" }, 60_000).decision;
  assert.equal(w.tokens.list().length, 2);
  assert.ok((await state(main)).pin.resetUntil);

  const r = await post(main, "/api/pin/reset", {});
  assert.equal(r.status, 200);
  assert.equal(((await r.json()) as { removed: number }).removed, 2);
  assert.match(r.headers.get("set-cookie") ?? "", /Max-Age=0/);

  assert.equal(w.tokens.list().length, 0);
  assert.equal(await waiting, "declined");
  for (const k of [token, second.token]) {
    const res = await fetch(`${main}/mcp`, { method: "POST", headers: { ...mcpHeaders, Authorization: `Bearer ${k}` }, body: listTools });
    assert.equal(res.status, 401);
  }
  // the old session is gone and the page asks for a new PIN
  const s = await state(main, cookie);
  assert.equal(s.pin.set, false);
  assert.equal(s.pin.unlocked, false);
  assert.equal((await post(main, "/api/tokens", { name: "x" }, cookie)).status, 401);
  assert.ok(w.activity.list().some((e) => e.tool === "pin reset" && /2 connections were removed/.test(e.detail ?? "")));

  // a new PIN works; a second reset in the same start is not offered
  const fresh = await setPin(main, "640213");
  assert.equal((await state(main, fresh)).pin.unlocked, true);
  assert.equal((await state(main)).pin.resetUntil, null);
  assert.equal((await post(main, "/api/pin/reset", {})).status, 403);
  assert.equal(existsSync(path.join(w.config.stateDir, "pin.json")), true);
});

test("the reset window closes 10 minutes after the start", async () => {
  let now = 1_800_000_000_000;
  const g = new PinGuard(null, { now: () => now, startedAt: now, resetOpen: true, scryptN: TEST_SCRYPT_N });
  await g.set(GOOD_PIN);
  assert.ok(g.resetUntil());
  now += 10 * 60_000;
  assert.equal(g.resetUntil(), null);
  let called = false;
  await assert.rejects(
    g.reset(async () => (called = true)),
    (e: PinError) => e.status === 403,
  );
  assert.equal(g.isSet(), true);
  assert.equal(called, false, "no key is removed when the reset is refused");
});

test("reset removes the keys before the PIN: if removing pin.json fails, no new PIN can reach the old keys", async () => {
  const dir = tempDir();
  const g = new PinGuard(path.join(dir, "pin.json"), { resetOpen: true, scryptN: TEST_SCRYPT_N });
  await g.set(GOOD_PIN);
  // the keys are removed while the PIN is still set
  let pinSetDuringRemove: boolean | null = null;
  assert.equal(await g.reset(async () => ((pinSetDuringRemove = g.isSet()), 3)), 3);
  assert.equal(pinSetDuringRemove, true);
  assert.equal(g.isSet(), false);

  // a failing key removal leaves the PIN in place (the owner can try again after another restart)
  const h = new PinGuard(path.join(dir, "pin2.json"), { resetOpen: true, scryptN: TEST_SCRYPT_N });
  await h.set(GOOD_PIN);
  await assert.rejects(h.reset(async () => Promise.reject(new Error("disk"))));
  assert.equal(h.isSet(), true);
  await assert.rejects(h.set("640213"), (e: PinError) => e.status === 409);
});

test("ownerRestarted: only a new container of the same version (an Admin restart) opens the reset window", async () => {
  const dir = tempDir();
  const marker = path.join(dir, "container-marker");
  const versionFile = path.join(dir, "volume", "last-version");
  // first install: new container, no version yet
  assert.equal(await ownerRestarted(marker, versionFile, "0.1.0"), false);
  // reboot, power cut, crash, Pause then Start: same container (marker still there)
  assert.equal(await ownerRestarted(marker, versionFile, "0.1.0"), false);
  // Restart in the Admin: compose rm + up -> new container, same version
  const rm = () => rmSync(marker);
  rm();
  assert.equal(await ownerRestarted(marker, versionFile, "0.1.0"), true);
  // an update: new container, new version
  rm();
  assert.equal(await ownerRestarted(marker, versionFile, "0.1.1"), false);
  assert.equal(readFileSync(versionFile, "utf8").trim(), "0.1.1");
  // a restart after the update
  rm();
  assert.equal(await ownerRestarted(marker, versionFile, "0.1.1"), true);
});

test("a PIN file that cannot be read is reported as damaged (server.ts then removes every key)", async () => {
  const file = path.join(tempDir(), "pin.json");
  writeFileSync(file, "{not json");
  const g = new PinGuard(file, { scryptN: TEST_SCRYPT_N });
  assert.equal(await g.load(), "damaged");
  assert.equal(g.isSet(), false);
  assert.equal(existsSync(file), false);
  assert.equal(await new PinGuard(path.join(tempDir(), "none.json")).load(), "none");
});

test("keys without a PIN are removed at start (a damaged PIN file, or a reset that could not save the empty key list)", async () => {
  const dir = tempDir();
  const tokensFile = path.join(dir, "tokens.json");
  const pinFile = path.join(dir, "pin.json");
  const made = new TokenStore(tokensFile);
  await made.load();
  await made.create({ name: "Claude Code", client: "claude-code", scopes: ["read", "install"] });
  await made.create({ name: "Codex", client: "codex", scopes: ["read"] });

  // a PIN is set: the keys stay
  const withPin = new PinGuard(pinFile, { scryptN: TEST_SCRYPT_N });
  await withPin.set(GOOD_PIN);
  const kept = new TokenStore(tokensFile);
  await kept.load();
  assert.equal(await removeKeysWithoutPin(withPin, kept), 0);
  assert.equal(kept.list().length, 2);

  // the PIN file is gone but tokens.json still holds the keys (what a reset leaves on a full disk)
  rmSync(pinFile);
  const pin = new PinGuard(pinFile, { scryptN: TEST_SCRYPT_N });
  assert.equal(await pin.load(), "none");
  const left = new TokenStore(tokensFile);
  await left.load();
  assert.equal(left.list().length, 2);
  assert.equal(await removeKeysWithoutPin(pin, left), 2);
  assert.equal(left.list().length, 0);
  const reread = new TokenStore(tokensFile);
  await reread.load();
  assert.equal(reread.list().length, 0, "removed on disk too");

  // a failing save never stops the start, and the keys are gone from memory anyway
  let cleared = false;
  const failing = { list: () => (cleared ? [] : [{}]), revokeAll: async () => ((cleared = true), Promise.reject(new Error("disk full"))) };
  assert.equal(await removeKeysWithoutPin(pin, failing), 1);
  assert.equal(failing.list().length, 0);
});
