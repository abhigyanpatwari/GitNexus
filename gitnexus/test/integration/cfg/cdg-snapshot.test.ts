import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import Parser from 'tree-sitter';
import TypeScript from 'tree-sitter-typescript';
import { collectFunctionCfgs } from '../../../src/core/ingestion/cfg/collect.js';
import { computeControlDependence } from '../../../src/core/ingestion/cfg/control-dependence.js';
import { computePostDominators } from '../../../src/core/ingestion/cfg/post-dominators.js';
import { getProvider } from '../../../src/core/ingestion/languages/index.js';
import { SupportedLanguages } from '../../../src/config/supported-languages.js';
import type { FunctionCfg } from '../../../src/core/ingestion/cfg/types.js';

// #2085 M5 AC1 — a committed snapshot of the CDG edge set on the shared M1
// fixture (the same `ten-functions.ts` the REACHING_DEF snapshot uses). The
// serialization is deterministic — sorted `controller->dependent:label`
// strings — so any post-dominator / Ferrante behavior change shows as a
// reviewable snapshot diff, never silent drift.

const FIXTURES = path.join(__dirname, 'fixtures');

function cfgsOfFile(file: string): readonly FunctionCfg[] {
  const visitor = getProvider(SupportedLanguages.TypeScript).cfgVisitor;
  if (!visitor) throw new Error('no cfgVisitor');
  const source = fs.readFileSync(path.join(FIXTURES, file), 'utf8');
  const parser = new Parser();
  parser.setLanguage(TypeScript.typescript);
  return collectFunctionCfgs(parser.parse(source).rootNode, visitor, file).cfgs;
}

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
    expect(cfgs.map(serialize)).toMatchSnapshot();
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
