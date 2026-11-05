/**
 * Box-wide settings of the AI Connect page, kept in /data/settings.json.
 *
 * "Allow changes" (off by default): while it is off, no assistant can change anything on the box,
 * whatever its connection may do. The tools that change things (restart, install, update) are not
 * even listed to assistants then, the same way DAppNode's MCP server hides its mutating tools until
 * the owner switches them on (DNP_DAPPMANAGER, packages/dappmanager/src/mcp/server.ts). Looking is
 * always allowed.
 */
import { readFile } from "node:fs/promises";
import { writeFileAtomic } from "./files.js";

export interface SettingsData {
  allowChanges: boolean;
}

export class Settings {
  private data: SettingsData = { allowChanges: false };
  private writing: Promise<void> = Promise.resolve();

  constructor(private readonly file: string | null) {}

  async load(): Promise<void> {
    if (!this.file) return;
    try {
      const raw = JSON.parse(await readFile(this.file, "utf8")) as Partial<SettingsData>;
      // anything but an explicit true counts as off
      this.data = { allowChanges: raw.allowChanges === true };
    } catch {
      this.data = { allowChanges: false };
    }
  }

  get allowChanges(): boolean {
    return this.data.allowChanges;
  }

  async setAllowChanges(on: boolean): Promise<void> {
    this.data = { ...this.data, allowChanges: on };
    if (!this.file) return;
    const file = this.file;
    const body = JSON.stringify(this.data);
    this.writing = this.writing.catch(() => {}).then(() => writeFileAtomic(file, body, 0o600));
    await this.writing;
  }

  toJSON(): SettingsData {
    return { ...this.data };
  }
}
