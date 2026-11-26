import { describe, it } from 'node:test';
import { expect } from 'expect';
import { readFileSync } from 'node:fs';
import { cfgsOfFile } from '../support/cfg-fixture.js';
import { computeControlDependence } from '../../../../src/core/ingestion/cfg/control-dependence.js';
import { computePostDominators } from '../../../../src/core/ingestion/cfg/post-dominators.js';
import type { FunctionCfg } from '../../../../src/core/ingestion/cfg/types.js';

// #2085 M5 AC1 — a committed snapshot of the CDG edge set on the shared M1
// fixture (the same `ten-functions.ts` the REACHING_DEF snapshot uses). The
// serialization is deterministic — sorted `controller->dependent:label`
// strings — so any post-dominator / Ferrante behavior change shows as a
// reviewable snapshot diff, never silent drift.

const expected = JSON.parse(
  readFileSync(new URL('../snapshots/cdg.json', import.meta.url), 'utf8'),
);

/** Deterministic rendering: startLine + sorted controller->dependent:label. */
function serialize(cfg: FunctionCfg): Record<string, unknown> {
  const { edges } = computeControlDependence(cfg);
  return {
    startLine: cfg.functionStartLine,
    cdg: edges.map((e) => `${e.controllerBlock}->${e.dependentBlock}:${e.label}`),
  };
}

describe('AC1 — CDG snapshot on the M1 fixture', () => {
  it('matches the committed control-dependence set for every fixture function', () => {
    const cfgs = cfgsOfFile('ten-functions.ts');
    expect(cfgs).toHaveLength(12);
    expect(cfgs.map(serialize)).toEqual(expected);
  });

  it('every CDG edge references in-range blocks with a valid T/F label (AC2 sanity)', () => {
    for (const cfg of cfgsOfFile('ten-functions.ts')) {
      const tree = computePostDominators(cfg);
      for (const e of computeControlDependence(cfg, tree).edges) {
        expect(e.controllerBlock).toBeGreaterThanOrEqual(0);
        expect(e.controllerBlock).toBeLessThan(cfg.blocks.length);
        expect(e.dependentBlock).toBeGreaterThanOrEqual(0);
        expect(e.dependentBlock).toBeLessThan(cfg.blocks.length);
        expect(['T', 'F']).toContain(e.label);
      }
    }
  });
});
