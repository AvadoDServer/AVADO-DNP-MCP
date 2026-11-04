/**
 * The Care package must run exactly the Admin's health rules. These checks fail when:
 *  - a vendored file was edited here (hash differs from VENDORED.json)
 *  - the Admin's copy changed and was not re-vendored (only when a DNP_ADMIN checkout is found:
 *    $ADMIN_SRC or ../DNP_ADMIN next to this repo; skipped inside the docker build)
 */
import assert from "node:assert/strict";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";

// The plain-JS helper shared with the vendor scripts (tests run from build/service).
const lib = (await import(pathToFileURL(path.resolve("scripts/vendor-lib.mjs")).href)) as {
  VENDORED_FILES: string[];
  findAdminSrc(): string | null;
  readManifest(): { files: Record<string, string> };
  sha256(buf: Buffer): string;
  vendorDir(): string;
  adminDivergence(admin: string): string[];
};
const { VENDORED_FILES, adminDivergence, findAdminSrc, readManifest, sha256, vendorDir } = lib;

const FIX = "Run `yarn vendor:sync` in build/service (ADMIN_SRC=/path/to/DNP_ADMIN/build/src/src if needed), review the diff and commit it.";

test("every vendored file matches the hash recorded in VENDORED.json (no local edits)", () => {
  const manifest = readManifest();
  assert.deepEqual(Object.keys(manifest.files).sort(), [...VENDORED_FILES].sort(), `VENDORED.json lists other files than scripts/vendor-lib.mjs. ${FIX}`);
  for (const rel of VENDORED_FILES) {
    const file = path.join(vendorDir(), rel);
    assert.ok(existsSync(file), `vendor/admin/${rel} is missing. ${FIX}`);
    const actual = sha256(readFileSync(file));
    assert.equal(actual, manifest.files[rel], `vendor/admin/${rel} was edited locally; vendored Admin files must stay byte-for-byte copies. ${FIX}`);
  }
});

test("no stray files in vendor/admin", () => {
  const found: string[] = [];
  const walk = (dir: string, prefix = "") => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const rel = prefix ? `${prefix}/${e.name}` : e.name;
      if (e.isDirectory()) walk(path.join(dir, e.name), rel);
      else if (rel !== "VENDORED.json") found.push(rel);
    }
  };
  walk(vendorDir());
  assert.deepEqual(found.sort(), [...VENDORED_FILES].sort());
});

test("vendored rules match the Admin source (DNP_ADMIN checkout)", (t) => {
  const admin = findAdminSrc();
  if (!admin) {
    t.skip("DNP_ADMIN checkout not found (set ADMIN_SRC to compare)");
    return;
  }
  const diverged = adminDivergence(admin);
  assert.deepEqual(diverged, [], `The Care package's health rules differ from the Admin at ${admin}:\n  ${diverged.join("\n  ")}\n${FIX}`);
});

test("the sync check notices a changed, deleted or new Admin rule", () => {
  const admin = mkdtempSync(path.join(tmpdir(), "avado-care-admin-"));
  for (const rel of VENDORED_FILES) {
    mkdirSync(path.dirname(path.join(admin, rel)), { recursive: true });
    cpSync(path.join(vendorDir(), rel), path.join(admin, rel));
  }
  assert.deepEqual(adminDivergence(admin), []);
  writeFileSync(path.join(admin, "health/rules/storage.js"), "// changed\n", { flag: "a" });
  rmSync(path.join(admin, "health/rules/core.js"));
  writeFileSync(path.join(admin, "health/rules/feeRecipient.js"), "export const x = 1;\n");
  assert.deepEqual(adminDivergence(admin).sort(), [
    "health/rules/core.js (deleted in the Admin)",
    "health/rules/feeRecipient.js (new in the Admin, not vendored)",
    "health/rules/storage.js (changed in the Admin)",
  ]);
});
