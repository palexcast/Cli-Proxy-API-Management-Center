/**
 * The pooled 5h simulations the page draws from. Pure; the page owns the scope toggle.
 *
 * The runway tile reads the Team pool, so it never changes with the chart's scope. Only
 * the 5h chart, and its runway marker, follow the scope. Every pool weighs its accounts
 * by their tier's 5h capacity. An account with no reading yet, one the proxy no longer
 * routes to (disabled or removed), or one without a 5h limit (a verified Ultra account)
 * is in no 5h pool.
 */

import { capacity5h, inPool, type AccountInfo } from './model';
import { simulatePool, type AccountProjection, type PoolSimulation } from './projection';

export type TeamScope = 'team' | 'all';

export interface Pools {
  /** Team accounts only: the runway tile. */
  team: PoolSimulation;
  /** What the 5h chart draws: the Team pool, or every account pooled together. */
  chart: PoolSimulation;
}

export function buildPools(
  all: AccountInfo[],
  projections5: Map<string, AccountProjection>,
  scope: TeamScope,
  now: number,
  horizonMs: number
): Pools {
  const accounts = all.filter((account) => inPool(account, '5h'));
  const size = new Map(accounts.map((account) => [account.authId, capacity5h(account)]));
  const simulate = (list: AccountInfo[]) =>
    simulatePool(
      list
        .map(({ authId }) => projections5.get(authId))
        .filter((projection): projection is AccountProjection => projection !== undefined),
      now,
      horizonMs,
      (authId) => size.get(authId) ?? 1
    );
  const team = simulate(accounts.filter((account) => account.plan === 'team'));
  return { team, chart: scope === 'all' ? simulate(accounts) : team };
}
