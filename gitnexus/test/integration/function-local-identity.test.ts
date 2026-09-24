/**
 * #2699 — a function-local callable gets its own graph node instead of
 * collapsing onto a same-named file-level one.
 *
 * Graph node ids are file-scoped, so before this a top-level `save()` and a
 * local `const save = …` inside `run()` both keyed `Function:<file>:save`. That
 * is a WRONG answer, not merely a missing one: `run`'s call to its own local
 * was attributed to the top-level function, so `impact` on `save` reported a
 * caller that never calls it.
 *
 * A local's identity is its enclosing-callable chain plus its own position —
 * `run.save@2:2`. The chain is for humans reading `impact` output; the position
 * is what makes it correct. ECMAScript creates an environment record per
 * function AND per block, so a name alone cannot separate sibling blocks, and
 * an anonymous function has no name to contribute at all. Position settles both
 * (SCIP reaches the same place with its document-scoped `local <id>`).
 * Top-level functions and class methods are NOT locals and keep their existing
 * ids — that is the bound on how far this churn reaches.
 *
 * THE SILENT FAILURE THIS GUARDS. Node ids are built twice and independently:
 * once by the definition phase and once by the caller-attribution phase
 * (`findEnclosingFunctionId`). If those two disagree by a single character the
 * caller attaches to a node that does not exist and the edge simply vanishes —
 * nothing throws, and a test that only checked "the node exists" would still
 * pass. Every assertion here is therefore on the EDGE, whose source and target
 * are produced by the two different phases: it can only pass if both agree.
 */
import {
  buildDefIndex,
  buildScopeTree,
  type Reference,
  type Scope,
  type ScopeId,
  type SymbolDefinition,
} from 'gitnexus-shared';
import { describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createKnowledgeGraph } from '../../src/core/graph/graph.js';
import type { ScopeResolutionIndexes } from '../../src/core/ingestion/model/scope-resolution-indexes.js';
import { runPipelineFromRepo } from '../../src/core/ingestion/pipeline.js';
import { buildGraphNodeLookup } from '../../src/core/ingestion/scope-resolution/graph-bridge/node-lookup.js';
import { emitReferencesViaLookup } from '../../src/core/ingestion/scope-resolution/graph-bridge/references-to-edges.js';
import { DIST_WORKER_URL, distWorkerExists } from '../helpers/worker-parse.js';

vi.setConfig({ testTimeout: 90_000 });

const describeIfWorkerBuilt = distWorkerExists() ? describe : describe.skip;

const analyze = async (
  filename: string,
  source: string,
): Promise<{ readonly calls: string[]; readonly nodes: string[] }> => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gn-local-identity-'));
  try {
    fs.writeFileSync(path.join(dir, filename), source, 'utf-8');
    const result = await runPipelineFromRepo(dir, () => {}, {
      workerPoolSize: 1,
      workerUrlForTest: DIST_WORKER_URL,
    });
    return {
      calls: result.graph.relationships
        .filter((rel) => rel.type === 'CALLS')
        .map((rel) => `${rel.sourceId} -> ${rel.targetId}`)
        .sort(),
      nodes: result.graph.nodes
        .filter((node) => node.properties.name?.toString().includes('save') === true)
        .map((node) => node.id)
        .sort(),
    };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
};

