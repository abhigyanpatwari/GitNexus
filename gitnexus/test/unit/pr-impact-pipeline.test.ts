import { describe, expect, it, vi } from 'vitest';
import { buildPrImpactPipelineReport } from '../../src/core/pr-impact/pipeline.js';

describe('PR Impact pipeline', () => {
  it('orchestrates local graph primitives into the versioned PR Impact report', async () => {
    const callTool = vi
      .fn()
      .mockResolvedValueOnce({
        summary: { changed_files: 1 },
        changed_symbols: [
          {
            id: 'Function:app/api/grants/route.ts:updateGrant',
            name: 'updateGrant',
            type: 'Function',
            filePath: 'app/api/grants/route.ts',
            change_type: 'modified',
          },
        ],
      })
      .mockResolvedValueOnce({
        risk: 'HIGH',
        summary: { direct: 4, processes_affected: 2 },
        byDepth: {
          1: [{ filePath: 'app/api/grants/route.test.ts' }],
        },
      })
      .mockResolvedValueOnce({
        route: '/api/grants',
        impactSummary: { riskLevel: 'MEDIUM', directConsumers: 3 },
        mismatches: [{ field: 'meta' }],
      });

    const report = await buildPrImpactPipelineReport(
      { callTool },
      {
        scope: 'compare',
        baseRef: 'main',
        repo: 'gitnexus-local-features',
      },
    );

    expect(callTool).toHaveBeenNthCalledWith(1, 'detect_changes', {
      scope: 'compare',
      base_ref: 'main',
      repo: 'gitnexus-local-features',
    });
    expect(callTool).toHaveBeenNthCalledWith(2, 'impact', {
      target: 'updateGrant',
      target_uid: 'Function:app/api/grants/route.ts:updateGrant',
      direction: 'upstream',
      maxDepth: 5,
      includeTests: true,
      repo: 'gitnexus-local-features',
      limit: 50,
    });
    expect(callTool).toHaveBeenNthCalledWith(3, 'api_impact', {
      file: 'app/api/grants/route.ts',
      repo: 'gitnexus-local-features',
    });
    expect(report.schema_version).toBe('pr-impact.v1alpha1');
    expect(report.mapped_symbols).toHaveLength(1);
    expect(report.api_impacts).toEqual([
      { route: '/api/grants', risk: 'MEDIUM', consumers: 3, mismatches: 1 },
    ]);
    expect(report.test_signal.status).toBe('has_test_reference');
  });
});
