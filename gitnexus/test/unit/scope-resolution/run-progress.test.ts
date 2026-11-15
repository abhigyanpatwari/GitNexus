import { describe, it, expect } from 'vitest';
import type { ParsedFile, ReferenceSite, ScopeId, Scope, SymbolDefinition } from 'gitnexus-shared';
import {
  runScopeResolution,
  type ScopeResolutionSubPhase,
} from '../../../src/core/ingestion/scope-resolution/pipeline/run.js';
import { createKnowledgeGraph } from '../../../src/core/graph/graph.js';
import { createSemanticModel } from '../../../src/core/ingestion/model/semantic-model.js';
import type { ScopeResolver } from '../../../src/core/ingestion/scope-resolution/contract/scope-resolver.js';
import type { LanguageProvider } from '../../../src/core/ingestion/language-provider.js';

const mkScope = (id: ScopeId, filePath: string): Scope => ({
  id,
  parent: null,
  kind: 'Module',
  range: { startLine: 1, startCol: 0, endLine: 10, endCol: 0 },
  filePath,
  bindings: new Map(),
  ownedDefs: [],
  imports: [],
  typeBindings: new Map(),
});

const mkFile = (filePath: string): ParsedFile => ({
  filePath,
  moduleScope: `scope:${filePath}#module`,
  scopes: [mkScope(`scope:${filePath}#module`, filePath)],
  parsedImports: [],
  localDefs: [],
  referenceSites: [],
});

const stubProvider = {
  language: 'python' as const,
  languageProvider: {} as ScopeResolver['languageProvider'],
  importEdgeReason: 'test',
  populateOwners: () => {},
  resolveImportTarget: () => null,
  mergeBindings: (existing: unknown) => existing,
  buildMro: () => new Map(),
  propagatesReturnTypesAcrossImports: false,
} as unknown as ScopeResolver;

const providerWithEmitter = (emitScopeCaptures: LanguageProvider['emitScopeCaptures']) =>
  ({
    ...stubProvider,
    languageProvider: { emitScopeCaptures } as LanguageProvider,
  }) as ScopeResolver;

