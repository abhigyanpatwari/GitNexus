import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { compileRExportPattern } from '../../src/core/ingestion/languages/r/export-pattern.js';
import {
  compileLinearRegex,
  MAX_STATES,
} from '../../src/core/ingestion/languages/r/linear-regex.js';

// Names every characterisation row is evaluated against.
const NAMES: readonly string[] = [
  'tidy_scores',
  '.hidden',
  'foo_bar',
  'bar_baz',
  'foo',
  'bar',
  'a',
  'aa',
  'aaa',
  'aaaa',
  'abc',
  'ac',
  'Abc',
  'A1_b',
  'print.foo',
  'getX',
  'setY',
  'x',
  '',
  '_x',
  '1a',
  'foo.',
  'a.c',
  'a{,2}',
  'a{',
  'a|b',
  '[',
  'a]',
  ']',
  'foo$',
  'my_internal',
  'x.y',
  'aaab',
  'ab',
];

// [exportPattern source, names from NAMES it matches]. Recorded from the original
// backtracking-RegExp implementation, so this table pins behaviour that must not change.
const CHARACTERISATION: ReadonlyArray<readonly [string, readonly string[] | null]> = [
  [
    '^[[:alpha:]]+',
    [
      'tidy_scores',
      'foo_bar',
      'bar_baz',
      'foo',
      'bar',
      'a',
      'aa',
      'aaa',
      'aaaa',
      'abc',
      'ac',
      'Abc',
      'A1_b',
      'print.foo',
      'getX',
      'setY',
      'x',
      'foo.',
      'a.c',
      'a{,2}',
      'a{',
      'a|b',
      'a]',
      'foo$',
      'my_internal',
      'x.y',
      'aaab',
      'ab',
    ],
  ],
  [
    '^[^\\.]',
    [
      'tidy_scores',
      'foo_bar',
      'bar_baz',
      'foo',
      'bar',
      'a',
      'aa',
      'aaa',
      'aaaa',
      'abc',
      'ac',
      'Abc',
      'A1_b',
      'print.foo',
      'getX',
      'setY',
      'x',
      '_x',
      '1a',
      'foo.',
      'a.c',
      'a{,2}',
      'a{',
      'a|b',
      '[',
      'a]',
      ']',
      'foo$',
      'my_internal',
      'x.y',
      'aaab',
      'ab',
    ],
  ],
  ['^(foo|bar)_', ['foo_bar', 'bar_baz']],
  [
    '.',
    [
      'tidy_scores',
      '.hidden',
      'foo_bar',
      'bar_baz',
      'foo',
      'bar',
      'a',
      'aa',
      'aaa',
      'aaaa',
      'abc',
      'ac',
      'Abc',
      'A1_b',
      'print.foo',
      'getX',
      'setY',
      'x',
      '_x',
      '1a',
      'foo.',
      'a.c',
      'a{,2}',
      'a{',
      'a|b',
      '[',
      'a]',
      ']',
      'foo$',
      'my_internal',
      'x.y',
      'aaab',
      'ab',
    ],
  ],
  [
    '^',
    [
      'tidy_scores',
      '.hidden',
      'foo_bar',
      'bar_baz',
      'foo',
      'bar',
      'a',
      'aa',
      'aaa',
      'aaaa',
      'abc',
      'ac',
      'Abc',
      'A1_b',
      'print.foo',
      'getX',
      'setY',
      'x',
      '',
      '_x',
      '1a',
      'foo.',
      'a.c',
      'a{,2}',
      'a{',
      'a|b',
      '[',
      'a]',
      ']',
      'foo$',
      'my_internal',
      'x.y',
      'aaab',
      'ab',
    ],
  ],
  [
    '$',
    [
      'tidy_scores',
      '.hidden',
      'foo_bar',
      'bar_baz',
      'foo',
      'bar',
      'a',
      'aa',
      'aaa',
      'aaaa',
      'abc',
      'ac',
      'Abc',
      'A1_b',
      'print.foo',
      'getX',
      'setY',
      'x',
      '',
      '_x',
      '1a',
      'foo.',
      'a.c',
      'a{,2}',
      'a{',
      'a|b',
      '[',
      'a]',
      ']',
      'foo$',
      'my_internal',
      'x.y',
      'aaab',
      'ab',
    ],
  ],
  [
    '',
    [
      'tidy_scores',
      '.hidden',
      'foo_bar',
      'bar_baz',
      'foo',
      'bar',
      'a',
      'aa',
      'aaa',
      'aaaa',
      'abc',
      'ac',
      'Abc',
      'A1_b',
      'print.foo',
      'getX',
      'setY',
      'x',
      '',
      '_x',
      '1a',
      'foo.',
      'a.c',
      'a{,2}',
      'a{',
      'a|b',
      '[',
      'a]',
      ']',
      'foo$',
      'my_internal',
      'x.y',
      'aaab',
      'ab',
    ],
  ],
  ['foo', ['foo_bar', 'foo', 'print.foo', 'foo.', 'foo$']],
  ['^foo', ['foo_bar', 'foo', 'foo.', 'foo$']],
  ['foo$', ['foo', 'print.foo']],
  ['^foo$', ['foo']],
  [
    'a|b',
    [
      'foo_bar',
      'bar_baz',
      'bar',
      'a',
      'aa',
      'aaa',
      'aaaa',
      'abc',
      'ac',
      'Abc',
      'A1_b',
      '1a',
      'a.c',
      'a{,2}',
      'a{',
      'a|b',
      'a]',
      'my_internal',
      'aaab',
      'ab',
    ],
  ],
  ['^(a|b)c', ['ac']],
  [
    '[abc]',
    [
      'tidy_scores',
      'foo_bar',
      'bar_baz',
      'bar',
      'a',
      'aa',
      'aaa',
      'aaaa',
      'abc',
      'ac',
      'Abc',
      'A1_b',
      '1a',
      'a.c',
      'a{,2}',
      'a{',
      'a|b',
      'a]',
      'my_internal',
      'aaab',
      'ab',
    ],
  ],
  [
    '[^abc]',
    [
      'tidy_scores',
      '.hidden',
      'foo_bar',
      'bar_baz',
      'foo',
      'bar',
      'Abc',
      'A1_b',
      'print.foo',
      'getX',
      'setY',
      'x',
      '_x',
      '1a',
      'foo.',
      'a.c',
      'a{,2}',
      'a{',
      'a|b',
      '[',
      'a]',
      ']',
      'foo$',
      'my_internal',
      'x.y',
    ],
  ],
  ['^[a-z]+$', ['foo', 'bar', 'a', 'aa', 'aaa', 'aaaa', 'abc', 'ac', 'x', 'aaab', 'ab']],
  ['^[[:upper:]][[:alnum:]_]*$', ['Abc', 'A1_b']],
  [
    '^[[:alpha:].]+$',
    [
      '.hidden',
      'foo',
      'bar',
      'a',
      'aa',
      'aaa',
      'aaaa',
      'abc',
      'ac',
      'Abc',
      'print.foo',
      'getX',
      'setY',
      'x',
      'foo.',
      'a.c',
      'x.y',
      'aaab',
      'ab',
    ],
  ],
  ['\\.', ['.hidden', 'print.foo', 'foo.', 'a.c', 'x.y']],
  ['^\\.', ['.hidden']],
  ['^[.]', ['.hidden']],
  ['^(?:foo|bar)', ['foo_bar', 'bar_baz', 'foo', 'bar', 'foo.', 'foo$']],
  [
    'x?',
    [
      'tidy_scores',
      '.hidden',
      'foo_bar',
      'bar_baz',
      'foo',
      'bar',
      'a',
      'aa',
      'aaa',
      'aaaa',
      'abc',
      'ac',
      'Abc',
      'A1_b',
      'print.foo',
      'getX',
      'setY',
      'x',
      '',
      '_x',
      '1a',
      'foo.',
      'a.c',
      'a{,2}',
      'a{',
      'a|b',
      '[',
      'a]',
      ']',
      'foo$',
      'my_internal',
      'x.y',
      'aaab',
      'ab',
    ],
  ],
  ['a{2,3}', ['aa', 'aaa', 'aaaa', 'aaab']],
  ['^a{2}$', ['aa']],
  [
    '^\\w+$',
    [
      'tidy_scores',
      'foo_bar',
      'bar_baz',
      'foo',
      'bar',
      'a',
      'aa',
      'aaa',
      'aaaa',
      'abc',
      'ac',
      'Abc',
      'A1_b',
      'getX',
      'setY',
      'x',
      '_x',
      '1a',
      'my_internal',
      'aaab',
      'ab',
    ],
  ],
  ['^\\d', ['1a']],
  ['\\bfoo\\b', ['foo', 'print.foo', 'foo.', 'foo$']],
  [
    '^[[:alpha:]][[:alnum:]._]*$',
    [
      'tidy_scores',
      'foo_bar',
      'bar_baz',
      'foo',
      'bar',
      'a',
      'aa',
      'aaa',
      'aaaa',
      'abc',
      'ac',
      'Abc',
      'A1_b',
      'print.foo',
      'getX',
      'setY',
      'x',
      'foo.',
      'a.c',
      'my_internal',
      'x.y',
      'aaab',
      'ab',
    ],
  ],
  ['^print\\.', ['print.foo']],
  ['^(get|set)[A-Z]', ['getX', 'setY']],
  ['a.c', ['abc', 'a.c']],
  ['^.{3}$', ['foo', 'bar', 'aaa', 'abc', 'Abc', 'a.c', 'a|b', 'x.y']],
  ['[]a]', []],
  ['[^]a]', []],
  ['^[\\]]', [']']],
  [
    'a+?',
    [
      'foo_bar',
      'bar_baz',
      'bar',
      'a',
      'aa',
      'aaa',
      'aaaa',
      'abc',
      'ac',
      '1a',
      'a.c',
      'a{,2}',
      'a{',
      'a|b',
      'a]',
      'my_internal',
      'aaab',
      'ab',
    ],
  ],
  ['a{,2}', ['a{,2}']],
  ['a{', ['a{,2}', 'a{']],
  ['^[[:punct:]]', ['.hidden', '_x', '[', ']']],
  ['^.*_internal$', ['my_internal']],
  ['^[A-Z]', ['Abc', 'A1_b']],
  ['\\$', ['foo$']],
  ['a\\|b', ['a|b']],
  ['^(a+)+$', ['a', 'aa', 'aaa', 'aaaa']],
  ['^(a|a)+$', ['a', 'aa', 'aaa', 'aaaa']],
  ['^(a*)*b', ['bar_baz', 'bar', 'abc', 'aaab', 'ab']],
  ['^[[:digit:]a-c_]+$', ['a', 'aa', 'aaa', 'aaaa', 'abc', 'ac', '1a', 'aaab', 'ab']],
];

