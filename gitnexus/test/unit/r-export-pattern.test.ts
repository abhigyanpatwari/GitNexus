import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
  compileRExportPattern,
  unescapeRString,
} from '../../src/core/ingestion/languages/r/export-pattern.js';
import { loadRPackageConfig } from '../../src/core/ingestion/languages/r/package-config.js';
import { createTempDirPool } from '../helpers/temp-dir-pool.js';

// `exportPattern("...")` arguments are POSIX (TRE) regexes; JavaScript RegExp has no
// `[:alpha:]`-style classes, so they must be translated before compiling.
describe('compileRExportPattern', () => {
  const matches = (pattern: string, name: string): boolean =>
    compileRExportPattern(pattern)?.test(name) ?? false;

  it('matches the RStudio default pattern against an ordinary name', () => {
    expect(matches('^[[:alpha:]]+', 'tidy_scores')).toBe(true);
    expect(matches('^[[:alpha:]]+', '.hidden')).toBe(false);
  });

  it.each([
    ['[[:alpha:]]', 'q', '5'],
    ['[[:alnum:]]', '7', '_'],
    ['[[:digit:]]', '3', 'x'],
    ['[[:upper:]]', 'Q', 'q'],
    ['[[:lower:]]', 'q', 'Q'],
    ['[[:punct:]]', '.', 'a'],
    ['[[:space:]]', ' ', 'a'],
  ])('translates %s', (pattern, hit, miss) => {
    expect(matches(`^${pattern}$`, hit)).toBe(true);
    expect(matches(`^${pattern}$`, miss)).toBe(false);
  });

  it('treats punct as ASCII punctuation including brackets, backslash, backtick and tilde', () => {
    for (const ch of ['!', '/', ':', '@', '[', '\\', ']', '^', '_', '`', '{', '~']) {
      expect(matches('^[[:punct:]]$', ch)).toBe(true);
    }
  });

  it('translates a negated class', () => {
    expect(matches('^[^[:digit:]]+$', 'abc')).toBe(true);
    expect(matches('^[^[:digit:]]+$', 'ab1')).toBe(false);
  });

  it('combines a class with a range and literals in one bracket expression', () => {
    expect(matches('^[[:digit:]a-c_]+$', '1a_c2')).toBe(true);
    expect(matches('^[[:digit:]a-c_]+$', '1d')).toBe(false);
  });

  it('combines several classes in one bracket expression', () => {
    expect(matches('^[[:upper:][:digit:]]+$', 'AB12')).toBe(true);
    expect(matches('^[[:upper:][:digit:]]+$', 'Ab12')).toBe(false);
  });

  it('honours ^ and $ anchors around a class', () => {
    expect(matches('^[[:alpha:]]', '9a')).toBe(false);
    expect(matches('[[:digit:]]$', 'a9')).toBe(true);
    expect(matches('[[:digit:]]$', '9a')).toBe(false);
    expect(matches('[[:digit:]]', 'a9b')).toBe(true);
  });

  it('translates a class in a pattern with several bracket expressions', () => {
    expect(matches('^[[:upper:]][a-z]+[[:digit:]]*$', 'Foo12')).toBe(true);
    expect(matches('^[[:upper:]][a-z]+[[:digit:]]*$', 'foo12')).toBe(false);
  });

  it('leaves patterns without POSIX classes unchanged', () => {
    expect(compileRExportPattern('^[a-z]')?.source).toBe('^[a-z]');
    expect(compileRExportPattern('^Pattern')?.source).toBe('^Pattern');
    expect(matches('^Pattern', 'PatternX')).toBe(true);
    expect(matches('^Pattern', 'xPattern')).toBe(false);
  });

  it('does not treat an escaped bracket as a bracket expression', () => {
    expect(matches('^\\[[:alpha:]$', '[:alpha:')).toBe(false);
  });

  it('never throws and yields null for an uncompilable pattern', () => {
    for (const bad of ['(', '[abc', '[[:alpha:]', '[[:nosuch:]]', '*', '[[:alpha:', '\\']) {
      expect(() => compileRExportPattern(bad)).not.toThrow();
      expect(compileRExportPattern(bad)).toBeNull();
    }
  });
});

describe('loadRPackageConfig -> RNamespaceInfo.exportPatterns (POSIX classes)', () => {
  const pool = createTempDirPool('gn-r-exp-');

  const load = async (namespace: string) => {
    const root = pool.dir();
    fs.writeFileSync(path.join(root, 'DESCRIPTION'), 'Package: rootpkg\n');
    fs.writeFileSync(path.join(root, 'NAMESPACE'), namespace);
    const config = await loadRPackageConfig(root);
    return config?.namespaceInfoByPackageDir.get('')?.exportPatterns ?? [];
  };

  it('compiles the RStudio default exportPattern so it matches tidy_scores', async () => {
    const patterns = await load('exportPattern("^[[:alpha:]]+")\n');
    expect(patterns).toHaveLength(1);
    expect(patterns.some((p) => p.test('tidy_scores'))).toBe(true);
  });

  it('drops an invalid pattern without throwing and keeps the valid ones', async () => {
    const patterns = await load('exportPattern("[[:nosuch:]]")\nexportPattern("^[[:digit:]]")\n');
    expect(patterns).toHaveLength(1);
    expect(patterns[0].test('1a')).toBe(true);
  });

  it('keeps a plain pattern working', async () => {
    const patterns = await load('exportPattern("^Pattern")\n');
    expect(patterns.some((p) => p.test('PatternX'))).toBe(true);
    expect(patterns.some((p) => p.test('xPattern'))).toBe(false);
  });
});

describe('unescapeRString', () => {
  it('returns text without a backslash unchanged', () => {
    expect(unescapeRString('^[[:alpha:]]+')).toBe('^[[:alpha:]]+');
  });

  it('handles the common single-character escapes', () => {
    expect(unescapeRString('a\\\\b')).toBe('a\\b');
    expect(unescapeRString('\\"\\\'\\`')).toBe('"\'`');
    expect(unescapeRString('\\n\\t\\r\\a\\b\\f\\v')).toBe('\n\t\r\x07\b\f\v');
  });

  it('handles hex and unicode escapes, with and without braces', () => {
    expect(unescapeRString('\\x41\\u0042\\u{43}\\U00000044\\U{45}')).toBe('ABCDE');
    expect(unescapeRString('\\U{1F600}')).toBe('\u{1F600}');
  });

  it('keeps an unknown or malformed escape verbatim and never throws', () => {
    expect(unescapeRString('\\.')).toBe('\\.');
    expect(unescapeRString('\\xZZ')).toBe('\\xZZ');
    expect(unescapeRString('\\u{110000}')).toBe('\\u{110000}');
    expect(unescapeRString('\\u{41')).toBe('\\u{41');
    expect(unescapeRString('trailing\\')).toBe('trailing\\');
  });
});
