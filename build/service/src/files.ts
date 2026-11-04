import { randomBytes } from "node:crypto";
import { mkdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";

/** Writes to a temp file next to `file`, then renames it over: a crash never leaves half a file. */
export async function writeFileAtomic(file: string, data: string | Buffer, mode = 0o600): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${randomBytes(6).toString("hex")}.tmp`;
  await writeFile(tmp, data, { mode });
  await rename(tmp, file);
}
