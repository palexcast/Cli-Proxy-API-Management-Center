/**
 * The pooled 5h simulations the page draws from, and the right-now table rows. Pure;
 * the page owns the scope toggles.
 *
 * The table and the runway tile read the plan pools (Team accounts with each other,
 * Max accounts with each other), so a row's "Empty in" never changes with the chart's
 * scope. Only the 5h chart, and its runway marker, follow the scope. Every pool weighs
 * its accounts by their tier's 5h capacity. An account with no reading yet, or one the
 * proxy no longer routes to (disabled or removed), is in no pool and reads as a dash.
 */

import type { NowRow } from './components/NowTable';
import {
  HOUR_MS,
  capacity5h,
  isActive,
  lastLeftover,
  type AccountInfo,
  type QuotaWindow,
} from './model';
import {
  poolValueBefore,
  simulatePool,
  type AccountProjection,
  type PoolSimulation,
} from './projection';

export type TeamScope = 'team' | 'all';

export interface Pools {
  /** Team accounts only: the runway tile and the Team rows. */
  team: PoolSimulation;
  /** Max accounts only: the Max rows. */
  max: PoolSimulation;
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
  const accounts = all.filter(isActive);
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
  const max = simulate(accounts.filter((account) => account.plan === 'max'));
  return { team, max, chart: scope === 'all' ? simulate(accounts) : team };
}

export interface NowRowInput {
  accounts: AccountInfo[];
  projections5: Map<string, AccountProjection>;
  projections7: Map<string, AccountProjection>;
  windows5: Map<string, QuotaWindow[]>;
  windows7: Map<string, QuotaWindow[]>;
  pools: Pick<Pools, 'team' | 'max'>;
  now: number;
}

/**
 * One row per account; "Empty in" and the 5h leftover come from the account's plan pool.
 * An account out of the pool keeps only its last leftover: its live figures would carry
 * a stale reading forward as if it still served requests.
 */
export function buildNowRows({
  accounts,
  projections5,
  projections7,
  windows5,
  windows7,
  pools,
  now,
}: NowRowInput): NowRow[] {
  return accounts.map((account) => {
    const p5 = projections5.get(account.authId);
    const p7 = projections7.get(account.authId);
    const isTeam = account.plan === 'team';
    const planWindows = (isTeam ? windows5 : windows7).get(account.authId) ?? [];
    if (!isActive(account)) {
      return {
        account,
        used5: null,
        reset5: null,
        emptyIn5: null,
        blocked5: false,
        used7: null,
        reset7: null,
        lastLeftover: lastLeftover(planWindows, now),
        nextLeftover: null,
      };
    }
    const pool = isTeam ? pools.team : pools.max;
    const pooled = pool.values.has(account.authId);
    const emptyAt = pooled ? (pool.accountEmptyAt.get(account.authId) ?? null) : null;
    const blockedUntil = p5?.blockedUntil ?? null;
    // The 5h leftover is what the pooled tail holds just before the reset. A weekly
    // block that outlasts the reset leaves the window untouched: the tail reads 0
    // while blocked, but nothing was spent.
    const pooledLeftover =
      !pooled || p5?.reset == null
        ? null
        : blockedUntil !== null && blockedUntil >= p5.reset
          ? p5.left
          : poolValueBefore(pool, account.authId, p5.reset);
    const usedOf = (projection: AccountProjection | undefined) =>
      projection?.left == null ? null : 1 - projection.left;
    return {
      account,
      used5: usedOf(p5),
      reset5: p5?.reset ?? null,
      emptyIn5: emptyAt === null ? null : (emptyAt - now) / HOUR_MS,
      blocked5: blockedUntil !== null,
      used7: usedOf(p7),
      reset7: p7?.reset ?? null,
      lastLeftover: lastLeftover(planWindows, now),
      nextLeftover: isTeam ? pooledLeftover : (p7?.projectedLeftover ?? null),
    };
  });
}
