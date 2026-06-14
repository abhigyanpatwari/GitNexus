import { describe, it, expect } from 'vitest';
import Parser from 'tree-sitter';
import TypeScript from 'tree-sitter-typescript';
import {
  createTypeScriptCfgVisitor,
  TS_FUNCTION_TYPES,
} from '../../../src/core/ingestion/cfg/visitors/typescript.js';
import { hasTaintSafeSites } from '../../../src/core/ingestion/taint/site-safety.js';
import { isEmitSafeCfg, hasEmitSafeFacts } from '../../../src/core/ingestion/cfg/emit.js';
import type {
  FunctionCfg,
  SiteRecord,
  StatementFacts,
} from '../../../src/core/ingestion/cfg/types.js';
import type { SyntaxNode } from '../../../src/core/ingestion/utils/ast-helpers.js';

// #2083 M3 U1 — `hasTaintSafeSites` mirrors `hasEmitSafeFacts`'s contract:
// out-of-range indices from a corrupted durable store must degrade to
// "skip taint for this function", never crash or fabricate matches. These
// tests build a REAL harvested CFG, then surgically corrupt the `sites`
// payload field-by-field — and pin that corrupt sites do NOT trip the
// CFG/REACHING_DEF guards (the degradation is taint-local).

const visitor = createTypeScriptCfgVisitor();

function cfgOf(code: string): FunctionCfg {
  const parser = new Parser();
  parser.setLanguage(TypeScript.typescript);
  const root = parser.parse(code).rootNode as SyntaxNode;
  const stack = [root];
  while (stack.length) {
    const n = stack.pop() as SyntaxNode;
    if (TS_FUNCTION_TYPES.has(n.type)) {
      const cfg = visitor.buildFunctionCfg(n, 'fixture.ts');
      if (cfg) return cfg;
    }
    for (let i = n.namedChildCount - 1; i >= 0; i--) {
      const c = n.namedChild(i);
      if (c) stack.push(c);
    }
  }
  throw new Error('no function found');
}

const BASE = cfgOf(`function f(req, x) { const b = req.body; exec(escape(x), b); }`);

/** Deep-copy and rewrite the FIRST site of the FIRST site-bearing statement. */
function mutateFirstSite(patch: (site: Record<string, unknown>) => void): FunctionCfg {
  const copy = JSON.parse(JSON.stringify(BASE)) as FunctionCfg;
  for (const block of copy.blocks) {
    for (const s of block.statements ?? []) {
      if (s.sites && s.sites.length > 0) {
        patch(s.sites[0] as unknown as Record<string, unknown>);
        return copy;
      }
    }
  }
  throw new Error('no site-bearing statement in fixture');
}

describe('hasTaintSafeSites — valid shapes pass', () => {
  it('a real harvested CFG passes', () => {
    expect(hasTaintSafeSites(BASE)).toBe(true);
  });

  it('a CFG with facts but no sites passes (absence is the well-formed empty case)', () => {
    const cfg = cfgOf(`function f() { let a = 1; a = 2; }`);
    expect(hasTaintSafeSites(cfg)).toBe(true);
  });

  it('a pre-M2 CFG with no statements at all passes', () => {
    const copy = JSON.parse(JSON.stringify(BASE)) as FunctionCfg;
    const stripped = {
      ...copy,
      bindings: undefined,
      blocks: copy.blocks.map((b) => ({ ...b, statements: undefined })),
    } as FunctionCfg;
    expect(hasTaintSafeSites(stripped)).toBe(true);
  });

  it('the full M3 surface validates on a JSON round-trip (durable-store shape)', () => {
    const cfg = cfgOf(
      'function f(req, dir, t) { const cp = require("child_process"); ' +
        'cp.exec(`ls ${dir}`); sql`q ${t}`; new Function(t); exec(...dir); }',
    );
    expect(hasTaintSafeSites(JSON.parse(JSON.stringify(cfg)) as FunctionCfg)).toBe(true);
  });
});

