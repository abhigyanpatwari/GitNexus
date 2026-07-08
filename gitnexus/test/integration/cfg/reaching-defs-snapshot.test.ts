import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import Parser from 'tree-sitter';
import TypeScript from 'tree-sitter-typescript';
import { collectFunctionCfgs } from '../../../src/core/ingestion/cfg/collect.js';
import { computeReachingDefs } from '../../../src/core/ingestion/cfg/reaching-defs.js';
import { getProvider } from '../../../src/core/ingestion/languages/index.js';
import { SupportedLanguages } from '../../../src/config/supported-languages.js';
import type { FunctionCfg } from '../../../src/core/ingestion/cfg/types.js';

// #2082 M2 R5 acceptance: a committed snapshot of the REACHING_DEF facts on
// the M1 fixture (extended in U5 with the early-exit-finally + shadowing
// functions). The serialization is deterministic — sorted fact strings keyed
// by program points + binding identity — so any solver/harvest behavior
// change shows as a reviewable snapshot diff, never silent drift.

const FIXTURES = path.join(__dirname, 'fixtures');

function cfgsOfFile(file: string): readonly FunctionCfg[] {
  const visitor = getProvider(SupportedLanguages.TypeScript).cfgVisitor;
  if (!visitor) throw new Error('no cfgVisitor');
  const source = fs.readFileSync(path.join(FIXTURES, file), 'utf8');
  const parser = new Parser();
  parser.setLanguage(TypeScript.typescript);
  return collectFunctionCfgs(parser.parse(source).rootNode, visitor, file).cfgs;
}

/** Deterministic rendering: defBlock:stmt->useBlock:stmt:bindingKey */
function serialize(cfg: FunctionCfg): Record<string, unknown> {
  const r = computeReachingDefs(cfg);
  const key = (idx: number): string => {
    const b = r.bindings[idx];
    return b.synthetic ? `${b.name}@module` : `${b.name}:${b.declLine}:${b.declColumn}`;
  };
  return {
    startLine: cfg.functionStartLine,
    status: r.status,
    defs: r.defCount,
    uses: r.useCount,
    facts: r.facts.map(
      (f) =>
        `${f.def.blockIndex}:${f.def.stmtIndex}->${f.use.blockIndex}:${f.use.stmtIndex}:${key(f.bindingIdx)}`,
    ),
  };
}

describe('R5 — REACHING_DEF facts snapshot on the M1 fixture', () => {
  it('matches the committed fact set for every fixture function', () => {
    const cfgs = cfgsOfFile('ten-functions.ts');
    expect(cfgs).toHaveLength(12);
    expect(cfgs.map(serialize)).toMatchSnapshot();
  });

  it('every fixture function computes (no truncation at default limits, no no-facts)', () => {
    for (const cfg of cfgsOfFile('ten-functions.ts')) {
      const r = computeReachingDefs(cfg);
      expect(r.status).toBe('computed');
    }
  });

  it('acceptance shapes: the finally redefinition and the shadowed binding behave per R4/R9', () => {
    const cfgs = cfgsOfFile('ten-functions.ts');
    const byLine = new Map(cfgs.map((c) => [c.functionStartLine, c]));

    // withEarlyExitFinally — `val = 2` (finally) is the ONLY def reaching the
    // post-try return; the early return's use sees the original `val = 1`.
    const early = [...byLine.values()].find((c) =>
      c.blocks.some((b) => b.text.includes('return probe(val)')),
    )!;
    const re = computeReachingDefs(early);
    const val = re.bindings.findIndex((b) => b.name === 'val');
    const probeUses = re.facts.filter(
      (f) => f.bindingIdx === val && early.blocks[f.use.blockIndex].text.includes('probe'),
    );
    const finalUses = re.facts.filter(
      (f) => f.bindingIdx === val && early.blocks[f.use.blockIndex].text.includes('return val'),
    );
    expect(probeUses).toHaveLength(1);
    expect(early.blocks[probeUses[0].def.blockIndex].text).toContain('let val = 1');
    expect(finalUses).toHaveLength(1);
    expect(early.blocks[finalUses[0].def.blockIndex].text).toContain('val = 2');

    // withShadowing — two distinct `s` bindings; each use resolves to its own.
    const shadow = [...byLine.values()].find((c) =>
      c.blocks.some((b) => b.text.includes('done2(s)')),
    )!;
    const rs = computeReachingDefs(shadow);
    const sBindings = rs.bindings.filter((b) => b.name === 's');
    expect(sBindings).toHaveLength(2);
    const factsByBinding = new Map<number, number>();
    for (const f of rs.facts) {
      factsByBinding.set(f.bindingIdx, (factsByBinding.get(f.bindingIdx) ?? 0) + 1);
    }
    // each s binding forms its own facts (no cross-kill, no cross-reach): the
    // inner block's reassign+use never references the outer binding and vice
    // versa — both have facts, and every fact's def and use share the binding
    // by construction of DefUseFact, so distinct counts per binding prove the
    // bindings never conflated.
    const sIdxs = rs.bindings.map((b, i) => (b.name === 's' ? i : -1)).filter((i) => i >= 0);
    for (const idx of sIdxs) expect(factsByBinding.get(idx) ?? 0).toBeGreaterThanOrEqual(2);
  });
});
