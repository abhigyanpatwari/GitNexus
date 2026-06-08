import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { describe, expect, it } from 'vitest';
import type { E2ETestPlanReport } from '../../src/core/e2e-test-generation/report.js';
import {
  renderE2EGeneratedApiSmokeSpecs,
  type ExistingGeneratedApiSmokeSpec,
} from '../../src/core/e2e-test-generation/api-smoke-renderer.js';

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
    pr_impact_schema_version: 'pr-impact.v1alpha1',
    pr_impact_verdict: 'NEEDS_DISCUSSION',
  },
  proposals: [
    {
      id: 'route-api-processes',
      title: 'Exercise route /api/processes after impacted API change',
      priority: 'HIGH',
      status: 'new_proposal',
      target_spec: 'gitnexus/test/api-smoke/api-processes.spec.ts',
      evidence: [
        'Route /api/processes has risk HIGH',
        'Consumers: 0',
        'Mismatches: 0',
      ],
    },
  ],
  caveats: ['V1 proposes scenarios only; it does not generate executable test files.'],
};

const handWrittenSpec: ExistingGeneratedApiSmokeSpec = {
  path: 'gitnexus/test/api-smoke/generated/route-api-processes.generated.api.spec.ts',
  generated: false,
};

const generatedSpec: ExistingGeneratedApiSmokeSpec = {
  path: 'gitnexus/test/api-smoke/generated/route-api-processes.generated.api.spec.ts',
  generated: true,
};

describe('E2E generated API smoke renderer', () => {
  it('renders deterministic Playwright APIRequestContext text for /api/processes', () => {
    const result = renderE2EGeneratedApiSmokeSpecs(baseReport);

    expect(result.blocked).toEqual([]);
    expect(result.specs).toHaveLength(1);
    expect(result.specs[0].path).toBe(
      'gitnexus/test/api-smoke/generated/route-api-processes.generated.api.spec.ts',
    );
    expect(result.specs[0].text).toContain('request.get(apiUrl');
    expect(result.specs[0].text).not.toContain('page.goto');

    const golden = readFileSync(
      path.join(__dirname, '../fixtures/e2e-test-generation/generated-api-processes-smoke.spec.ts'),
      'utf-8',
    ).trim();
    expect(result.specs[0].text).toBe(golden);
  });

  it('renders deterministic Playwright APIRequestContext text for /api/health', () => {
    const result = renderE2EGeneratedApiSmokeSpecs({
      ...baseReport,
      proposals: [
        {
          ...baseReport.proposals[0],
          id: 'route-api-health',
          title: 'Exercise route /api/health after impacted API change',
          target_spec: 'gitnexus/test/api-smoke/api-health.spec.ts',
          evidence: [
            'Route /api/health has risk LOW',
            'Consumers: 0',
            'Mismatches: 0',
          ],
        },
      ],
    });

    expect(result.blocked).toEqual([]);
    expect(result.specs).toHaveLength(1);
    expect(result.specs[0].path).toBe(
      'gitnexus/test/api-smoke/generated/route-api-health.generated.api.spec.ts',
    );
    expect(result.specs[0].text).toContain("request.get(apiUrl('/api/health'))");
    expect(result.specs[0].text).not.toContain('page.goto');

    const golden = readFileSync(
      path.join(__dirname, '../fixtures/e2e-test-generation/generated-api-health-smoke.spec.ts'),
      'utf-8',
    ).trim();
    expect(result.specs[0].text).toBe(golden);
  });

  it('renders deterministic Playwright APIRequestContext text for /api/info', () => {
    const result = renderE2EGeneratedApiSmokeSpecs({
      ...baseReport,
      proposals: [
        {
          ...baseReport.proposals[0],
          id: 'route-api-info',
          title: 'Exercise route /api/info after impacted API change',
          target_spec: 'gitnexus/test/api-smoke/api-info.spec.ts',
          evidence: [
            'Route /api/info has risk LOW',
            'Consumers: 0',
            'Mismatches: 0',
          ],
        },
      ],
    });

    expect(result.blocked).toEqual([]);
    expect(result.specs).toHaveLength(1);
    expect(result.specs[0].path).toBe(
      'gitnexus/test/api-smoke/generated/route-api-info.generated.api.spec.ts',
    );
    expect(result.specs[0].text).toContain("request.get(apiUrl('/api/info'))");
    expect(result.specs[0].text).not.toContain('page.goto');

    const golden = readFileSync(
      path.join(__dirname, '../fixtures/e2e-test-generation/generated-api-info-smoke.spec.ts'),
      'utf-8',
    ).trim();
    expect(result.specs[0].text).toBe(golden);
  });

  it('blocks unsupported routes instead of widening the API-smoke lane silently', () => {
    const result = renderE2EGeneratedApiSmokeSpecs({
      ...baseReport,
      proposals: [
        {
          ...baseReport.proposals[0],
          id: 'route-api-graph',
          title: 'Exercise route /api/graph after impacted API change',
          target_spec: 'gitnexus/test/api-smoke/api-graph.spec.ts',
          evidence: ['Route /api/graph has risk HIGH'],
        },
      ],
    });

    expect(result.specs).toEqual([]);
    expect(result.blocked).toEqual([
      {
        proposalId: 'route-api-graph',
        reason:
          'Only /api/processes, /api/health, and /api/info route proposals have deterministic API-smoke fixtures in V1.',
      },
    ]);
  });

  it('refuses to overwrite hand-written API-smoke specs and only overwrites generated specs with force', () => {
    const defaultResult = renderE2EGeneratedApiSmokeSpecs(baseReport, {
      existingSpecs: [handWrittenSpec],
    });
    expect(defaultResult.specs).toEqual([]);
    expect(defaultResult.blocked).toEqual([
      {
        proposalId: 'route-api-processes',
        reason: 'Refusing to overwrite an existing hand-written API-smoke spec.',
      },
    ]);

    const generatedNoForce = renderE2EGeneratedApiSmokeSpecs(baseReport, {
      existingSpecs: [generatedSpec],
    });
    expect(generatedNoForce.specs).toEqual([]);
    expect(generatedNoForce.blocked).toEqual([
      {
        proposalId: 'route-api-processes',
        reason: 'Generated API-smoke spec already exists; pass force to overwrite.',
      },
    ]);

    const forced = renderE2EGeneratedApiSmokeSpecs(baseReport, {
      existingSpecs: [generatedSpec],
      force: true,
    });
    expect(forced.specs).toHaveLength(1);
    expect(forced.blocked).toEqual([]);
  });

  it('uses a separate default output path from browser UI generated specs', () => {
    const result = renderE2EGeneratedApiSmokeSpecs(baseReport);

    expect(result.specs[0].path).toContain('gitnexus/test/api-smoke/generated/');
    expect(result.specs[0].path).not.toContain('gitnexus-web/e2e/generated/');
  });
});
