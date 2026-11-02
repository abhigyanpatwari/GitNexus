import { describe, expect, it, vi } from 'vitest';
import Parser from 'tree-sitter';
import TypeScript from 'tree-sitter-typescript';
import { createKnowledgeGraph } from '../../../src/core/graph/graph.js';
import { createSemanticModel } from '../../../src/core/ingestion/model/semantic-model.js';
import { typescriptScopeResolver } from '../../../src/core/ingestion/languages/typescript/scope-resolver.js';
import { runScopeResolution } from '../../../src/core/ingestion/scope-resolution/pipeline/run.js';
import { collectFunctionCfgs } from '../../../src/core/ingestion/cfg/collect.js';
import { createTypeScriptCfgVisitor } from '../../../src/core/ingestion/cfg/visitors/typescript.js';

const source = 'function sample(value: number) {\n if (value) return value;\n return 0;\n}';

function sourceCollector(content: string, filePath: string, maxLines: number) {
  const parser = new Parser();
  parser.setLanguage(TypeScript.typescript);
  return collectFunctionCfgs(
    parser.parse(content).rootNode,
    createTypeScriptCfgVisitor(),
    filePath,
    maxLines,
  );
}

function analyze(pdg: boolean, collector = vi.fn(sourceCollector), maxLines?: number) {
  const graph = createKnowledgeGraph();
  const onWarn = vi.fn();
  const stats = runScopeResolution(
    {
      graph,
      model: createSemanticModel(),
      files: [{ path: 'source.ts', content: source }],
      pdg,
      pdgMaxFunctionLines: maxLines,
      onWarn,
    },
    {
      ...typescriptScopeResolver,
      languageProvider: {
        ...typescriptScopeResolver.languageProvider,
        collectSourceCfgs: collector,
      },
    },
  );
  return { graph, stats, collector, onWarn };
}

describe('source-backed provider flow collection', () => {
  it('feeds provider source CFGs through the existing CFG and CDG emission path', () => {
    const { graph, collector } = analyze(true);
    expect(collector).toHaveBeenCalledWith(source, 'source.ts', 2000);
    const kinds = new Set([...graph.iterRelationships()].map((edge) => edge.type));
    expect(kinds.has('CFG')).toBe(true);
    expect(kinds.has('CDG')).toBe(true);
  });

  it('does not collect or emit flow when PDG is disabled', () => {
    const { graph, collector } = analyze(false);
    expect(collector).not.toHaveBeenCalled();
    expect([...graph.iterNodes()].some((node) => node.label === 'BasicBlock')).toBe(false);
  });

  it('passes the configured source-region limit and reports skipped regions', () => {
    const { graph, collector, onWarn } = analyze(true, vi.fn(sourceCollector), 1);
    expect(collector).toHaveBeenCalledWith(source, 'source.ts', 1);
    expect([...graph.iterNodes()].some((node) => node.label === 'BasicBlock')).toBe(false);
    expect(onWarn).toHaveBeenCalledWith(expect.stringContaining('tooManyLines=1'));
  });

  it('keeps semantic extraction available and reports a source CFG provider failure', () => {
    const collector = vi.fn(sourceCollector).mockImplementation(() => {
      throw new Error('bad region');
    });
    const { stats, onWarn } = analyze(true, collector);
    expect(stats.filesProcessed).toBe(1);
    expect(onWarn).toHaveBeenCalledWith(expect.stringContaining('source CFG extraction failed'));
  });
});
