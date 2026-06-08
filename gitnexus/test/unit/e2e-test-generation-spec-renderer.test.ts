import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { describe, expect, it } from 'vitest';
import type { E2ETestPlanReport } from '../../src/core/e2e-test-generation/report.js';
import {
  renderE2EGeneratedSpecs,
  type ExistingGeneratedSpec,
} from '../../src/core/e2e-test-generation/spec-renderer.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const baseReport: E2ETestPlanReport = {
  schema_version: 'e2e-test-plan.v1alpha1',
  confidence: 'MEDIUM',
  target: {
    app: 'gitnexus-web',
    framework: 'playwright',
    browser: 'chromium',
    backendUrl: 'http://localhost:4747',
    frontendUrl: 'http://localhost:5173',
    fixturePolicy: 'CI mini fixture repo indexed before E2E run',
  },
  summary: {
    proposed_scenarios: 1,
    covered_by_existing_spec: 0,
    new_proposals: 1,
    high_priority: 1,
  },
  source_reports: {
    impact_evidence_mode: 'pr-impact',
    impact_schema_version: 'pr-impact.v1alpha1',
    impact_verdict: 'NEEDS_DISCUSSION',
  },
  proposals: [
    {
      id: 'route-api-repos',
      title: 'Exercise route /api/repos after impacted API change',
      priority: 'HIGH',
      status: 'new_proposal',
      target_spec: 'gitnexus-web/e2e/api-repos.spec.ts',
      evidence: [
        'Route /api/repos has risk HIGH',
        'Consumers: 2',
        'Mismatches: 0',
      ],
    },
  ],
  caveats: ['V1 proposes scenarios only; it does not generate executable test files.'],
};

const handWrittenSpec: ExistingGeneratedSpec = {
  path: 'gitnexus-web/e2e/generated/route-api-repos.generated.spec.ts',
  generated: false,
};

const generatedSpec: ExistingGeneratedSpec = {
  path: 'gitnexus-web/e2e/generated/route-api-repos.generated.spec.ts',
  generated: true,
};

