import type { AuthFileItem } from '@/types';

const readText = (value: unknown): string => (typeof value === 'string' ? value.trim() : '');

/**
 * Explicit operator label for a credential. The backend sends `label` for every
 * credential but falls back to the email when the file carries no `label` field,
 * so a label equal to the email (case-insensitively) is treated as absent.
 */
export const readExplicitLabel = (file: AuthFileItem): string => {
  const label = readText(file.label);
  if (!label) return '';
  const email = readText(file.email);
  if (email && label.toLowerCase() === email.toLowerCase()) return '';
  return label;
};
