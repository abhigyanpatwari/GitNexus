import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { describe, expect, it } from 'vitest';
import {
  buildE2ETestPlanReport,
  renderE2ETestPlanMarkdown,
  type E2ETestPlanInput,
} from '../../src/core/e2e-test-generation/report.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const baseInput: E2ETestPlanInput = {
  target: {
    app: 'gitnexus-web',
    framework: 'playwright',
    browser: 'chromium',
    backendUrl: 'http://localhost:4747',
    frontendUrl: 'http://localhost:5173',
    fixturePolicy: 'CI mini fixture repo indexed before E2E run',
  },
  prImpactReport: {
    schema_version: 'pr-impact.v1alpha1',
    verdict: 'BLOCK',
    diff: {
      scope: 'compare',
      baseRef: 'main',
      headRef: 'HEAD',
      filesChanged: 2,
    },
    graph: {
      freshness: 'fresh',
      indexedCommit: 'abc123',
      currentCommit: 'abc123',
    },
    summary: {
      files_changed: 2,
      mapped_symbols: 2,
      unmatched_ranges: 0,
      deleted_symbols: 0,
      new_symbols: 0,
      impact_entries: 2,
      api_impact_entries: 1,
    },
    mapped_symbols: [
      {
        id: 'Function:app/api/grants/route.ts:updateGrant',
        name: 'updateGrant',
        kind: 'Function',
        filePath: 'app/api/grants/route.ts',
        changeType: 'modified',
      },
      {
        id: 'Function:src/components/GraphCanvas.tsx:renderGraph',
        name: 'renderGraph',
        kind: 'Function',
        filePath: 'src/components/GraphCanvas.tsx',
        changeType: 'modified',
      },
    ],
    unmatched_ranges: [],
    new_symbols: [],
    deleted_symbols: [],
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
        symbolId: 'Function:src/components/GraphCanvas.tsx:renderGraph',
        symbolName: 'renderGraph',
        risk: 'MEDIUM',
        direct: 2,
        processesAffected: 1,
        testReference: 'unknown_or_unreferenced',
      },
    ],
    api_impacts: [
      {
        route: '/api/grants',
        risk: 'HIGH',
        consumers: 3,
        mismatches: 1,
      },
    ],
    test_signal: {
      status: 'unknown_or_unreferenced',
    },
    caveats: ['High-risk impact has no known graph-derived test reference.'],
  },
  regressionForensicsReport: {
    schema_version: 'regression-forensics.v1alpha1',
    confidence: 'MEDIUM',
    recommendation: 'Investigate candidate causes before retrying the failing command.',
    failure: {
      failure_command: 'npm run test:e2e',
      exit_code: 1,
      failing_tests: ['Server Connection & Graph Loading > selects a repo from landing'],
      failure_excerpt: 'Timed out waiting for status-ready',
      environment: {
        label: 'local',
        os: 'Windows',
        runtime: 'node 24',
      },
    },
    refs: {
      known_bad_ref: 'HEAD',
    },
    impact_evidence: {
      evidence_mode: 'pr-impact',
      schema_version: 'pr-impact.v1alpha1',
      verdict: 'BLOCK',
      files_changed: 2,
      mapped_symbols: 2,
      test_signal: 'unknown_or_unreferenced',
    },
    candidate_causes: [],
    caveats: ['Report identifies candidate causes, not a proven root cause.'],
  },
  routeEvidence: [
    {
      route: '/api/grants',
      consumers: 3,
      mismatches: 1,
      evidence: 'api_impact reported consumers and one shape mismatch',
    },
  ],
  existingScenarios: [
    {
      name: 'Server Connection & Graph Loading > selects a repo from landing',
      filePath: 'gitnexus-web/e2e/server-connect.spec.ts',
      covers: ['/api/repos'],
    },
    {
      name: 'Grant route smoke',
      filePath: 'gitnexus-web/e2e/grants.spec.ts',
      covers: ['/api/grants'],
    },
  ],
};

