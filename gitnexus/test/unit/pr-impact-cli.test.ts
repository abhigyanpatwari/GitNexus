import { beforeEach, describe, expect, it, vi } from 'vitest';

const initMock = vi.fn();
const callToolMock = vi.fn();
const writeSyncMock = vi.fn();

vi.mock('../../src/mcp/local/local-backend.js', () => ({
  LocalBackend: class {
    init = initMock;
    callTool = callToolMock;
  },
}));

vi.mock('node:fs', () => ({
  writeSync: writeSyncMock,
}));

describe('pr-impact CLI command', () => {
  beforeEach(() => {
    vi.resetModules();
    initMock.mockReset();
    callToolMock.mockReset();
    writeSyncMock.mockReset();
    initMock.mockResolvedValue(true);
  });

  it('orchestrates detect_changes, impact, api_impact, and writes Markdown', async () => {
    callToolMock
      .mockResolvedValueOnce({
        summary: {
          changed_files: 1,
          changed_count: 1,
          affected_count: 1,
          risk_level: 'high',
        },
        changed_symbols: [
          {
            id: 'Function:app/api/grants/route.ts:updateGrant',
            name: 'updateGrant',
            type: 'Function',
            filePath: 'app/api/grants/route.ts',
            change_type: 'touched',
          },
        ],
      })
      .mockResolvedValueOnce({
        risk: 'HIGH',
        summary: {
          direct: 4,
          processes_affected: 2,
        },
        byDepth: {
          1: [
            {
              name: 'updateGrant.test',
              filePath: 'app/api/grants/route.test.ts',
            },
          ],
        },
      })
      .mockResolvedValueOnce({
        route: '/api/grants',
        impactSummary: {
          riskLevel: 'MEDIUM',
          directConsumers: 3,
        },
        mismatches: [{ field: 'items' }],
      });

    const { prImpactCommand } = await import('../../src/cli/pr-impact.js');

    await prImpactCommand({
      scope: 'compare',
      baseRef: 'main',
      repo: 'gitnexus-local-features',
      format: 'markdown',
    });

    expect(callToolMock).toHaveBeenNthCalledWith(1, 'detect_changes', {
      scope: 'compare',
      base_ref: 'main',
      repo: 'gitnexus-local-features',
    });
    expect(callToolMock).toHaveBeenNthCalledWith(2, 'impact', {
      target: 'updateGrant',
      target_uid: 'Function:app/api/grants/route.ts:updateGrant',
      direction: 'upstream',
      maxDepth: 5,
      includeTests: true,
      repo: 'gitnexus-local-features',
      limit: 50,
    });
    expect(callToolMock).toHaveBeenNthCalledWith(3, 'api_impact', {
      file: 'app/api/grants/route.ts',
      repo: 'gitnexus-local-features',
    });

    const output: string = writeSyncMock.mock.calls[0][1];
    expect(output).toContain('# GitNexus PR Impact Report');
    expect(output).toContain('Verdict: NEEDS_DISCUSSION');
    expect(output).toContain('| `/api/grants` | MEDIUM | 3 | 1 |');
  });

  it('writes JSON when requested', async () => {
    callToolMock.mockResolvedValueOnce({
      summary: { changed_files: 0, changed_count: 0, affected_count: 0, risk_level: 'none' },
      changed_symbols: [],
    });

    const { prImpactCommand } = await import('../../src/cli/pr-impact.js');

    await prImpactCommand({ format: 'json' });

    const output: string = writeSyncMock.mock.calls[0][1];
    const parsed = JSON.parse(output);
    expect(parsed.schema_version).toBe('pr-impact.v1alpha1');
    expect(parsed.verdict).toBe('PROCEED');
  });
});
