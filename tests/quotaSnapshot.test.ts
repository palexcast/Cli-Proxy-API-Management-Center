import { beforeEach, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { I18nextProvider } from 'react-i18next';
import i18n from '@/i18n';
import {
  normalizeQuotaSnapshot,
  type QuotaSnapshot,
  type QuotaSnapshotAccount,
} from '@/services/api/quotaSnapshot';
import { ClaudeQuotaBody } from '@/features/quota/providers/claude/ClaudeQuotaBody';
import {
  SNAPSHOT_STALE_MS,
  buildClaudeSnapshotState,
  describeClaudeObservation,
  mergeClaudeSnapshot,
  selectEntriesOlderThan,
} from '@/features/quota/providers/claude/snapshot';
import { parseQuotaSettings } from '@/features/quota/settings';
import type { QuotaFileEntry } from '@/features/quota/logic';
import { QUOTA_CLASS_KEYS, bindQuotaClasses } from '@/features/quota/types';
import { useQuotaStore } from '@/stores/useQuotaStore';
import type { ClaudeQuotaState } from '@/types';
import usage from './fixtures/claude-oauth-usage.json';

const translations = i18n.cloneInstance({ lng: 'en' });
const t = translations.t.bind(translations) as typeof translations.t;
const classes = bindQuotaClasses(
  Object.fromEntries(QUOTA_CLASS_KEYS.map((key) => [key, key])),
  'quota-snapshot-test'
);

const NOW = Date.parse('2026-10-09T12:00:00Z');
const MINUTE = 60 * 1000;
// Unix seconds, ahead of NOW like the fixture's resets.
const R5 = NOW / 1000 + 3 * 60 * 60;
const R7 = NOW / 1000 + 4 * 24 * 60 * 60;

const claudeEntry = (name: string, extra: Record<string, unknown> = {}): QuotaFileEntry => ({
  type: 'claude',
  file: { name, type: 'claude', provider: 'claude', ...extra },
});

const account = (fields: Partial<QuotaSnapshotAccount> = {}): QuotaSnapshotAccount => ({
  authId: 'claude-a1',
  name: 'claude-a1.json',
  label: 'A1',
  provider: 'claude',
  ...fields,
});

const snapshotOf = (...accounts: QuotaSnapshotAccount[]): QuotaSnapshot => ({
  generatedAt: NOW,
  accounts,
});

const windowById = (state: ClaudeQuotaState | null | undefined, id: string) =>
  state?.windows.find((window) => window.id === id);

const render = (state: ClaudeQuotaState) =>
  renderToStaticMarkup(
    createElement(
      I18nextProvider,
      { i18n: translations },
      createElement(ClaudeQuotaBody, { quota: state, classes })
    )
  );

const clockTime = (ms: number) =>
  new Date(ms).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', hour12: false });

describe('quota snapshot API normalization', () => {
  test('converts units and keeps the raw usage object', () => {
    const snapshot = normalizeQuotaSnapshot({
      generated_at: '2026-10-09T12:00:00Z',
      accounts: [
        {
          auth_id: 'claude-a1',
          name: 'claude-a1.json',
          label: 'A1',
          provider: 'Claude',
          observed_at: '2026-10-09T11:58:03Z',
          u5: 0.42,
          r5: R5,
          s5: 'Allowed',
          u7: 0.11,
          r7: R7,
          s7: 'allowed_warning',
          refreshed_at: '2026-10-09T09:15:00Z',
          usage,
        },
      ],
    });
    expect(snapshot.generatedAt).toBe(NOW);
    expect(snapshot.accounts).toEqual([
      {
        authId: 'claude-a1',
        name: 'claude-a1.json',
        label: 'A1',
        provider: 'claude',
        observedAt: Date.parse('2026-10-09T11:58:03Z'),
        u5: 0.42,
        r5: R5 * 1000,
        s5: 'allowed',
        u7: 0.11,
        r7: R7 * 1000,
        s7: 'allowed_warning',
        refreshedAt: Date.parse('2026-10-09T09:15:00Z'),
        usage,
      },
    ]);
  });

  test('drops malformed accounts, fields and usage', () => {
    const snapshot = normalizeQuotaSnapshot({
      accounts: [
        null,
        { name: 'no-id.json' },
        { auth_id: 'empty', name: 'empty.json', label: '', provider: 'claude' },
        {
          auth_id: 'bad',
          provider: 'claude',
          observed_at: 'not a time',
          u5: 1.5,
          r5: -1,
          u7: '0.2',
          refreshed_at: '2026-10-09T09:15:00Z',
          usage: [usage],
        },
        { auth_id: 'no-receipt', provider: 'claude', usage },
      ],
    });
    expect(snapshot.accounts).toEqual([
      { authId: 'empty', name: 'empty.json', label: '', provider: 'claude' },
      { authId: 'bad', name: '', label: '', provider: 'claude' },
      { authId: 'no-receipt', name: '', label: '', provider: 'claude' },
    ]);
    expect(normalizeQuotaSnapshot('nope').accounts).toEqual([]);
  });
});

describe('Claude snapshot state', () => {
  test('usage only: windows come from the stored usage response', () => {
    const refreshedAt = NOW - 10 * MINUTE;
    const state = buildClaudeSnapshotState(account({ refreshedAt, usage }), t, NOW);
    expect(state?.status).toBe('success');
    expect(state?.snapshotSource).toBe('usage');
    expect(state?.observedAt).toBe(new Date(refreshedAt).toISOString());
    expect(state?.stale).toBe(false);
    expect(state?.windows.map((window) => window.id)).toEqual([
      'five-hour',
      'seven-day',
      'seven-day-sonnet',
    ]);
    expect(windowById(state, 'five-hour')?.usedPercent).toBe(42.5);
    expect(state?.extraUsage?.monthlyLimit).toBe(5000);
    expect(state?.dollarWindows?.map((balance) => balance.key)).toEqual([
      'iguana_necktie',
      'additional_credit_balance',
    ]);
  });

  test('headers newer than usage replace the 5h and 7d windows only', () => {
    const state = buildClaudeSnapshotState(
      account({
        observedAt: NOW - 2 * MINUTE,
        u5: 0.42,
        r5: R5 * 1000,
        u7: 0.11,
        r7: R7 * 1000,
        refreshedAt: NOW - 3 * 60 * MINUTE,
        usage,
      }),
      t,
      NOW
    );
    expect(state?.snapshotSource).toBe('headers');
    expect(state?.observedAt).toBe(new Date(NOW - 2 * MINUTE).toISOString());
    expect(windowById(state, 'five-hour')).toMatchObject({
      usedPercent: 42,
      resetAtMs: R5 * 1000,
      periodHours: 5,
    });
    expect(windowById(state, 'seven-day')).toMatchObject({ usedPercent: 11, resetAtMs: R7 * 1000 });
    expect(windowById(state, 'seven-day-sonnet')?.usedPercent).toBe(10);
    expect(state?.extraUsage).not.toBeNull();
  });

  test('headers older than usage leave the usage windows alone', () => {
    const state = buildClaudeSnapshotState(
      account({ observedAt: NOW - 60 * MINUTE, u5: 0.9, refreshedAt: NOW - MINUTE, usage }),
      t,
      NOW
    );
    expect(state?.snapshotSource).toBe('usage');
    expect(windowById(state, 'five-hour')?.usedPercent).toBe(42.5);
  });

  test('headers alone build the 5h and 7d windows in order', () => {
    const state = buildClaudeSnapshotState(
      account({ observedAt: NOW - MINUTE, u7: 0.5, r7: R7 * 1000, u5: 0.25, r5: R5 * 1000 }),
      t,
      NOW
    );
    expect(state?.windows.map((window) => [window.id, window.usedPercent])).toEqual([
      ['five-hour', 25],
      ['seven-day', 50],
    ]);
    const fiveOnly = buildClaudeSnapshotState(
      account({ observedAt: NOW - MINUTE, u5: 0.25 }),
      t,
      NOW
    );
    expect(fiveOnly?.windows.map((window) => window.id)).toEqual(['five-hour']);
  });

  test('a window whose reset has passed shows as refilled', () => {
    const state = buildClaudeSnapshotState(
      account({
        observedAt: Date.parse('2026-10-26T22:30:00Z'),
        u5: 0.88,
        r5: Date.parse('2026-10-27T01:00:00Z'),
        u7: 0.4,
        r7: Date.parse('2026-10-30T00:00:00Z'),
      }),
      t,
      Date.parse('2026-10-27T09:00:00Z')
    );
    expect(windowById(state, 'five-hour')).toMatchObject({
      usedPercent: 0,
      resetAtMs: null,
      resetLabel: '-',
    });
    expect(windowById(state, 'seven-day')).toMatchObject({
      usedPercent: 40,
      resetAtMs: Date.parse('2026-10-30T00:00:00Z'),
    });
    expect(windowById(state, 'seven-day')?.resetLabel).not.toBe('-');
    expect(state?.observedAt).toBe('2026-10-26T22:30:00.000Z');
    expect(state?.stale).toBe(true);

    // Usage-derived windows too: the fixture's 5h window resets at 18:00, the weekly on the 15th.
    const fromUsage = buildClaudeSnapshotState(
      account({ refreshedAt: NOW - 10 * MINUTE, usage }),
      t,
      Date.parse('2026-10-09T19:00:00Z')
    );
    expect(windowById(fromUsage, 'five-hour')).toMatchObject({ usedPercent: 0, resetAtMs: null });
    expect(windowById(fromUsage, 'seven-day')?.resetAtMs).toBe(Date.parse('2026-10-15T09:00:00Z'));
  });

  test('an account without a 5h window gets no 5h row from an old reading', () => {
    // A verified Ultra account: the usage response has five_hour null, and the last 5h
    // reading (Oct 31) reset long before the newer weekly-only headers.
    const ultraUsage = {
      five_hour: null,
      seven_day: { utilization: 28, resets_at: '2026-11-07T13:59:59+00:00' },
    };
    const reading = {
      u5: 1,
      r5: Date.parse('2026-10-31T21:50:00Z'),
      u7: 0.29,
      r7: Date.parse('2026-11-07T14:00:00Z'),
    };
    const now = Date.parse('2026-11-02T12:00:00Z');
    const state = buildClaudeSnapshotState(
      account({
        observedAt: Date.parse('2026-11-02T11:56:00Z'),
        refreshedAt: Date.parse('2026-11-02T11:04:56Z'),
        usage: ultraUsage,
        ...reading,
      }),
      t,
      now
    );
    expect(windowById(state, 'five-hour')).toBeUndefined();
    expect(windowById(state, 'seven-day')).toMatchObject({ usedPercent: 29 });

    // Without a usage response saying so, an ended reading still shows as refilled.
    const headersOnly = buildClaudeSnapshotState(
      account({ observedAt: Date.parse('2026-11-02T11:56:00Z'), ...reading }),
      t,
      now
    );
    expect(windowById(headersOnly, 'five-hour')).toMatchObject({ usedPercent: 0, resetAtMs: null });
  });

  test('nothing known builds nothing', () => {
    expect(buildClaudeSnapshotState(account(), t, NOW)).toBeNull();
    expect(buildClaudeSnapshotState(account({ observedAt: NOW, s5: 'allowed' }), t, NOW)).toBe(
      null
    );
  });

  test('stale when the newest reading is older than 30 minutes', () => {
    const fresh = buildClaudeSnapshotState(
      account({ observedAt: NOW - SNAPSHOT_STALE_MS, u5: 0.1 }),
      t,
      NOW
    );
    const stale = buildClaudeSnapshotState(
      account({ observedAt: NOW - SNAPSHOT_STALE_MS - MINUTE, u5: 0.1 }),
      t,
      NOW
    );
    expect(fresh?.stale).toBe(false);
    expect(stale?.stale).toBe(true);
  });
});

describe('Claude snapshot pre-fill merge', () => {
  const headers = account({ observedAt: NOW - 5 * MINUTE, u5: 0.3, r5: R5 * 1000 });

  test('fills idle and missing Claude entries', () => {
    const prev: Record<string, ClaudeQuotaState> = {};
    const next = mergeClaudeSnapshot(
      prev,
      [claudeEntry('claude-a1.json')],
      snapshotOf(headers),
      t,
      NOW
    );
    expect(next).not.toBe(prev);
    expect(next['claude-a1.json']?.snapshotSource).toBe('headers');

    const idle = { 'claude-a1.json': { status: 'idle', windows: [] } as ClaudeQuotaState };
    expect(
      mergeClaudeSnapshot(idle, [claudeEntry('claude-a1.json')], snapshotOf(headers), t, NOW)[
        'claude-a1.json'
      ].status
    ).toBe('success');
  });

  test('matches by auth id when the file name differs', () => {
    const next = mergeClaudeSnapshot(
      {},
      [claudeEntry('renamed.json', { id: 'claude-a1' })],
      snapshotOf(headers),
      t,
      NOW
    );
    expect(next['renamed.json']?.windows[0]?.usedPercent).toBe(30);
  });

  test('an account with nothing known leaves the card alone', () => {
    const prev: Record<string, ClaudeQuotaState> = {};
    expect(
      mergeClaudeSnapshot(prev, [claudeEntry('claude-a1.json')], snapshotOf(account()), t, NOW)
    ).toBe(prev);
  });

  test('non-Claude entries are never touched', () => {
    useQuotaStore.getState().clearQuotaCache();
    const codexBefore = useQuotaStore.getState().codexQuota;
    const codexEntry: QuotaFileEntry = {
      type: 'codex',
      file: { name: 'claude-a1.json', type: 'codex' },
    };
    useQuotaStore
      .getState()
      .setClaudeQuota((prev) =>
        mergeClaudeSnapshot(prev, [codexEntry], snapshotOf(headers), t, NOW)
      );
    expect(useQuotaStore.getState().claudeQuota).toEqual({});
    expect(useQuotaStore.getState().codexQuota).toBe(codexBefore);
  });

  test('a session read is kept even when the snapshot is newer', () => {
    const session = (minutesAgo: number): Record<string, ClaudeQuotaState> => ({
      'claude-a1.json': {
        status: 'success',
        windows: [],
        planType: 'plan_max',
        observedAt: new Date(NOW - minutesAgo * MINUTE).toISOString(),
        stale: false,
      },
    });
    const newer = session(1);
    expect(
      mergeClaudeSnapshot(newer, [claudeEntry('claude-a1.json')], snapshotOf(headers), t, NOW)
    ).toBe(newer);
    // Refresh all, then a proxied request lands before the snapshot is read again.
    const older = session(20);
    expect(
      mergeClaudeSnapshot(older, [claudeEntry('claude-a1.json')], snapshotOf(headers), t, NOW)
    ).toBe(older);
  });

  test('a pre-fill older than the snapshot is replaced; a newer one is kept', () => {
    const prefill = (minutesAgo: number): Record<string, ClaudeQuotaState> => ({
      'claude-a1.json': {
        status: 'success',
        windows: [],
        planType: 'plan_max',
        observedAt: new Date(NOW - minutesAgo * MINUTE).toISOString(),
        stale: false,
        snapshotSource: 'usage',
      },
    });
    const replaced = mergeClaudeSnapshot(
      prefill(20),
      [claudeEntry('claude-a1.json')],
      snapshotOf(headers),
      t,
      NOW
    )['claude-a1.json'];
    expect(replaced.snapshotSource).toBe('headers');
    expect(replaced.planType).toBe('plan_max');

    const newer = prefill(1);
    expect(
      mergeClaudeSnapshot(newer, [claudeEntry('claude-a1.json')], snapshotOf(headers), t, NOW)
    ).toBe(newer);
  });

  test('loading and error states are left to their fetch', () => {
    const prev: Record<string, ClaudeQuotaState> = {
      'claude-a1.json': { status: 'loading', windows: [] },
      'claude-b2.json': { status: 'error', windows: [], error: 'boom' },
    };
    const snapshot = snapshotOf(headers, { ...headers, authId: 'b2', name: 'claude-b2.json' });
    expect(
      mergeClaudeSnapshot(
        prev,
        [claudeEntry('claude-a1.json'), claudeEntry('claude-b2.json')],
        snapshot,
        t,
        NOW
      )
    ).toBe(prev);
  });
});

describe('snapshot store integration', () => {
  beforeEach(() => useQuotaStore.getState().clearQuotaCache());

  test('a manual refresh keeps the pre-fill source while loading', () => {
    const state = buildClaudeSnapshotState(
      account({ observedAt: NOW - 45 * MINUTE, u5: 0.3 }),
      t,
      NOW
    )!;
    const { setClaudeQuota } = useQuotaStore.getState();
    setClaudeQuota({ 'claude-a1.json': state });
    setClaudeQuota((prev) => ({ ...prev, 'claude-a1.json': { status: 'loading', windows: [] } }));
    const loading = useQuotaStore.getState().claudeQuota['claude-a1.json'];
    expect(loading).toMatchObject({ status: 'loading', snapshotSource: 'headers', stale: true });
    expect(loading.windows).toEqual(state.windows);
  });
});

describe('auto-refresh selection', () => {
  test('picks Claude entries with no reading or one older than the threshold', () => {
    const entries = [
      claudeEntry('fresh.json'),
      claudeEntry('old.json'),
      claudeEntry('none.json'),
      claudeEntry('busy.json'),
      claudeEntry('off.json', { disabled: true }),
      { type: 'codex', file: { name: 'codex.json', type: 'codex' } } as QuotaFileEntry,
    ];
    const at = (minutesAgo: number) => new Date(NOW - minutesAgo * MINUTE).toISOString();
    const quota: Record<string, ClaudeQuotaState> = {
      'fresh.json': { status: 'success', windows: [], observedAt: at(5) },
      'old.json': { status: 'success', windows: [], observedAt: at(40) },
      'busy.json': { status: 'loading', windows: [] },
    };
    expect(
      selectEntriesOlderThan(entries, quota, 30 * MINUTE, NOW).map((entry) => entry.file.name)
    ).toEqual(['old.json', 'none.json']);
  });

  test('settings default to off and reject unknown values', () => {
    expect(parseQuotaSettings(null).autoRefreshMinutes).toBe(0);
    expect(parseQuotaSettings('{"autoRefreshMinutes":30}').autoRefreshMinutes).toBe(30);
    expect(parseQuotaSettings('{"autoRefreshMinutes":7}').autoRefreshMinutes).toBe(0);
    expect(parseQuotaSettings('not json').autoRefreshMinutes).toBe(0);
  });
});

describe('Claude card "as of" badge', () => {
  const now = Date.now();

  test('names the source and the clock time', () => {
    const observed = now - 2 * MINUTE;
    const base: ClaudeQuotaState = {
      status: 'success',
      windows: [],
      observedAt: new Date(observed).toISOString(),
    };
    expect(describeClaudeObservation({ ...base, snapshotSource: 'headers' }, now, t)?.text).toBe(
      `as of ${clockTime(observed)}, headers`
    );
    expect(describeClaudeObservation({ ...base, snapshotSource: 'usage' }, now, t)?.text).toBe(
      `refreshed ${clockTime(observed)}`
    );
    expect(describeClaudeObservation(base, now, t)?.text).toBe(`refreshed ${clockTime(observed)}`);
    expect(describeClaudeObservation({ status: 'success', windows: [] }, now, t)).toBeNull();
  });

  test('a stale pre-fill is tinted, not reported as a failed refresh', () => {
    const state = buildClaudeSnapshotState(
      account({ observedAt: now - 2 * 60 * MINUTE, u5: 0.3 }),
      t,
      now
    )!;
    const markup = render(state);
    expect(markup).toContain('class="quotaResetRelativeSoon"');
    expect(markup).toContain(', headers');
    expect(markup).not.toContain('Refresh failed');

    const fresh = render({ ...state, stale: false });
    expect(fresh).toContain('class="quotaReset"');
    expect(fresh).not.toContain('quotaResetRelativeSoon');
  });

  test('a failed session refresh keeps its own notice and no badge', () => {
    const markup = render({
      status: 'error',
      windows: [],
      observedAt: new Date(now - MINUTE).toISOString(),
      stale: true,
    });
    expect(markup).toContain('Refresh failed');
    expect(markup).not.toContain('refreshed ');
  });
});

describe('snapshot pre-fill contracts', () => {
  test('a pre-filled card does not start a reset-grant read against the usage endpoint', () => {
    const card = readFileSync('src/features/quota/components/QuotaCard.tsx', 'utf8');
    expect(card).toContain("entry.type === 'claude' && status !== 'idle' && !claudeSnapshot,");
    expect(card).toContain("status === 'success' && !claudeSnapshot");
  });

  test('Refresh all re-reads the snapshot after the batch completes', () => {
    const page = readFileSync('src/features/quota/QuotaPage.tsx', 'utf8');
    expect(page).toContain('void loadQuota(pageItems).then(reloadSnapshot);');
  });
});
