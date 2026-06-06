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
    pr_impact: {
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
});