describeIfWorkerBuilt('a function-local callable does not collide with a file-level one', () => {
  it('TypeScript: two locals and a top-level function are three distinct nodes', async () => {
    const { calls, nodes } = await analyze(
      'a.ts',
      [
        'export function save(x: number): number { return x; }',
        'export function run(): number {',
        '  const save = (x: number): number => x * 2;',
        '  return save(1);',
        '}',
        'export function other(): number {',
        '  const save = (x: number): number => x * 3;',
        '  return save(2);',
        '}',
      ].join('\n'),
    );

    // Three nodes, not one. `other`'s local is distinct from `run`'s: qualifying
    // by the enclosing FUNCTION (not the file) is what separates two locals that
    // share a name in different functions.
    expect(nodes).toEqual([
      'Function:a.ts:other.save@6:2',
      'Function:a.ts:run.save@2:2',
      'Function:a.ts:save',
    ]);

    // Each function calls its OWN local. The top-level `save` has no callers —
    // before this it collected both, and `impact` reported callers that do not
    // exist in the source.
    expect(calls).toEqual([
      'Function:a.ts:other -> Function:a.ts:other.save@6:2',
      'Function:a.ts:run -> Function:a.ts:run.save@2:2',
    ]);
  });

  it('Python: the same collision, via a lambda binding', async () => {
    const { calls } = await analyze(
      'c.py',
      [
        'def save(x):',
        '    return x',
        '',
        'def run():',
        '    save = lambda x: x * 2',
        '    return save(1)',
      ].join('\n'),
    );

    expect(calls).toEqual(['Function:c.py:run -> Function:c.py:run.save@4:4']);
  });

  it('PHP: the enclosing-callable qualifier composes with the `$` sigil', async () => {
    // Two independent separations, both needed. The sigil (#2693) keeps PHP's
    // variable namespace apart from its function namespace; the qualifier
    // (#2699) keeps this function's local apart from any other scope's.
    const { calls } = await analyze(
      'b.php',
      [
        '<?php',
        'function save($x) { return $x; }',
        'function run() {',
        '  $save = fn($x) => $x * 2;',
        '  return $save(1);',
        '}',
      ].join('\n'),
    );

    expect(calls).toEqual(['Function:b.php:run -> Function:b.php:run.$save@3:2']);
  });

  it('a closure inside a METHOD is qualified by the method, not just the class', async () => {
    // Before this, both closures qualified as `S.h` and collapsed — the class
    // was the only qualifier, so two methods' locals still collided.
    const { calls } = await analyze(
      's.ts',
      [
        'export class S {',
        '  first(): number { const h = (): number => 1; return h(); }',
        '  second(): number { const h = (): number => 2; return h(); }',
        '}',
      ].join('\n'),
    );

    expect(calls).toEqual([
      'Method:s.ts:S.first#0 -> Function:s.ts:S.first.h@1:20',
      'Method:s.ts:S.second#0 -> Function:s.ts:S.second.h@2:21',
    ]);
  });

  it('an ANONYMOUS enclosing callable is named by its position', async () => {
    // An anonymous function has no name to qualify with, but ECMAScript still
    // gives it an environment record, so its `save` is a genuinely different
    // binding from the file-level one. The anonymous link becomes `fn@1:9` —
    // unique by construction, since two functions cannot start at one offset.
    const { calls } = await analyze(
      'anon.ts',
      [
        'export function outer() {',
        '  return function () {',
        '    const save = (x: number) => x * 2;',
        '    return save(1);',
        '  };',
        '}',
        'export function save(x: number) { return x; }',
      ].join('\n'),
    );

    expect(calls).toEqual(['Function:anon.ts:outer -> Function:anon.ts:outer.fn@1:9.save@2:4']);
  });

  it('sibling BLOCKS hold different bindings, and each call reaches its own', async () => {
    // `let`/`const` are block-scoped, so these are two bindings, not one name
    // declared twice. Two things had to be true for this to work, and the first
    // without the second is worse than neither: giving them distinct ids made
    // the collapse visible as DUPLICATE edges (each call resolving to both),
    // because JS/TS emitted no block scopes at all and the resolver could not
    // tell the branches apart. `(statement_block) @scope.block` supplies the
    // missing environment record — `tsBindingScopeFor` already implemented the
    // other half of the ECMAScript rule, hoisting `var` past blocks while
    // `let`/`const` bind innermost.
    const { calls } = await analyze(
      'blocks.ts',
      [
        'export function outer(a: boolean): number {',
        '  if (a) {',
        '    const pick = (x: number) => x * 2;',
        '    return pick(1);',
        '  } else {',
        '    const pick = (x: number) => x * 3;',
        '    return pick(2);',
        '  }',
        '}',
      ].join('\n'),
    );

    // Exactly two edges: one per call, each to the binding in its OWN branch.
    expect(calls).toEqual([
      'Function:blocks.ts:outer -> Function:blocks.ts:outer.pick@2:4',
      'Function:blocks.ts:outer -> Function:blocks.ts:outer.pick@5:4',
    ]);
  });

  it('`var` still hoists past blocks to the function, per the spec', async () => {
    // The other half of block scoping: a `var` declared in a block belongs to
    // the FUNCTION environment record. If block scopes had captured `var` too,
    // this would silently become two bindings.
    const { calls } = await analyze(
      'v.js',
      [
        'function outer(a) {',
        '  if (a) { var pick = (x) => x * 2; }',
        '  return pick(1);',
        '}',
        'module.exports = { outer };',
      ].join('\n'),
    );

    expect(calls).toEqual(['Function:v.js:outer -> Function:v.js:outer.pick@1:11']);
  });

  it('a MULTILINE local declaration does not alias onto a same-named sibling local', async () => {
    // The two id phases anchor on different nodes ON PURPOSE: the graph node anchors on
    // the outer `lexical_declaration`, the scope def on the inner `arrow_function` (so
    // `anchor.range` lines up with `@scope.function` for auto-hoist). Splitting the
    // declaration across lines therefore puts them on different LINES and the position
    // join misses.
    //
    // Before the fix that miss fell through to the label-agnostic, first-write-wins
    // `simpleKey`, which aliased `other`'s local onto `run`'s and emitted a FABRICATED
    // edge `other -> run.pick@1:2`. Every other fixture in this file keeps the
    // declaration and its initializer on ONE line, where the anchors coincide — which is
    // exactly why the suite was green while the bug shipped.
    //
    // Correct behaviour is to fail CLOSED: two edges, each to its own binding, and no
    // third edge. A missing edge is recoverable; a fabricated caller silently corrupts
    // `impact`.
    const { calls } = await analyze(
      'm.ts',
      [
        'export function run(): number {',
        '  const pick =',
        '    (x: number): number => x * 2;',
        '  return pick(1);',
        '}',
        'export function other(): number {',
        '  const pick =',
        '    (x: number): number => x * 3;',
        '  return pick(2);',
        '}',
      ].join('\n'),
    );

    expect(calls).toEqual([
      'Function:m.ts:other -> Function:m.ts:other.pick@6:2',
      'Function:m.ts:run -> Function:m.ts:run.pick@1:2',
    ]);
  });

  it('leaves top-level functions and ordinary methods unqualified', async () => {
    // The bound on id churn: only a callable nested inside another callable
    // gains a prefix. If this ever fails, the change is rewriting far more ids
    // than it intends to.
    const { calls } = await analyze(
      't.ts',
      [
        'export function helper(): number { return 1; }',
        'export class T {',
        '  m(): number { return helper(); }',
        '}',
        'export function top(): number { return helper(); }',
      ].join('\n'),
    );

    expect(calls).toEqual([
      'Function:t.ts:top -> Function:t.ts:helper',
      'Method:t.ts:T.m#0 -> Function:t.ts:helper',
    ]);
  });
});

