import type { Finding, Rule, Snapshot } from "./types.js";

export declare const SEVERITIES: readonly string[];
export declare const TOPICS: readonly string[];
export declare function runChecksDetailed(snapshot: Snapshot, rules: readonly Rule[]): { findings: Finding[]; passed: number; total: number };
export declare function runChecks(snapshot: Snapshot, rules: readonly Rule[]): Finding[];
export declare function verdictOf(findings: readonly Finding[]): { level: "ok" | "warning" | "critical"; label: string };
