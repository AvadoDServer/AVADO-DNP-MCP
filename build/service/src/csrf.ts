import type { IncomingMessage } from "node:http";

export const CSRF_HEADER = "x-avado-request";

export function isSafeMethod(method: string | undefined): boolean {
  return method === "GET" || method === "HEAD";
}

function sameHost(value: string, host: string): boolean {
  try {
    const url = new URL(value);
    // compare with the default port removed on both sides (Host "x:80" == Origin "http://x")
    return url.host.toLowerCase() === new URL(`${url.protocol}//${host}`).host.toLowerCase();
  } catch {
    return false;
  }
}

/**
 * Same-origin guard for state-changing requests (same as the Rocket Pool and Care package backends).
 * Returns null when the request may proceed, or the reason it is refused (-> 403).
 *
 * - the custom header `X-Avado-Request: 1` is required (a cross-site form or a "simple"
 *   fetch cannot set it without a CORS preflight, which this server never grants)
 * - Origin, and otherwise Referer, must match the Host header when present
 * - Sec-Fetch-Site, when the browser sends it, must not be cross-site
 */
export function checkCsrf(req: IncomingMessage): string | null {
  if (isSafeMethod(req.method)) return null;
  if (req.headers[CSRF_HEADER] !== "1") return "Missing X-Avado-Request header";
  const host = req.headers.host;
  if (!host) return "Missing Host header";
  const origin = req.headers.origin;
  if (origin !== undefined) {
    if (!sameHost(origin, host)) return "Cross-origin request refused";
  } else {
    const referer = req.headers.referer;
    if (referer !== undefined && !sameHost(referer, host)) return "Cross-origin request refused";
  }
  const site = req.headers["sec-fetch-site"];
  if (site !== undefined && site !== "same-origin" && site !== "none") {
    return "Cross-site request refused";
  }
  return null;
}
