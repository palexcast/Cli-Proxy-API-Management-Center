/**
 * The simulated pools the page draws from. Pure; the page owns the scope toggle.
 *
 * Both windows are simulated over every active account, the way the proxy routes
 * (`simulateRouting`): when one account cannot take requests its load moves to the others,
 * whatever their limiting window. The weekly run goes first; the spans in which an account's
 * weekly window is projected empty block it in the 5h run, like the weekly block it is in
 * now. Each pool is then a set of accounts within its run:
 *
 * - `team`: the Team accounts' 5h windows, read by the 5h runway tile whatever the scope;
 * - `chart`: what the 5h chart draws, the Team pool or every account with a 5h window;
 * - `weekly`: every account whose responses carry weekly headers.
 *
 * Every pool weighs its accounts by their tier's capacity. An account with no reading yet,
 * one the proxy no longer routes to (disabled or removed), and on the 5h run one without
 * a 5h limit (a verified Ultra account) is in no pool; an active account without the
 * window still takes failover in that run.
 */

import { capacity5h, capacity7d, isActive, type AccountInfo } from './model';
import {
  emptySpans,
  poolOf,
  simulateRouting,
  type AccountProjection,
  type BlockInterval,
  type PoolSimulation,
  type RoutedAccount,
} from './projection';

export type TeamScope = 'team' | 'all';

export interface Pools {
  /** Team accounts' 5h windows: the 5h runway tile. */
  team: PoolSimulation;
  /** What the 5h chart draws: the Team pool, or every account with a 5h window. */
  chart: PoolSimulation;
  /** Every account with weekly readings: the weekly runway tile and the weekly chart. */
  weekly: PoolSimulation;
}

export interface PoolInput {
  accounts: AccountInfo[];
  projections5: Map<string, AccountProjection>;
  projections7: Map<string, AccountProjection>;
  scope: TeamScope;
  now: number;
  horizon5Ms: number;
  horizon7Ms: number;
}

/** The weekly block an account is in now, read from its 5h projection. */
const blockNow = (projection: AccountProjection | undefined, now: number): BlockInterval[] =>
  projection?.blockedUntil != null && projection.blockedUntil > now
    ? [{ from: now, until: projection.blockedUntil }]
    : [];

export function buildPools({
  accounts: all,
  projections5,
  projections7,
  scope,
  now,
  horizon5Ms,
  horizon7Ms,
}: PoolInput): Pools {
  const active = all.filter(isActive);

  // Weekly: accounts with weekly readings drain; the rest of the seen accounts take failover.
  const routed7: RoutedAccount[] = active.flatMap((account) => {
    const weekly = projections7.get(account.authId);
    const seen5 = projections5.get(account.authId)?.left != null;
    if (weekly?.left == null && !seen5) return [];
    return [
      {
        authId: account.authId,
        priority: account.priority,
        size: capacity7d(account),
        projection: weekly?.left == null ? null : weekly,
        blocks: blockNow(projections5.get(account.authId), now),
      },
    ];
  });
  const run7 = simulateRouting(routed7, '7d', now, horizon7Ms);
  const weeklyIds = routed7.flatMap((entry) => (entry.projection ? [entry.authId] : []));

  // 5h: accounts with a 5h limit drain; an active one without (verified Ultra) takes
  // failover until its weekly window runs dry.
  const routed5: RoutedAccount[] = active.flatMap((account) => {
    const projection = projections5.get(account.authId);
    if (!projection) return [];
    return [
      {
        authId: account.authId,
        priority: account.priority,
        size: capacity5h(account),
        projection: account.fiveHourLimit ? projection : null,
        blocks: [...blockNow(projection, now), ...emptySpans(run7, account.authId)],
      },
    ];
  });
  const run5 = simulateRouting(routed5, '5h', now, horizon5Ms);
  const ids5 = (keep: (account: AccountInfo) => boolean) =>
    active.filter((account) => account.fiveHourLimit && keep(account)).map(({ authId }) => authId);
  const team = poolOf(
    run5,
    ids5((account) => account.plan === 'team')
  );
  const chart =
    scope === 'all'
      ? poolOf(
          run5,
          ids5(() => true)
        )
      : team;
  return { team, chart, weekly: poolOf(run7, weeklyIds) };
}
