import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { scoreImpactRisk, type ImpactRisk, type ImpactRiskInput } from 'gitnexus-shared';

// Issue #2975: the impact skill's risk table is user-facing guidance for the
// edit gate. Assert every documented threshold boundary against the runtime
// scorer so the two cannot drift apart again. The shipped skill copies are
// byte-identical to this one (shipped-skills-sync.test.ts).

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const SKILL = path.join(REPO_ROOT, '.claude', 'skills', 'gitnexus-impact-analysis', 'SKILL.md');

const RANK: Record<Exclude<ImpactRisk, 'UNKNOWN'>, number> = {
  LOW: 0,
  MEDIUM: 1,
  HIGH: 2,
  CRITICAL: 3,
};
const GRADED = ['CRITICAL', 'HIGH', 'MEDIUM'] as const;
type Graded = (typeof GRADED)[number];
type Axis = 'direct' | 'processes' | 'modules' | 'total';

const skill = fs.readFileSync(SKILL, 'utf-8');

function riskTableRows(): Map<string, { upstream: string; downstream: string }> {
  const section = skill.split('## Risk Assessment')[1]?.split('\n## ')[0];
  if (!section) throw new Error('Risk Assessment section not found in impact skill');
  const rows = new Map<string, { upstream: string; downstream: string }>();
  for (const line of section.split('\n')) {
    const cells = line
      .split('|')
      .slice(1, -1)
      .map((cell) => cell.trim());
    if (cells.length !== 3 || !/^[A-Z]+$/.test(cells[0])) continue;
    rows.set(cells[0], { upstream: cells[1], downstream: cells[2] });
  }
  return rows;
}

function row(level: string): { upstream: string; downstream: string } {
  const found = riskTableRows().get(level);
  if (!found) throw new Error(`Risk table has no ${level} row`);
  return found;
}

function upstream(directCount: number): ImpactRisk {
  return scoreImpactRisk({
    direction: 'upstream',
    directCount,
    processCount: 0,
    moduleCount: 0,
    impactedCount: Math.max(directCount, 1),
  }).risk;
}

function downstream(axis: Axis, value: number): ImpactRisk {
  const input: ImpactRiskInput = {
    direction: 'downstream',
    directCount: 0,
    processCount: 0,
    moduleCount: 0,
    impactedCount: 0,
  };
  if (axis === 'direct') input.directCount = value;
  if (axis === 'processes') input.processCount = value;
  if (axis === 'modules') input.moduleCount = value;
  if (axis === 'total') input.impactedCount = value;
  return scoreImpactRisk(input).risk;
}

function rank(risk: ImpactRisk): number {
  if (risk === 'UNKNOWN') throw new Error('unexpected UNKNOWN on a nonempty walk');
  return RANK[risk];
}

describe('impact skill risk table matches scoreImpactRisk (#2975)', () => {
  it('documents every graded level', () => {
    for (const level of [...GRADED, 'LOW', 'UNKNOWN'])
      expect(riskTableRows().has(level)).toBe(true);
  });

  it.each(GRADED)(
    'upstream %s starts at the documented direct-dependant count',
    (level: Graded) => {
      const bound = Number(row(level).upstream.match(/\d+/)?.[0]);
      expect(Number.isInteger(bound)).toBe(true);
      expect(upstream(bound)).toBe(level);
      expect(rank(upstream(bound - 1))).toBeLessThan(RANK[level]);
    },
  );

  it('upstream LOW covers the counts below MEDIUM, and an empty walk is UNKNOWN', () => {
    const mediumBound = Number(row('MEDIUM').upstream.match(/\d+/)?.[0]);
    expect(row('LOW').upstream).toContain(`Fewer than ${mediumBound}`);
    expect(upstream(mediumBound - 1)).toBe('LOW');
    expect(
      scoreImpactRisk({
        direction: 'upstream',
        directCount: 0,
        processCount: 0,
        moduleCount: 0,
        impactedCount: 0,
      }).risk,
    ).toBe('UNKNOWN');
  });

  it.each(GRADED)('downstream %s thresholds are the scorer boundaries', (level: Graded) => {
    const thresholds = [
      ...row(level).downstream.matchAll(/(\d+) (direct|processes|modules|total)/g),
    ];
    expect(thresholds.length).toBeGreaterThan(0);
    for (const [, value, axis] of thresholds) {
      const bound = Number(value);
      expect(downstream(axis as Axis, bound), `${axis} = ${bound}`).toBe(level);
      expect(rank(downstream(axis as Axis, bound - 1)), `${axis} = ${bound - 1}`).toBeLessThan(
        RANK[level],
      );
    }
  });

  it('does not present depth-1 dependents as certain breakage', () => {
    expect(skill).not.toMatch(/WILL BREAK/);
  });
});
