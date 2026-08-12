import type {
  EvidenceKind,
  RegisteredTemplateProfile,
  ResolvedLanguage,
  SectionSpec,
} from '../profiles/types.js';
import { validateSectionBlocks } from './claim.js';
import type { EvidenceBundle, EvidenceStatus } from './evidence.js';
import {
  flattenSections,
  validateDocumentPlan,
  type Diagnostic,
  type DocumentPlan,
  type SectionIR,
} from './planner.js';
import { parseSectionDraftResponse } from './response-parser.js';

export const DOCUMENT_VALIDATOR_VERSION = 1;

export type ProfileCoverageStatus = 'passed' | 'incomplete' | 'legacy';

export interface SectionCoverage {
  id: string;
  required: boolean;
  status: EvidenceStatus;
  evidenceIds: string[];
  diagnostics: Diagnostic[];
}

export interface ProfileCoverageReport {
  schemaVersion: 1;
  profile: DocumentPlan['profile'];
  language: ResolvedLanguage;
  status: ProfileCoverageStatus;
  conclusion: string;
  standardsConformanceAssessed: false;
  sections: SectionCoverage[];
  counts: Record<EvidenceStatus, number>;
  diagnostics: Diagnostic[];
  limitations: string[];
}

function assertClosedObject(
  value: unknown,
  allowedKeys: readonly string[],
  label: string,
): asserts value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  const unknown = Object.keys(value).filter((key) => !allowedKeys.includes(key));
  if (unknown.length > 0)
    throw new Error(`${label} contains unknown fields: ${unknown.join(', ')}`);
}

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

export function validateReviewedDocumentPlan(
  value: unknown,
  expected: DocumentPlan,
  knownEvidenceIds: ReadonlySet<string>,
): DocumentPlan {
  assertClosedObject(
    value,
    [
      'schemaVersion',
      'profile',
      'language',
      'sourceCommit',
      'moduleTree',
      'sections',
      'dependencyOrder',
      'status',
    ],
    'reviewedPlan',
  );
  if (value.schemaVersion !== expected.schemaVersion) {
    throw new Error('Reviewed DocumentPlan schema identity does not match');
  }
  if (!sameJson(value.profile, expected.profile)) {
    throw new Error('Reviewed DocumentPlan Profile identity does not match');
  }
  if (!sameJson(value.language, expected.language)) {
    throw new Error('Reviewed DocumentPlan language identity does not match');
  }
  if (value.sourceCommit !== expected.sourceCommit) {
    throw new Error('Reviewed DocumentPlan source commit does not match');
  }
  if (!Array.isArray(value.moduleTree))
    throw new Error('Reviewed DocumentPlan moduleTree is invalid');
  if (!Array.isArray(value.sections)) throw new Error('Reviewed DocumentPlan sections are invalid');
  if (!Array.isArray(value.dependencyOrder)) {
    throw new Error('Reviewed DocumentPlan dependencyOrder is invalid');
  }
  if (!['planned', 'reviewed'].includes(value.status as string)) {
    throw new Error('Reviewed DocumentPlan status must be planned or reviewed');
  }

  const expectedSections = new Map(
    flattenSections(expected.sections).map((section) => [section.id, section]),
  );
  const sanitizeSections = (sections: unknown[], label: string): SectionIR[] =>
    sections.map((raw, index) => {
      const sectionLabel = `${label}[${index}]`;
      assertClosedObject(
        raw,
        ['id', 'title', 'required', 'status', 'payload', 'children', 'diagnostics'],
        sectionLabel,
      );
      if (typeof raw.id !== 'string') throw new Error(`${sectionLabel}.id is invalid`);
      const expectedSection = expectedSections.get(raw.id);
      if (!expectedSection)
        throw new Error(`Reviewed DocumentPlan contains unknown section: ${raw.id}`);
      if (raw.title !== expectedSection.title || raw.required !== expectedSection.required) {
        throw new Error(`Reviewed DocumentPlan section identity changed: ${raw.id}`);
      }
      if (
        !['verified', 'inferred', 'missing', 'conflicting', 'needs-human'].includes(
          raw.status as string,
        )
      ) {
        throw new Error(`${sectionLabel}.status is invalid`);
      }
      assertClosedObject(raw.payload, ['mode', 'blocks'], `${sectionLabel}.payload`);
      if (raw.payload.mode !== 'structured' || !Array.isArray(raw.payload.blocks)) {
        throw new Error(`${sectionLabel}.payload must be structured`);
      }
      const parsed = parseSectionDraftResponse(
        JSON.stringify({ schemaVersion: 1, sectionId: raw.id, blocks: raw.payload.blocks }),
        raw.id,
        knownEvidenceIds,
      );
      if (!Array.isArray(raw.diagnostics))
        throw new Error(`${sectionLabel}.diagnostics is invalid`);
      const diagnostics = raw.diagnostics.map((diagnostic, diagnosticIndex) => {
        const diagnosticLabel = `${sectionLabel}.diagnostics[${diagnosticIndex}]`;
        assertClosedObject(diagnostic, ['code', 'message', 'severity'], diagnosticLabel);
        if (
          typeof diagnostic.code !== 'string' ||
          typeof diagnostic.message !== 'string' ||
          !['info', 'warning', 'error'].includes(diagnostic.severity as string)
        ) {
          throw new Error(`${diagnosticLabel} is invalid`);
        }
        return diagnostic as unknown as Diagnostic;
      });
      let children: SectionIR[] | undefined;
      if (raw.children !== undefined) {
        if (!Array.isArray(raw.children)) throw new Error(`${sectionLabel}.children is invalid`);
        children = sanitizeSections(raw.children, `${sectionLabel}.children`);
      }
      const expectedChildIds = (expectedSection.children ?? []).map((child) => child.id);
      if (
        !sameJson(
          (children ?? []).map((child) => child.id),
          expectedChildIds,
        )
      ) {
        throw new Error(`Reviewed DocumentPlan child identity changed: ${raw.id}`);
      }
      return {
        id: raw.id,
        title: raw.title,
        required: raw.required,
        status: raw.status as EvidenceStatus,
        payload: { mode: 'structured', blocks: parsed.blocks },
        ...(children ? { children } : {}),
        diagnostics,
      };
    });

  const plan: DocumentPlan = {
    schemaVersion: expected.schemaVersion,
    profile: expected.profile,
    language: expected.language,
    sourceCommit: expected.sourceCommit,
    moduleTree: expected.moduleTree,
    sections: sanitizeSections(value.sections, 'reviewedPlan.sections'),
    dependencyOrder: value.dependencyOrder.map((item, index) => {
      if (typeof item !== 'string') {
        throw new Error(`reviewedPlan.dependencyOrder[${index}] is invalid`);
      }
      return item;
    }),
    status: 'reviewed',
  };
  const reviewedIds = flattenSections(plan.sections).map((section) => section.id);
  if (
    !sameJson(
      reviewedIds,
      flattenSections(expected.sections).map((section) => section.id),
    )
  ) {
    throw new Error('Reviewed DocumentPlan section order or identity changed');
  }
  validateDocumentPlan(plan);
  return plan;
}

