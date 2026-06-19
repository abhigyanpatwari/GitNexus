import { createHash } from 'crypto';
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

describe('CFG provider gate — a cfgVisitor enables the worker CFG path', () => {
  it('TS and JS providers carry a cfgVisitor', () => {
    expect(getProvider(SupportedLanguages.TypeScript).cfgVisitor).toBeDefined();
    expect(getProvider(SupportedLanguages.JavaScript).cfgVisitor).toBeDefined();
  });

  it('a non-CFG language (COBOL) has no cfgVisitor ⇒ worker emits no cfgSideChannel', () => {
    // `provider.cfgVisitor &&` short-circuits in the worker → no CFG, no field.
    // COBOL is the deliberate non-goal of the PDG-language rollout (#2195) —
    // every other supported language now carries a cfgVisitor.
    expect(getProvider(SupportedLanguages.Cobol).cfgVisitor).toBeUndefined();
  });
});

describe('U3 — collectFunctionCfgs', () => {
  it('produces one CFG per function with the expected branch edges', () => {
    const root = tsRoot(`
      function a(x: number) { if (x) { p(); } else { q(); } }
      function b() { return 1; }
    `);
    const { cfgs, skipped } = collectFunctionCfgs(root, tsVisitor(), 'a.ts');
    expect(skipped).toEqual({ tooManyLines: 0, tooDeeplyNested: 0, buildError: 0 });
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
    expect(skipped).toEqual({ tooManyLines: 0, tooDeeplyNested: 0, buildError: 0 });
  });

  it('maxFunctionLines skips an over-cap function and counts the skip', () => {
    const big = `function big() {\n${'  step();\n'.repeat(20)}}`;
    const root = tsRoot(`${big}\nfunction small() { ok(); }`);
    const { cfgs, skipped } = collectFunctionCfgs(root, tsVisitor(), 'f.ts', 5);
    expect(skipped.tooManyLines).toBe(1); // big() exceeds the 5-line cap
    expect(skipped.tooDeeplyNested).toBe(0);
    expect(skipped.buildError).toBe(0);
    // small() is still built
    expect(cfgs.some((c) => c.blocks.some((bl) => bl.text.includes('ok();')))).toBe(true);
    expect(cfgs.some((c) => c.blocks.some((bl) => bl.text.includes('step();')))).toBe(false);
  });

  it('a pathologically deep nest is bailed proactively and counted (#2195)', () => {
    // A function nested far past MAX_CFG_NESTING_DEPTH (real code is ≤ ~50 deep).
    // The visitor's proactive guard throws CfgNestingDepthError; collect counts
    // it under tooDeeplyNested and ISOLATES it — the sibling function still
    // builds (the bail must not drop the whole file's CFGs).
    const deep = `function deep() { ${'if (c) {'.repeat(1200)} leaf(); ${'}'.repeat(1200)} }`;
    const root = tsRoot(`${deep}\nfunction sibling() { ok(); }`);
    const { cfgs, skipped } = collectFunctionCfgs(root, tsVisitor(), 'deep.ts');
    expect(skipped.tooDeeplyNested).toBe(1);
    expect(skipped.tooManyLines).toBe(0);
    expect(skipped.buildError).toBe(0);
    // sibling() survives the bail
    expect(cfgs.some((c) => c.blocks.some((bl) => bl.text.includes('ok();')))).toBe(true);
    expect(cfgs.some((c) => c.blocks.some((bl) => bl.text.includes('leaf();')))).toBe(false);
  });

  it('isolates a generic build error to one function and counts it (buildError, #2195)', () => {
    // A non-CfgNestingDepthError throw from buildFunctionCfg used to escape to the
    // worker language-group catch and drop EVERY remaining file's CFG. It must now
    // be caught per function, counted under buildError, and NOT stop the sibling.
    const real = tsVisitor();
    const flaky: CfgVisitor<SyntaxNode> = {
      isFunction: (n) => real.isFunction(n),
      buildFunctionCfg: (n, fp) => {
        if (n.text.includes('boom()')) throw new Error('synthetic build failure');
        return real.buildFunctionCfg(n, fp);
      },
    };
    const root = tsRoot(`function bad() { boom(); }\nfunction good() { ok(); }`);
    const { cfgs, skipped } = collectFunctionCfgs(root, flaky, 'be.ts');
    expect(skipped).toEqual({ tooManyLines: 0, tooDeeplyNested: 0, buildError: 1 });
    // good() still builds — the throw didn't drop the file's other CFGs
    expect(cfgs.some((c) => c.blocks.some((bl) => bl.text.includes('ok();')))).toBe(true);
    expect(cfgs.some((c) => c.blocks.some((bl) => bl.text.includes('boom();')))).toBe(false);
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

describe('#2083 M3 U1 — taint sites cross the worker/store boundary intact', () => {
  const siteSource = `function handler(req, x) {
    const cp = require('child_process');
    const b = req.body;
    cp.exec(escape(x), b);
    sql\`select \${x}\`;
    run(...b);
  }`;

  function siteCfgs() {
    const { cfgs } = collectFunctionCfgs(tsRoot(siteSource), tsVisitor(), 'sites.ts');
    expect(cfgs).toHaveLength(1);
    return cfgs;
  }

  function allSites(cfgs: readonly { blocks: readonly { statements?: readonly unknown[] }[] }[]) {
    return cfgs.flatMap((c) =>
      c.blocks.flatMap((b) =>
        (b.statements ?? []).flatMap((s) => (s as { sites?: unknown[] }).sites ?? []),
      ),
    );
  }

  it('sites survive the worker JSON boundary (mapReplacer/mapReviver) byte-equal', () => {
    const cfgs = siteCfgs();
    expect(allSites(cfgs).length).toBeGreaterThan(0);
    const round = JSON.parse(JSON.stringify(cfgs, mapReplacer), mapReviver);
    expect(round).toEqual(cfgs);
    expect(allSites(round)).toEqual(allSites(cfgs));
  });

  it('sites survive a frozen re-wrap + the DURABLE store interning reviver (no nodeId-dedup loss)', async () => {
    const { makeInterningReviver } = await import('../../../src/storage/parsedfile-store.js');
    const cfgs = siteCfgs();
    // The pipeline deep-freezes ParsedFiles and re-wraps via spread — the CFG
    // payload itself rides by reference and must tolerate being frozen.
    const deepFreeze = (o: unknown): unknown => {
      if (o && typeof o === 'object') {
        for (const v of Object.values(o)) deepFreeze(v);
        Object.freeze(o);
      }
      return o;
    };
    const frozen = (deepFreeze(cfgs) as typeof cfgs).map((c) => ({ ...c }));
    const raw = JSON.stringify(frozen, mapReplacer);
    // The durable parsedfile-cache revives with the interning reviver, which
    // DEDUPS any object carrying a string `nodeId` field — SiteRecord must
    // never trip it (the KTD2 "no field named nodeId" obligation).
    const revived = JSON.parse(raw, makeInterningReviver(new Map(), new Map()));
    expect(revived).toEqual(frozen);
    expect(allSites(revived)).toEqual(allSites(cfgs));
  });
});

describe('#2083 M3 U1 — pdg chunk-key namespace version (flag-off keys untouched)', () => {
  const entries = [
    { filePath: 'b.ts', contentHash: 'h2' },
    { filePath: 'a.ts', contentHash: 'h1' },
  ];

  it('flag-off chunk keys are BYTE-IDENTICAL across the M3 namespace bump (pinned hash)', () => {
    // Independent reconstruction of the pre-namespace key format: pdg-off
    // keys are sha256 over the sorted filePath:contentHash lines and NOTHING
    // else. This pin fails if the version token ever leaks into non-pdg keys
    // (which would force a cold re-parse on every flag-off user).
    const expected = createHash('sha256').update(Buffer.from('a.ts:h1\nb.ts:h2')).digest('hex');
    expect(computeChunkHash(entries, false)).toBe(expected);
    expect(computeChunkHash(entries)).toBe(expected);
  });

  it('pdg-mode keys CHANGED from the M2-era namespace (v1 chunks invalidate on upgrade)', () => {
    // The M2-era pdg namespace was `pdg:1;maxFn=<v>` — an M3 binary must not
    // serve a v1 chunk (its cfgSideChannel lacks `sites`, so taint would
    // silently no-op on warm caches).
    const joined = 'a.ts:h1\nb.ts:h2';
    const m2Key = createHash('sha256')
      .update(Buffer.from(`pdg:1;maxFn=def\n${joined}`))
      .digest('hex');
    expect(computeChunkHash(entries, { pdg: true })).not.toBe(m2Key);
    // and the v2 key is still deterministic + order-independent
    expect(computeChunkHash([...entries].reverse(), { pdg: true })).toBe(
      computeChunkHash(entries, { pdg: true }),
    );
  });

  it('pdg-mode keys CHANGED from prior namespaces AND pin the current pdg:5 (FU-C BindingEntry.formalIndex)', () => {
    // The pdg namespace bumps whenever the worker `cfgSideChannel` SHAPE changes:
    // U1 added `SiteRecord.at` (pdg:2→3), U4 added the Rust struct-literal
    // `kind:'new'` site (pdg:3→4), and the FU-C call-summary soundness fix added
    // `BindingEntry.formalIndex` on param bindings (pdg:4→5) so return-flow keys on
    // the enclosing formal position, not the flattened binding ordinal. A stale
    // prior shard lacks the new field, so the call-summary harvest would route to
    // its conservative empty-summary fallback on a warm cache. Assert prior chunks
    // are NOT served, and PIN the current pdg:5 namespace so an accidental revert
    // of the token re-introduces the stale-shape bug.
    const joined = 'a.ts:h1\nb.ts:h2';
    const keyOf = (token: string) =>
      createHash('sha256')
        .update(Buffer.from(`${token};maxFn=def\n${joined}`))
        .digest('hex');
    const current = computeChunkHash(entries, { pdg: true });
    expect(current).not.toBe(keyOf('pdg:2'));
    expect(current).not.toBe(keyOf('pdg:3'));
    expect(current).not.toBe(keyOf('pdg:4'));
    expect(current).toBe(keyOf('pdg:5'));
  });
});
