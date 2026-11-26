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
      ownedDefs: [topLevel],
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
      ownedDefs: [caller, local],
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