describe('E2E test plan report core', () => {
  it('builds versioned experimental JSON and deterministic Markdown', () => {
    const report = buildE2ETestPlanReport(baseInput);

    expect(report.schema_version).toBe('e2e-test-plan.v1alpha1');
    expect(report.target.framework).toBe('playwright');
    expect(report.summary).toMatchObject({
      proposed_scenarios: 2,
      covered_by_existing_spec: 1,
      new_proposals: 1,
      high_priority: 1,
    });
    expect(report.proposals[0]).toMatchObject({
      title: 'Exercise route /api/grants after impacted API change',
      priority: 'HIGH',
      status: 'covered_by_existing_spec',
      existing_spec: 'gitnexus-web/e2e/grants.spec.ts',
    });
    expect(report.proposals[1]).toMatchObject({
      title: 'Add E2E scenario for changed surface renderGraph',
      priority: 'MEDIUM',
      status: 'new_proposal',
      target_spec: 'gitnexus-web/e2e/render-graph.spec.ts',
    });
    expect(report.caveats).toContain('V1 proposes scenarios only; it does not generate executable test files.');

    const golden = readFileSync(
      path.join(__dirname, '../fixtures/e2e-test-generation/golden-basic-report.md'),
      'utf-8',
    ).trim();
    expect(renderE2ETestPlanMarkdown(report)).toBe(golden);
  });

  it('does not emit executable Playwright code', () => {
    const markdown = renderE2ETestPlanMarkdown(buildE2ETestPlanReport(baseInput));

    expect(markdown).not.toContain('test(');
    expect(markdown).not.toContain('page.goto');
    expect(markdown).not.toContain('await page');
  });

  it('marks graph-stale inputs as low-confidence planning evidence', () => {
    const report = buildE2ETestPlanReport({
      ...baseInput,
      prImpactReport: {
        ...baseInput.prImpactReport,
        graph: {
          freshness: 'stale',
          indexedCommit: 'old456',
          currentCommit: 'abc123',
          reason: 'index commit is behind HEAD',
        },
      },
    });

    expect(report.confidence).toBe('LOW');
    expect(report.caveats).toContain('PR Impact graph evidence is stale; generated-test planning is advisory only.');
  });

  it('supports explicit-range evidence with honest provenance and caveats', () => {
    const report = buildE2ETestPlanReport({
      ...baseInput,
      prImpactReport: undefined,
      impactForRangesReport: {
        schema_version: 'impact-for-ranges.v1alpha1',
        repo: {
          name: 'gitnexus-local-features',
          indexed_commit: 'abc123',
        },
        summary: {
          input_ranges: 2,
          matched_symbols: 2,
          unmatched_ranges: 0,
          deleted_symbols: 0,
          symbols_with_processes: 1,
          unmapped_symbols: 1,
          unknown_symbols: 1,
          affected_processes: 1,
        },
        symbols: [
          {
            id: 'Function:src/components/GraphCanvas.tsx:renderGraph',
            name: 'renderGraph',
            type: 'Function',
            filePath: 'src/components/GraphCanvas.tsx',
            change_types: ['modified'],
            matched_ranges: [
              {
                filePath: 'src/components/GraphCanvas.tsx',
                startLine: 10,
                endLine: 40,
                side: 'new',
                change_type: 'modified',
              },
            ],
            processes: [
              {
                id: 'Process:graph-view',
                name: 'GraphView',
                process_type: 'ui_flow',
              },
            ],
          },
        ],
        unmapped_symbols: [
          {
            id: 'Function:src/ui/legend.ts:renderLegend',
            name: 'renderLegend',
            type: 'Function',
            filePath: 'src/ui/legend.ts',
            change_types: ['modified'],
            matched_ranges: [
              {
                filePath: 'src/ui/legend.ts',
                startLine: 1,
                endLine: 12,
                side: 'new',
                change_type: 'modified',
              },
            ],
            processes: [],
            reason: 'No direct process membership found for this symbol',
          },
        ],
        unknown_symbols: [
          {
            id: 'Symbol:unknown',
            name: 'unknownSurface',
            type: 'Function',
            change_types: ['modified'],
            matched_ranges: [
              {
                filePath: 'src/unknown.ts',
                startLine: 1,
                endLine: 3,
                side: 'new',
                change_type: 'modified',
              },
            ],
            reason: 'Symbol could not be resolved confidently',
          },
        ],
        unmatched_ranges: [],
        affected_processes: [
          {
            id: 'Process:graph-view',
            name: 'GraphView',
            process_type: 'ui_flow',
            matched_symbols: 1,
          },
        ],
        caveats: ['Direct process membership only; no caller traversal or risk scoring is included.'],
      },
      routeEvidence: [
        {
          route: '/api/processes',
          consumers: 0,
          mismatches: 0,
          evidence: 'backend route exists without current frontend consumer',
        },
      ],
    });

    expect(report.source_reports).toMatchObject({
      impact_evidence_mode: 'impact-for-ranges',
      impact_schema_version: 'impact-for-ranges.v1alpha1',
      impact_indexed_commit: 'abc123',
    });
    expect(report.source_reports.impact_verdict).toBeUndefined();
    expect(report.confidence).toBe('MEDIUM');
    expect(report.proposals.map((proposal) => proposal.id)).toEqual([
      'symbol-render-graph',
      'route-api-processes',
      'symbol-render-legend',
    ]);
    expect(report.caveats).toContain(
      'Impact-for-ranges evidence mode does not include classic PR-impact verdicts, api_impacts, or graph-derived test signal.',
    );
    expect(report.caveats).toContain(
      'Route/API prioritization in impact-for-ranges mode is inferred from supplied route evidence rather than classic PR-impact api_impacts.',
    );
    expect(report.caveats).toContain('Explicit-range evidence reported 1 unknown symbol(s).');
  });
});
