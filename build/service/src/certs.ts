/**
 * The *.my.ava.do certificate, fetched the way other AVADO packages fetch it: from the DAPPMANAGER's
 * copy on the box (http://dappmanager.my.ava.do/my.ava.do.crt and .key, kept fresh by its
 * certificate watcher), else from http://iso.ava.do. Checked, and cached in the volume so HTTPS
 * also starts when neither answers. Renewed once a day.
 *
 * Note: AVADO publishes this key for every box, so HTTPS here protects against someone who only
 * listens on the network, not against someone who can also redirect traffic. That is why every
 * agent also needs its own key, and why the Tailscale route (its own certificate) is offered.
 */
import { X509Certificate, createPrivateKey } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { writeFileAtomic } from "./files.js";
import { errorMessage, type Logger } from "./log.js";
import type { FetchLike } from "./store.js";

export interface CertPair {
  cert: string;
  key: string;
  validTo: string;
}

/** Checks that the pair belongs together, covers *.my.ava.do and is valid for at least another hour. */
export function checkPair(cert: string, key: string, now = Date.now()): CertPair {
  const blocks = cert.match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g);
  if (!blocks?.length) throw new Error("no certificate in the file");
  const leaf = new X509Certificate(blocks[0]!);
  const san = leaf.subjectAltName ?? "";
  if (!/DNS:\*\.my\.ava\.do\b/.test(san)) throw new Error(`the certificate is not for *.my.ava.do (${san})`);
  if (Date.parse(leaf.validTo) - now < 60 * 60 * 1000) throw new Error(`the certificate expires ${leaf.validTo}`);
  if (!leaf.checkPrivateKey(createPrivateKey(key))) throw new Error("the key does not match the certificate");
  return { cert, key, validTo: leaf.validTo };
}

async function download(fetchImpl: FetchLike, url: string): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20_000);
  try {
    const res = await fetchImpl(url, { signal: controller.signal });
    if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
    const body = await res.text();
    if (body.length > 64 * 1024) throw new Error(`${url}: too large`);
    return body;
  } finally {
    clearTimeout(timer);
  }
}

export class CertManager {
  private current: CertPair | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly opts: { sources: string[]; dir: string },
    private readonly logger: Logger,
    private readonly fetchImpl: FetchLike,
    private readonly onChange: (pair: CertPair) => void,
  ) {}

  get pair(): CertPair | null {
    return this.current;
  }

  private files() {
    return { cert: path.join(this.opts.dir, "my.ava.do.crt"), key: path.join(this.opts.dir, "my.ava.do.key") };
  }

  async loadCached(): Promise<void> {
    try {
      const f = this.files();
      const pair = checkPair(await readFile(f.cert, "utf8"), await readFile(f.key, "utf8"));
      this.set(pair);
    } catch {
      /* none yet, or expired */
    }
  }

  async refresh(): Promise<boolean> {
    const problems: string[] = [];
    for (const base of this.opts.sources) {
      try {
        const [cert, key] = await Promise.all([download(this.fetchImpl, `${base}/my.ava.do.crt`), download(this.fetchImpl, `${base}/my.ava.do.key`)]);
        const pair = checkPair(cert, key);
        const f = this.files();
        await writeFileAtomic(f.cert, cert, 0o600);
        await writeFileAtomic(f.key, key, 0o600);
        if (!this.current || this.current.cert !== pair.cert) {
          this.logger.info(`certificate for *.my.ava.do loaded from ${base}, valid until ${pair.validTo}`);
          this.set(pair);
        }
        return true;
      } catch (e) {
        problems.push(`${base}: ${errorMessage(e)}`);
      }
    }
    this.logger.warn(`cannot fetch the *.my.ava.do certificate (${problems.join("; ")})`);
    return false;
  }

  private set(pair: CertPair) {
    this.current = pair;
    this.onChange(pair);
  }

  /** Daily renewal; every 10 minutes while there is no usable certificate. */
  start(): void {
    const loop = async () => {
      const ok = await this.refresh();
      this.timer = setTimeout(loop, ok || this.current ? 24 * 60 * 60 * 1000 : 10 * 60 * 1000);
      this.timer.unref?.();
    };
    void loop();
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer);
  }
}
