import type { CacheCleanupPreview } from "./api";

export const DEFAULT_KEEP_VERSIONS = 3;
export type CleanupProjection = CacheCleanupPreview;

/** Choose the highest keep setting that meets the shortfall. Never suggest deleting every version. */
export function keepFreeing(projections: ReadonlyMap<number, CleanupProjection>, bytes: number): number | null {
  for (const keep of [2, 1]) {
    if ((projections.get(keep)?.bytes ?? 0) >= bytes) return keep;
  }
  return null;
}
