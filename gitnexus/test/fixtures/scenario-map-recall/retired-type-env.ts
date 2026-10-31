// Static input for recall-audit.test.ts; excluded from Vitest discovery by its .ts suffix.
// Preserves the 12 duplicate callbacks removed from type-env.test.ts (see README.md).
import { describe, expect, it } from 'vitest';
import { stripNullable } from '../../../src/core/ingestion/type-extractors/shared.js';

describe('buildTypeEnv', () => {
  describe('stripNullable', () => {
    it('strips User | null → User', () => {
      expect(stripNullable('User | null')).toBe('User');
    });

    it('strips User | undefined → User', () => {
      expect(stripNullable('User | undefined')).toBe('User');
    });

    it('strips User | null | undefined → User', () => {
      expect(stripNullable('User | null | undefined')).toBe('User');
    });

    it('strips User? → User', () => {
      expect(stripNullable('User?')).toBe('User');
    });

    it('refuses genuine union User | Repo → undefined', () => {
      expect(stripNullable('User | Repo')).toBeUndefined();
    });

    it('returns undefined for null alone', () => {
      expect(stripNullable('null')).toBeUndefined();
    });

    it('returns undefined for undefined alone', () => {
      expect(stripNullable('undefined')).toBeUndefined();
    });

    it('returns undefined for None alone', () => {
      expect(stripNullable('None')).toBeUndefined();
    });

    it('returns undefined for nil alone', () => {
      expect(stripNullable('nil')).toBeUndefined();
    });

    it('returns undefined for void alone', () => {
      expect(stripNullable('void')).toBeUndefined();
    });

    it('returns undefined for empty string', () => {
      expect(stripNullable('')).toBeUndefined();
    });

    it('passes through User unchanged', () => {
      expect(stripNullable('User')).toBe('User');
    });
  });
});