function flattenSpecs(sections: readonly SectionSpec[]): SectionSpec[] {
  const result: SectionSpec[] = [];
  for (const section of sections) {
    result.push(section);
    if (section.children) result.push(...flattenSpecs(section.children));
  }
  return result;
}

function evidenceKindsForRequirement(kind: EvidenceKind): readonly string[] {
  switch (kind) {
    case 'source':
      return ['file', 'symbol', 'line'];
    case 'config':
      return ['config'];
    case 'test':
      return ['test'];
    case 'documentation':
      return ['existing-doc'];
    case 'call-graph':
      return ['relation'];
    case 'process':
      return ['process'];
  }
}

function evidenceIdsForSection(section: SectionIR): string[] {
  if (section.payload.mode === 'legacy-markdown') {
    return [...section.payload.sectionEvidenceIds];
  }
  const evidenceIds: string[] = [];
  for (const block of section.payload.blocks) {
    if (block.type === 'claim') evidenceIds.push(...block.claim.evidenceIds);
    else if (block.type === 'table') {
      for (const row of block.rows) evidenceIds.push(...row.evidenceIds);
    } else evidenceIds.push(...block.evidenceIds);
  }
  return Array.from(new Set(evidenceIds)).sort();
}

function effectiveSectionStatus(section: SectionIR): EvidenceStatus {
  if (section.status !== 'verified') return section.status;
  if (section.payload.mode === 'legacy-markdown') return 'verified';
  if (section.payload.blocks.length === 0) return 'missing';
  const unknownStatuses = section.payload.blocks
    .filter((block) => block.type === 'unknown')
    .map((block) => block.status);
  if (unknownStatuses.includes('conflicting')) return 'conflicting';
  if (unknownStatuses.includes('needs-human')) return 'needs-human';
  if (unknownStatuses.includes('missing')) return 'missing';
  if (
    section.payload.blocks.some(
      (block) => block.type === 'claim' && block.claim.status === 'conflicting',
    )
  ) {
    return 'conflicting';
  }
  if (
    section.payload.blocks.some(
      (block) => block.type === 'claim' && block.claim.status === 'inferred',
    )
  ) {
    return 'inferred';
  }
  return 'verified';
}

