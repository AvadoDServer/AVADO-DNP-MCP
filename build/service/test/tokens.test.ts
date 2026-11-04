import assert from "node:assert/strict";
import { readFileSync, statSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { TokenError, TokenStore, hashToken } from "../src/tokens.js";
import { tempDir } from "./helpers.js";

test("a key is shown once and only its hash is stored, in a file only the service can read", async () => {
  const dir = tempDir();
  const file = path.join(dir, "tokens.json");
  const store = new TokenStore(file);
  await store.load();
  const { token, record } = await store.create({ name: "Claude on my laptop", client: "claude-code", scopes: ["restart"] });
  await store.flush();
  assert.match(token, /^avado_[A-Za-z0-9_-]{43}$/);
  const disk = readFileSync(file, "utf8");
  assert.ok(!disk.includes(token));
  assert.ok(disk.includes(hashToken(token)));
  assert.equal(statSync(file).mode & 0o777, 0o600);
  assert.deepEqual(record.scopes, ["read", "restart"]);
  assert.equal(record.confirmActions, true);
  assert.equal("hash" in record, false);
});

test("verify accepts the key, rejects others, and stops accepting it after revoke (also after a restart)", async () => {
  const file = path.join(tempDir(), "tokens.json");
  const store = new TokenStore(file);
  await store.load();
  const { token, record } = await store.create({ name: "Codex", client: "codex", scopes: [] });
  assert.equal(store.verify(token)?.id, record.id);
  assert.equal(store.verify(token.slice(0, -1) + (token.endsWith("A") ? "B" : "A")), null);
  assert.equal(store.verify("Bearer " + token), null);
  assert.equal(store.verify(""), null);
  assert.equal(store.verify(undefined), null);

  const again = new TokenStore(file);
  await again.load();
  assert.equal(again.verify(token)?.name, "Codex");
  assert.equal(await again.revoke(record.id), true);
  assert.equal(again.verify(token), null);
  await again.flush();
  const third = new TokenStore(file);
  await third.load();
  assert.equal(third.verify(token), null);
});

test("unknown scopes and empty names are refused; read is always included", async () => {
  const store = new TokenStore(path.join(tempDir(), "tokens.json"));
  await store.load();
  await assert.rejects(store.create({ name: "x", client: "other", scopes: ["admin"] }), TokenError);
  await assert.rejects(store.create({ name: "  ", client: "other", scopes: [] }), TokenError);
  const { record } = await store.create({ name: "<b>Cursor</b>", client: "nope", scopes: ["install"] });
  assert.equal(record.name, "bCursor/b");
  assert.equal(record.client, "other");
  assert.deepEqual(record.scopes, ["read", "install"]);
});
