import { describe, expect, it } from 'vitest';

import { createEvidenceRef, type EvidenceBundle } from '../../src/core/wiki/document/evidence.js';
import { createDocumentPlan } from '../../src/core/wiki/document/planner.js';
import {
  DOCUMENT_VALIDATOR_VERSION,
  validateProfileCoverage,
} from '../../src/core/wiki/document/validator.js';
import { resolveLanguage } from '../../src/core/wiki/profiles/locale.js';
import { resolveTemplateProfile } from '../../src/core/wiki/profiles/registry.js';

const allEvidence = [
  createEvidenceRef({
    kind: 'file',
    status: 'verified',
    filePath: 'src/core.ts',
    summary: 'source',
  }),
  createEvidenceRef({
    kind: 'config',
    status: 'verified',
    filePath: 'package.json',
    summary: 'config',
  }),
  createEvidenceRef({
    kind: 'test',
    status: 'verified',
    filePath: 'test/core.test.ts',
    summary: 'test',
  }),
  createEvidenceRef({
    kind: 'existing-doc',
    status: 'verified',
    filePath: 'docs/architecture.md',
    summary: 'documentation',
  }),
  createEvidenceRef({
    kind: 'relation',
    status: 'verified',
    filePath: 'src/core.ts',
    symbol: 'run',
    relation: 'internal:calls:src/io.ts:write',
    summary: 'relation',
  }),
  createEvidenceRef({
    kind: 'relation',
    status: 'verified',
    filePath: 'src/core.ts',
    symbol: 'run',
    relation: 'outgoing:calls:ext/api.ts:fetch',
    summary: 'external relation',
  }),
  createEvidenceRef({
    kind: 'process',
    status: 'verified',
    processId: 'process-core',
    summary: 'process',
  }),
];

function bundle(evidence = allEvidence): EvidenceBundle {
  return {
    schemaVersion: 1,
    repoPath: '/repo',
    sourceCommit: 'abc123',
    collectedAt: '2026-08-12T00:00:00.000Z',
    repository: evidence,
    modules: {},
    conflicts: [],
    limitations: ['Graph process discovery is lower-bound.'],
  };
}

function generatedPlan(
  profileId: 'arc42' | 'engineering-wiki' | 'ieee-1016-sdd' | 'iso-42010-ad',
  languageName: string,
  evidence = bundle(),
) {
  const profile = resolveTemplateProfile(profileId);
  const plan = createDocumentPlan({
    profile,
    language: resolveLanguage(languageName, profile.profile),
    sourceCommit: 'abc123',
    moduleTree: [],
    evidence,
  });
  const sections = (items: typeof plan.sections): (typeof plan.sections)[number][] =>
    items.flatMap((section) => [section, ...(section.children ? sections(section.children) : [])]);
  for (const section of sections(plan.sections)) {
    section.status = 'verified';
    section.diagnostics = [];
    section.payload = {
      mode: 'structured',
      blocks: [
        {
          type: 'claim',
          claim: {
            id: `claim-${section.id}`,
            text: `Evidence-backed content for ${section.id}.`,
            status: 'verified',
            evidenceIds: evidence.repository.map((evidence) => evidence.id),
            origin: 'llm',
          },
        },
      ],
    };
  }
  plan.status = 'generated';
  return { profile, plan };
}

describe('wiki Profile coverage validator', () => {
  it.each(['arc42', 'engineering-wiki', 'ieee-1016-sdd', 'iso-42010-ad'] as const)(
    'passes complete %s structural traceability without claiming standards conformance',
    (profileId) => {
      const { profile, plan } = generatedPlan(profileId, 'english');
      const report = validateProfileCoverage(profile, plan, bundle());

      expect(DOCUMENT_VALIDATOR_VERSION).toBe(1);
      expect(report.status).toBe('passed');
      expect(report.conclusion).toBe(
        'GitNexus profile coverage checks passed; standards conformance not assessed.',
      );
      expect(report.standardsConformanceAssessed).toBe(false);
      expect(report.sections).toHaveLength(
        profileId === 'engineering-wiki' ? 27 : profile.profile.sections.length,
      );
      expect(report.limitations).toContain(
        'Structural traceability does not prove that cited evidence semantically entails a claim.',
      );
    },
  );

  it('localizes the conservative pass conclusion without translating machine ids', () => {
    const { profile, plan } = generatedPlan('iso-42010-ad', 'zh-CN');
    const report = validateProfileCoverage(profile, plan, bundle());

    expect(report.status).toBe('passed');
    expect(report.conclusion).toBe('GitNexus Profile 覆盖检查已通过；未进行标准符合性评估。');
    expect(report.profile.id).toBe('iso-42010-ad');
    expect(report.sections[report.sections.length - 1]?.id).toBe('profile-coverage');
  });

  it('reports incomplete when required evidence or a required generated section is missing', () => {
    const sourceOnly = bundle([allEvidence[0]]);
    const { profile, plan } = generatedPlan('arc42', 'chinese', sourceOnly);
    plan.sections = plan.sections.filter((section) => section.id !== 'deployment-view');
    plan.dependencyOrder = plan.dependencyOrder.filter((id) => id !== 'deployment-view');

    const report = validateProfileCoverage(profile, plan, sourceOnly);

    expect(report.status).toBe('incomplete');
    expect(report.conclusion).toBe('GitNexus Profile 覆盖检查不完整；未进行标准符合性评估。');
    expect(report.sections.find((section) => section.id === 'deployment-view')).toMatchObject({
      status: 'missing',
    });
    expect(report.diagnostics).toContainEqual(
      expect.objectContaining({ code: 'required-section-missing', severity: 'error' }),
    );
  });

  it('turns unknown evidence ids and needs-human content into incomplete coverage', () => {
    const { profile, plan } = generatedPlan('ieee-1016-sdd', 'english');
    plan.sections[0].payload = {
      mode: 'structured',
      blocks: [
        {
          type: 'claim',
          claim: {
            id: 'claim-invalid',
            text: 'Unsupported claim.',
            status: 'verified',
            evidenceIds: ['ev-invented'],
            origin: 'llm',
          },
        },
      ],
    };
    plan.sections[1].payload = {
      mode: 'structured',
      blocks: [
        {
          type: 'unknown',
          status: 'needs-human',
          reason: 'Decision rationale requires human input.',
          evidenceIds: [],
        },
      ],
    };

    const report = validateProfileCoverage(profile, plan, bundle());

    expect(report.status).toBe('incomplete');
    expect(report.sections[0].diagnostics).toContainEqual(
      expect.objectContaining({ code: 'invalid-section-blocks', severity: 'error' }),
    );
    expect(report.sections[1].status).toBe('needs-human');
  });

  it('marks default as legacy section-level traceability instead of coverage PASS', () => {
    const profile = resolveTemplateProfile('default');
    const evidence = bundle();
    const plan = createDocumentPlan({
      profile,
      language: resolveLanguage('english', profile.profile),
      sourceCommit: 'abc123',
      moduleTree: [],
      evidence,
    });

    const report = validateProfileCoverage(profile, plan, evidence);

    expect(report.status).toBe('legacy');
    expect(report.conclusion).toContain('section-level traceability only');
    expect(report.standardsConformanceAssessed).toBe(false);
  });
});
