/**
 * #2701 — `this` inside an ordinary JS/TS `function` is NOT the enclosing
 * instance, so `this.m()` there must not emit a `CALLS` edge to the enclosing
 * class's member. Only an arrow inherits `this`.
 *
 * ECMA-262 gives an arrow `[[ThisMode]] = lexical`: it has no `this` binding in
 * its environment record, so the lookup passes through to the enclosing
 * environment. Every other function form binds `this` at call time. `tsc` draws
 * the same line by resolving `this` through `getThisContainer` with
 * `includeArrowFunctions = false`.
 *
 * The fix spans three layers, and each is load-bearing — the false edge
 * survived removing any one of them alone, which is why the negative cases here
 * assert on the emitted edge rather than on any single walk:
 *
 *   1. `Scope.ownsReceivers`, set from the `@receiver-owner.this` query marker,
 *      stops both receiver-type walks (`findReceiverTypeBinding` in ingestion,
 *      `lookupReceiverType` in gitnexus-shared's `lookup-core`).
 *   2. `LanguageTypeConfig.thisBoundaryNodeTypes` stops the type-env AST walk
 *      that infers a receiver's type during capture.
 *   3. `isReceiverOwnedButUnbound` makes `receiver-bound-calls` SUPPRESS the
 *      site. Without this the member still resolved by NAME through
 *      `lookupCore`'s lexical chain — the class-body scope binds `m`, two
 *      scopes up — at a merely lower confidence.
 *
 * WHAT THIS DELIBERATELY GIVES UP. `.bind(this)`, `.call(this)` and
 * `forEach(fn, thisArg)` DO make `this` the instance at runtime; their edges
 * were correct and are now dropped. Their correctness is fixed at the call
 * site, which a scope-level rule cannot see, so the choice is between losing
 * them and keeping every detached-callback false positive. The pinned cases at
 * the bottom record that trade so a future change to it is deliberate.
 */
import { describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runPipelineFromRepo } from '../../src/core/ingestion/pipeline.js';
import { DIST_WORKER_URL, distWorkerExists } from '../helpers/worker-parse.js';

vi.setConfig({ testTimeout: 90_000 });

const describeIfWorkerBuilt = distWorkerExists() ? describe : describe.skip;

/** `CALLS` edges in a one-file repo as sorted `source -> target` strings. */
const callEdgesFor = async (filename: string, source: string): Promise<string[]> => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gn-this-boundary-'));
  try {
    fs.writeFileSync(path.join(dir, filename), source, 'utf-8');
    const result = await runPipelineFromRepo(dir, () => {}, {
      workerPoolSize: 1,
      workerUrlForTest: DIST_WORKER_URL,
    });
    return result.graph.relationships
      .filter((rel) => rel.type === 'CALLS')
      .map((rel) => `${rel.sourceId} -> ${rel.targetId}`)
      .sort();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
};

