/**
 * Sliding-window counters, in memory. Used for:
 *  - every MCP request per key (an agent in a loop cannot hammer the DAPPMANAGER)
 *  - actions per key (restart/install/update)
 *  - requests with a wrong key per client address (no guessing; keys have 256 bits anyway)
 */
export class RateLimiter {
  private hits = new Map<string, number[]>();

  constructor(
    readonly limit: number,
    readonly windowMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  /** Counts a hit and says whether it is within the limit. */
  take(key: string): boolean {
    const t = this.now();
    const from = t - this.windowMs;
    const list = (this.hits.get(key) ?? []).filter((x) => x > from);
    if (list.length >= this.limit) {
      this.hits.set(key, list);
      return false;
    }
    list.push(t);
    this.hits.set(key, list);
    if (this.hits.size > 10_000) this.prune(from);
    return true;
  }

  /** Whether the key is over the limit right now, without counting. */
  blocked(key: string): boolean {
    const from = this.now() - this.windowMs;
    return (this.hits.get(key) ?? []).filter((x) => x > from).length >= this.limit;
  }

  private prune(from: number) {
    for (const [k, v] of this.hits) {
      const keep = v.filter((x) => x > from);
      if (keep.length) this.hits.set(k, keep);
      else this.hits.delete(k);
    }
  }
}
