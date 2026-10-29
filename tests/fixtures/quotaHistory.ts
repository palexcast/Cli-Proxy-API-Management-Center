/**
 * Synthetic `/observability/quota-history` payload: six Claude accounts over two
 * weeks, raw backend shape (snake_case, RFC3339, Unix-second resets).
 *
 * Schedule (all UTC), chosen so the expected figures can be worked out by hand:
 * - Team accounts "Alex NT team", "James team", "Kay team": two 5h windows a day,
 *   09:00-14:00 and 15:00-20:00. Final utilization per window comes from `finals5`
 *   (morning, afternoon). "Alex NT team" fills its morning window (rejected).
 * - "Pete team" is loaded but idle: no samples at all.
 * - Max accounts "Alex Max", "Alex Gmail": one 5h window a day, 10:00-15:00.
 * - On the last day the morning window is still open at NOW (12:00) and drains
 *   linearly at `openRate5` per hour, so the burn rate is exact.
 * - Weekly utilization rises linearly over the first six days of each 7d window
 *   and holds at `weekly[reset]` for the last day, so every 7d window's final
 *   utilization equals that table entry.
 * Samples are every 10 minutes inside an open 5h window. Recording starts at SINCE
 * (mid-window on the first day), like a freshly deployed recorder.
 */

export const NOW = Date.parse('2026-10-27T12:00:00Z');
export const SINCE = NOW - 14 * 24 * 60 * 60 * 1000;

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

interface FixtureAccount {
  authId: string;
  name: string;
  label: string;
  windowStarts: number[];
  finals5: number[];
  openRate5: number;
  weeklyAnchor: string;
  weekly: Record<string, number>;
}

export const FIXTURE_ACCOUNTS: FixtureAccount[] = [
  {
    authId: 'claude-a1',
    name: 'claude-a1-alex-nt@example.com.json',
    label: 'Alex NT team',
    windowStarts: [9, 15],
    finals5: [1, 0.6],
    openRate5: 0.15,
    weeklyAnchor: '2026-10-18T00:00:00Z',
    weekly: {
      '2026-10-18T00:00:00Z': 0.55,
      '2026-10-25T00:00:00Z': 0.5,
      '2026-11-01T00:00:00Z': 0.4,
    },
  },
  {
    authId: 'claude-b2',
    name: 'claude-b2-james@example.com.json',
    label: 'James team',
    windowStarts: [9, 15],
    finals5: [0.8, 0.4],
    openRate5: 0.25,
    weeklyAnchor: '2026-10-15T12:00:00Z',
    weekly: {
      '2026-10-15T12:00:00Z': 0.38,
      '2026-10-22T12:00:00Z': 0.45,
      '2026-10-29T12:00:00Z': 0.3,
    },
  },
  {
    authId: 'claude-c3',
    name: 'claude-c3-kay@example.com.json',
    label: 'Kay team',
    windowStarts: [9, 15],
    finals5: [0.5, 0.5],
    openRate5: 0.1,
    weeklyAnchor: '2026-10-17T08:00:00Z',
    weekly: {
      '2026-10-17T08:00:00Z': 0.47,
      '2026-10-24T08:00:00Z': 0.52,
      '2026-10-31T08:00:00Z': 0.2,
    },
  },
  {
    authId: 'claude-d4',
    name: 'claude-d4-pete@example.com.json',
    label: 'Pete team',
    windowStarts: [],
    finals5: [],
    openRate5: 0,
    weeklyAnchor: '2026-10-19T00:00:00Z',
    weekly: {},
  },
  {
    authId: 'claude-e5',
    name: 'claude-e5-alex-max@example.com.json',
    label: 'Alex Max',
    windowStarts: [10],
    finals5: [0.3],
    openRate5: 0.05,
    weeklyAnchor: '2026-10-20T18:00:00Z',
    weekly: {
      '2026-10-13T18:00:00Z': 0.92,
      '2026-10-20T18:00:00Z': 0.85,
      '2026-10-27T18:00:00Z': 0.6,
    },
  },
  {
    authId: 'claude-f6',
    name: 'claude-f6-alex-gmail@example.com.json',
    label: 'Alex Gmail',
    windowStarts: [10],
    finals5: [0.2],
    openRate5: 0.05,
    weeklyAnchor: '2026-10-16T06:00:00Z',
    weekly: {
      '2026-10-16T06:00:00Z': 0.7,
      '2026-10-23T06:00:00Z': 0.5,
      '2026-10-30T06:00:00Z': 0.35,
    },
  },
];

interface RawSample {
  t: string;
  auth_id: string;
  u5: number;
  r5: number;
  u7: number;
  r7: number;
  s5: string;
  s7: string;
}

const iso = (ms: number) => new Date(ms).toISOString().replace('.000Z', 'Z');
const round = (value: number) => Math.round(value * 10000) / 10000;

function weeklyReading(account: FixtureAccount, t: number) {
  const anchor = Date.parse(account.weeklyAnchor);
  const reset = anchor + Math.ceil((t - anchor + 1) / (7 * DAY)) * 7 * DAY;
  const final = account.weekly[iso(reset)] ?? 0;
  const elapsed = t - (reset - 7 * DAY);
  return { u7: round(final * Math.min(1, elapsed / (6 * DAY))), r7: reset };
}

function buildSamples(): RawSample[] {
  const samples: RawSample[] = [];
  const firstDay = Date.parse('2026-10-13T00:00:00Z');
  FIXTURE_ACCOUNTS.forEach((account) => {
    for (let day = firstDay; day <= NOW; day += DAY) {
      account.windowStarts.forEach((startHour, slot) => {
        const start = day + startHour * HOUR;
        const reset = start + 5 * HOUR;
        const open = reset > NOW;
        for (let k = 1; k <= 29; k += 1) {
          const t = start + k * 10 * MINUTE;
          if (t < SINCE || t > NOW) continue;
          const u5 = open
            ? round((account.openRate5 * (k * 10 * MINUTE)) / HOUR)
            : round((account.finals5[slot] * k) / 29);
          const { u7, r7 } = weeklyReading(account, t);
          samples.push({
            t: iso(t),
            auth_id: account.authId,
            u5,
            r5: reset / 1000,
            u7,
            r7: r7 / 1000,
            s5: u5 >= 1 ? 'rejected' : u5 >= 0.9 ? 'allowed_warning' : 'allowed',
            s7: 'allowed',
          });
        }
      });
    }
  });
  return samples.sort((a, b) =>
    a.t === b.t ? a.auth_id.localeCompare(b.auth_id) : a.t.localeCompare(b.t)
  );
}

export const quotaHistoryResponse = {
  since: iso(SINCE),
  until: iso(NOW),
  accounts: FIXTURE_ACCOUNTS.map((account) => ({
    auth_id: account.authId,
    name: account.name,
    label: account.label,
    provider: 'claude',
    disabled: false,
  })),
  samples: buildSamples(),
  truncated: false,
};
