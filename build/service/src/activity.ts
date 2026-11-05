/**
 * The activity list on the AI Connect page: every tool call, every refused key, every action
 * the owner approved or declined. Kept in /data/activity.json (the newest MAX_ENTRIES).
 */
import { readFile } from "node:fs/promises";
import { writeFileAtomic } from "./files.js";
import { redact } from "./redact.js";

export const MAX_ENTRIES = 500;

export type Outcome = "ok" | "error" | "refused" | "declined" | "waiting" | "started";

export interface ActivityEntry {
  at: string;
  /** the connection's name, or null for a request without a valid key */
  who: string | null;
  tokenId: string | null;
  tool: string;
  /** the app it was about, when there is one */
  target?: string;
  outcome: Outcome;
  /** one plain-language sentence */
  detail?: string;
  /**
   * For changes (restart, install, update, the Allow changes switch): the whole entry as one plain
   * sentence for the page, e.g. "Claude Code restarted Teku."
   */
  says?: string;
  /** the entry is about a change to the box (shown under "Allow changes" on the page) */
  change?: boolean;
  ms?: number;
}

export class ActivityLog {
  private entries: ActivityEntry[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;
  private writing: Promise<void> = Promise.resolve();

  constructor(
    private readonly file: string | null,
    private readonly now: () => number = Date.now,
  ) {}

  async load(): Promise<void> {
    if (!this.file) return;
    try {
      const data = JSON.parse(await readFile(this.file, "utf8")) as { entries?: unknown };
      if (Array.isArray(data.entries)) this.entries = data.entries.filter((e) => e && typeof e === "object").slice(-MAX_ENTRIES) as ActivityEntry[];
    } catch {
      this.entries = [];
    }
  }

  add(entry: Omit<ActivityEntry, "at">): ActivityEntry {
    const e: ActivityEntry = {
      at: new Date(this.now()).toISOString(),
      ...entry,
      ...(entry.detail ? { detail: redact(entry.detail).slice(0, 300) } : {}),
      ...(entry.says ? { says: redact(entry.says).slice(0, 300) } : {}),
      ...(entry.target ? { target: entry.target.slice(0, 120) } : {}),
    };
    this.entries.push(e);
    if (this.entries.length > MAX_ENTRIES) this.entries.splice(0, this.entries.length - MAX_ENTRIES);
    this.scheduleSave();
    return e;
  }

  /** Newest first. */
  list(limit = 200): ActivityEntry[] {
    return this.entries.slice(-limit).reverse();
  }

  /** The newest changes (restart, install, update, the switch), newest first. */
  changes(limit = 20): ActivityEntry[] {
    const out: ActivityEntry[] = [];
    for (let i = this.entries.length - 1; i >= 0 && out.length < limit; i--) if (this.entries[i]!.change) out.push(this.entries[i]!);
    return out;
  }

  private scheduleSave() {
    if (!this.file || this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.flush();
    }, 2_000);
    this.timer.unref?.();
  }

  flush(): Promise<void> {
    if (!this.file) return Promise.resolve();
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    const body = JSON.stringify({ entries: this.entries });
    const file = this.file;
    this.writing = this.writing.then(() => writeFileAtomic(file, body, 0o600)).catch(() => {});
    return this.writing;
  }
}
