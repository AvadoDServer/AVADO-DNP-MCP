import { isIPv4, isIPv6 } from "node:net";

/**
 * Host allow-list against DNS rebinding (same rules as the Rocket Pool and Care package backends).
 * A page on an attacker's domain that is re-pointed at the box sends its own name as Host,
 * which would otherwise pass the same-origin check. Every /api/* request must name the box:
 *  - an IP literal (IPv4, or IPv6 in brackets), any port
 *  - localhost, any port
 *  - one of the package's own DNS names, with no port or :80/:443
 */
export const DEFAULT_ALLOWED_HOSTNAMES = [
  "mcp.my.ava.do",
  // container / service names on the AVADO docker network
  "mcp.avado.dnp.dappnode.eth",
  "my.mcp.avado.dnp.dappnode.eth",
  "dappnodepackage-mcp.avado.dnp.dappnode.eth",
  // the box's bind also answers these; .avado and .dappnode are not public TLDs.
  // (mcp.avadopackage.com is deliberately NOT listed: nobody at AVADO controls that domain.)
  "mcp.avado.dappnode",
  "mcp.avado.avado",
];

export function isAllowedHost(hostHeader: string | undefined, allowedNames: readonly string[]): boolean {
  if (!hostHeader) return false;
  const host = hostHeader.trim().toLowerCase();

  const v6 = /^\[([0-9a-f:.]+)\](?::(\d{1,5}))?$/.exec(host);
  if (v6) return isIPv6(v6[1]!);

  const m = /^([a-z0-9.-]+?)\.?(?::(\d{1,5}))?$/.exec(host);
  if (!m) return false;
  const name = m[1]!;
  const port = m[2];
  if (isIPv4(name) || name === "localhost") return true;
  if (!allowedNames.includes(name)) return false;
  return port === undefined || port === "80" || port === "443";
}
