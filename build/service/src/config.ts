import { readFileSync } from "node:fs";
import { DEFAULT_ALLOWED_HOSTNAMES } from "./host.js";

export interface Config {
  host: string;
  /** The AI Connect page and the MCP endpoint, plain HTTP (http://mcp.my.ava.do). */
  httpPort: number;
  /** Same as httpPort over HTTPS with the *.my.ava.do certificate (https://mcp.my.ava.do). 0 = off. */
  httpsPort: number;
  /**
   * Agents only: serves /mcp and nothing else (no page, no token management). This is the port the
   * Tailscale package forwards to, so a public Funnel URL can never reach the token page.
   */
  agentPort: number;
  wampUrl: string;
  wampRealm: string;
  storeRpcUrl: string;
  ipfsGateway: string;
  ipfsApi: string;
  /**
   * Where the *.my.ava.do certificate and key come from, tried in order: the DAPPMANAGER's copy on
   * the box (what AVADO-DNP-Nethermind uses), then AVADO's download server (what the DAPPMANAGER
   * itself and older packages use). Each entry is the base URL holding my.ava.do.crt and .key.
   */
  certSources: string[];
  /** Holds tokens.json, activity.json, pin.json and the downloaded certificate. */
  stateDir: string;
  /**
   * A file in the container's own files, NOT in a volume: missing only in a new container. With
   * stateDir/last-version it tells an Admin restart from a reboot or an update (pin.ts).
   */
  containerMarker: string;
  publicDir: string;
  allowedHostnames: string[];
  /**
   * Proxies whose X-Forwarded-For header counts for the wrong-PIN limit (see clientAddress in
   * http.ts). Empty: nothing on an AVADO proxies the page, so the header is never trusted.
   */
  trustedProxies: string[];
  /** Origins a browser-based MCP client may call /mcp from (all others are refused, MCP spec). */
  allowedOrigins: string[];
  /**
   * Where the page and /mcp are on the AVADO network, as an OAuth issuer and resource base (MCP
   * spec: the sign-in endpoints are https). Tests point it at their own listener.
   */
  localBase: string;
  /**
   * The same for the agent-only port. Empty: taken from the X-Forwarded-Host the Tailscale relay
   * sends (the box's Tailscale name), so the Connect button works on the Tailscale address too.
   */
  agentBase: string;
  /** How long an action that needs the owner's OK waits for a click on the page. */
  approvalTimeoutMs: number;
  /** How long an install/update tool call waits before it answers "still running". */
  installWaitMs: number;
  version: string;
}

function num(env: NodeJS.ProcessEnv, key: string, fallback: number): number {
  const raw = env[key];
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) throw new Error(`${key} must be a non-negative number`);
  return n;
}

function url(env: NodeJS.ProcessEnv, key: string, fallback: string): string {
  const raw = (env[key] || fallback).trim().replace(/\/+$/, "");
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new Error(`${key} is not a URL`);
  }
  if (!["http:", "https:", "ws:", "wss:"].includes(u.protocol)) throw new Error(`${key} must be an http(s) or ws(s) URL`);
  return raw;
}

function list(env: NodeJS.ProcessEnv, key: string): string[] {
  return (env[key] || "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

function readVersion(env: NodeJS.ProcessEnv): string {
  if (env.PACKAGE_VERSION) return env.PACKAGE_VERSION;
  for (const file of [env.PACKAGE_VERSION_FILE, "/usr/src/service/package-version"]) {
    if (!file) continue;
    try {
      const v = readFileSync(file, "utf8").trim();
      if (v) return v;
    } catch {
      /* not in the image (tests, local runs) */
    }
  }
  return "0.0.0-dev";
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  return {
    host: env.HOST || "0.0.0.0",
    httpPort: num(env, "HTTP_PORT", 80),
    httpsPort: num(env, "HTTPS_PORT", 443),
    agentPort: num(env, "AGENT_PORT", 8000),
    wampUrl: url(env, "WAMP_URL", "ws://wamp.my.ava.do:8080/ws"),
    wampRealm: env.WAMP_REALM || "dappnode_admin",
    storeRpcUrl: url(env, "STORE_RPC_URL", "https://rpc.ava.do"),
    ipfsGateway: url(env, "IPFS_GATEWAY", "http://ipfs.my.ava.do:8080/ipfs"),
    ipfsApi: url(env, "IPFS_API", "http://ipfs.my.ava.do:5001/api/v0"),
    certSources: (env.CERT_SOURCES || "http://dappmanager.my.ava.do,http://iso.ava.do")
      .split(",")
      .map((s) => s.trim().replace(/\/+$/, ""))
      .filter(Boolean)
      .map((s, i) => url({ [`CERT_SOURCES_${i}`]: s }, `CERT_SOURCES_${i}`, s)),
    stateDir: env.STATE_DIR || "/data",
    containerMarker: env.CONTAINER_MARKER || "/tmp/ai-connect-container",
    publicDir: env.PUBLIC_DIR || new URL("../public", import.meta.url).pathname,
    allowedHostnames: [...DEFAULT_ALLOWED_HOSTNAMES, ...list(env, "EXTRA_ALLOWED_HOSTNAMES")],
    trustedProxies: [],
    allowedOrigins: ["http://mcp.my.ava.do", "https://mcp.my.ava.do", ...list(env, "EXTRA_ALLOWED_ORIGINS")],
    localBase: url(env, "LOCAL_BASE_URL", "https://mcp.my.ava.do"),
    agentBase: env.AGENT_BASE_URL ? url(env, "AGENT_BASE_URL", "") : "",
    approvalTimeoutMs: num(env, "APPROVAL_TIMEOUT_MS", 120_000),
    installWaitMs: num(env, "INSTALL_WAIT_MS", 45_000),
    version: readVersion(env),
  };
}
