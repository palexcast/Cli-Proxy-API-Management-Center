import { isTier, type Tier, type TierOverrides } from './model';

/** Per-browser preferences (localStorage): tier overrides. */
const PLAN_OVERRIDES_KEY = 'usageHistory.planOverrides';

/** Overrides saved before tiers existed name only the plan: its default tier. */
const LEGACY_PLAN_TIER = new Map<unknown, Tier>([
  ['team', 'team_premium'],
  ['max', 'max_20x'],
]);

const readJson = (key: string): unknown => {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as unknown) : null;
  } catch {
    return null;
  }
};

const writeJson = (key: string, value: unknown) => {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Storage full or blocked: the preference just does not persist.
  }
};

/** Tier overrides from stored JSON; anything unrecognized is dropped. */
export function parseTierOverrides(stored: unknown): TierOverrides {
  if (!stored || typeof stored !== 'object' || Array.isArray(stored)) return {};
  const overrides: TierOverrides = {};
  Object.entries(stored).forEach(([authId, value]) => {
    const tier = isTier(value) ? value : LEGACY_PLAN_TIER.get(value);
    if (authId && tier) overrides[authId] = tier;
  });
  return overrides;
}

export const readTierOverrides = (): TierOverrides =>
  parseTierOverrides(readJson(PLAN_OVERRIDES_KEY));

export const writeTierOverrides = (overrides: TierOverrides) =>
  writeJson(PLAN_OVERRIDES_KEY, overrides);
