/**
 * Locks the span-map check (KTD7): Stryker's locations refer to the prepared file, whose only
 * difference from the original is `as` assertions blanked to spaces of equal length. A mutant
 * passes when its span means the same text in both files outside the blanked ranges; any other
 * difference fails with the mutant's global identity in the message.
 */
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { blankAssertions } from '../../../tools/mutation/prepare/blank-assertions.js';
import {
  identifyMutants,
  type MutationReport,
  type ReportLocation,
  type ReportMutant,
} from '../../../tools/mutation/prepare/mutant-identity.js';
import {
  assertSpanMap,
  checkSpanMap,
  indexSource,
  locationToOffsets,
} from '../../../tools/mutation/prepare/span-map-check.js';

const PACKAGE_DIR = path.join(path.sep, 'prepared', 'gitnexus');
const SHARED_KEY = 'relocated/gitnexus-shared/src/lbug/schema-constants.ts';

const TABLE = "export const KINDS = ['a', 'b'] as const;\n";
const TABLE_PREPARED = "export const KINDS = ['a', 'b']         ;\n";

const CALL = 'export function f(x: unknown) {\n  return g(x as string);\n}\n';
const CALL_PREPARED = 'export function f(x: unknown) {\n  return g(x          );\n}\n';

const loc = (
  startLine: number,
  startColumn: number,
  endLine: number,
  endColumn: number,
): ReportLocation => ({
  start: { line: startLine, column: startColumn },
  end: { line: endLine, column: endColumn },
});

const mutant = (id: string, location: ReportLocation, replacement = '""'): ReportMutant => ({
  id,
  mutatorName: 'StringLiteral',
  replacement,
  status: 'Survived',
  location,
});

/** Runs the check on one file: `original` in the repo, `prepared` as Stryker read it. */
const check = (original: string, prepared: string, mutants: readonly ReportMutant[]) => {
  const report: MutationReport = {
    schemaVersion: '1.0',
    files: { [SHARED_KEY]: { language: 'typescript', source: prepared, mutants: [...mutants] } },
  };
  const run = identifyMutants(report, { packageDir: PACKAGE_DIR, readOriginal: () => original });
  return { run, result: checkSpanMap(report, run) };
};

describe('fixtures', () => {
  it.each([
    ['an as-const table', TABLE, TABLE_PREPARED],
    ['an assertion inside a call', CALL, CALL_PREPARED],
  ])('match what the prepare step writes for %s', (_label, original, prepared) => {
    expect(blankAssertions(original)).toEqual({ ok: true, assertions: 1, text: prepared });
  });
});

describe('locationToOffsets', () => {
  it.each([
    ['a span at the start of a line', 'ab\ncd\n', loc(2, 1, 2, 2), 'c'],
    ['a span that ends at the end of a line', 'ab\ncd\n', loc(2, 2, 2, 3), 'd'],
    ['the last line without a terminator', 'ab\ncd', loc(2, 1, 2, 3), 'cd'],
    ['an empty span at the end of a line', 'ab\n', loc(1, 3, 1, 3), ''],
    ['a multi-line span', 'ab\ncd\nef', loc(1, 2, 3, 2), 'b\ncd\ne'],
    ['a span on a CRLF line', 'ab\r\ncd\r\n', loc(2, 1, 2, 3), 'cd'],
    ['a multi-line span over CRLF', 'ab\r\ncd', loc(1, 2, 2, 2), 'b\r\nc'],
    ['a span after a lone CR', 'ab\rcd', loc(2, 1, 2, 3), 'cd'],
    ['a span after a line separator', 'ab cd', loc(2, 2, 2, 3), 'd'],
  ])('converts %s', (_label, text, location, expected) => {
    const { start, end } = locationToOffsets(indexSource(text), location);
    expect(text.slice(start, end)).toBe(expected);
  });

  it('returns 0-based offsets with an exclusive end', () => {
    expect(locationToOffsets(indexSource('ab\r\ncd\r\n'), loc(2, 1, 2, 3))).toEqual({
      start: 4,
      end: 6,
    });
  });

  it.each([
    ['line 0', 'ab\n', loc(0, 1, 1, 2)],
    ['a line past the end', 'ab\n', loc(3, 1, 3, 1)],
    ['column 0', 'ab\n', loc(1, 0, 1, 2)],
    ['a column past the end of the line', 'ab\ncd', loc(1, 1, 1, 4)],
    ['a column inside a CRLF terminator', 'ab\r\ncd', loc(1, 1, 1, 4)],
  ])('rejects %s', (_label, text, location) => {
    expect(() => locationToOffsets(indexSource(text), location)).toThrow(RangeError);
  });
});

