import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { describe, expect, it } from 'vitest';
import {
  buildPrImpactReport,
  renderPrImpactMarkdown,
  type PrImpactReportInput,
} from '../../src/core/pr-impact/report.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const baseInput: PrImpactReportInput = {
  diff: {
    scope: 'compare',
    baseRef: 'main',
    headRef: 'HEAD',
    filesChanged: 3,
  },
  graph: {
    freshness: 'fresh',
    indexedCommit: 'abc123',
    currentCommit: 'abc123',
  },
  mappedSymbols: [
    {
      id: 'Function:app/api/grants/route.ts:updateGrant',
      name: 'updateGrant',
      kind: 'Function',
      filePath: 'app/api/grants/route.ts',
      changeType: 'modified',
    },
    {
      id: 'Function:hooks/useGrants.ts:useGrants',
      name: 'useGrants',
      kind: 'Function',
      filePath: 'hooks/useGrants.ts',
      changeType: 'modified',
    },
  ],
  unmatchedRanges: [
    {
      filePath: 'app/api/grants/route.ts',
      startLine: 44,
      endLine: 46,
      reason: 'No indexed symbol overlapped this changed range',
      riskHint: 'high',
    },
  ],
  newSymbols: [
    {
      name: 'formatGrantRow',
      kind: 'Function',
      filePath: 'components/GrantRow.tsx',
      reason: 'New symbol is not present in the base graph',
    },
  ],
  deletedSymbols: [],
  impacts: [
    {
      symbolId: 'Function:app/api/grants/route.ts:updateGrant',
      symbolName: 'updateGrant',
      risk: 'HIGH',
      direct: 4,
      processesAffected: 2,
      testReference: 'unknown_or_unreferenced',
    },
    {
      symbolId: 'Function:hooks/useGrants.ts:useGrants',
      symbolName: 'useGrants',
      risk: 'MEDIUM',
      direct: 2,
      processesAffected: 1,
      testReference: 'has_test_reference',
    },
  ],
  apiImpacts: [
    {
      route: '/api/grants',
      risk: 'MEDIUM',
      consumers: 3,
      mismatches: 1,
    },
  ],
};

describe('PR Impact report core', () => {
  it('builds versioned experimental JSON and deterministic Markdown', () => {
    const report = buildPrImpactReport(baseInput);

    expect(report.schema_version).toBe('pr-impact.v1alpha1');
    expect(report.verdict).toBe('BLOCK');
    expect(report.test_signal.status).toBe('unknown_or_unreferenced');
    expect(report.summary).toMatchObject({
      files_changed: 3,
      mapped_symbols: 2,
      unmatched_ranges: 1,
      deleted_symbols: 0,
      new_symbols: 1,
      impact_entries: 2,
      api_impact_entries: 1,
    });
    expect(report.caveats).toContain('Graph evidence is current for commit abc123.');
    expect(report.caveats).toContain('Unmatched high-risk ranges require human review.');

    const golden = readFileSync(
      path.join(__dirname, '../fixtures/pr-impact/golden-basic-report.md'),
      'utf-8',
    ).trim();
    expect(renderPrImpactMarkdown(report)).toBe(golden);
  });

  it('returns BLOCK for deleted symbols with inbound callers', () => {
    const report = buildPrImpactReport({
      ...baseInput,
      unmatchedRanges: [],
      newSymbols: [],
      apiImpacts: [],
      deletedSymbols: [
        {
          id: 'Function:src/auth.ts:validateUser',
          name: 'validateUser',
          kind: 'Function',
          filePath: 'src/auth.ts',
          inboundCallers: 3,
        },
      ],
      impacts: [],
    });

    expect(report.verdict).toBe('BLOCK');
    expect(report.caveats).toContain('Deleted symbol `validateUser` has 3 inbound caller(s).');
  });

  it('returns UNKNOWN when graph freshness is stale or ambiguous', () => {
    const report = buildPrImpactReport({
      ...baseInput,
      graph: {
        freshness: 'stale',
        indexedCommit: 'old456',
        currentCommit: 'abc123',
        reason: 'index commit is behind HEAD',
      },
    });

    expect(report.verdict).toBe('UNKNOWN');
    expect(report.caveats).toContain('Graph evidence is stale: index commit is behind HEAD.');
  });

  it('omits optional Markdown sections when there is no graph evidence', () => {
    const report = buildPrImpactReport({
      diff: { scope: 'unstaged', filesChanged: 1 },
      graph: { freshness: 'fresh' },
      mappedSymbols: [],
      unmatchedRanges: [],
      newSymbols: [],
      deletedSymbols: [],
      impacts: [],
      apiImpacts: [],
    });

    const markdown = renderPrImpactMarkdown(report);

    expect(report.verdict).toBe('PROCEED');
    expect(markdown).not.toContain('## Changed Symbols');
    expect(markdown).not.toContain('## API Impact');
    expect(markdown).not.toContain('## Caveats');
  });
});
