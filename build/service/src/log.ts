/**
 * Logging with redaction (from the AVADO Care package). Nothing in this service logs tokens,
 * request bodies or app logs; redaction is the second line of defence.
 */

import { redact } from "./redact.js";

export { redact };

export interface Logger {
  info(msg: string): void;
  warn(msg: string): void;
  error(msg: string): void;
}

export type LogSink = (level: "info" | "warn" | "error", line: string) => void;

const defaultSink: LogSink = (level, line) => {
  if (level === "info") process.stdout.write(line + "\n");
  else process.stderr.write(line + "\n");
};

export function createLogger(sink: LogSink = defaultSink): Logger {
  const write = (level: "info" | "warn" | "error", msg: string) =>
    sink(level, `${new Date().toISOString()} ${level.toUpperCase()} ${redact(msg)}`);
  return {
    info: (m) => write("info", m),
    warn: (m) => write("warn", m),
    error: (m) => write("error", m),
  };
}

export const silentLogger: Logger = { info() {}, warn() {}, error() {} };

export function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
