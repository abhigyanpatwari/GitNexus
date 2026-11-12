/**
 * The numeric caps docs/languages/r-provider.md publishes, pinned by literal.
 *
 * Other tests assert against the exported constants (`toBeLessThan(MAX_SHARED_WORK)`), which
 * stays green when a cap changes. These pin the values themselves, and check that the document
 * states the same numbers, so that neither can drift from the other unnoticed. Changing a cap
 * means changing it here and in the document.
 */
import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  compileLinearRegexDetailed,
  MAX_NESTING,
  MAX_PACKAGE_STATES,
  MAX_PACKAGE_WORK,
  MAX_PATTERN_LENGTH,
  MAX_SHARED_STATES,
  MAX_SHARED_WORK,
  MAX_STATES,
  MAX_TOTAL_WORK,
  SharedWorkBudget,
} from '../../src/core/ingestion/languages/r/linear-regex.js';
import {
  hidesUndiscoveredPackage,
  MAX_LISTED_DROPPED_PATTERNS,
} from '../../src/core/ingestion/languages/r/package-config.js';
import { compileRExportPattern } from '../../src/core/ingestion/languages/r/export-pattern.js';
import { cleanupTempDirSync } from '../helpers/test-db.js';

const DOC = fs.readFileSync(
  fileURLToPath(new URL('../../../docs/languages/r-provider.md', import.meta.url)),
  'utf-8',
);

/** The number the document gives right after a backticked constant name, commas removed. */
function documented(pattern: RegExp): number {
  const match = pattern.exec(DOC);
  if (match === null) throw new Error(`r-provider.md no longer states ${String(pattern)}`);
  return Number(match[1].replace(/,/g, ''));
}

describe('the documented export-pattern caps', () => {
  it('have the values the document publishes', () => {
    expect({
      MAX_PATTERN_LENGTH,
      MAX_STATES,
      MAX_NESTING,
      MAX_TOTAL_WORK,
      MAX_SHARED_WORK,
      MAX_PACKAGE_WORK,
      MAX_SHARED_STATES,
      MAX_PACKAGE_STATES,
      MAX_LISTED_DROPPED_PATTERNS,
    }).toEqual({
      MAX_PATTERN_LENGTH: 16_384,
      MAX_STATES: 16_384,
      MAX_NESTING: 256,
      MAX_TOTAL_WORK: 40_000_000,
      MAX_SHARED_WORK: 100_000_000,
      MAX_PACKAGE_WORK: 30_000_000,
      MAX_SHARED_STATES: 500_000,
      MAX_PACKAGE_STATES: 100_000,
      MAX_LISTED_DROPPED_PATTERNS: 50,
    });
  });

  it.each([
    ['MAX_TOTAL_WORK', /`MAX_TOTAL_WORK` \(([\d,]+) /, MAX_TOTAL_WORK],
    ['MAX_SHARED_WORK', /`MAX_SHARED_WORK` \(([\d,]+) /, MAX_SHARED_WORK],
    ['MAX_PACKAGE_WORK', /`MAX_PACKAGE_WORK` \(([\d,]+) /, MAX_PACKAGE_WORK],
    ['MAX_SHARED_STATES', /`MAX_SHARED_STATES` \(([\d,]+) /, MAX_SHARED_STATES],
    ['MAX_PACKAGE_STATES', /`MAX_PACKAGE_STATES` \(([\d,]+) /, MAX_PACKAGE_STATES],
    ['MAX_PATTERN_LENGTH', /`MAX_PATTERN_LENGTH` \(([\d,]+) characters\)/, MAX_PATTERN_LENGTH],
    ['MAX_STATES', /`MAX_STATES` \(([\d,]+)\)/, MAX_STATES],
    ['MAX_NESTING', /deeper than ([\d,]+) \(`MAX_NESTING`\)/, MAX_NESTING],
    [
      'MAX_LISTED_DROPPED_PATTERNS',
      /at most ([\d,]+) patterns are named per package \(`MAX_LISTED_DROPPED_PATTERNS`\)/,
      MAX_LISTED_DROPPED_PATTERNS,
    ],
  ])('%s is the number the document states', (_name, pattern, value) => {
    expect(documented(pattern)).toBe(value);
  });

  it('keep the per-pattern state cap and the pattern length cap equal to the documented 16,384', () => {
    // The two are separate limits that the document gives the same number.
    expect(MAX_PATTERN_LENGTH).toBe(MAX_STATES);
  });
});

describe('the per-pattern state cap sits exactly at MAX_STATES', () => {
  it('compiles a pattern that fills the cap', () => {
    const result = compileLinearRegexDetailed('^a{16381}$');
    expect(result.regex?.stateCount).toBe(MAX_STATES);
  });

  it('refuses a pattern one state over the cap, and says why', () => {
    const result = compileLinearRegexDetailed('^a{16382}$');
    expect(result.regex).toBeNull();
    expect('reason' in result ? result.reason : '').toMatch(/state cap/);
  });
});

describe('the pattern length cap sits exactly at MAX_PATTERN_LENGTH', () => {
  it('accepts a pattern of exactly that many characters, and it matches', () => {
    // Empty groups add no states, so only the length rule is in play: 1 + 4 * 4095 + 2 + 1.
    const pattern = `^${'(?:)'.repeat(4095)}aa$`;
    expect(pattern.length).toBe(MAX_PATTERN_LENGTH);
    const result = compileLinearRegexDetailed(pattern);
    expect(result.regex).not.toBeNull();
    expect(result.regex?.test('aa')).toBe(true);
    expect(result.regex?.test('a')).toBe(false);
    // The same shape one character longer is refused for its length.
    const over = compileLinearRegexDetailed(`^${'(?:)'.repeat(4095)}aaa$`);
    expect(over.regex).toBeNull();
    expect('reason' in over ? over.reason : '').toMatch(/longer than 16384 characters/);
  });

  it('refuses a pattern one character longer', () => {
    const result = compileLinearRegexDetailed(`^${'a'.repeat(MAX_PATTERN_LENGTH - 1)}$`);
    expect(result.regex).toBeNull();
    expect('reason' in result ? result.reason : '').toMatch(/longer than 16384 characters/);
  });
});

describe('a matcher whose budget is spent answers a strict false', () => {
  it('returns false, not undefined, for a name it has not decided', () => {
    // Compiled before the budget is spent: a spent budget refuses to compile at all.
    const fresh = new SharedWorkBudget(1_000);
    const matcher = compileRExportPattern('^foo', fresh);
    fresh.charge(2_000);
    expect(fresh.isSpent).toBe(true);
    expect(matcher?.test('foo_new')).toBe(false);
    expect(matcher?.exhausted).toBe(true);
  });
});

describe('the hidden-package scan budget of 5,000 directories', () => {
  let tmp: string;
  beforeAll(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'r-hidden-scan-'));
  });
  afterAll(() => cleanupTempDirSync(tmp));

  async function treeOf(children: number): Promise<string> {
    const root = path.join(tmp, `tree${String(children)}`);
    await fsp.mkdir(root, { recursive: true });
    await Promise.all(
      Array.from({ length: children }, (_, i) => fsp.mkdir(path.join(root, `d${String(i)}`))),
    );
    return root;
  }

  it('reads a root and 4,999 directories (5,000 in all) without giving up', async () => {
    const root = await treeOf(4_999);
    expect(await hidesUndiscoveredPackage([root], new Set())).toBe(false);
  }, 30_000);

  it('gives up on the 5,001st directory', async () => {
    const root = await treeOf(5_000);
    expect(await hidesUndiscoveredPackage([root], new Set())).toBe(true);
  }, 30_000);
});