describe('runScopeResolution onProgress', () => {
  it('exposes every source binding while preserving graph output with observation disabled', () => {
    const run = (observe: boolean) => {
      const graph = createKnowledgeGraph();
      const definition: SymbolDefinition = {
        nodeId: 'def:helper',
        type: 'Function',
        filePath: 'a.py',
        qualifiedName: 'helper',
      };
      const parsed = mkFile('a.py');
      const sites: ReferenceSite[] = [3, 4].map((line) => ({
        name: 'helper',
        kind: 'call',
        callForm: 'free',
        inScope: parsed.moduleScope,
        atRange: { startLine: line, startCol: 0, endLine: line, endCol: 8 },
      }));
      const source = {
        ...parsed,
        localDefs: [definition],
        referenceSites: sites,
        scopes: [
          {
            ...parsed.scopes[0]!,
            ownedDefs: [definition],
            bindings: new Map([['helper', [{ def: definition, origin: 'local' as const }]]]),
          },
        ],
      };
      graph.addNode({
        id: 'function:helper',
        label: 'Function',
        properties: { name: 'helper', qualifiedName: 'helper', filePath: 'a.py' },
      });
      graph.addNode({
        id: 'file:a.py',
        label: 'File',
        properties: { name: 'a.py', filePath: 'a.py' },
      });
      const observed: unknown[] = [];
      runScopeResolution(
        {
          graph,
          model: createSemanticModel(),
          files: [{ path: 'a.py', content: 'def helper(): pass\nhelper()\nhelper()' }],
          preExtractedParsedFiles: new Map([['a.py', source]]),
          ...(observe
            ? {
                onResolved: (result) => {
                  for (const site of result.parsedFiles[0]!.referenceSites)
                    observed.push(result.referenceBindings.get(site));
                },
              }
            : {}),
        },
        stubProvider,
      );
      return { graph, observed };
    };
    const plain = run(false);
    const observed = run(true);
    expect(observed.graph.relationships).toEqual(plain.graph.relationships);
    expect(observed.observed).toHaveLength(2);
    for (const binding of observed.observed)
      expect(binding).toMatchObject({ status: 'resolved', targetDefIds: ['def:helper'] });
  });

  it('emits sub-phases in order for a 3-file input', () => {
    const files = [
      { path: 'a.py', content: '' },
      { path: 'b.py', content: '' },
      { path: 'c.py', content: '' },
    ];
    const preExtracted = new Map<string, ParsedFile>();
    for (const f of files) preExtracted.set(f.path, mkFile(f.path));

    const calls: { subPhase: ScopeResolutionSubPhase; current: number; total: number }[] = [];
    const onProgress = (subPhase: ScopeResolutionSubPhase, current: number, total: number) => {
      calls.push({ subPhase, current, total });
    };

    runScopeResolution(
      {
        graph: createKnowledgeGraph(),
        model: createSemanticModel(),
        files,
        preExtractedParsedFiles: preExtracted,
        onProgress,
      },
      stubProvider,
    );

    const subPhases = calls.map((c) => c.subPhase);
    expect(subPhases).toContain('extracting');
    expect(subPhases).toContain('analyzing types');
    expect(subPhases).toContain('resolving references');
    expect(subPhases).toContain('linking symbols');

    const extractCalls = calls.filter((c) => c.subPhase === 'extracting');
    expect(extractCalls.length).toBeGreaterThan(0);
    expect(extractCalls[0].total).toBe(3);
    expect(extractCalls[0].current).toBe(0);
    expect(extractCalls[extractCalls.length - 1].current).toBe(3);

    const analyzeIdx = subPhases.indexOf('analyzing types');
    const resolveIdx = subPhases.indexOf('resolving references');
    const linkIdx = subPhases.indexOf('linking symbols');
    expect(analyzeIdx).toBeLessThan(resolveIdx);
    expect(resolveIdx).toBeLessThan(linkIdx);
  });

  it('emits only extracting (0, 0) then returns early for 0-file input', () => {
    const calls: { subPhase: ScopeResolutionSubPhase; current: number; total: number }[] = [];
    const onProgress = (subPhase: ScopeResolutionSubPhase, current: number, total: number) => {
      calls.push({ subPhase, current, total });
    };

    const stats = runScopeResolution(
      {
        graph: createKnowledgeGraph(),
        model: createSemanticModel(),
        files: [],
        onProgress,
      },
      stubProvider,
    );

    expect(stats.filesProcessed).toBe(0);
    expect(calls).toEqual([{ subPhase: 'extracting', current: 0, total: 0 }]);
  });

  it('counts empty migrated files as skipped without recording extraction failures', () => {
    const stats = runScopeResolution(
      {
        graph: createKnowledgeGraph(),
        model: createSemanticModel(),
        files: [
          { path: 'empty.py', content: '' },
          { path: 'whitespace.py', content: ' \n\t' },
        ],
      },
      providerWithEmitter(() => {
        throw new Error('empty files must short-circuit before capture');
      }),
    );

    expect(stats.filesProcessed).toBe(0);
    expect(stats.filesSkipped).toBe(2);
    expect(stats.scopeExtractionFailedPaths).toEqual([]);
  });

  it('records a warned emitter failure as a final extraction omission', () => {
    const warnings: string[] = [];
    const stats = runScopeResolution(
      {
        graph: createKnowledgeGraph(),
        model: createSemanticModel(),
        files: [{ path: 'broken.py', content: 'value = 1' }],
        onWarn: (warning) => warnings.push(warning),
      },
      providerWithEmitter(() => {
        throw new Error('capture failed');
      }),
    );

    expect(stats.filesProcessed).toBe(0);
    expect(stats.filesSkipped).toBe(1);
    expect(stats.scopeExtractionFailedPaths).toEqual(['broken.py']);
    expect(warnings).toEqual([expect.stringContaining('capture failed')]);
  });
});
