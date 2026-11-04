export declare function computeUpdates(
  storePackages: unknown[] | null | undefined,
  installedPackages: Array<{ name: string; version?: string }> | null | undefined,
): Record<string, { from: string; to: string; hash?: string }>;
