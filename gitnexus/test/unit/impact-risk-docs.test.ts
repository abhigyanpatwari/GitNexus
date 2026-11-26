import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { scoreImpactRisk, type ImpactRisk, type ImpactRiskInput } from 'gitnexus-shared';

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
