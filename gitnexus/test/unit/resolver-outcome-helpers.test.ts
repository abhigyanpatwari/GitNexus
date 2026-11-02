import { describe, expect, it } from 'vitest';
import { suppressionReasonsAt } from '../integration/resolvers/helpers.js';
import type { PipelineResult } from '../../src/types/pipeline.js';
import { createKnowledgeGraph } from '../../src/core/graph/graph.js';

describe('suppressionReasonsAt', () => {
  it('separates a call and a read of the same member at the same position', () => {
    const common = {
      kind: 'suppressed' as const,
      phase: 'receiver-bound-calls',
      filePath: 'app.go',
      name: 'save',
      range: { startLine: 1, startCol: 0, endLine: 1, endCol: 10 },
      candidateIds: [],
    };
    const result: PipelineResult = {
      graph: createKnowledgeGraph(),
      repoPath: '/repo',
      totalFileCount: 1,
      usedWorkerPool: false,
      reparsedFileCount: 0,
      scopeExtractionFailures: [],
      unavailableScopeLanguageFiles: 0,
      resolutionOutcomes: [
        { ...common, reason: 'receiver-unresolved', siteKind: 'call' },
        { ...common, reason: 'receiver-owned-but-unbound', siteKind: 'read' },
      ],
    };
    expect(suppressionReasonsAt(result, ['app.go', 1, 0, 'save', 'call'])).toEqual([
      'receiver-unresolved',
    ]);
    expect(suppressionReasonsAt(result, ['app.go', 1, 0, 'save', 'read'])).toEqual([
      'receiver-owned-but-unbound',
    ]);
  });
});