describe('E2E generated spec renderer', () => {
  it('renders deterministic Playwright text and stable output path for safe route proposals', () => {
    const result = renderE2EGeneratedSpecs(baseReport);

    expect(result.blocked).toEqual([]);
    expect(result.specs).toHaveLength(1);
    expect(result.specs[0].path).toBe(
      'gitnexus-web/e2e/generated/route-api-repos.generated.spec.ts',
    );

    const golden = readFileSync(
      path.join(__dirname, '../fixtures/e2e-test-generation/generated-route.spec.ts'),
      'utf-8',
    ).trim();
    expect(result.specs[0].text).toBe(golden);
  });

  it('renders deterministic Playwright text for /api/repo route proposals', () => {
    const result = renderE2EGeneratedSpecs({
      ...baseReport,
      proposals: [
        {
          ...baseReport.proposals[0],
          id: 'route-api-repo',
          title: 'Exercise route /api/repo after impacted API change',
          target_spec: 'gitnexus-web/e2e/api-repo.spec.ts',
          evidence: [
            'Route /api/repo has risk HIGH',
            'Consumers: 1',
            'Mismatches: 0',
          ],
        },
      ],
    });

    expect(result.blocked).toEqual([]);
    expect(result.specs).toHaveLength(1);
    expect(result.specs[0].path).toBe(
      'gitnexus-web/e2e/generated/route-api-repo.generated.spec.ts',
    );

    const golden = readFileSync(
      path.join(__dirname, '../fixtures/e2e-test-generation/generated-api-repo-route.spec.ts'),
      'utf-8',
    ).trim();
    expect(result.specs[0].text).toBe(golden);
  });

  it('keeps /api/repo graph-stat assertions aligned with mocked /api/graph data', () => {
    const result = renderE2EGeneratedSpecs({
      ...baseReport,
      proposals: [
        {
          ...baseReport.proposals[0],
          id: 'route-api-repo',
          title: 'Exercise route /api/repo after impacted API change',
          target_spec: 'gitnexus-web/e2e/api-repo.spec.ts',
          evidence: ['Route /api/repo has risk HIGH'],
        },
      ],
    });

    const text = result.specs[0].text;

    expect(text).not.toContain('JSON.stringify({ nodes: [], relationships: [] })');
    expect(text).toContain("await expect(page.getByRole('contentinfo').getByTestId('graph-stats')).toContainText('2 nodes');");
    expect(text).toContain("await expect(page.getByRole('contentinfo').getByTestId('graph-stats')).toContainText('1 edge');");
  });

  it('renders deterministic Playwright text for /api/graph route proposals', () => {
    const result = renderE2EGeneratedSpecs({
      ...baseReport,
      proposals: [
        {
          ...baseReport.proposals[0],
          id: 'route-api-graph',
          title: 'Exercise route /api/graph after impacted API change',
          target_spec: 'gitnexus-web/e2e/api-graph.spec.ts',
          evidence: [
            'Route /api/graph has risk HIGH',
            'Consumers: 1',
            'Mismatches: 0',
          ],
        },
      ],
    });

    expect(result.blocked).toEqual([]);
    expect(result.specs).toHaveLength(1);
    expect(result.specs[0].path).toBe(
      'gitnexus-web/e2e/generated/route-api-graph.generated.spec.ts',
    );

    const golden = readFileSync(
      path.join(__dirname, '../fixtures/e2e-test-generation/generated-api-graph-route.spec.ts'),
      'utf-8',
    ).trim();
    expect(result.specs[0].text).toBe(golden);
  });

  it('renders deterministic Playwright text for /api/file route proposals', () => {
    const result = renderE2EGeneratedSpecs({
      ...baseReport,
      proposals: [
        {
          ...baseReport.proposals[0],
          id: 'route-api-file',
          title: 'Exercise route /api/file after impacted API change',
          target_spec: 'gitnexus-web/e2e/api-file.spec.ts',
          evidence: [
            'Route /api/file has risk HIGH',
            'Consumers: 1',
            'Mismatches: 0',
          ],
        },
      ],
    });

    expect(result.blocked).toEqual([]);
    expect(result.specs).toHaveLength(1);
    expect(result.specs[0].path).toBe(
      'gitnexus-web/e2e/generated/route-api-file.generated.spec.ts',
    );

    const golden = readFileSync(
      path.join(__dirname, '../fixtures/e2e-test-generation/generated-api-file-route.spec.ts'),
      'utf-8',
    ).trim();
    expect(result.specs[0].text).toBe(golden);
  });

  it('blocks unsafe or unsupported proposals instead of emitting brittle specs', () => {
    const result = renderE2EGeneratedSpecs({
      ...baseReport,
      proposals: [
        {
          ...baseReport.proposals[0],
          id: 'symbol-render-graph',
          title: 'Add E2E scenario for changed surface renderGraph',
          target_spec: 'gitnexus-web/e2e/render-graph.spec.ts',
          evidence: ['Risk: MEDIUM', 'Processes affected: 1'],
        },
        {
          ...baseReport.proposals[0],
          id: 'route-api-secret',
          title: 'Exercise route /api/secret after impacted API change',
          target_spec: 'C:/Users/steve/tmp/secret.spec.ts',
          evidence: ['Requires token credential', 'Route /api/secret has risk HIGH'],
        },
      ],
    });

    expect(result.specs).toEqual([]);
    expect(result.blocked).toEqual([
      {
        proposalId: 'symbol-render-graph',
        reason: 'Only route proposals are supported by the generated-spec V1 renderer.',
      },
      {
        proposalId: 'route-api-secret',
        reason: 'Proposal evidence references credentials or secrets.',
      },
    ]);
  });

  it('keeps /api/processes out of the browser UI generated-spec lane', () => {
    const result = renderE2EGeneratedSpecs({
      ...baseReport,
      proposals: [
        {
          ...baseReport.proposals[0],
          id: 'route-api-processes',
          title: 'Exercise route /api/processes after impacted API change',
          target_spec: 'gitnexus-web/e2e/api-processes.spec.ts',
          evidence: [
            'Route /api/processes has risk HIGH',
            'Consumers: 0',
            'Mismatches: 0',
          ],
        },
      ],
    });

    expect(result.specs).toEqual([]);
    expect(result.blocked).toEqual([
      {
        proposalId: 'route-api-processes',
        reason:
          'Only /api/repos, /api/repo, /api/graph, and /api/file route proposals have deterministic generated fixtures in V1.',
      },
    ]);
  });

  it('refuses to overwrite hand-written specs and only overwrites generated specs with force', () => {
    const defaultResult = renderE2EGeneratedSpecs(baseReport, {
      existingSpecs: [handWrittenSpec],
    });
    expect(defaultResult.specs).toEqual([]);
    expect(defaultResult.blocked).toEqual([
      {
        proposalId: 'route-api-repos',
        reason: 'Refusing to overwrite an existing hand-written spec.',
      },
    ]);

    const generatedNoForce = renderE2EGeneratedSpecs(baseReport, {
      existingSpecs: [generatedSpec],
    });
    expect(generatedNoForce.specs).toEqual([]);
    expect(generatedNoForce.blocked).toEqual([
      {
        proposalId: 'route-api-repos',
        reason: 'Generated spec already exists; pass force to overwrite.',
      },
    ]);

    const forced = renderE2EGeneratedSpecs(baseReport, {
      existingSpecs: [generatedSpec],
      force: true,
    });
    expect(forced.specs).toHaveLength(1);
    expect(forced.blocked).toEqual([]);
  });

  it('does not emit credentials, absolute personal paths, CSS selectors, or canvas-coordinate assertions', () => {
    const result = renderE2EGeneratedSpecs(baseReport);
    const text = result.specs[0].text;

    expect(text).not.toMatch(/token|credential|password|secret/i);
    expect(text).not.toMatch(/[A-Z]:\\\\|C:\\/);
    expect(text).not.toContain("locator('.");
    expect(text).not.toContain('locator("#');
    expect(text).not.toContain('canvas');
    expect(text).not.toMatch(/mouse\\.click|boundingBox/);
  });
});
