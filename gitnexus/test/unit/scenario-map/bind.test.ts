/**
 * Locks the test side of the value-flow check (U10, R9, KTD11 "Test side (Babel)", design §5.3a
 * step 1): each differing discarded value of a pair (real U6 facets) is bound to where it enters
 * production code, a call argument (callee and argument index), a field of a fixture object or
 * array, or a table key (an `it.each` row value), following `const` bindings. A differing expected
 * value follows the input that produced it; when only expected values differ the pair is unknown
 * (`expected-only`). A value transformed by test code, used nowhere, or bound differently by the
 * two tests is unknown.
 */
import { describe, expect, it } from 'vitest';
import {
  computeFacet,
  createFacetContext,
  type FacetSources,
  type FacetSubject,
} from '../../../tools/scenario-map/facet/input-facet.js';
import { expandCases } from '../../../tools/scenario-map/inventory/cases.js';
import {
  bindPair,
  bindSideOf,
  type BindResult,
  type BindSide,
} from '../../../tools/scenario-map/value-flow/bind.js';

const TEST_FILE = 'gitnexus/test/unit/a.test.ts';
const PACKAGE_FILE = 'test/unit/a.test.ts';
const M = 'gitnexus/src/m.ts';
const PRODUCTION = [
  'export function roundScore(raw: number): number { return Math.round(raw); }',
  'export function formatTags(tags: readonly string[]): string { return tags.join(); }',
  'export function configure(options: { ratio: number }): number { return options.ratio; }',
  'export class Box { constructor(readonly size: number) {} }',
  'export function pick(first: number, second: number): number { return first + second; }',
].join('\n');
const IMPORTS = `import { Box, configure, formatTags, pick, roundScore } from '../../src/m.js';`;

const memorySources = (files: Record<string, string>): FacetSources => ({
  read: (file) => files[file] ?? null,
  list: (dir) =>
    Object.keys(files)
      .filter((file) => file.startsWith(`${dir}/`))
      .sort(),
});

/** The two bind sides of the instances written in `body`, with real U6 facets. */
async function sidesOf(body: string): Promise<[BindSide, BindSide]> {
  const source = [IMPORTS, `describe('d', () => {`, body, `});`].join('\n');
  const sites = expandCases([{ path: TEST_FILE, source }]).sites;
  const ctx = createFacetContext({
    sources: memorySources({ [M]: PRODUCTION, [TEST_FILE]: source }),
    productionFiles: [M],
    closures: new Map([[PACKAGE_FILE, [TEST_FILE, M]]]),
    builtinFiles: [],
  });
  const subjects: FacetSubject[] = sites.flatMap((site) =>
    (site.instances ?? []).map((instance) => ({
      id: `${PACKAGE_FILE}#d > ${site.record.title}#${instance.row}`,
      file: PACKAGE_FILE,
      record: site.record,
      instance,
      executedFiles: [M],
    })),
  );
  expect(subjects).toHaveLength(2);
  const sides = await Promise.all(
    subjects.map(async (subject) =>
      bindSideOf(subject.record, (await computeFacet(subject, ctx)).discarded, source),
    ),
  );
  return [sides[0], sides[1]];
}

/** The result without AST-dependent detail, for comparison. */
function summary(result: BindResult): unknown {
  return {
    status: result.status,
    reasons: result.reasons,
    entries: result.entries.map(
      (entry) =>
        `${entry.kind} ${entry.isNew ? 'new ' : ''}${entry.callee}#${entry.argIndex}${entry.path.length > 0 ? ` ${entry.path.join('.')}` : ''} @${entry.position}`,
    ),
    roles: result.positions.map((position) => `${position.position}:${position.role}`),
  };
}

const twoTests = (first: string, second: string): string =>
  `it('a', () => { ${first} });\nit('b', () => { ${second} });`;

