import http from "node:http";
import https from "node:https";
import path from "node:path";
import { ActivityLog } from "./activity.js";
import { Approvals } from "./approvals.js";
import { Box } from "./box.js";
import { CertManager, type CertPair } from "./certs.js";
import { loadConfig } from "./config.js";
import { createAgentApp, createApp, defaultLimits, type AppDeps } from "./http.js";
import { createLogger, errorMessage } from "./log.js";
import { PinGuard, ownerRestarted } from "./pin.js";
import { TokenStore } from "./tokens.js";
import { WampClient } from "./wamp.js";

const config = loadConfig();
const logger = createLogger();

process.on("unhandledRejection", (reason) => {
  logger.error(`unhandled rejection: ${errorMessage(reason)}`);
});

const tokens = new TokenStore(path.join(config.stateDir, "tokens.json"));
const activity = new ActivityLog(path.join(config.stateDir, "activity.json"));
// "Forgot PIN" works for a few minutes after the owner presses Restart for AI Connect in the Admin
// (a new container with the same version; see ownerRestarted in pin.ts).
const resetOpen = await ownerRestarted(config.containerMarker, path.join(config.stateDir, "last-version"), config.version);
const pin = new PinGuard(path.join(config.stateDir, "pin.json"), { startedAt: Date.now(), resetOpen });
const [, , pinFile] = await Promise.all([tokens.load(), activity.load(), pin.load()]);
if (pinFile === "damaged") {
  // The page now asks for a new PIN; whoever chooses it must not find the owner's keys.
  const removed = await tokens.revokeAll();
  activity.add({ who: null, tokenId: null, tool: "pin reset", outcome: "ok", detail: `The saved PIN could not be read, so the page asks for a new one. ${removed} connection(s) were removed for safety.` });
  logger.warn(`pin.json could not be read; ${removed} key(s) removed`);
}
if (resetOpen && pin.isSet()) logger.info("restarted from the Admin: the page offers Reset the PIN for 10 minutes");

const box = new Box(config, logger, {
  openWamp: () => new WampClient({ url: config.wampUrl, realm: config.wampRealm }),
  fetch: (input, init) => fetch(input, init),
  now: () => Date.now(),
});

let httpsServer: https.Server | null = null;
let certValidTo: string | null = null;

const deps: AppDeps = {
  config,
  logger,
  box,
  tokens,
  activity,
  approvals: new Approvals(),
  pin,
  fetch: (input, init) => fetch(input, init),
  httpsInfo: () => ({ on: httpsServer !== null && httpsServer.listening, validTo: certValidTo }),
};
const limits = defaultLimits();
const app = createApp(deps, limits);

function tune<T extends http.Server | https.Server>(server: T): T {
  // an install or an approval can keep a request open for a few minutes
  server.requestTimeout = 300_000;
  server.headersTimeout = 30_000;
  server.maxConnections = 64;
  return server;
}

function listen(server: http.Server | https.Server, port: number, what: string) {
  server.on("error", (err: NodeJS.ErrnoException) => {
    const reason =
      err.code === "EACCES"
        ? `not allowed to use port ${port} (the node binary needs cap_net_bind_service)`
        : err.code === "EADDRINUSE"
          ? `port ${port} is already in use`
          : errorMessage(err);
    logger.error(`AI Connect cannot start its ${what}: ${reason}`);
    process.exit(1);
  });
  server.listen(port, config.host, () => logger.info(`${what} listening on ${config.host}:${port}`));
}

listen(tune(http.createServer(app)), config.httpPort, "page and MCP endpoint (http)");
if (config.agentPort) listen(tune(http.createServer(createAgentApp(deps, limits))), config.agentPort, "agent-only MCP endpoint (for Tailscale)");

function onCert(pair: CertPair) {
  certValidTo = pair.validTo;
  if (httpsServer) {
    httpsServer.setSecureContext({ cert: pair.cert, key: pair.key });
    return;
  }
  if (!config.httpsPort) return;
  httpsServer = tune(https.createServer({ cert: pair.cert, key: pair.key, minVersion: "TLSv1.2" }, app));
  listen(httpsServer, config.httpsPort, "page and MCP endpoint (https)");
}

const certs = new CertManager({ sources: config.certSources, dir: path.join(config.stateDir, "certs") }, logger, deps.fetch, onCert);
if (config.httpsPort) {
  await certs.loadCached();
  certs.start();
}

logger.info(`AVADO AI Connect ${config.version} started; ${tokens.list().length} connection(s); page PIN ${pin.isSet() ? "set" : "not set yet"}`);

function shutdown(signal: string): void {
  logger.info(`${signal} received, shutting down`);
  certs.stop();
  void Promise.all([activity.flush(), tokens.flush()]).finally(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
