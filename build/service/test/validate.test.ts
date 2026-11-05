/**
 * validate_package (borrowed from DAppNode's dappnode_validate_package, AVADO rules): problems in
 * one list, plain words about what a package would get on a box, and nothing on the box touched.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { runTool } from "../src/tools.js";
import { validatePackage } from "../src/validate.js";
import { makeWorld } from "./helpers.js";

const good = {
  name: "mcp.avado.dnp.dappnode.eth",
  version: "0.2.0",
  title: "AI Connect",
  description: "Connect your own AI assistant.",
  type: "service",
  avadocategory: "thelab",
  autoupdate: true,
  image: { volumes: ["mcp:/data"], ports: [], restart: "always" },
  author: "AVADO",
  license: "GPL-3.0",
  dependencies: {},
  links: { OnboardingWizard: "http://mcp.my.ava.do" },
};
const goodCompose = `version: '3.4'
services:
  mcp.avado.dnp.dappnode.eth:
    image: 'mcp.avado.dnp.dappnode.eth:0.2.0'
    build:
      context: .
      dockerfile: build/Dockerfile
    volumes:
      - 'mcp:/data'
    restart: always
volumes:
  mcp: {}
`;

test("AI Connect's own files pass, and it would get nothing beyond its own data", () => {
  const r = validatePackage({ manifest: JSON.stringify(good), compose: goodCompose });
  assert.deepEqual(r.errors, []);
  assert.deepEqual(r.warnings, []);
  assert.equal(r.ok, true);
  assert.deepEqual(r.checked, { manifest: true, compose: true, setupWizard: false });
  assert.match(r.wouldGet[0]!, /Nothing beyond its own data/);
});

test("the Tailscale package passes and its extra rights are said in plain words", () => {
  const ts = {
    ...good,
    name: "tailscale.avado.dnp.dappnode.eth",
    version: "0.1.0",
    image: { volumes: ["tailscale:/data", "/dev/net/tun:/dev/net/tun"], environment: ["TS_AUTHKEY=", "TS_ROUTES=172.33.0.0/16"], ports: [], restart: "always", cap_add: ["NET_ADMIN", "SYS_MODULE"] },
    setupWizard: { version: "2", fields: [{ id: "TS_AUTHKEY", target: { type: "environment", name: "TS_AUTHKEY" }, title: "Tailscale auth key", secret: true, required: false }] },
  };
  const r = validatePackage({ manifest: ts });
  assert.deepEqual(r.errors, []);
  assert.equal(r.checked.setupWizard, true);
  assert.ok(r.wouldGet.some((s) => /device \/dev\/net\/tun/.test(s)));
  assert.ok(r.wouldGet.some((s) => /Extra system rights: NET_ADMIN, SYS_MODULE/.test(s)));
});

test("every problem comes back in one list", () => {
  const bad = {
    name: "My App",
    version: "one",
    type: "app",
    image: { volumes: ["data"], ports: ["99999", "8080:80", "8080:81"], restart: "sometimes", environment: ["NOVALUE", "A=1", "A=2"] },
    setupWizard: { version: "1", fields: [{ id: "X", target: { type: "file" } }] },
  };
  const r = validatePackage({ manifest: JSON.stringify(bad), compose: "services:\n  other:\n    image: x\n" });
  assert.equal(r.ok, false);
  const all = r.errors.join("\n");
  for (const want of [/name must be lowercase/, /version must be/, /type must be/, /“data” must be/, /“99999” is outside/, /8080\/tcp is listed twice/, /image.restart/, /“NOVALUE” must look like/, /A is listed twice/, /setupWizard.version/, /only environment fields/, /title is missing/, /service must be named exactly/]) {
    assert.match(all, want);
  }
});

test("risky rights are named so the owner can be told before anything is installed", () => {
  const risky = { ...good, image: { volumes: ["/var/run/docker.sock:/var/run/docker.sock", "/:/host"], privileged: true, network_mode: "host", ports: ["30303:30303/udp"], restart: "always" } };
  const r = validatePackage({ manifest: risky });
  const said = r.wouldGet.join("\n");
  assert.match(said, /Docker socket/);
  assert.match(said, /whole disk/);
  assert.match(said, /privileged/);
  assert.match(said, /host network/);
  assert.match(said, /port 30303 \(UDP\)/);
});

test("the compose file must use the name:version image tag the DAPPMANAGER loads, and match the manifest", () => {
  const r = validatePackage({ manifest: good, compose: goodCompose.replace("0.2.0'", "latest'").replace("- 'mcp:/data'", "- 'other:/data'\n    privileged: true") });
  assert.match(r.errors.join("\n"), /image must be “mcp.avado.dnp.dappnode.eth:0.2.0”/);
  const warn = r.warnings.join("\n");
  assert.match(warn, /does not mount the volume “mcp”/);
  assert.match(warn, /mounts “other”/);
  assert.match(warn, /sets privileged, but the manifest does not/);
  assert.match(validatePackage({ manifest: "{nope" }).errors[0]!, /not valid JSON/);
  assert.match(validatePackage({ manifest: good, compose: "a: [" }).errors[0]!, /not valid YAML/);
});

test("as an MCP tool it is read-only: any key may use it and nothing on the box is called", async () => {
  const w = makeWorld({ scopes: ["read"], allowChanges: false });
  const r = await runTool("validate_package", { manifest: JSON.stringify(good), compose: goodCompose }, w.ctx);
  assert.notEqual(r.isError, true);
  assert.equal((JSON.parse(r.content[0]!.text) as { ok: boolean }).ok, true);
  assert.deepEqual(w.procedures(), []);
});
