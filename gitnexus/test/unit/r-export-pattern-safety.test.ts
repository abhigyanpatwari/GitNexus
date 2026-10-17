import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { compileRExportPattern } from '../../src/core/ingestion/languages/r/export-pattern.js';
import {
  compileLinearRegex,
  compileLinearRegexDetailed,
  MAX_STATES,
  MAX_TOTAL_WORK,
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
  // Leading `]` in a bracket expression WITHOUT a POSIX class: these two rows record the
  // JS-RegExp reading (`[]` is an empty class), not TRE's. They cannot tell a working
  // matcher from a never-matching one; the discriminating checks are in the
  // 'leading ] in a bracket expression' block below.
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

// R compiles exportPattern() with TRE (POSIX extended): a `]` in first position of a bracket
// expression, after an optional `^`, is a literal member. The translator only applies that
// rule when the pattern also contains a POSIX class (`[:`); otherwise the text reaches the
// matcher verbatim and is read as a JavaScript RegExp, where `[]` is an empty class and
// `[^]` matches any character. The first block characterises what the code does today with
// names that discriminate (`a`, `]`, `xa]`, `5`); the second states the TRE expectation and
// is marked `it.fails` until export-pattern.ts translates the leading `]` unconditionally.
// The gap is listed under the limits in docs/languages/r-provider.md.
describe('compileRExportPattern: leading ] in a bracket expression', () => {
  const BRACKET_NAMES = ['a', ']', 'b', '5', 'xa]', 'ba]', 'a]', 'x]', ']a'];
  const matched = (pattern: string): readonly string[] | null => {
    const matcher = compileRExportPattern(pattern);
    return matcher === null ? null : BRACKET_NAMES.filter((n) => matcher.test(n));
  };

  describe('current behaviour (characterisation, JS-RegExp reading)', () => {
    it.each([
      ['[]a]', []],
      ['[]]', []],
      ['[^]a]', ['xa]', 'ba]']],
      ['[^]]', ['xa]', 'ba]', 'a]', 'x]']],
    ] as const)('%s matches %j', (pattern, expected) => {
      expect(matched(pattern)).toEqual(expected);
    });

    it('applies the TRE rule once a POSIX class is present (translated path)', () => {
      expect(matched('[]a[:digit:]]')).toEqual(['a', ']', '5', 'xa]', 'ba]', 'a]', 'x]', ']a']);
      expect(matched('[^]a[:digit:]]')).toEqual(['b', 'xa]', 'ba]', 'x]']);
    });
  });

  describe('TRE expectation (known gap)', () => {
    // The expected sets come from the equivalent JavaScript RegExp with the leading `]`
    // escaped, so the expectation is computed, not hand-listed, and is never empty by luck.
    it.fails.each([
      ['[]a]', /[\]a]/],
      ['[]]', /[\]]/],
      ['[^]a]', /[^\]a]/],
      ['[^]]', /[^\]]/],
    ] as const)('%s behaves like its escaped equivalent', (pattern, oracle) => {
      const expected = BRACKET_NAMES.filter((n) => oracle.test(n));
      expect(expected.length).toBeGreaterThan(0);
      expect(matched(pattern)).toEqual(expected);
    });
  });
});

