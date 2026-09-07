import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const runScopeResolutionMock = vi.hoisted(() => vi.fn());
vi.mock('../../src/core/ingestion/scope-resolution/pipeline/run.js', async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import('../../src/core/ingestion/scope-resolution/pipeline/run.js')
    >();
  return { ...actual, runScopeResolution: runScopeResolutionMock };
});

import { createKnowledgeGraph } from '../../src/core/graph/graph.js';
import { createSemanticModel } from '../../src/core/ingestion/model/index.js';
import { scopeResolutionPhase } from '../../src/core/ingestion/scope-resolution/pipeline/phase.js';
import type { ParseOutput } from '../../src/core/ingestion/pipeline-phases/parse.js';
import type { StructureOutput } from '../../src/core/ingestion/pipeline-phases/structure.js';
import type {
  PhaseResult,
  PipelineContext,
} from '../../src/core/ingestion/pipeline-phases/types.js';

const phaseResult = <T>(phaseName: string, output: T): PhaseResult<T> => ({
  phaseName,
  output,
  durationMs: 0,
});

describe('scopeResolutionPhase failure reconciliation', () => {
  let repoDir = '';

  afterEach(() => {
    runScopeResolutionMock.mockReset();
    if (repoDir) fs.rmSync(repoDir, { recursive: true, force: true });
  });

  it('retains a parse failure when the main-thread provider fallback also fails', async () => {
    repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scope-phase-failure-'));
    fs.writeFileSync(path.join(repoDir, 'broken.py'), 'def broken(:\n');

    runScopeResolutionMock.mockReturnValue({
      filesProcessed: 0,
      filesSkipped: 1,
      scopeExtractionFailedPaths: ['broken.py'],
      importsEmitted: 0,
      resolve: { unresolved: 0 },
      referenceEdgesEmitted: 0,
      referenceSkipped: 0,
      propertyDispatchSkippedKeys: 0,
      importedValueRefEdges: 0,
      uniqueNamePropertyEdges: 0,
      uniqueNamePropertyAmbiguous: 0,
      uniqueNamePropertyNarrowed: 0,
      uniqueNamePropertyAmbiguousNames: [],
      uniqueNamePropertyCrossLanguage: 0,
      uniqueNamePropertyCrossLanguageNames: [],
      resolutionOutcomes: [],
      undecidedSatisfaction: [],
      functionSummaries: [],
      callSummaries: [],
    });

    const graph = createKnowledgeGraph();
    const ctx: PipelineContext = {
      repoPath: repoDir,
      graph,
      onProgress: () => {},
      pipelineStart: Date.now(),
    };
    const structure: StructureOutput = {
      scannedFiles: [{ path: 'broken.py', size: 13 }],
      allPaths: ['broken.py'],
      allPathSet: new Set(['broken.py']),
      totalFiles: 1,
    };
    const parse = {
      model: createSemanticModel(),
      parsedFiles: [],
      scopeExtractionFailures: ['broken.py'],
    } as unknown as ParseOutput;
    const deps = new Map<string, PhaseResult<unknown>>([
      ['structure', phaseResult('structure', structure)],
      ['parse', phaseResult('parse', parse)],
      ['crossFile', phaseResult('crossFile', {})],
    ]);

    const output = await scopeResolutionPhase.execute(ctx, deps);

    expect(runScopeResolutionMock).toHaveBeenCalledOnce();
    expect(output.scopeExtractionFailures).toEqual(['broken.py']);
  });
});
