#!/usr/bin/env node
// Copies the Admin's health rules into vendor/admin and rewrites VENDORED.json.
// Run from build/service:  yarn vendor:sync   (optionally ADMIN_SRC=/path/to/DNP_ADMIN/build/src/src)
// Review the diff afterwards: the vendored rules decide what the box reports.
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { MANIFEST_NAME, VENDORED_FILES, findAdminSrc, sha256, vendorDir } from "./vendor-lib.mjs";

const src = findAdminSrc();
if (!src) {
  console.error("DNP_ADMIN source not found. Set ADMIN_SRC=/path/to/DNP_ADMIN/build/src/src");
  process.exit(1);
}

let commit = "unknown";
try {
  commit = execFileSync("git", ["-C", src, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
} catch {
  /* not a git checkout */
}

const out = vendorDir();
const files = {};
for (const rel of VENDORED_FILES) {
  const from = path.join(src, rel);
  const to = path.join(out, rel);
  mkdirSync(path.dirname(to), { recursive: true });
  copyFileSync(from, to);
  files[rel] = sha256(readFileSync(to));
}

const manifest = {
  source: "https://github.com/AvadoDServer/DNP_ADMIN build/src/src",
  commit,
  note: "Byte-for-byte copies. Do not edit: run `yarn vendor:sync` instead. test/vendor-sync.test.ts checks these hashes.",
  files,
};
writeFileSync(path.join(out, MANIFEST_NAME), JSON.stringify(manifest, null, 2) + "\n");
console.log(`Vendored ${VENDORED_FILES.length} files from ${src} (${commit})`);
