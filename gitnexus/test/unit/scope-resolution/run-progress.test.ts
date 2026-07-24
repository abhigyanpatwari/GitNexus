import { describe, it, expect, vi } from 'vitest';
import type { ParsedFile, ScopeId, Scope } from 'gitnexus-shared';
import {
  formatScopeResolutionWarningContext,
  MAX_PROGRESS_WARNING_CONTEXT_CHARS,
  runScopeResolution,
  type ScopeResolutionSubPhase,
} from '../../../src/core/ingestion/scope-resolution/pipeline/run.js';
import { createKnowledgeGraph } from '../../../src/core/graph/graph.js';
import { createSemanticModel } from '../../../src/core/ingestion/model/semantic-model.js';
import type { ScopeResolver } from '../../../src/core/ingestion/scope-resolution/contract/scope-resolver.js';
import { _captureLogger, warnRespectingProgressBar } from '../../../src/core/logger.js';

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
  it('escapes control bytes and bounds progress warning contexts', () => {
    const formatted = formatScopeResolutionWarningContext(`binding\0${'x'.repeat(200)}`);

    expect(formatted).not.toContain('\0');
    expect(formatted).toContain('\\u0000');
    expect(formatted).toHaveLength(MAX_PROGRESS_WARNING_CONTEXT_CHARS);
    expect(formatted.endsWith('...')).toBe(true);
  });

  it('routes warnings through the analyze progress logger instead of Pino', () => {
    const previous = process.env.GITNEXUS_ANALYZE_PROGRESS_ACTIVE;
    const capture = _captureLogger();
    const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      process.env.GITNEXUS_ANALYZE_PROGRESS_ACTIVE = '1';
      warnRespectingProgressBar('progress-safe warning', {
        fields: { language: 'move', occurrences: 2 },
        message: 'structured warning',
      });

      expect(consoleWarn).toHaveBeenCalledOnce();
      expect(consoleWarn).toHaveBeenCalledWith('progress-safe warning');
      expect(capture.records()).toEqual([]);
    } finally {
      consoleWarn.mockRestore();
      capture.restore();
      if (previous === undefined) delete process.env.GITNEXUS_ANALYZE_PROGRESS_ACTIVE;
      else process.env.GITNEXUS_ANALYZE_PROGRESS_ACTIVE = previous;
    }
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
});