describe('checkSpanMap', () => {
  it('maps a mutant inside a blanked-assertion line to the same line and column', () => {
    const { run, result } = check(TABLE, TABLE_PREPARED, [mutant('5', loc(1, 28, 1, 31))]);
    expect(result).toEqual({
      checked: 1,
      failures: [],
      mapped: [
        {
          localId: '5',
          globalId: run.mutants[0].globalId,
          start: 27,
          end: 30,
          originalText: "'b'",
          preparedText: "'b'",
        },
      ],
    });
  });

  it('passes a mutant whose span contains a whole blanked assertion', () => {
    const { result } = check(CALL, CALL_PREPARED, [mutant('0', loc(1, 31, 3, 2), '{}')]);
    expect(result.failures).toEqual([]);
    expect(result.mapped.map((m) => [m.originalText, m.preparedText])).toEqual([
      ['{\n  return g(x as string);\n}', '{\n  return g(x          );\n}'],
    ]);
  });

  it('fails a mutant whose span text differs outside blanked ranges, naming its global id', () => {
    const { run, result } = check('const a = 1;\n', 'const a = 2;\n', [
      mutant('3', loc(1, 11, 1, 12), '0'),
    ]);
    expect(result.mapped).toEqual([]);
    expect(result.failures).toEqual([
      {
        localId: '3',
        globalId: run.mutants[0].globalId,
        message:
          `span map: mutant ${run.mutants[0].globalId} (local id 3): the original span text ` +
          'differs from the prepared span text at 1:11 outside blanked assertions ' +
          '(original "1", prepared "2")',
      },
    ]);
  });

  it('quotes only a window around the difference of a long span', () => {
    const literal = (digit: string) => `const s = '${'a'.repeat(40)}${digit}${'b'.repeat(40)}';\n`;
    const { result } = check(literal('1'), literal('2'), [mutant('6', loc(1, 11, 1, 94))]);
    const window = (digit: string) => `…"${'a'.repeat(24)}${digit}${'b'.repeat(23)}"…`;
    expect(result.failures.map((f) => f.message.replace(/^.*?\): /, ''))).toEqual([
      'the original span text differs from the prepared span text at 1:52 outside blanked ' +
        `assertions (original ${window('1')}, prepared ${window('2')})`,
    ]);
  });

  it('fails a mutant when the files differ outside its span', () => {
    const { run, result } = check('const a = 1;\nconst b = 2;\n', 'const a = 1;\nconst b = 3;\n', [
      mutant('8', loc(1, 11, 1, 12), '0'),
    ]);
    expect(result.failures.map((f) => f.message)).toEqual([
      `span map: mutant ${run.mutants[0].globalId} (local id 8): the original file differs ` +
        'from the prepared file at 2:11 outside blanked assertions',
    ]);
  });

  it('fails every mutant when the prepared file has a different length', () => {
    const { run, result } = check(TABLE, `// @ts-nocheck\n${TABLE_PREPARED}`, [
      mutant('0', loc(2, 23, 2, 26)),
      mutant('1', loc(2, 28, 2, 31)),
    ]);
    expect(result.failures.map((f) => [f.globalId, f.message])).toEqual(
      run.mutants.map((m) => [
        m.globalId,
        `span map: mutant ${m.globalId} (local id ${m.localId}): the prepared file has 57 ` +
          'characters and the original 42, so columns do not map',
      ]),
    );
  });

  it('fails a mutant whose span boundary cuts a blanked assertion', () => {
    const { run, result } = check(TABLE, TABLE_PREPARED, [mutant('2', loc(1, 34, 1, 41), '')]);
    expect(result.failures.map((f) => f.message)).toEqual([
      `span map: mutant ${run.mutants[0].globalId} (local id 2): the span start cuts a ` +
        'blanked assertion at 1:34',
    ]);
  });

  it('fails a mutant whose location lies outside the file', () => {
    const { run, result } = check(TABLE, TABLE_PREPARED, [mutant('4', loc(1, 23, 9, 1))]);
    expect(result.failures.map((f) => f.message)).toEqual([
      `span map: mutant ${run.mutants[0].globalId} (local id 4): line 9 is outside the ` +
        'prepared file (2 lines)',
    ]);
  });
});

describe('assertSpanMap', () => {
  it('accepts a result without failures', () => {
    const { result } = check(TABLE, TABLE_PREPARED, [mutant('0', loc(1, 23, 1, 26))]);
    expect(() => assertSpanMap(result)).not.toThrow();
  });

  it('throws with the count and every failing global id', () => {
    const { run, result } = check('const a = 1;\n', 'const a = 2;\n', [
      mutant('0', loc(1, 11, 1, 12), '0'),
      mutant('1', loc(1, 1, 1, 6), ''),
    ]);
    const ids = run.mutants.map((m) => m.globalId);
    expect(() => assertSpanMap(result)).toThrow(
      new RegExp(`2 of 2 mutants failed[\\s\\S]*${ids.map(escape).join('[\\s\\S]*')}`),
    );
  });
});

function escape(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\/-]/g, '\\$&');
}