/** Node ids for `name`, with local value symbols kept so the pruner can't hide them. */
const valueNodeIdsFor = async (
  filename: string,
  source: string,
  name: string,
): Promise<string[]> => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gn-local-value-identity-'));
  try {
    fs.writeFileSync(path.join(dir, filename), source, 'utf-8');
    const result = await runPipelineFromRepo(dir, () => {}, {
      workerPoolSize: 1,
      workerUrlForTest: DIST_WORKER_URL,
      // `pruneLocalSymbols` deletes ~94% of inert function-local value symbols,
      // which would make the collapse below invisible rather than absent.
      keepLocalValueSymbols: true,
    });
    return result.graph.nodes
      .filter((node) => node.properties.name === name)
      .map((node) => node.id)
      .sort();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
};

describeIfWorkerBuilt('function-local VALUES carry their own identity (#2699 A1)', () => {
  it('a function-local VALUE does not collapse onto the file-level node', async () => {
    // FLIPPED, per this test's own former instruction. It previously pinned the
    // collapse as a KNOWN LIMIT: #2695 gave function-local CALLABLES a
    // position-bearing id and deliberately excluded VALUES, so a top-level
    // `const handler` and a function-local `const handler` shared ONE node.
    // That was the residual half of #2699's ORIGINAL complaint — the issue is
    // about values first, and no callable-only gate could ever reach it.
    //
    // Widened here via `isPositionQualifiedLocalLabel`, the single definition
    // shared by all THREE phases that must agree: id-building
    // (`parse-worker.ts`), resolution (`ids.ts` position key) and registration
    // (`node-lookup.ts`). Two of them disagreeing does not fail loudly — the
    // caller attaches to a node that does not exist and the edge is silently
    // dropped, which is the #2714 failure mode.
    //
    // The churn this was deferred for is real and was accepted deliberately:
    // it re-keys ~14,700 build-time nodes to change ~800 persisted ones,
    // because `pruneLocalSymbols` deletes most locals. Hence the paired
    // schema-fingerprint changes / parse-cache SCHEMA_BUMP bumps — without them
    // a warm cache or an incremental top-up replays the old un-suffixed ids.
    //
    // Only LOCALS move. The prefix comes from `enclosingCallablePrefix`, which
    // returns undefined when nothing encloses the declaration, so the
    // file-level `handler` below keeps its bare id — that is what keeps this
    // off the symbols other files and stored references address.
    const ids = await valueNodeIdsFor(
      'v.ts',
      [
        "export const handler = 'top-level value';",
        '',
        'export function run(): string {',
        "  const handler = 'function-local value';",
        '  return handler;',
        '}',
        '',
      ].join('\n'),
      'handler',
    );

    // Two distinct nodes: the file-level one keeps its bare id, the local
    // carries its enclosing callable AND declaration position.
    expect(ids).toEqual(['Const:v.ts:handler', 'Const:v.ts:run.handler@3:2']);
  });
});