function conclusion(status: ProfileCoverageStatus, language: ResolvedLanguage): string {
  if (status === 'legacy') {
    return language.resolvedLocale === 'zh-CN'
      ? 'default Profile 仅提供章节级追踪；未进行标准符合性评估。'
      : 'The default Profile provides section-level traceability only; standards conformance not assessed.';
  }
  if (language.resolvedLocale === 'zh-CN') {
    return status === 'passed'
      ? 'GitNexus Profile 覆盖检查已通过；未进行标准符合性评估。'
      : 'GitNexus Profile 覆盖检查不完整；未进行标准符合性评估。';
  }
  return status === 'passed'
    ? 'GitNexus profile coverage checks passed; standards conformance not assessed.'
    : 'GitNexus profile coverage checks incomplete; standards conformance not assessed.';
}

export function validateProfileCoverage(
  profile: RegisteredTemplateProfile,
  plan: DocumentPlan,
  evidence: EvidenceBundle,
): ProfileCoverageReport {
  const diagnostics: Diagnostic[] = [];
  if (
    plan.profile.id !== profile.profile.id ||
    plan.profile.revision !== profile.profile.revision ||
    plan.profile.fingerprint !== profile.fingerprint
  ) {
    diagnostics.push({
      code: 'profile-identity-mismatch',
      message: 'DocumentPlan profile identity does not match the selected Profile.',
      severity: 'error',
    });
  }
  if (plan.sourceCommit !== evidence.sourceCommit) {
    diagnostics.push({
      code: 'generation-identity-mismatch',
      message: 'DocumentPlan and evidence generation identity are inconsistent.',
      severity: 'error',
    });
  }

  const allEvidence = [...evidence.repository, ...Object.values(evidence.modules).flat()];
  const knownEvidenceIds = new Set(allEvidence.map((item) => item.id));
  const specs = flattenSpecs(profile.profile.sections);
  const sections = flattenSections(plan.sections);
  const byId = new Map(sections.map((section) => [section.id, section]));
  const coverage: SectionCoverage[] = [];

  for (const spec of specs) {
    const section = byId.get(spec.id);
    if (!section) {
      diagnostics.push({
        code: 'required-section-missing',
        message: `Section ${spec.id} is missing from DocumentPlan.`,
        severity: spec.required ? 'error' : 'warning',
      });
      coverage.push({
        id: spec.id,
        required: spec.required,
        status: 'missing',
        evidenceIds: [],
        diagnostics: [],
      });
      continue;
    }
    const sectionDiagnostics = [...section.diagnostics];
    const missingRequirements = spec.evidenceRequirements.filter(
      (requirement) =>
        requirement.required &&
        !allEvidence.some((item) =>
          evidenceKindsForRequirement(requirement.kind).includes(item.kind),
        ),
    );
    for (const requirement of missingRequirements) {
      sectionDiagnostics.push({
        code: 'required-evidence-missing',
        message: `Required evidence ${requirement.id} is unavailable.`,
        severity: 'error',
      });
    }
    if (profile.profile.id !== 'default' && section.payload.mode !== 'structured') {
      sectionDiagnostics.push({
        code: 'legacy-payload-for-standard-profile',
        message: `Section ${section.id} must use structured blocks.`,
        severity: 'error',
      });
    } else if (section.payload.mode === 'structured') {
      try {
        validateSectionBlocks(section.payload.blocks, knownEvidenceIds);
      } catch (error) {
        sectionDiagnostics.push({
          code: 'invalid-section-blocks',
          message: (error as Error).message,
          severity: 'error',
        });
      }
    }
    coverage.push({
      id: section.id,
      required: spec.required,
      status: missingRequirements.length > 0 ? 'missing' : effectiveSectionStatus(section),
      evidenceIds: evidenceIdsForSection(section),
      diagnostics: sectionDiagnostics,
    });
  }

  const counts: Record<EvidenceStatus, number> = {
    verified: 0,
    inferred: 0,
    missing: 0,
    conflicting: 0,
    'needs-human': 0,
  };
  coverage.forEach((section) => counts[section.status]++);

  const isLegacy = profile.profile.id === 'default';
  const hasIncompleteRequired = coverage.some(
    (section) =>
      section.required && ['missing', 'conflicting', 'needs-human'].includes(section.status),
  );
  const hasErrors = [...diagnostics, ...coverage.flatMap((section) => section.diagnostics)].some(
    (diagnostic) => diagnostic.severity === 'error',
  );
  const status: ProfileCoverageStatus = isLegacy
    ? 'legacy'
    : hasIncompleteRequired || hasErrors
      ? 'incomplete'
      : 'passed';

  return {
    schemaVersion: 1,
    profile: plan.profile,
    language: plan.language,
    status,
    conclusion: conclusion(status, plan.language),
    standardsConformanceAssessed: false,
    sections: coverage,
    counts,
    diagnostics,
    limitations: [
      ...evidence.limitations,
      'Structural traceability does not prove that cited evidence semantically entails a claim.',
    ],
  };
}