describe('compileRExportPattern characterisation', () => {
  it.each(CHARACTERISATION)('pattern %s keeps its recorded matches', (pattern, expected) => {
    const matcher = compileRExportPattern(pattern);
    if (expected === null) {
      expect(matcher).toBeNull();
      return;
    }
    expect(matcher).not.toBeNull();
    expect(NAMES.filter((n) => matcher?.test(n) === true)).toEqual(expected);
  });
});

// Differential check against the JavaScript RegExp the matcher replaced. Patterns are
// built from a fixed atom list by a seeded generator, so the corpus is deterministic.
// Names are short enough that even a catastrophic generated pattern finishes instantly
// on the oracle.
describe('compileRExportPattern agrees with RegExp on generated patterns', () => {
  const ATOMS = [
    'a',
    'b',
    '1',
    '_',
    '\\.',
    '.',
    '[ab]',
    '[^a]',
    '[a-c]',
    '[^.]',
    '(?:$)',
    '(\\b)',
    '[a.]',
    '\\d',
    '\\w',
    '\\s',
    '\\D',
    '\\W',
    '\\b',
    '\\B',
    '^',
    '$',
    '(',
    '(?:',
    ')',
    '|',
    '*',
    '+',
    '?',
    '{2}',
    '{1,2}',
    '{2,}',
    '{,1}',
    '{',
    '}',
    '*?',
    '+?',
    '??',
    '{1,2}?',
    '[',
    ']',
    '[]',
    '\\x61',
    '\\u0062',
    '\\t',
    '\\-',
    '[\\d-z]',
    '[z-a]',
  ];
  const NAME_ALPHABET = ['a', 'b', '1', '_', '.', ' ', 'c', '\t'];

  function lcg(seed: number): () => number {
    let state = seed >>> 0;
    return () => {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
      return state / 0x100000000;
    };
  }

  it('returns the same verdict, or null exactly when RegExp rejects the source', () => {
    const rand = lcg(20260930);
    const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)];
    const names: string[] = [''];
    for (let i = 0; i < 60; i++) {
      const len = Math.floor(rand() * 6);
      let n = '';
      for (let j = 0; j < len; j++) n += pick(NAME_ALPHABET);
      names.push(n);
    }
    let compiled = 0;
    let rejected = 0;
    for (let i = 0; i < 4000; i++) {
      const parts = Math.floor(rand() * 7) + 1;
      let source = '';
      for (let j = 0; j < parts; j++) source += pick(ATOMS);
      let oracle: RegExp | null = null;
      try {
        oracle = new RegExp(source);
      } catch {
        oracle = null;
      }
      const matcher = compileRExportPattern(source);
      if (oracle === null) {
        expect(matcher, `source ${JSON.stringify(source)} is invalid for RegExp`).toBeNull();
        rejected++;
        continue;
      }
      expect(matcher, `source ${JSON.stringify(source)} is valid for RegExp`).not.toBeNull();
      compiled++;
      for (const name of names) {
        expect(matcher?.test(name), `${JSON.stringify(source)} vs ${JSON.stringify(name)}`).toBe(
          oracle.test(name),
        );
      }
    }
    // The corpus must exercise both branches, or the comparison proves nothing.
    expect(compiled).toBeGreaterThan(500);
    expect(rejected).toBeGreaterThan(500);
  });
});

