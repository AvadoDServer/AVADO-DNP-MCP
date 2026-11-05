export declare function trackUpdateAges(
  previous: Record<string, number> | null | undefined,
  updates: Record<string, unknown> | null | undefined,
  now: number,
): Record<string, number> | null;
