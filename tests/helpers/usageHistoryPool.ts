import type { WindowKind } from '../../src/features/usageHistory/model';
import {
  poolOf,
  simulateRouting,
  type AccountProjection,
  type BlockInterval,
  type PoolSimulation,
  type RoutedAccount,
} from '../../src/features/usageHistory/projection';

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

/** An account without the simulated window: it takes failover and never runs dry. */
export interface Sink {
  authId: string;
  priority?: number;
  blocks?: BlockInterval[];
}

interface SimulateOptions {
  now: number;
  horizonMs: number;
  kind?: WindowKind;
  /** Window size per account; 1 when absent. */
  size?: (authId: string) => number;
  /** Routing priority per account; 0 when absent. */
  priority?: (authId: string) => number;
  sinks?: Sink[];
}

/**
 * Routes hand-made projections (a `blockedUntil` becomes a block from `now`) plus `sinks`,
 * and returns the pool of every projection's account.
 */
export function simulate(list: AccountProjection[], options: SimulateOptions): PoolSimulation {
  const { now, horizonMs, kind = '5h' } = options;
  const size = options.size ?? (() => 1);
  const priority = options.priority ?? (() => 0);
  const routed: RoutedAccount[] = [
    ...list.map((projection) => ({
      authId: projection.authId,
      priority: priority(projection.authId),
      size: size(projection.authId),
      projection,
      blocks:
        projection.blockedUntil !== null && projection.blockedUntil > now
          ? [{ from: now, until: projection.blockedUntil }]
          : [],
    })),
    ...(options.sinks ?? []).map((sink) => ({
      authId: sink.authId,
      priority: sink.priority ?? 0,
      size: 1,
      projection: null,
      blocks: sink.blocks ?? [],
    })),
  ];
  const run = simulateRouting(routed, kind, now, horizonMs);
  return poolOf(
    run,
    list.map((projection) => projection.authId)
  );
}
