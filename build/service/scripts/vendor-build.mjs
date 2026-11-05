#!/usr/bin/env node
// Emits the vendored Admin files as Node ESM next to the compiled service:
//   vendor/admin/<path>  ->  <outDir>/admin/<path>
// The Admin's webpack setup resolves "health/clients" from its src root and
// extension-less relative imports ("./apps"); Node's ESM loader does neither,
// so only the import specifiers are rewritten. Nothing else changes.
//
// Usage: node scripts/vendor-build.mjs <outDir>   (e.g. dist, .test-build/src)
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { VENDORED_FILES, vendorDir } from "./vendor-lib.mjs";

const outDir = process.argv[2];
if (!outDir) {
  console.error("usage: vendor-build.mjs <outDir>");
  process.exit(1);
}

const srcRoot = vendorDir();
const outRoot = path.resolve(outDir, "admin");

/** Resolves an Admin import to a vendored file, or null for a package import (e.g. "semver"). */
function resolveSpecifier(fromFile, spec) {
  let base;
  if (spec.startsWith("./") || spec.startsWith("../")) base = path.resolve(path.dirname(fromFile), spec);
  else if (spec.startsWith("health/") || spec.startsWith("services/")) base = path.join(srcRoot, spec);
  else return null;
  for (const candidate of [base, `${base}.js`, path.join(base, "index.js")]) {
    if (candidate.endsWith(".js") && existsSync(candidate)) return candidate;
  }
  throw new Error(`${path.relative(srcRoot, fromFile)}: cannot resolve "${spec}" inside vendor/admin (vendor the file it needs)`);
}

export function rewriteImports(fromFile, code) {
  return code.replace(/(\bfrom\s+|\bimport\s+)(["'])([^"']+)\2/g, (whole, lead, quote, spec) => {
    const target = resolveSpecifier(fromFile, spec);
    if (!target) return whole;
    let rel = path.relative(path.dirname(fromFile), target).split(path.sep).join("/");
    if (!rel.startsWith(".")) rel = `./${rel}`;
    return `${lead}${quote}${rel}${quote}`;
  });
}

for (const rel of VENDORED_FILES) {
  const from = path.join(srcRoot, rel);
  const to = path.join(outRoot, rel);
  mkdirSync(path.dirname(to), { recursive: true });
  writeFileSync(to, rewriteImports(from, readFileSync(from, "utf8")));
}
console.log(`vendor-build: ${VENDORED_FILES.length} Admin files -> ${outRoot}`);
