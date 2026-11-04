import type { Metrics } from "./types.js";

export declare const PROMETHEUS_BASES: readonly string[];
export declare const QUERIES: Record<string, string>;
export declare function resetPrometheusBase(): void;
export declare function fetchMetrics(fetchImpl?: typeof fetch): Promise<Metrics | null>;
