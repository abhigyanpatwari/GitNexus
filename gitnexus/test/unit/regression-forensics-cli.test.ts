import { beforeEach, describe, expect, it, vi } from 'vitest';

const readFileSyncMock = vi.fn();
const writeSyncMock = vi.fn();

vi.mock('node:fs', () => ({
  readFileSync: readFileSyncMock,
  writeSync: writeSyncMock,
}));

const failureJson = {
  failureCommand: 'npm test -- test/unit/pr-impact-report.test.ts',
  exitCode: 1,
  failingTests: ['PR Impact report core > builds versioned experimental JSON'],
  failureExcerpt: 'expected report.verdict to be BLOCK',
  environment: {
    label: 'local',
    os: 'Windows',
    runtime: 'node 24',
  },
  knownBadRef: 'HEAD',
};

const prImpactJson = {
  schema_version: 'pr-impact.v1alpha1',
  verdict: 'BLOCK',
  diff: { scope: 'compare', baseRef: 'main', headRef: 'HEAD', filesChanged: 1 },
  graph: { freshness: 'fresh' },
  summary: {
    files_changed: 1,
    mapped_symbols: 1,
    unmatched_ranges: 0,
    deleted_symbols: 0,
    new_symbols: 0,
    impact_entries: 1,
    api_impact_entries: 0,
  },
  mapped_symbols: [
    {
      id: 'Function:src/core/pr-impact/report.ts:computeVerdict',
      name: 'computeVerdict',
      kind: 'Function',
      filePath: 'src/core/pr-impact/report.ts',
      changeType: 'modified',
    },
  ],
  unmatched_ranges: [],
  new_symbols: [],
  deleted_symbols: [],
  impacts: [
    {
      symbolId: 'Function:src/core/pr-impact/report.ts:computeVerdict',
      symbolName: 'computeVerdict',
      risk: 'HIGH',
      direct: 4,
      processesAffected: 2,
      testReference: 'unknown_or_unreferenced',
    },
  ],
  api_impacts: [],
  test_signal: { status: 'unknown_or_unreferenced' },
  caveats: ['High-risk impact has no known graph-derived test reference.'],
};

describe('regression-forensics CLI command', () => {
  beforeEach(() => {
    vi.resetModules();
    readFileSyncMock.mockReset();
    writeSyncMock.mockReset();
  });

  it('reads local JSON inputs and writes Markdown', async () => {
    readFileSyncMock.mockImplementation((filePath: string) => {
      if (filePath === 'failure.json') return JSON.stringify(failureJson);
      if (filePath === 'pr-impact.json') return JSON.stringify(prImpactJson);
      throw new Error(`unexpected path ${filePath}`);
    });

    const { regressionForensicsCommand } = await import(
      '../../src/cli/regression-forensics.js'
    );

    await regressionForensicsCommand({
      failureJson: 'failure.json',
      prImpactJson: 'pr-impact.json',
      format: 'markdown',
    });

    expect(readFileSyncMock).toHaveBeenNthCalledWith(1, 'failure.json', 'utf-8');
    expect(readFileSyncMock).toHaveBeenNthCalledWith(2, 'pr-impact.json', 'utf-8');

    const output: string = writeSyncMock.mock.calls[0][1];
    expect(output).toContain('# GitNexus Regression Forensics Report');
    expect(output).toContain('Schema: regression-forensics.v1alpha1');
    expect(output).toContain('`computeVerdict`');
  });

  it('writes JSON when requested', async () => {
    readFileSyncMock.mockImplementation((filePath: string) => {
      if (filePath === 'failure.json') return JSON.stringify(failureJson);
      if (filePath === 'pr-impact.json') return JSON.stringify(prImpactJson);
      throw new Error(`unexpected path ${filePath}`);
    });

    const { regressionForensicsCommand } = await import(
      '../../src/cli/regression-forensics.js'
    );

    await regressionForensicsCommand({
      failureJson: 'failure.json',
      prImpactJson: 'pr-impact.json',
      format: 'json',
    });

    const output: string = writeSyncMock.mock.calls[0][1];
    const parsed = JSON.parse(output);
    expect(parsed.schema_version).toBe('regression-forensics.v1alpha1');
    expect(parsed.pr_impact.schema_version).toBe('pr-impact.v1alpha1');
  });
});