// `$` is the end of the name only: neither JavaScript (no `m` flag) nor TRE (no REG_NEWLINE)
// lets it match before a final line terminator, as PCRE and Python do. `\1` to `\9` are
// back-references in TRE even when the group is absent, so they are refused, `\8` and `\9`
// included, where JavaScript's Annex B would read them as a literal digit (outside a class).
describe('compileRExportPattern: `$` and numbered escapes', () => {
  it.each([
    ['^foo$', 'foo\n'],
    ['foo$', 'foo\n'],
    ['^foo$', 'foo\r'],
    ['^foo$', 'foo\u2028'],
  ])('%s does not match %j, as RegExp does not', (pattern, name) => {
    expect(new RegExp(pattern).test(name)).toBe(false);
    expect(compileRExportPattern(pattern)?.test(name)).toBe(false);
    expect(compileRExportPattern(pattern)?.test('foo')).toBe(true);
  });

  it.each(['\\1', '\\7', '\\8', '\\9', 'a\\8', '(a)\\9'])(
    '%s is refused as a back-reference',
    (pattern) => {
      expect(compileRExportPattern(pattern)).toBeNull();
    },
  );
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

// docs/languages/r-provider.md: "Character classes use ASCII semantics." R's TRE engine would
// match a locale's letters; the translator deliberately does not, so this is pinned.
describe('compileRExportPattern: POSIX classes are ASCII-only', () => {
  it.each([
    ['^[[:alpha:]]+$', 'abc', 'caf\u00e9'],
    ['^[[:alnum:]]+$', 'ab12', 'na\u00efve1'],
    ['^[[:upper:]]+$', 'ABC', '\u00c9COLE'],
    ['^[[:lower:]]+$', 'abc', 'stra\u00dfe'],
    ['^[[:punct:]]+$', '!?', '\u00bf'],
  ])('%s matches %s but not %s', (source, ascii, nonAscii) => {
    const matcher = compileRExportPattern(source);
    expect(matcher).not.toBeNull();
    expect(matcher?.test(ascii)).toBe(true);
    expect(matcher?.test(nonAscii)).toBe(false);
  });
});

// A hostile pattern must not be able to stall the analyzer. The matching runs in a child
// process with a hard timeout so that a regression fails the test instead of hanging the
// whole suite for minutes. The timeout is only that hang guard: the bound itself is on the
// matcher's deterministic state-visit counter, never on wall-clock time.
describe('compileRExportPattern is linear-time on catastrophic patterns', () => {
  const modulePath = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '../../src/core/ingestion/languages/r/export-pattern.ts',
  );
  const GITNEXUS_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
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

  it('does linear work on every hostile pattern for 40 and 10,000 character names', () => {
    const script = `
      const { compileRExportPattern } = await import(${JSON.stringify(pathToFileURL(modulePath).href)});
      const out = [];
      for (const p of ${JSON.stringify(HOSTILE)}) {
        for (const len of [40, 10000]) {
          const name = 'a'.repeat(len - 1) + '!';
          const m = compileRExportPattern(p);
          const r = m ? m.test(name) : false;
          out.push({ p, len, r, work: m?.work, states: m?.stateCount, exhausted: m?.exhausted });
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
        // `cwd` pins how `--import tsx` resolves (vitest may be run from the repository root).
        cwd: GITNEXUS_ROOT,
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
      work?: number;
      states?: number;
      exhausted?: boolean;
    }>;
    expect(rows).toHaveLength(HOSTILE.length * 2);
    for (const row of rows) {
      const label = `${row.p} on ${row.len} characters`;
      expect(row.r, `${row.p} must not match`).toBe(false);
      // A backtracking RegExp has no counter: `work` would be undefined and this fails.
      expect(typeof row.work, label).toBe('number');
      expect(row.exhausted, label).toBe(false);
      // Linear: at most a few state visits per input character per NFA state (measured
      // peak is ~1.6), and nowhere near the per-matcher budget.
      expect(row.work as number, label).toBeLessThanOrEqual(
        3 * (row.states as number) * (row.len + 1),
      );
      expect(row.work as number, label).toBeLessThan(MAX_TOTAL_WORK);
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

  describe('"(?<" is only a group opener outside a character class and an escape', () => {
    it.each([
      ['[(?<]', ['(', '?', '<'], ['a', '']],
      ['[^(?<]x', ['ax'], ['(x', '<x']],
      ['^[(?<]+$', ['(<?', '<'], ['a<', '']],
      ['[(?<]\\k', ['(k'], ['k']],
      ['\\(?<x', ['<x', '(<x'], ['x']],
      ['\\[[(?<]', ['[<', '[('], ['<']],
      ['[\\]](?:a)', [']a'], ['a']],
      ['[\\](?<]x', ['(x', ']x', '<x'], ['ax']],
      ['[[(?<]', ['[', '('], ['a']],
    ])('compiles %s and matches it as written', (pattern, matching, notMatching) => {
      const regex = compileLinearRegex(pattern);
      expect(regex, pattern).not.toBeNull();
      for (const name of matching) expect(regex?.test(name), `${pattern} ~ ${name}`).toBe(true);
      for (const name of notMatching) {
        expect(regex?.test(name), `${pattern} !~ ${name}`).toBe(false);
      }
    });

    it.each([
      ['a real look-behind', '(?<=x)y'],
      ['a negative look-behind', '(?<!x)y'],
      ['a named group', '(?<n>a)'],
      ['after a closed class', '[ab](?<=x)'],
      ['after a class holding an escaped ]', '[\\]](?<=x)'],
      ['after an escaped [', '\\[(?<=x)'],
      ['after a class that holds (?<', '[(?<](?<=x)'],
      ['inside a group', '(a|(?<=x)b)'],
    ])('still rejects %s', (_label, pattern) => {
      expect(compileLinearRegex(pattern), pattern).toBeNull();
    });

    it('reports a named group or look-behind as such', () => {
      for (const pattern of ['(?<=x)y', '(?<n>a)']) {
        expect(compileLinearRegexDetailed(pattern)).toMatchObject({
          regex: null,
          reason: expect.stringContaining('look-behind'),
        });
      }
    });
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
