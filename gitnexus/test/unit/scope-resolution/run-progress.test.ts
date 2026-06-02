import { describe, it, expect } from 'vitest';
import type { ParsedFile, ScopeId, Scope } from 'gitnexus-shared';
import {
  runScopeResolution,
  type ScopeResolutionSubPhase,
} from '../../../src/core/ingestion/scope-resolution/pipeline/run.js';
import { createKnowledgeGraph } from '../../../src/core/graph/graph.js';
import { createSemanticModel } from '../../../src/core/ingestion/model/semantic-model.js';
import type { ScopeResolver } from '../../../src/core/ingestion/scope-resolution/contract/scope-resolver.js';

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

describe('runScopeResolution onProgress', () => {
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
});
