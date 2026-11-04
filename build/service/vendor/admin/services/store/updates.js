import semver from "semver";

export function computeUpdates(storePackages, installedPackages) {
  const out = {};
  const latest = {};
  for (const p of storePackages || []) {
    const m = p && p.manifest;
    if (m && m.name && semver.valid(m.version)) latest[m.name] = { version: m.version, hash: p.manifesthash };
  }
  for (const pkg of installedPackages || []) {
    const l = pkg && latest[pkg.name];
    if (l && semver.valid(pkg.version) && semver.gt(l.version, pkg.version))
      out[pkg.name] = { from: pkg.version, to: l.version, hash: l.hash };
  }
  return out;
}
