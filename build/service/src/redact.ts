/**
 * Hides secret-looking text before anything leaves this package (app logs sent to an agent, the
 * activity log, our own log lines). It is a safety net, not a guarantee: the page tells owners
 * that logs are filtered, and the log tool is size-capped.
 */
import { BIP39_WORDS } from "./bip39.js";

export const HIDDEN = "[hidden by AVADO]";

// eslint-disable-next-line no-control-regex
const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]/g;
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;

const PATTERNS: Array<[RegExp, string | ((...m: string[]) => string)]> = [
  // our own tokens, and other bearer credentials
  [/\bavado_[A-Za-z0-9_-]{16,}/g, HIDDEN],
  [/(Bearer\s+)[^\s"',;]+/gi, `$1${HIDDEN}`],
  [/(authorization["']?\s*[:=]\s*["']?)(?!Bearer\b)[^\s"',;]+/gi, `$1${HIDDEN}`],
  // a pending Tailscale login link: whoever opens it first adds the box to their tailnet
  [/https:\/\/login\.tailscale\.com\/a\/[A-Za-z0-9]+/g, HIDDEN],
  // JWTs (the beacon/engine API secret is used to sign these)
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, HIDDEN],
  // extended private keys
  [/\b[xyzt]prv[1-9A-HJ-NP-Za-km-z]{100,}/g, HIDDEN],
  // user:password@ in URLs
  [/(\b[a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:)[^\s@/]+@/gi, `$1${HIDDEN}@`],
  // key = value pairs whose key names a secret
  [
    /((?:password|passwd|passphrase|pwd|mnemonic|seed[_ -]?phrase|seed|private[_ -]?key|privkey|secret|api[_-]?key|access[_-]?key|token|jwt|keystore[_-]?password)["']?\s*[:=]\s*)("(?:[^"\\]|\\.)*"|'[^']*'|[^\s,&}]+)/gi,
    `$1${HIDDEN}`,
  ],
  // long hex: private keys (64), signatures (130, 192) and the like. 40 (addresses) and 96 (BLS
  // public keys, which are public) stay readable; so do shorter hashes.
  [/\b(?:0x)?[0-9a-fA-F]{64,}\b/g, (m: string) => (m.replace(/^0x/, "").length === 96 ? m : HIDDEN)],
];

/** Hides runs of 12 or more BIP-39 words in a row (a wallet recovery phrase). */
export function hideMnemonics(text: string): string {
  return text.replace(/[A-Za-z]+(?:[\s,"'-]+[A-Za-z]+){11,}/g, (run) => {
    const parts = run.split(/([\s,"'-]+)/);
    // parts: word, sep, word, sep, ...; find stretches of >= 12 list words
    const words: Array<{ i: number; ok: boolean }> = [];
    for (let i = 0; i < parts.length; i += 2) words.push({ i, ok: BIP39_WORDS.has(parts[i]!.toLowerCase()) });
    let start = -1;
    const ranges: Array<[number, number]> = [];
    for (let k = 0; k <= words.length; k++) {
      const ok = k < words.length && words[k]!.ok;
      if (ok && start < 0) start = k;
      if (!ok && start >= 0) {
        if (k - start >= 12) ranges.push([start, k - 1]);
        start = -1;
      }
    }
    if (!ranges.length) return run;
    for (const [a, b] of ranges.reverse()) {
      const from = words[a]!.i;
      const to = words[b]!.i;
      parts.splice(from, to - from + 1, HIDDEN);
    }
    return parts.join("");
  });
}

export function redact(text: string): string {
  let out = text.replace(ANSI, "").replace(CONTROL, "");
  for (const [re, replacement] of PATTERNS) out = out.replace(re, replacement as string);
  return hideMnemonics(out);
}

/**
 * Redacts a log and keeps it under maxBytes, cutting from the start (the newest lines matter most).
 */
export function capLog(text: string, maxBytes: number): { text: string; cut: boolean } {
  const clean = redact(text);
  if (Buffer.byteLength(clean) <= maxBytes) return { text: clean, cut: false };
  let buf = Buffer.from(clean);
  buf = buf.subarray(buf.length - maxBytes);
  let s = buf.toString("utf8");
  const nl = s.indexOf("\n");
  if (nl >= 0 && nl < s.length - 1) s = s.slice(nl + 1);
  return { text: s, cut: true };
}
