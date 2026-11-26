import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { scoreImpactRisk, type ImpactRisk, type ImpactRiskInput } from 'gitnexus-shared';
import { getNextStepHint } from '../../src/mcp/server.js';
import { GITNEXUS_TOOLS } from '../../src/mcp/tools.js';

// Issue #2975: the impact skill's Risk Assessment table is the user-facing
// statement of the edit gate. Every threshold it documents is checked against
// scoreImpactRisk at the boundary and one below it, so the table and the
// scorer cannot drift apart. The shipped skill copies are byte-identical to
// this file (shipped-skills-sync.test.ts).

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const SKILL_PATH = path.join(
  REPO_ROOT,
  '.claude',
  'skills',
  'gitnexus-impact-analysis',
  'SKILL.md',
);
const skill = fs.readFileSync(SKILL_PATH, 'utf-8');

// Highest first: the documented level is the first one whose threshold is met.
const GRADED = ['CRITICAL', 'HIGH', 'MEDIUM'] as const;
type Graded = (typeof GRADED)[number];
type Axis = 'direct' | 'processes' | 'modules' | 'total';

interface RiskRow {
  upstream: string;
  downstream: string;
}

function readRiskTable(): Map<string, RiskRow> {
  const section = skill.split('## Risk Assessment')[1]?.split('\n## ')[0];
  if (!section) throw new Error('impact skill has no Risk Assessment section');
  const rows = new Map<string, RiskRow>();
  for (const line of section.split('\n')) {
    const cells = line
      .split('|')
      .slice(1, -1)
      .map((cell) => cell.trim());
    if (cells.length === 3 && /^[A-Z]+$/.test(cells[0])) {
      rows.set(cells[0], { upstream: cells[1], downstream: cells[2] });
    }
  }
  return rows;
}

const table = readRiskTable();

function row(level: string): RiskRow {
  const found = table.get(level);
  if (!found) throw new Error(`impact skill risk table has no ${level} row`);
  return found;
}

const upstreamBound = Object.fromEntries(
  GRADED.map((level) => {
    const bound = Number(row(level).upstream.match(/^\d+/)?.[0]);
    if (!Number.isInteger(bound)) throw new Error(`${level} row has no upstream bound`);
    return [level, bound];
  }),
) as Record<Graded, number>;

const downstreamBounds = Object.fromEntries(
  GRADED.map((level) => {
    const bounds: Partial<Record<Axis, number>> = {};
    for (const [, value, axis] of row(level).downstream.matchAll(
      /(\d+) (direct|processes|modules|total)/g,
    )) {
      bounds[axis as Axis] = Number(value);
    }
    if (Object.keys(bounds).length === 0) throw new Error(`${level} row has no downstream bound`);
    return [level, bounds];
  }),
) as Record<Graded, Partial<Record<Axis, number>>>;

function documentedRisk(input: ImpactRiskInput): ImpactRisk {
  const measured: Record<Axis, number> = {
    direct: input.directCount,
    processes: input.processCount,
    modules: input.moduleCount,
    total: input.impactedCount,
  };
  for (const level of GRADED) {
    if (input.direction === 'upstream' && input.directCount >= upstreamBound[level]) return level;
    if (
      input.direction === 'downstream' &&
      Object.entries(downstreamBounds[level]).some(
        ([axis, bound]) => measured[axis as Axis] >= bound,
      )
    ) {
      return level;
    }
  }
  return 'LOW';
}

function upstreamInput(directCount: number): ImpactRiskInput {
  return {
    direction: 'upstream',
    directCount,
    processCount: 0,
    moduleCount: 0,
    impactedCount: directCount,
  };
}

// One measured axis at a time; total reach is never below the direct count.
function downstreamInput(axis: Axis, value: number): ImpactRiskInput {
  const direct = axis === 'direct' ? value : 1;
  return {
    direction: 'downstream',
    directCount: direct,
    processCount: axis === 'processes' ? value : 0,
    moduleCount: axis === 'modules' ? value : 0,
    impactedCount: axis === 'total' ? value : direct,
  };
}

interface BoundaryCase {
  name: string;
  input: ImpactRiskInput;
  expected: ImpactRisk;
}

function boundaryCase(name: string, input: ImpactRiskInput): BoundaryCase {
  return { name, input, expected: documentedRisk(input) };
}

const upstreamCases = GRADED.flatMap((level) =>
  [upstreamBound[level] - 1, upstreamBound[level]].map((direct) =>
    boundaryCase(`${direct} direct`, upstreamInput(direct)),
  ),
);

const downstreamCases = GRADED.flatMap((level) =>
  Object.entries(downstreamBounds[level]).flatMap(([axis, bound]) =>
    [bound - 1, bound].map((value) =>
      boundaryCase(`${value} ${axis} (${level} row)`, downstreamInput(axis as Axis, value)),
    ),
  ),
);

describe('impact skill risk table matches scoreImpactRisk (#2975)', () => {
  it.each(upstreamCases)('upstream $name scores $expected', ({ input, expected }) => {
    expect(scoreImpactRisk(input).risk).toBe(expected);
  });

  it.each(downstreamCases)('downstream $name scores $expected', ({ input, expected }) => {
    expect(scoreImpactRisk(input).risk).toBe(expected);
  });

  it('documents upstream LOW as everything below the MEDIUM bound', () => {
    expect(row('LOW').upstream).toBe(`Fewer than ${upstreamBound.MEDIUM} on a nonempty walk`);
  });

  it('documents an empty upstream walk as UNKNOWN, as the scorer rates it', () => {
    expect(row('UNKNOWN').upstream).toMatch(/^Empty upstream walk/);
    expect(scoreImpactRisk(upstreamInput(0)).risk).toBe('UNKNOWN');
  });

  it('does not present depth-1 dependents as certain breakage', () => {
    expect(skill).not.toContain('WILL BREAK');
  });
});

