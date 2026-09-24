/**
 * The locality filter for value references, and the invariant triple it has to
 * hold at once.
 *
 * A bare-identifier read (A2) makes module-scope constants answerable, but the
 * same capture matches a read of a function-local `const`, and an edge to one of
 * those retains exactly the inert symbols `pruneLocalSymbols` exists to drop.
 * So references to `Const`/`Variable`/`Static` are filtered — and the shape of
 * that filter is the whole story:
 *
 *   1. a function-local value MUST NOT keep an edge,
 *   2. a module-scope value MUST keep one,
 *   3. a CLASS MEMBER must keep one too — and this is the case a
 *      "module-level?" allowlist silently gets wrong.
 *
 * (3) is why the filter is a BLOCKLIST of function-local defs rather than an
 * allowlist of module-level ones. A Java field, a C# field and a Python class
 * attribute are none of module-level, and none of function-local. Under an
 * allowlist they fall outside the allowed set and every one of their ACCESSES
 * edges disappears — a whole edge class, in three languages, reported as
 * "nothing reads this field".
 *
 * ── What each half of this file actually gates. Read before trusting it. ──
 *
 * The JS half gates the MECHANISM. Measured by instrumenting the bridge: for
 * `javascript-const-references` it sees exactly two value-ACCESSES candidates,
 * `DEFAULT_FETCH_LIMIT` (blocked=false) and `localScratchValue` (blocked=true).
 * Inverting the filter's sense fails these tests.
 *
 * The Java half gates the OUTCOME, and deliberately not the mechanism, because
 * the mechanism is not reachable from there: instrumenting the same bridge over
 * `java-write-access` shows **zero** value-ACCESSES candidates — Java field
 * references resolve to a `Property` target, and `isValueDefinitionLabel` covers
 * only `Const`/`Static`/`Variable`, so the filter is never consulted. Those
 * edges come from a different emitter entirely. So this half cannot fail when
 * only the filter regresses, and saying otherwise would make it the kind of test
 * that looks like a gate and is not one.
 *
 * It earns its place anyway: it asserts the user-visible answer ("does the graph
 * know who reads this field?") by TARGET rather than by `reason`, which the
 * per-language suites cannot do — they filter on `rel.reason === 'read'|'write'`
 * while the bridge stamps `scope-resolution: read|write`, so a bridge-side
 * change is invisible to them in either direction. If a future change ever makes
 * the bridge the sole emitter for class members, this is the assertion that
 * notices when they vanish.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import path from 'node:path';
import { runPipelineFromRepo } from '../../../src/core/ingestion/pipeline.js';
import type { PipelineResult } from '../../../types/pipeline.js';

const LANG_FIXTURES = path.resolve(__dirname, '..', '..', 'fixtures', 'lang-resolution');

interface AccessEdge {
  readonly source: string;
  readonly target: string;
  readonly targetLabel: string;
  readonly reason: string;
}

const accessesOf = (result: PipelineResult): AccessEdge[] => {
  const out: AccessEdge[] = [];
  result.graph.forEachRelationship((r) => {
    if (r.type !== 'ACCESSES') return;
    const source = result.graph.getNode(r.sourceId);
    const target = result.graph.getNode(r.targetId);
    out.push({
      source: String(source?.properties.name ?? ''),
      target: String(target?.properties.name ?? ''),
      targetLabel: String(target?.label ?? ''),
      reason: String(r.reason ?? ''),
    });
  });
  return out;
};

describe('value-reference locality filter', () => {
  describe('class members survive it (the allowlist regression)', () => {
    let java: PipelineResult;

    beforeAll(async () => {
      java = await runPipelineFromRepo(path.join(LANG_FIXTURES, 'java-write-access'), () => {}, {});
    }, 60_000);

    it('keeps ACCESSES to Java instance fields', () => {
      const targets = accessesOf(java).map((e) => e.target);
      // Asserted as a non-empty set FIRST: every `toContain` below is vacuous
      // if the fixture stopped producing ACCESSES entirely, which is precisely
      // the regression this file exists to catch.
      expect(targets.length).toBeGreaterThan(0);
      expect(targets).toContain('name');
      expect(targets).toContain('address');
    });

    it('resolves them to a member node, not to a stray local', () => {
      const memberEdges = accessesOf(java).filter(
        (e) => e.target === 'name' || e.target === 'address',
      );
      for (const edge of memberEdges) {
        expect(edge.targetLabel).toBe('Property');
      }
    });
  });

  describe('the two cases the filter exists for still hold', () => {
    let js: PipelineResult;

    beforeAll(async () => {
      js = await runPipelineFromRepo(
        path.join(LANG_FIXTURES, 'javascript-const-references'),
        () => {},
        {},
      );
    }, 60_000);

    it('keeps a module-scope const read', () => {
      const targets = accessesOf(js).map((e) => e.target);
      expect(targets.length).toBeGreaterThan(0);
      expect(targets).toContain('DEFAULT_FETCH_LIMIT');
    });

    it('drops a function-local const read', () => {
      // The whole reason the filter exists. `localScratchValue` is declared and
      // read inside one function; an edge to it retains a symbol
      // `pruneLocalSymbols` would otherwise remove.
      expect(accessesOf(js).map((e) => e.target)).not.toContain('localScratchValue');
    });
  });
});
