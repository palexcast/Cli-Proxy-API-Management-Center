import type { PoolSimulation } from '../../src/features/usageHistory/projection';

/**
 * First step at which a pooled account's simulated capacity is 0, read from the pool's
 * per-account values; null when it never empties, undefined when it is not pooled.
 */
export function accountEmptyAt(pool: PoolSimulation, authId: string): number | null | undefined {
  const row = pool.values.get(authId);
  if (!row) return undefined;
  const step = row.findIndex((value) => value <= 1e-9);
  return step < 0 ? null : pool.start + step * pool.stepMs;
}
