import { describe, it, expect } from 'vitest';
import {
  fileMatchesServicePrefix,
  normalizeServicePrefix,
  repoInSubgroup,
} from '../../../src/core/group/group-path-utils.js';

describe('group-path-utils', () => {
  describe('normalizeServicePrefix', () => {
    it('returns undefined for null/undefined/empty', () => {
      expect(normalizeServicePrefix(undefined)).toBeUndefined();
      expect(normalizeServicePrefix(null)).toBeUndefined();
      expect(normalizeServicePrefix('')).toBeUndefined();
      expect(normalizeServicePrefix('   ')).toBeUndefined();
    });

    it('strips trailing slashes', () => {
      expect(normalizeServicePrefix('services/auth/')).toBe('services/auth');
      expect(normalizeServicePrefix('services/auth///')).toBe('services/auth');
    });

    it('normalizes Windows-style backslashes to POSIX', () => {
      expect(normalizeServicePrefix('services\\auth')).toBe('services/auth');
      expect(normalizeServicePrefix('app\\backend\\')).toBe('app/backend');
    });
  });

  describe('fileMatchesServicePrefix', () => {
    it('returns true when prefix is empty/undefined', () => {
      expect(fileMatchesServicePrefix('any/file.ts', undefined)).toBe(true);
      expect(fileMatchesServicePrefix('any/file.ts', '')).toBe(true);
    });

    it('returns false when filePath is missing but prefix is set', () => {
      expect(fileMatchesServicePrefix(undefined, 'services/auth')).toBe(false);
    });

    it('matches exact prefix and descendants', () => {
      expect(fileMatchesServicePrefix('services/auth', 'services/auth')).toBe(true);
      expect(fileMatchesServicePrefix('services/auth/a.ts', 'services/auth')).toBe(true);
    });

    it('rejects partial-segment matches', () => {
      expect(fileMatchesServicePrefix('services/aut', 'services/auth')).toBe(false);
      expect(fileMatchesServicePrefix('services/authz/a.ts', 'services/auth')).toBe(false);
    });

    it('matches Windows-style file paths against POSIX prefix', () => {
      expect(fileMatchesServicePrefix('services\\auth\\a.ts', 'services/auth')).toBe(true);
      expect(fileMatchesServicePrefix('services\\authz\\a.ts', 'services/auth')).toBe(false);
    });
  });

  describe('repoInSubgroup', () => {
    it('matches every repo when subgroup is empty/undefined', () => {
      expect(repoInSubgroup('any/repo', undefined)).toBe(true);
      expect(repoInSubgroup('any/repo', '')).toBe(true);
      expect(repoInSubgroup('any/repo', '   ')).toBe(true);
    });

    it('matches exact path and descendants by default', () => {
      expect(repoInSubgroup('app/backend', 'app/backend')).toBe(true);
      expect(repoInSubgroup('app/backend/sub', 'app/backend')).toBe(true);
      expect(repoInSubgroup('app/frontend', 'app/backend')).toBe(false);
    });

    it('strips trailing slashes from subgroup', () => {
      expect(repoInSubgroup('app/backend', 'app/backend/')).toBe(true);
      expect(repoInSubgroup('app/backend/x', 'app/backend///')).toBe(true);
    });

    it('with exact=true matches only the exact repo', () => {
      expect(repoInSubgroup('app/backend', 'app/backend', true)).toBe(true);
      expect(repoInSubgroup('app/backend/sub', 'app/backend', true)).toBe(false);
    });

    it('rejects partial-segment matches', () => {
      expect(repoInSubgroup('app/backendz', 'app/backend')).toBe(false);
    });

    it('normalizes Windows-style paths on both sides', () => {
      expect(repoInSubgroup('app\\backend', 'app/backend')).toBe(true);
      expect(repoInSubgroup('app/backend/x', 'app\\backend')).toBe(true);
      expect(repoInSubgroup('app\\backend\\sub', 'app\\backend', true)).toBe(false);
    });
  });
});
