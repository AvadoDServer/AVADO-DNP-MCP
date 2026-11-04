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
import { TokenStore } from "./tokens.js";
import { WampClient } from "./wamp.js";

const config = loadConfig();
const logger = createLogger();

process.on("unhandledRejection", (reason) => {
  logger.error(`unhandled rejection: ${errorMessage(reason)}`);
});

const tokens = new TokenStore(path.join(config.stateDir, "tokens.json"));
const activity = new ActivityLog(path.join(config.stateDir, "activity.json"));
await Promise.all([tokens.load(), activity.load()]);

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

logger.info(`AVADO AI Connect ${config.version} started; ${tokens.list().length} connection(s)`);

function shutdown(signal: string): void {
  logger.info(`${signal} received, shutting down`);
  certs.stop();
  void Promise.all([activity.flush(), tokens.flush()]).finally(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
