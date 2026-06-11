import { describe, it, expect } from 'vitest';
import Parser from 'tree-sitter';
import TypeScript from 'tree-sitter-typescript';
import { collectFunctionCfgs } from '../../../src/core/ingestion/cfg/collect.js';
import { computeChunkHash, mapReplacer, mapReviver } from '../../../src/storage/parse-cache.js';
import { getProvider } from '../../../src/core/ingestion/languages/index.js';
import { SupportedLanguages } from '../../../src/config/supported-languages.js';
import type { CfgVisitor } from '../../../src/core/ingestion/cfg/types.js';
import type { SyntaxNode } from '../../../src/core/ingestion/utils/ast-helpers.js';

// U3 — the worker→main boundary + cache coherence for the CFG side-channel.
// These pin the contracts that make the disk-store + warm/durable parse cache
// carry the CFG intact across the --pdg flag (R3, R4) WITHOUT spinning a real
// worker pool: the worker simply calls collectFunctionCfgs (tested here) and
// attaches the result as plain data, and the parse-cache key folds the flag.

function tsRoot(code: string): SyntaxNode {
  const parser = new Parser();
  parser.setLanguage(TypeScript.typescript);
  return parser.parse(code).rootNode;
}

const tsVisitor = (): CfgVisitor<SyntaxNode> => {
  const v = getProvider(SupportedLanguages.TypeScript).cfgVisitor;
  if (!v) throw new Error('typescript provider has no cfgVisitor');
  return v;
};

describe('U3 — TS/JS provider exposes a cfgVisitor; others do not (worker gate)', () => {
  it('TS and JS providers carry a cfgVisitor', () => {
    expect(getProvider(SupportedLanguages.TypeScript).cfgVisitor).toBeDefined();
    expect(getProvider(SupportedLanguages.JavaScript).cfgVisitor).toBeDefined();
  });

  it('a non-CFG language (Python) has no cfgVisitor ⇒ worker emits no cfgSideChannel', () => {
    // `provider.cfgVisitor &&` short-circuits in the worker → no CFG, no field.
    expect(getProvider(SupportedLanguages.Python).cfgVisitor).toBeUndefined();
  });
});

describe('U3 — collectFunctionCfgs', () => {
  it('produces one CFG per function with the expected branch edges', () => {
    const root = tsRoot(`
      function a(x: number) { if (x) { p(); } else { q(); } }
      function b() { return 1; }
    `);
    const { cfgs, skipped } = collectFunctionCfgs(root, tsVisitor(), 'a.ts');
    expect(skipped).toBe(0);
    expect(cfgs).toHaveLength(2);
    const a = cfgs.find((c) => c.blocks.some((bl) => bl.text.includes('p();')));
    expect(a).toBeDefined();
    const kinds = new Set(a!.edges.map((e) => e.kind));
    expect(kinds.has('cond-true')).toBe(true);
    expect(kinds.has('cond-false')).toBe(true);
    // every block belongs to its declaring file
    for (const c of cfgs) expect(c.filePath).toBe('a.ts');
  });

  it('a file with no functions yields an empty CFG set (no error)', () => {
    const { cfgs, skipped } = collectFunctionCfgs(
      tsRoot(`const x = 1; export {};`),
      tsVisitor(),
      'x.ts',
    );
    expect(cfgs).toHaveLength(0);
    expect(skipped).toBe(0);
  });

  it('maxFunctionLines skips an over-cap function and counts the skip', () => {
    const big = `function big() {\n${'  step();\n'.repeat(20)}}`;
    const root = tsRoot(`${big}\nfunction small() { ok(); }`);
    const { cfgs, skipped } = collectFunctionCfgs(root, tsVisitor(), 'f.ts', 5);
    expect(skipped).toBe(1); // big() exceeds the 5-line cap
    // small() is still built
    expect(cfgs.some((c) => c.blocks.some((bl) => bl.text.includes('ok();')))).toBe(true);
    expect(cfgs.some((c) => c.blocks.some((bl) => bl.text.includes('step();')))).toBe(false);
  });
});