// A hostile pattern must not be able to stall the analyzer. The matching runs in a child
// process with a hard timeout so that a regression fails the test instead of hanging the
// whole suite for minutes.
describe('compileRExportPattern is linear-time on catastrophic patterns', () => {
  const modulePath = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '../../src/core/ingestion/languages/r/export-pattern.ts',
  );
  const HOSTILE = [
    '^(a+)+$',
    '^(a|a)+$',
    '^(a*)*b',
    '(a|aa)+$',
    '^(.*a){20}$',
    '(x+x+)+y',
    '^([a-z]+)*$',
    '^(a?){30}a{30}$',
  ];

  it('completes every hostile pattern in under 100 ms on 40 and 10,000 character names', () => {
    const script = `
      const { compileRExportPattern } = await import(${JSON.stringify(modulePath)});
      const out = [];
      for (const p of ${JSON.stringify(HOSTILE)}) {
        for (const len of [40, 10000]) {
          const name = 'a'.repeat(len - 1) + '!';
          const t0 = performance.now();
          const m = compileRExportPattern(p);
          const r = m ? m.test(name) : false;
          out.push({ p, len, r, ms: performance.now() - t0 });
        }
      }
      console.log('RESULT' + JSON.stringify(out));
    `;
    const res = spawnSync(
      process.execPath,
      ['--import', 'tsx', '--input-type=module', '-e', script],
      {
        encoding: 'utf-8',
        timeout: 30_000,
      },
    );
    expect(res.error, 'hostile pattern stalled past the 30 s guard').toBeUndefined();
    expect(res.status, res.stderr).toBe(0);
    const line = res.stdout.split('\n').find((l) => l.startsWith('RESULT'));
    expect(line).toBeDefined();
    const rows = JSON.parse((line ?? '').slice('RESULT'.length)) as Array<{
      p: string;
      len: number;
      r: boolean;
      ms: number;
    }>;
    expect(rows).toHaveLength(HOSTILE.length * 2);
    for (const row of rows) {
      expect(row.ms, `${row.p} on ${row.len} characters`).toBeLessThan(100);
      expect(row.r, `${row.p} must not match`).toBe(false);
    }
  }, 60_000);

  it('still reports a true match for a hostile-shaped pattern', () => {
    expect(compileRExportPattern('^(a+)+$')?.test('a'.repeat(10_000))).toBe(true);
    expect(compileRExportPattern('^(a|a)+$')?.test('aaaa')).toBe(true);
    expect(compileRExportPattern('^(a*)*b')?.test('aab')).toBe(true);
  });

  it('no longer hands back a backtracking RegExp', () => {
    expect(compileRExportPattern('^(a+)+$')).not.toBeInstanceOf(RegExp);
    expect(compileRExportPattern('^[[:alpha:]]+')).not.toBeInstanceOf(RegExp);
  });

  it('drops constructs it cannot match in linear time, like an uncompilable pattern', () => {
    for (const unsupported of [
      '(a)\\1',
      '(?=a)a',
      '(?!a)a',
      '(?<=a)b',
      '(?<!a)b',
      '(?<n>a)\\k<n>',
    ]) {
      expect(compileRExportPattern(unsupported), unsupported).toBeNull();
    }
  });

  it('bounds the matcher by pattern size, not by the name it is run against', () => {
    // The state count is fixed at compile time and capped, so the work per tested name
    // is at most name length x MAX_STATES whatever the pattern says.
    const nested = compileLinearRegex('^(a+)+$');
    expect(nested).not.toBeNull();
    expect(nested?.stateCount).toBeLessThanOrEqual(16);
    const widest = compileLinearRegex('a{' + (MAX_STATES - 2) + '}');
    expect(widest).not.toBeNull();
    expect(widest?.stateCount).toBeLessThanOrEqual(MAX_STATES);
    expect(compileLinearRegex('a{' + (MAX_STATES + 1) + '}')).toBeNull();
  });

  it('rejects nested empty repetition that would expand exponentially', () => {
    expect(
      compileRExportPattern(
        '((((((((((){1000}){1000}){1000}){1000}){1000}){1000}){1000}){1000}){1000}){1000}',
      ),
    ).toBeNull();
  });

  it('drops a pattern whose repetition expands beyond the size cap', () => {
    expect(compileRExportPattern('(a{1000}){1000}')).toBeNull();
    expect(compileRExportPattern('a{100000}')).toBeNull();
    expect(compileRExportPattern('a{3}')).not.toBeNull();
  });
});
