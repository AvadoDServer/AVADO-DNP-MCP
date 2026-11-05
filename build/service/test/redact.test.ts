import assert from "node:assert/strict";
import { test } from "node:test";
import { HIDDEN, capLog, redact } from "../src/redact.js";

const MNEMONIC = "abandon ability able about above absent absorb abstract absurd abuse access accident";

test("a 12-word recovery phrase is hidden, also inside a sentence or JSON", () => {
  assert.equal(redact(`mnemonic: ${MNEMONIC}`).includes("abandon"), false);
  assert.equal(redact(`{"words":"${MNEMONIC}"}`).includes("absurd"), false);
  assert.ok(redact(`your phrase is ${MNEMONIC}, keep it safe`).includes(HIDDEN));
});

test("ordinary log text with a few list words stays readable", () => {
  const line = "INFO Syncing: the beacon node is about to start, able to reach 42 peers";
  assert.equal(redact(line), line);
});

test("private keys, signatures and other long hex are hidden; addresses and BLS public keys stay", () => {
  const key = "0x" + "a1".repeat(32);
  const sig = "0x" + "b2".repeat(65);
  const addr = "0x" + "c3".repeat(20);
  const pubkey = "0x" + "d4".repeat(48);
  const out = redact(`key=${key} sig ${sig} addr ${addr} pubkey ${pubkey}`);
  assert.ok(!out.includes("a1a1a1"));
  assert.ok(!out.includes("b2b2b2"));
  assert.ok(out.includes(addr));
  assert.ok(out.includes(pubkey));
});

test("passwords, tokens, bearer headers, JWTs and URL passwords are hidden", () => {
  const samples = [
    "password=hunter2",
    'keystorePassword: "s3cr3t"',
    "Authorization: Bearer abc.def.ghi",
    "token=abcdef123456",
    "jwt eyJhbGciOiJIUzI1NiJ9.eyJpYXQiOjE3MDAwMDAwMDB9.c2lnbmF0dXJlc2lnbmF0dXJl",
    "connecting to https://user:pa55w0rd@rpc.example.com/",
    "used key avado_AbCdEfGhIjKlMnOpQrStUvWxYz0123456789",
    "control: AuthURL is https://login.tailscale.com/a/146bb557012d98",
    "xprv9s21ZrQH143K3QTDL4LXw2F7HEK3wJUD2nW2nRk4stbPy6cq3jPPqjiChkVvvNKmPGJxWUtg6LnF5kejMRNNU3TGtRBeJgk33yuGBxrMPHi",
  ];
  for (const s of samples) {
    const out = redact(s);
    assert.ok(out.includes(HIDDEN), `${s} -> ${out}`);
    assert.doesNotMatch(out, /hunter2|s3cr3t|abc\.def|abcdef123456|c2lnbmF0dXJl|pa55w0rd|AbCdEfGh|xprv9s21|146bb557/);
  }
});

test("terminal colour codes are removed", () => {
  assert.equal(redact("\u001b[32mINFO\u001b[0m ready"), "INFO ready");
});

test("capLog keeps the newest part and starts on a whole line", () => {
  const lines = Array.from({ length: 2000 }, (_, i) => `line ${i}`).join("\n");
  const { text, cut } = capLog(lines, 1000);
  assert.equal(cut, true);
  assert.ok(Buffer.byteLength(text) <= 1000);
  assert.ok(text.endsWith("line 1999"));
  assert.match(text, /^line \d+\n/);
});
