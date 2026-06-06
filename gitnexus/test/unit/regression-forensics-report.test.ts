import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { describe, expect, it } from 'vitest';
import {
  buildRegressionForensicsReport,
  renderRegressionForensicsMarkdown,
  type RegressionForensicsInput,
} from '../../src/core/regression-forensics/report.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const baseInput: RegressionForensicsInput = {
  failure: {
    failureCommand: 'npm test -- test/unit/pr-impact-report.test.ts',
    exitCode: 1,
    failingTests: ['PR Impact report core > builds versioned experimental JSON'],
    failureExcerpt:
      'expected report.verdict to be BLOCK // Object.is equality\nReceived: NEEDS_DISCUSSION',
    environment: {
      label: 'local',
      os: 'Windows',
      runtime: 'node 24',
    },
  },
  refs: {
    knownBadRef: 'HEAD',
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
    test_signal: {
      status: 'unknown_or_unreferenced',
    },
    caveats: ['High-risk impact has no known graph-derived test reference.'],
  },
};

describe('Regression Forensics report core', () => {
  it('builds versioned experimental JSON and deterministic Markdown', () => {
    const report = buildRegressionForensicsReport(baseInput);

    expect(report.schema_version).toBe('regression-forensics.v1alpha1');
    expect(report.confidence).toBe('MEDIUM');
    expect(report.recommendation).toBe(
      'Investigate candidate causes before retrying the failing command.',
    );
    expect(report.failure.failing_tests).toEqual([
      'PR Impact report core > builds versioned experimental JSON',
    ]);
    expect(report.pr_impact.schema_version).toBe('pr-impact.v1alpha1');
    expect(report.candidate_causes).toEqual([
      {
        symbol: 'computeVerdict',
        file: 'src/core/pr-impact/report.ts',
        confidence: 'HIGH',
        reason: 'High-risk changed symbol is linked to the failing surface.',
        evidence: [
          'PR Impact verdict: BLOCK',
          'Risk: HIGH',
          'Direct dependents: 4',
          'Processes affected: 2',
          'Test reference: unknown_or_unreferenced',
        ],
      },
    ]);
    expect(report.caveats).toContain(
      'No known-good ref was provided; confidence is capped below HIGH.',
    );
    expect(report.caveats).toContain(
      'Report identifies candidate causes, not a proven root cause.',
    );

    const golden = readFileSync(
      path.join(__dirname, '../fixtures/regression-forensics/golden-basic-report.md'),
      'utf-8',
    ).trim();
    expect(renderRegressionForensicsMarkdown(report)).toBe(golden);
  });

  it('lowers confidence when graph evidence is stale', () => {
    const report = buildRegressionForensicsReport({
      ...baseInput,
      refs: {
        knownGoodRef: 'main',
        knownBadRef: 'HEAD',
      },
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
    expect(report.caveats).toContain(
      'PR Impact graph evidence is stale; causal confidence is limited.',
    );
  });

  it('keeps producing a report when failing tests are absent', () => {
    const report = buildRegressionForensicsReport({
      ...baseInput,
      failure: {
        ...baseInput.failure,
        failingTests: [],
      },
    });

    expect(report.failure.failing_tests).toEqual([]);
    expect(report.caveats).toContain(
      'No failing test names were provided; failure localization is weaker.',
    );
  });
});