describe('bindPair: entries', () => {
  it.each([
    {
      title: 'a call argument, with the expected value following its input',
      body: twoTests('expect(roundScore(2.4)).toBe(2);', 'expect(roundScore(2.5)).toBe(3);'),
      want: {
        status: 'bound',
        reasons: [],
        entries: ['call-argument roundScore#0 @0'],
        roles: ['0:input', '1:expected'],
      },
    },
    {
      title: 'a call argument through a const binding',
      body: twoTests(
        'const raw = 2.4; expect(roundScore(raw)).toBe(2);',
        'const raw = 2.5; expect(roundScore(raw)).toBe(3);',
      ),
      want: {
        status: 'bound',
        reasons: [],
        entries: ['call-argument roundScore#0 @0'],
        roles: ['0:input', '1:expected'],
      },
    },
    {
      title: 'a fixture field',
      body: twoTests(
        'expect(configure({ ratio: 2.4 })).toBeGreaterThan(2);',
        'expect(configure({ ratio: 2.5 })).toBeGreaterThan(2);',
      ),
      want: {
        status: 'bound',
        reasons: [],
        entries: ['fixture-field configure#0 ratio @0'],
        roles: ['0:input'],
      },
    },
    {
      title: 'a constructor argument',
      body: twoTests(
        'expect(new Box(2.4).size).toBe(2.4);',
        'expect(new Box(2.5).size).toBe(2.5);',
      ),
      want: {
        status: 'bound',
        reasons: [],
        entries: ['call-argument new Box#0 @0'],
        roles: ['0:input', '1:expected'],
      },
    },
    {
      title: 'a table key: an it.each row value read by the body',
      body: "it.each([[2.4, 2], [2.5, 3]])('rounds %s', (raw, want) => { expect(roundScore(raw)).toBe(want); });",
      want: {
        status: 'bound',
        reasons: [],
        entries: ['table-key roundScore#0 @0'],
        roles: ['0:input', '1:expected'],
      },
    },
    {
      title: 'a table key read through a shorthand property of a fixture',
      body: "it.each([{ ratio: 2.4 }, { ratio: 2.5 }])('ratio $ratio', ({ ratio }) => { expect(configure({ ratio })).toBeGreaterThan(2); });",
      want: {
        status: 'bound',
        reasons: [],
        entries: ['table-key configure#0 ratio @0'],
        roles: ['0:input'],
      },
    },
  ])('$title', async ({ body, want }) => {
    const [a, b] = await sidesOf(body);
    expect(summary(bindPair(a, b))).toEqual(want);
  });
});

describe('bindPair: unknown and not required', () => {
  it.each([
    {
      title: 'only the expected values differ (expected-only)',
      body: [
        "const tags = ['x', 'y'];",
        twoTests(
          "expect(formatTags(tags)).toContain('alpha');",
          "expect(formatTags(tags)).toContain('beta');",
        ),
      ].join('\n'),
      want: { status: 'unknown', reasons: ['expected-only'], entries: [], roles: ['0:expected'] },
    },
    {
      title: 'a value transformed by test code',
      body: twoTests(
        'expect(roundScore(2.4 * 2)).toBeGreaterThan(2);',
        'expect(roundScore(2.5 * 2)).toBeGreaterThan(2);',
      ),
      want: {
        status: 'unknown',
        reasons: ['position 0: derived in the test (BinaryExpression)'],
        entries: [],
        roles: ['0:unbound'],
      },
    },
    {
      title: 'a value that reaches no call',
      body: twoTests(
        'const unused = 2.4; expect(roundScore(3)).toBe(3);',
        'const unused = 2.5; expect(roundScore(3)).toBe(3);',
      ),
      want: {
        status: 'unknown',
        reasons: ['position 0: unbound (never read)'],
        entries: [],
        roles: ['0:unbound'],
      },
    },
    {
      title: 'equal discarded values need no check',
      body: twoTests('expect(roundScore(2.4)).toBe(2);', 'expect(roundScore(2.4)).toBe(2);'),
      want: { status: 'not-required', reasons: [], entries: [], roles: [] },
    },
  ])('$title', async ({ body, want }) => {
    const [a, b] = await sidesOf(body);
    expect(summary(bindPair(a, b))).toEqual(want);
  });

  it('is unknown when the two tests bind a position to different arguments', async () => {
    const [a, b] = await sidesOf(
      twoTests(
        'const x = 2.4; expect(pick(x, 3)).toBe(1);',
        'const x = 2.5; expect(pick(3, x)).toBe(1);',
      ),
    );
    expect(summary(bindPair(a, b))).toEqual({
      status: 'unknown',
      reasons: ['position 0: the two tests bind it differently'],
      entries: [],
      roles: ['0:input'],
    });
  });

  it('is unknown when the discarded positions do not align', async () => {
    const [a, b] = await sidesOf(
      twoTests('expect(roundScore(2.4)).toBe(2);', 'expect(roundScore(2.5)).toBe(3);'),
    );
    expect(summary(bindPair(a, { ...b, discarded: b.discarded.slice(0, 1) }))).toEqual({
      status: 'unknown',
      reasons: ['discarded values do not align'],
      entries: [],
      roles: [],
    });
  });
});