describeIfWorkerBuilt('an arrow inherits `this`; every other function form binds it', () => {
  it('TypeScript: a nested `function` emits no edge, its arrow twin does', async () => {
    // The two methods differ ONLY in arrow vs `function`, so any edge
    // difference between them is the boundary and nothing else.
    expect(
      await callEdgesFor(
        'c.ts',
        [
          'export class C {',
          '  m(): void {}',
          '  viaArrow(): void { const good = () => { this.m(); }; good(); }',
          '  viaFn(): void { const bad = function () { this.m(); }; bad(); }',
          '}',
        ].join('\n'),
      ),
    ).toEqual([
      'Function:c.ts:C.good -> Method:c.ts:C.m#0',
      'Method:c.ts:C.viaArrow#0 -> Function:c.ts:C.good',
      'Method:c.ts:C.viaFn#0 -> Function:c.ts:C.bad',
    ]);
  });

  it('JavaScript: the same boundary, via the JavaScript grammar', async () => {
    // JS and TS have separate query files; a marker added to one only would
    // pass the TypeScript case above and silently leave JavaScript broken.
    expect(
      await callEdgesFor(
        'h.js',
        [
          'class H {',
          '  m() {}',
          '  viaArrow() { const good = () => { this.m(); }; return good; }',
          '  viaFn() { const bad = function () { this.m(); }; return bad; }',
          '  direct() { this.m(); }',
          '}',
          'module.exports = { H };',
        ].join('\n'),
      ),
    ).toEqual([
      'Function:h.js:H.good -> Method:h.js:H.m#0',
      'Method:h.js:H.direct#0 -> Method:h.js:H.m#0',
    ]);
  });

  it('a callback `function` passed to forEach does not reach the enclosing class', async () => {
    // The original motivating shape: the bug arrow functions were introduced
    // to avoid. `run` must have NO outgoing call to `m`.
    expect(
      await callEdgesFor(
        'f.ts',
        [
          'export class F {',
          '  m(): void {}',
          '  run(xs: number[]): void { xs.forEach(function () { this.m(); }); }',
          '}',
        ].join('\n'),
      ),
    ).toEqual([]);
  });

  it('a plain `this.m()` in a method still resolves', async () => {
    // The boundary must not swallow the ordinary case: a `method_definition`
    // carries the marker too, but its own synthesized `this` binding is
    // consulted first.
    expect(
      await callEdgesFor(
        'd.ts',
        ['export class D {', '  m(): void {}', '  direct(): void { this.m(); }', '}'].join('\n'),
      ),
    ).toEqual(['Method:d.ts:D.direct#0 -> Method:d.ts:D.m#0']);
  });

  it('a class-field arrow still resolves', async () => {
    // `m = () => {}` is lexically bound to the instance, so it keeps its edge.
    // The caller is the class itself: a field initializer has no method scope.
    expect(
      await callEdgesFor(
        'g.ts',
        ['export class G {', '  m(): void {}', '  field = (): void => { this.m(); };', '}'].join(
          '\n',
        ),
      ),
    ).toEqual(['Class:g.ts:G -> Method:g.ts:G.m#0']);
  });

  it('a generator `function` is a boundary too', async () => {
    expect(
      await callEdgesFor(
        'gen.ts',
        [
          'export class Gen {',
          '  m(): void {}',
          '  run() { return function* () { this.m(); }; }',
          '}',
        ].join('\n'),
      ),
    ).toEqual([]);
  });

  it('leaves other languages untouched: a Kotlin lambda still sees the receiver', async () => {
    // `ownsReceivers` is unset for every language but JS/TS, so a Kotlin lambda
    // — which DOES capture the enclosing `this` — must keep resolving. This is
    // the guard against the boundary leaking into shared code.
    expect(
      await callEdgesFor(
        'K.kt',
        ['class K {', '    fun m() {}', '    fun run() { val f = { this.m() }; f() }', '}'].join(
          '\n',
        ),
      ),
      // Attributed to `run`, not to `f`: Kotlin scopes `lambda_literal` as a
      // BLOCK (#1757), so the lambda is not its own caller anchor. What matters
      // here is only that the `this.m()` edge still exists at all.
    ).toContain('Method:K.kt:K.run#0 -> Method:K.kt:K.m#0');
  });
});

describeIfWorkerBuilt('receiver rebinding is not modelled — pinned, not endorsed', () => {
  // Each of these is CORRECT at runtime and produces no edge. The rebinding
  // happens at the call site, which a scope-level rule cannot see; modelling it
  // needs call-site receiver tracking, which is a separate concern. Pinned so
  // that a future change here is a decision rather than a surprise.

  it('`.bind(this)` loses its edge', async () => {
    expect(
      await callEdgesFor(
        'b.ts',
        [
          'export class B {',
          '  m(): void {}',
          '  run() { return function (this: B) { this.m(); }.bind(this); }',
          '}',
        ].join('\n'),
      ),
    ).toEqual([]);
  });

  it('a forEach `thisArg` loses its edge', async () => {
    expect(
      await callEdgesFor(
        't.ts',
        [
          'export class T {',
          '  m(): void {}',
          '  run(xs: number[]): void { xs.forEach(function (this: T) { this.m(); }, this); }',
          '}',
        ].join('\n'),
      ),
    ).toEqual([]);
  });

  it('`this` in a static method no longer reaches the instance member', async () => {
    // `this` in a static context is the constructor, not an instance, so an
    // edge to the INSTANCE method `m` was wrong in the other direction. It was
    // previously emitted by the same lexical-name fallback this change closes.
    expect(
      await callEdgesFor(
        's.ts',
        ['export class S {', '  m(): void {}', '  static go(): void { this.m(); }', '}'].join('\n'),
      ),
    ).toEqual([]);
  });
});