describe('function-local value identity resolves through to emitted edges (#2736)', () => {
  it('targets the position-qualified local rather than its file-level twin', () => {
    const filePath = 'v.ts';
    const caller: SymbolDefinition = {
      nodeId: 'def:v.ts#3:0:Function:run',
      filePath,
      type: 'Function',
      qualifiedName: 'run',
    };
    const topLevel: SymbolDefinition = {
      nodeId: 'def:v.ts#1:0:Const:handler',
      filePath,
      type: 'Const',
      qualifiedName: 'handler',
    };
    const local: SymbolDefinition = {
      nodeId: 'def:v.ts#4:2:Const:run.handler',
      filePath,
      type: 'Const',
      qualifiedName: 'run.handler',
    };
    const moduleScope: Scope = {
      id: 'scope:v.ts#1:0-100:0:Module',
      parent: null,
      kind: 'Module',
      range: { startLine: 1, startCol: 0, endLine: 100, endCol: 0 },
      filePath,
      bindings: new Map(),
      ownedDefs: [caller, topLevel],
      imports: [],
      typeBindings: new Map(),
    };
    const functionScope: Scope = {
      id: 'scope:v.ts#3:0-6:1:Function',
      parent: moduleScope.id,
      kind: 'Function',
      range: { startLine: 3, startCol: 0, endLine: 6, endCol: 1 },
      filePath,
      bindings: new Map(),
      ownedDefs: [local],
      imports: [],
      typeBindings: new Map(),
    };
    const indexes = {
      scopeTree: buildScopeTree([moduleScope, functionScope]),
      defs: buildDefIndex([caller, topLevel, local]),
    } as unknown as ScopeResolutionIndexes;

    const graph = createKnowledgeGraph();
    graph.addNode({
      id: 'Function:v.ts:run',
      label: 'Function',
      properties: { name: 'run', qualifiedName: 'run', filePath, startLine: 2 },
    });
    graph.addNode({
      id: 'Const:v.ts:handler',
      label: 'Const',
      properties: { name: 'handler', qualifiedName: 'handler', filePath, startLine: 0 },
    });
    graph.addNode({
      id: 'Const:v.ts:run.handler@3:2',
      label: 'Const',
      properties: { name: 'handler', qualifiedName: 'run.handler', filePath, startLine: 3 },
    });

    const reference: Reference = {
      fromScope: functionScope.id,
      toDef: local.nodeId,
      atRange: { startLine: 5, startCol: 9, endLine: 5, endCol: 16 },
      kind: 'read',
      confidence: 1,
      evidence: [],
    };
    const emitted = emitReferencesViaLookup(
      graph,
      indexes,
      { bySourceScope: new Map<ScopeId, readonly Reference[]>([[functionScope.id, [reference]]]) },
      buildGraphNodeLookup(graph),
    );

    expect(emitted).toEqual({ emitted: 1, skipped: 0 });
    expect(graph.relationships).toEqual([
      expect.objectContaining({
        sourceId: 'Function:v.ts:run',
        targetId: 'Const:v.ts:run.handler@3:2',
        type: 'ACCESSES',
      }),
    ]);
  });
});
