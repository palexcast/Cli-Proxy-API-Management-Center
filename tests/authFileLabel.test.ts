import { describe, expect, test } from 'bun:test';
import { deriveAuthFileIdentity } from '../src/features/authFiles/identity';
import { normalizeAuthFilesResponse } from '../src/services/api/authFiles';
import type { AuthFileItem } from '../src/types';
import { readExplicitLabel } from '../src/utils/authFileLabel';
import { getQuotaDisplayName } from '../src/utils/quota/identity';

const claudeFile = (overrides: Partial<AuthFileItem> = {}): AuthFileItem => ({
  name: 'claude-77b04383-user@example.com.json',
  type: 'claude',
  email: 'user@example.com',
  ...overrides,
});

describe('readExplicitLabel', () => {
  test('returns the trimmed label when it differs from the email', () => {
    expect(readExplicitLabel(claudeFile({ label: '  Team account  ' }))).toBe('Team account');
  });

  test('treats the backend email fallback as no label', () => {
    expect(readExplicitLabel(claudeFile({ label: 'user@example.com' }))).toBe('');
    expect(readExplicitLabel(claudeFile({ label: 'USER@example.com' }))).toBe('');
  });

  test('ignores empty and non-string labels', () => {
    expect(readExplicitLabel(claudeFile({ label: '   ' }))).toBe('');
    expect(readExplicitLabel(claudeFile({ label: 42 as unknown as string }))).toBe('');
  });
});

describe('deriveAuthFileIdentity with labels', () => {
  test('leads with the label and keeps the email as the secondary row', () => {
    const identity = deriveAuthFileIdentity(claudeFile({ label: 'Team account' }));
    expect(identity.kind).toBe('label');
    expect(identity.primary).toBe('Team account');
    expect(identity.secondary).toBe('user@example.com');
    expect(identity.fullName).toBe('claude-77b04383-user@example.com.json');
  });

  test('falls back to the file name as the secondary row when there is no email', () => {
    const identity = deriveAuthFileIdentity(claudeFile({ label: 'Team account', email: undefined }));
    expect(identity.kind).toBe('label');
    expect(identity.secondary).toBe('claude-77b04383-user@example.com');
  });

  test('keeps the email-first behaviour when the label is only the email fallback', () => {
    const identity = deriveAuthFileIdentity(claudeFile({ label: 'user@example.com' }));
    expect(identity.kind).toBe('email');
    expect(identity.primary).toBe('user@example.com');
    expect(identity.secondary).toBe('claude-77b04383-user@example.com');
  });
});

describe('getQuotaDisplayName with labels', () => {
  test('shows the label instead of the file name on quota cards', () => {
    expect(getQuotaDisplayName(claudeFile({ label: 'Team account' }))).toBe('Team account');
  });

  test('keeps the file name when the label is only the email fallback', () => {
    expect(getQuotaDisplayName(claudeFile({ label: 'user@example.com' }))).toBe(
      'claude-77b04383-user@example.com.json'
    );
  });

  test('still disambiguates multi-identity files after the label', () => {
    const devin: AuthFileItem = {
      name: 'shared.json',
      type: 'devin',
      label: 'Shared Devin',
      authIndex: '42',
    };
    expect(getQuotaDisplayName(devin)).toBe('Shared Devin · 42');
  });
});

describe('normalizeAuthFilesResponse label handling', () => {
  test('trims the label and drops blank ones', () => {
    const response = normalizeAuthFilesResponse({
      files: [
        { name: 'a.json', type: 'claude', label: '  Alpha  ' },
        { name: 'b.json', type: 'claude', label: '   ' },
      ],
    });
    expect(response.files[0]?.label).toBe('Alpha');
    expect(response.files[1]?.label).toBeUndefined();
  });
});