// The boundary cases above come from the bounds the table lists, so a
// criterion deleted from the table would silently take its cases with it.
// Probe the scorer one axis at a time instead: the smallest value at which it
// reaches a level must be the smallest bound the table documents for that
// level or a higher one. A level reached only through a higher row's bound
// (MEDIUM at 3 processes, which is the HIGH bound) counts as that bound.
const RANK: Record<ImpactRisk, number> = { UNKNOWN: -1, LOW: 0, MEDIUM: 1, HIGH: 2, CRITICAL: 3 };
const PROBE_LIMIT = 1000;
const AXES: readonly Axis[] = ['direct', 'processes', 'modules', 'total'];

function scorerFirstValue(level: Graded, input: (value: number) => ImpactRiskInput) {
  for (let value = 1; value <= PROBE_LIMIT; value++) {
    if (RANK[scoreImpactRisk(input(value)).risk] >= RANK[level]) return value;
  }
  return undefined;
}

function documentedFirstValue(level: Graded, bound: (row: Graded) => number | undefined) {
  const bounds = GRADED.slice(0, GRADED.indexOf(level) + 1)
    .map(bound)
    .filter((value): value is number => value !== undefined);
  return bounds.length > 0 ? Math.min(...bounds) : undefined;
}

const coverageCases = GRADED.flatMap((level) => [
  {
    name: `upstream direct reaches ${level}`,
    level,
    input: upstreamInput,
    bound: (row: Graded) => upstreamBound[row],
  },
  ...AXES.map((axis) => ({
    name: `downstream ${axis} reaches ${level}`,
    level,
    input: (value: number) => downstreamInput(axis, value),
    bound: (row: Graded) => downstreamBounds[row][axis],
  })),
]);

describe('impact skill risk table lists every scoreImpactRisk criterion', () => {
  it.each(coverageCases)('$name at the documented bound', ({ level, input, bound }) => {
    expect(scorerFirstValue(level, input)).toBe(documentedFirstValue(level, bound));
  });
});

// The acceptance test in #2975: incomplete evidence must never read as a
// complete LOW (or MEDIUM). The table's UNKNOWN row says so; check the scorer
// keeps that promise at each graded bound, and that it leaves HIGH/CRITICAL
// standing, since a partial walk that already found that much is not safer.
describe('impact skill UNKNOWN row matches scoreImpactRisk on incomplete evidence', () => {
  it('documents incomplete evidence for LOW/MEDIUM as UNKNOWN', () => {
    expect(row('UNKNOWN').upstream).toContain('incomplete evidence for a LOW/MEDIUM rating');
    expect(row('UNKNOWN').downstream).toBe('Incomplete evidence for a LOW/MEDIUM rating');
  });

  const incompleteCases = [
    ...upstreamCases.map(({ name, input, expected }) => ({
      name: `upstream ${name}, incomplete walk`,
      input: { ...input, incompleteWalk: true },
      expected,
    })),
    ...downstreamCases.map(({ name, input, expected }) => ({
      name: `downstream ${name}, truncated enrichment`,
      input: {
        ...input,
        unusedAxes: [
          { axis: 'processes', reason: 'enrichment-truncated' },
          { axis: 'modules', reason: 'enrichment-truncated' },
        ] as const,
      },
      expected,
    })),
  ].map(({ name, input, expected }) => ({
    name,
    input,
    expected: expected === 'LOW' || expected === 'MEDIUM' ? ('UNKNOWN' as const) : expected,
  }));

  it.each(incompleteCases)('$name scores $expected', ({ input, expected }) => {
    expect(scoreImpactRisk(input).risk).toBe(expected);
  });
});

describe('impact tool runtime text matches the skill wording (#2975)', () => {
  it('does not tell MCP clients that depth-1 dependents will break', () => {
    const impact = GITNEXUS_TOOLS.find((tool) => tool.name === 'impact');
    expect(impact?.description).toContain('DIRECT — REVIEW FIRST');
    expect(impact?.description).not.toContain('WILL BREAK');
    expect(getNextStepHint('impact', {})).not.toContain('WILL BREAK');
  });

  it('names depth-1 items by the direction of the walk', () => {
    const upstream = getNextStepHint('impact', { direction: 'upstream' });
    const downstream = getNextStepHint('impact', { direction: 'downstream' });
    expect(upstream).toContain('direct dependents');
    expect(downstream).toContain('direct dependencies');
    expect(downstream).not.toContain('dependents');
    expect(upstream).not.toContain('WILL BREAK');
    expect(downstream).not.toContain('WILL BREAK');
  });

  it('describes depth-1 items for both directions in the tool description', () => {
    const description = GITNEXUS_TOOLS.find((tool) => tool.name === 'impact')?.description;
    expect(description).toContain('direct dependents upstream');
    expect(description).toContain('direct dependencies downstream');
    // Callers are one kind of dependent: EXTENDS/IMPLEMENTS edges are walked
    // too, and a downstream walk returns no callers at all.
    expect(description).not.toMatch(/review direct callers/i);
  });
});