describe('U3 — CFG side-channel JSON round-trip (no AST leakage, no field loss)', () => {
  it('serialize → JSON → deserialize yields an identical CFG', () => {
    const root = tsRoot(`function f(xs: number[]) {
      for (const x of xs) { if (x > 0) { use(x); } else { break; } }
      done();
    }`);
    const { cfgs } = collectFunctionCfgs(root, tsVisitor(), 'rt.ts');
    expect(cfgs.length).toBeGreaterThan(0);
    // The worker serializes ParsedFile via mapReplacer; the store revives via
    // mapReviver. The CFG is plain data, so it must survive byte-for-byte.
    const round = JSON.parse(JSON.stringify(cfgs, mapReplacer), mapReviver);
    expect(round).toEqual(cfgs);
    // No tree-sitter nodes leaked: every value is a primitive/array/plain object.
    for (const c of round) {
      for (const b of c.blocks) expect(typeof b.text).toBe('string');
      for (const e of c.edges) expect(typeof e.from).toBe('number');
    }
    // M2 (#2082 U1): the binding table + statement facts must survive the
    // boundary — a future cache-slimming field list that drops them would
    // silently break reaching-defs (the #2038 mergeChunkResults lesson).
    for (const c of round) {
      expect(Array.isArray(c.bindings)).toBe(true);
      expect(c.blocks.every((b: { statements?: unknown }) => Array.isArray(b.statements))).toBe(
        true,
      );
    }
    expect(round.some((c: { bindings: unknown[] }) => c.bindings.length > 0)).toBe(true);
  });
});

describe('U3 — parse-cache key folds the --pdg flag (R4, #2038-class guard)', () => {
  const entries = [
    { filePath: 'b.ts', contentHash: 'h2' },
    { filePath: 'a.ts', contentHash: 'h1' },
  ];

  it('pdg-on and pdg-off produce DIFFERENT chunk keys', () => {
    expect(computeChunkHash(entries, false)).not.toBe(computeChunkHash(entries, true));
  });

  it('the same flag value is stable and order-independent', () => {
    const reordered = [...entries].reverse();
    expect(computeChunkHash(entries, true)).toBe(computeChunkHash(reordered, true));
    expect(computeChunkHash(entries, false)).toBe(computeChunkHash(reordered, false));
  });

  it('default (no flag arg) equals the explicit pdg-off key — warm caches survive the change', () => {
    expect(computeChunkHash(entries)).toBe(computeChunkHash(entries, false));
  });

  it('the boolean form equals the object form with the same flag (back-compat)', () => {
    expect(computeChunkHash(entries, true)).toBe(computeChunkHash(entries, { pdg: true }));
    expect(computeChunkHash(entries, false)).toBe(computeChunkHash(entries, { pdg: false }));
  });

  it('the worker-side line cap is folded into the key — a different maxFunctionLines re-dispatches', () => {
    // Guards the #2038-class trap for the WORKER-visible cap: a warm chunk
    // built under one maxFunctionLines must NOT be served to a --pdg run with
    // a different cap (the cached cfgSideChannel differs — the worker skips
    // different functions). Different cap value ⇒ different key.
    const base = computeChunkHash(entries, { pdg: true });
    expect(computeChunkHash(entries, { pdg: true, maxFunctionLines: 500 })).not.toBe(base);
    // Same cap values ⇒ same key (deterministic, order-independent).
    const reordered = [...entries].reverse();
    expect(computeChunkHash(entries, { pdg: true, maxFunctionLines: 500 })).toBe(
      computeChunkHash(reordered, { pdg: true, maxFunctionLines: 500 }),
    );
  });

  it('the EMIT-time edge cap does NOT perturb the key — cached worker output is identical across it (#2099 F3)', () => {
    // pdgMaxEdgesPerFunction is applied in scope-resolution on the main
    // thread; the worker never sees it, so the cached shard is byte-identical
    // across cap values. Folding it in (a prior review round did) only forced
    // a spurious full re-parse + durable-store rewrite on every cap change.
    const base = computeChunkHash(entries, { pdg: true });
    expect(
      computeChunkHash(entries, {
        pdg: true,
        maxEdgesPerFunction: 100,
      } as Parameters<typeof computeChunkHash>[1]),
    ).toBe(base);
  });
});

describe('#2082 M2 — the REACHING_DEF emit cap does NOT perturb the chunk key', () => {
  const entries = [
    { filePath: 'b.ts', contentHash: 'h2' },
    { filePath: 'a.ts', contentHash: 'h1' },
  ];

  it('pdgMaxReachingDefEdgesPerFunction is emit-time-only — same key across values (F3 discipline)', () => {
    // The worker never sees the REACHING_DEF edge cap (solve + emit happen in
    // scope-resolution on the main thread), so the cached shard is identical
    // across cap values. Folding it in would be the #2099-F3 over-correction:
    // a spurious full re-parse on every cap change. PdgCacheKey simply has no
    // field for it — this test pins that the key API surface stays that way
    // (the object form ignores unknown extras rather than hashing them).
    const base = computeChunkHash(entries, { pdg: true });
    const withExtra = computeChunkHash(entries, {
      pdg: true,
      // @ts-expect-error — deliberately passing an unknown field: the key must ignore it
      maxReachingDefEdgesPerFunction: 1,
    });
    expect(withExtra).toBe(base);
  });
});
