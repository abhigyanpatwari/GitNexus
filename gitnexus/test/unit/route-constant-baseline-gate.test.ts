// Bench --check GATE scorer for shared route-constant baselines
// (missing/non-numeric budgets must fail --check).
//
// Asserts the PURE helper (`collectBaselineErrors`) that `runBaselineCheck`
// / tRPC `measure.mjs` use — on SYNTHETIC report + baseline shapes ONLY, no
// 800-router extract, no process.exit. The helper lives in the build-free
// `.mjs` harness, imported directly here, so this test is deterministic and
// stays OUT of the full bench lane (mirroring
// impact-pdg-id-bridge-gate.test.ts). Live timing arms run only via
// `node --import tsx bench/*/measure.mjs --check`, never in `npm test`.

import { describe, expect, it } from 'vitest';
// @ts-expect-error — .mjs pure-JS harness module, no types (intentional; build-free).
import * as G from '../../bench/lib/route-constant-guard.mjs';

const collectBaselineErrors = G.collectBaselineErrors as (
  report: Record<string, unknown>,
  baseline: Record<string, unknown>,
) => string[];

const FINGERPRINT = 'gate-fingerprint';

const reportAllThree = {
  fingerprint: FINGERPRINT,
  scaling_ratio: 1.2,
  absolute_ms: 40,
  widening_overhead: 2.0,
};

const baselineAllThree = {
  fingerprint: FINGERPRINT,
  scaling_budget: 1.8,
  absolute_ms_budget: 160,
  widening_overhead_budget: 3.5,
};

describe('route-constant baseline gate — collectBaselineErrors()', () => {
  it('fails closed when scaling_budget is missing — DELETED GATE', () => {
    const errors = collectBaselineErrors(reportAllThree, { fingerprint: FINGERPRINT });
    expect(errors.join(' ')).toContain('DELETED GATE');
    expect(errors.join(' ')).toContain('no numeric scaling_budget');
  });

  it('fails closed when scaling_budget is NaN or a string', () => {
    const nanErrors = collectBaselineErrors(reportAllThree, {
      fingerprint: FINGERPRINT,
      scaling_budget: Number.NaN,
    });
    const stringErrors = collectBaselineErrors(reportAllThree, {
      fingerprint: FINGERPRINT,
      scaling_budget: '1.8',
    });
    expect(nanErrors.join(' ')).toContain('no numeric scaling_budget');
    expect(stringErrors.join(' ')).toContain('no numeric scaling_budget');
  });

  it('fails closed when report.absolute_ms is present but absolute_ms_budget is missing', () => {
    const errors = collectBaselineErrors(
      { fingerprint: FINGERPRINT, scaling_ratio: 1.0, absolute_ms: 10 },
      { fingerprint: FINGERPRINT, scaling_budget: 1.6 },
    );
    expect(errors.join(' ')).toMatch(/no numeric absolute_ms_budget|DELETED GATE/);
  });

  it('fails closed when report.widening_overhead is present but widening_overhead_budget is missing', () => {
    const errors = collectBaselineErrors(
      { fingerprint: FINGERPRINT, scaling_ratio: 1.0, widening_overhead: 1.2 },
      { fingerprint: FINGERPRINT, scaling_budget: 1.6 },
    );
    expect(errors.join(' ')).toMatch(/no numeric widening_overhead_budget|DELETED GATE/);
  });

  it('does not require absolute/widening budgets when those report fields are absent (java-wildcard shape)', () => {
    const errors = collectBaselineErrors(
      { fingerprint: FINGERPRINT, scaling_ratio: 1.1 },
      { fingerprint: FINGERPRINT, scaling_budget: 1.6 },
    );
    expect(
      errors.filter((e) => e.includes('absolute_ms') || e.includes('widening_overhead')),
    ).toEqual([]);
    expect(errors).toEqual([]);
  });

  it('reports comparison errors when present budgets are overrun', () => {
    const errors = collectBaselineErrors(
      {
        fingerprint: FINGERPRINT,
        scaling_ratio: 2.0,
        absolute_ms: 200,
        widening_overhead: 5,
      },
      baselineAllThree,
    );
    expect(errors.join(' ')).toContain('scaling_ratio 2 > 1.8');
    expect(errors.join(' ')).toContain('absolute_ms 200 > 160');
    expect(errors.join(' ')).toContain('widening_overhead 5 > 3.5');
  });

  it('returns no errors on the happy path with all three budgets', () => {
    expect(collectBaselineErrors(reportAllThree, baselineAllThree)).toEqual([]);
  });

  it('fails closed when report.chain_scaling_ratio is present but chain_scaling_budget is missing', () => {
    const errors = collectBaselineErrors(
      { fingerprint: FINGERPRINT, scaling_ratio: 1.0, chain_scaling_ratio: 1.5 },
      { fingerprint: FINGERPRINT, scaling_budget: 1.6 },
    );
    expect(errors.join(' ')).toContain('DELETED GATE');
    expect(errors.join(' ')).toContain('no numeric chain_scaling_budget');
  });

  it('reports overrun against a numeric chain_scaling_budget', () => {
    const errors = collectBaselineErrors(
      { fingerprint: FINGERPRINT, scaling_ratio: 1.0, chain_scaling_ratio: 3 },
      { fingerprint: FINGERPRINT, scaling_budget: 1.6, chain_scaling_budget: 2.8 },
    );
    expect(errors.join(' ')).toContain('chain_scaling_ratio 3 > 2.8');
  });
});
