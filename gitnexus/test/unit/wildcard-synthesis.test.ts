/**
 * Coverage tests for wildcard-synthesis.ts.
 *
 * Scenarios aimed at branches that the integration tests only exercise on
 * the happy path:
 *   1. Go graph-IMPORTS fallback (importMap lacks the edge, graph has it).
 *   2. Python buildPythonModuleAliasForFile populates moduleAliasMap.
 *   3. MAX_SYNTHETIC_BINDINGS_PER_FILE cap halts further synthesis.
 *   4. Deduplication against an already-present namedImportMap entry.
 *   5. Empty exportedSymbolsByFile → early return, no work.
 */
import { describe, it, expect } from 'vitest';
import { synthesizeWildcardImportBindings } from '../../src/core/ingestion/pipeline-phases/wildcard-synthesis.js';
import { createResolutionContext } from '../../src/core/ingestion/model/resolution-context.js';
import { createKnowledgeGraph } from '../../src/core/graph/graph.js';
import type { GraphNode, GraphRelationship } from '../../src/core/graph/types.js';

function makeExportedFuncNode(
  id: string,
  name: string,
  filePath: string,
  label: GraphNode['label'] = 'Function',
): GraphNode {
  return {
    id,
    label,
    properties: {
      name,
      filePath,
      startLine: 1,
      endLine: 5,
      isExported: true,
    },
  };
}

function makeImportsRel(srcFile: string, tgtFile: string): GraphRelationship {
  return {
    id: `File:${srcFile}-IMPORTS-File:${tgtFile}`,
    sourceId: `File:${srcFile}`,
    targetId: `File:${tgtFile}`,
    type: 'IMPORTS',
    confidence: 1.0,
    reason: '',
  };
}

describe('synthesizeWildcardImportBindings', () => {
  it('uses graph-level IMPORTS fallback for Go when ctx.importMap lacks the edge', () => {
    const graph = createKnowledgeGraph();
    const ctx = createResolutionContext();

    // Exported Go symbol in the upstream file
    graph.addNode(makeExportedFuncNode('Function:pkg/util.go:Helper', 'Helper', 'pkg/util.go'));

    // Only the graph edge exists — ctx.importMap has NO entry for main.go
    graph.addRelationship(makeImportsRel('cmd/main.go', 'pkg/util.go'));

    const total = synthesizeWildcardImportBindings(graph, ctx);

    expect(total).toBe(1);
    const mainBindings = ctx.namedImportMap.get('cmd/main.go');
    expect(mainBindings).toBeDefined();
    expect(mainBindings!.get('Helper')).toEqual({
      sourcePath: 'pkg/util.go',
      exportedName: 'Helper',
    });
  });

  it('populates moduleAliasMap for Python namespace-import files', () => {
    const graph = createKnowledgeGraph();
    const ctx = createResolutionContext();

    // Need at least one exported symbol so exportedSymbolsByFile is non-empty
    // (otherwise the function early-returns before reaching alias-map build).
    graph.addNode(makeExportedFuncNode('Function:models.py:User', 'User', 'models.py', 'Class'));

    // Python importer — recorded in ctx.importMap (Python has namespace semantics)
    ctx.importMap.set('app.py', new Set(['models.py', 'utils/helpers.py']));

    synthesizeWildcardImportBindings(graph, ctx);

    const aliasMap = ctx.moduleAliasMap.get('app.py');
    expect(aliasMap).toBeDefined();
    // basename stem → full path
    expect(aliasMap!.get('models')).toBe('models.py');
    expect(aliasMap!.get('helpers')).toBe('utils/helpers.py');
  });

  it('caps synthesis at MAX_SYNTHETIC_BINDINGS_PER_FILE (1000) per file', () => {
    const graph = createKnowledgeGraph();
    const ctx = createResolutionContext();

    // Emit 1200 exported symbols in a single upstream Go file.
    for (let i = 0; i < 1200; i++) {
      graph.addNode(makeExportedFuncNode(`Function:pkg/big.go:Sym${i}`, `Sym${i}`, 'pkg/big.go'));
    }

    // Go is wildcard — use ctx.importMap (C/C++/Ruby/Swift path also works,
    // but Go via importMap exercises the same synthesizeForFile branch).
    ctx.importMap.set('cmd/main.go', new Set(['pkg/big.go']));

    const total = synthesizeWildcardImportBindings(graph, ctx);

    // Cap is 1000; totalSynthesized should equal the cap (not 1200).
    expect(total).toBe(1000);
    const bindings = ctx.namedImportMap.get('cmd/main.go');
    expect(bindings).toBeDefined();
    expect(bindings!.size).toBe(1000);
  });

  it('skips symbols already present in namedImportMap (dedup)', () => {
    const graph = createKnowledgeGraph();
    const ctx = createResolutionContext();

    graph.addNode(makeExportedFuncNode('Function:pkg/util.go:Helper', 'Helper', 'pkg/util.go'));
    graph.addNode(makeExportedFuncNode('Function:pkg/util.go:Other', 'Other', 'pkg/util.go'));

    // Pre-seed a binding for "Helper" with a distinct sourcePath so we can
    // detect that it was preserved rather than overwritten.
    const preExisting = new Map();
    preExisting.set('Helper', {
      sourcePath: 'other/source.go',
      exportedName: 'Helper',
    });
    ctx.namedImportMap.set('cmd/main.go', preExisting);

    ctx.importMap.set('cmd/main.go', new Set(['pkg/util.go']));

    const total = synthesizeWildcardImportBindings(graph, ctx);

    // Only "Other" should have been synthesized; "Helper" was skipped.
    expect(total).toBe(1);
    const bindings = ctx.namedImportMap.get('cmd/main.go')!;
    expect(bindings.get('Helper')!.sourcePath).toBe('other/source.go'); // untouched
    expect(bindings.get('Other')).toEqual({
      sourcePath: 'pkg/util.go',
      exportedName: 'Other',
    });
  });

  it('returns 0 early when exportedSymbolsByFile is empty (no exported symbols)', () => {
    const graph = createKnowledgeGraph();
    const ctx = createResolutionContext();

    // Even with wildcard-language imports declared, no exported symbols
    // means nothing to synthesize — function must short-circuit.
    ctx.importMap.set('cmd/main.go', new Set(['pkg/util.go']));
    graph.addRelationship(makeImportsRel('cmd/main.go', 'pkg/util.go'));

    const total = synthesizeWildcardImportBindings(graph, ctx);

    expect(total).toBe(0);
    expect(ctx.namedImportMap.size).toBe(0);
    expect(ctx.moduleAliasMap.size).toBe(0);
  });
});