describe('hasTaintSafeSites — malformed indices reject', () => {
  it('out-of-range receiver', () => {
    expect(hasTaintSafeSites(mutateFirstSite((s) => (s.receiver = 999)))).toBe(false);
    expect(hasTaintSafeSites(mutateFirstSite((s) => (s.receiver = -1)))).toBe(false);
    expect(hasTaintSafeSites(mutateFirstSite((s) => (s.receiver = 1.5)))).toBe(false);
  });

  it('out-of-range member-read object / missing property', () => {
    const cfg = cfgOf(`function f(req) { const b = req.body; }`);
    const corrupt = JSON.parse(JSON.stringify(cfg)) as FunctionCfg;
    const site = corrupt.blocks.flatMap((b) => [...(b.statements ?? [])]).find((s) => s.sites)!
      .sites![0] as unknown as Record<string, unknown>;
    site.object = 999;
    expect(hasTaintSafeSites(corrupt)).toBe(false);
    site.object = 0;
    delete site.property;
    expect(hasTaintSafeSites(corrupt)).toBe(false);
  });

  it('out-of-range arg binding entry and via-site tag', () => {
    expect(hasTaintSafeSites(mutateFirstSite((s) => (s.args = [[999]])))).toBe(false);
    // via-tag site index must be in range of the SAME statement's sites array
    expect(hasTaintSafeSites(mutateFirstSite((s) => (s.args = [[[0, 999]]])))).toBe(false);
    expect(hasTaintSafeSites(mutateFirstSite((s) => (s.args = [[[0, -1]]])))).toBe(false);
    // tuple arity is exact
    expect(hasTaintSafeSites(mutateFirstSite((s) => (s.args = [[[0, 1, 2]]])))).toBe(false);
    expect(hasTaintSafeSites(mutateFirstSite((s) => (s.args = [['x']])))).toBe(false);
    expect(hasTaintSafeSites(mutateFirstSite((s) => (s.args = [0])))).toBe(false);
  });

  it('out-of-range resultDefs / parent / spread / kind / callee', () => {
    expect(hasTaintSafeSites(mutateFirstSite((s) => (s.resultDefs = [999])))).toBe(false);
    expect(hasTaintSafeSites(mutateFirstSite((s) => (s.parent = [999, 0])))).toBe(false);
    expect(hasTaintSafeSites(mutateFirstSite((s) => (s.parent = [0, -1])))).toBe(false);
    expect(hasTaintSafeSites(mutateFirstSite((s) => (s.parent = [0])))).toBe(false);
    expect(hasTaintSafeSites(mutateFirstSite((s) => (s.spread = -1)))).toBe(false);
    expect(hasTaintSafeSites(mutateFirstSite((s) => (s.kind = 'evil')))).toBe(false);
    expect(hasTaintSafeSites(mutateFirstSite((s) => (s.callee = 42)))).toBe(false);
    expect(hasTaintSafeSites(mutateFirstSite((s) => (s.requireArg = 42)))).toBe(false);
  });

  it('sites without a binding table reject (nothing to range-check against)', () => {
    const copy = JSON.parse(JSON.stringify(BASE)) as { bindings?: unknown };
    delete copy.bindings;
    expect(hasTaintSafeSites(copy as FunctionCfg)).toBe(false);
  });

  it('non-array sites and null site entries reject', () => {
    const corrupt = JSON.parse(JSON.stringify(BASE)) as FunctionCfg;
    const stmt = corrupt.blocks.flatMap((b) => [...(b.statements ?? [])]).find((s) => s.sites) as {
      sites: unknown;
    };
    stmt.sites = { not: 'an array' };
    expect(hasTaintSafeSites(corrupt)).toBe(false);
    stmt.sites = [null];
    expect(hasTaintSafeSites(corrupt)).toBe(false);
  });
});

describe('hasTaintSafeSites — degradation is taint-local (KTD2)', () => {
  it('corrupt sites do NOT trip the CFG or REACHING_DEF guards', () => {
    const corrupt = mutateFirstSite((s) => (s.receiver = 999));
    expect(hasTaintSafeSites(corrupt)).toBe(false);
    // The CFG layer and the facts layer keep their own guards green — the
    // function degrades to "no taint", never to "no CFG"/"no REACHING_DEF".
    expect(isEmitSafeCfg(corrupt)).toBe(true);
    expect(hasEmitSafeFacts(corrupt)).toBe(true);
  });

  it('and the inverse: corrupt FACTS are not a sites problem (separate guards)', () => {
    const corrupt = JSON.parse(JSON.stringify(BASE)) as FunctionCfg;
    const stmt = corrupt.blocks.flatMap((b) => [...(b.statements ?? [])])[1] as StatementFacts & {
      defs: number[];
    };
    stmt.defs.push(999);
    expect(hasEmitSafeFacts(corrupt)).toBe(false);
    const sites: readonly SiteRecord[] | undefined = corrupt.blocks
      .flatMap((b) => [...(b.statements ?? [])])
      .find((s) => s.sites)?.sites;
    expect(sites).toBeDefined();
    expect(hasTaintSafeSites(corrupt)).toBe(true);
  });
});
