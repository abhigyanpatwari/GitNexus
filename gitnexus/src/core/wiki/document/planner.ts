import type { ModuleTreeNode } from '../generator.js';
import { localize } from '../profiles/locale.js';
import type {
  EvidenceKind,
  EvidenceRequirement,
  RegisteredTemplateProfile,
  ResolvedLanguage,
  SectionSpec,
} from '../profiles/types.js';
import type { SectionBlock } from './claim.js';
import type { EvidenceBundle, EvidenceRef, EvidenceStatus } from './evidence.js';

export const DOCUMENT_PLAN_SCHEMA_VERSION = 1 as const;

export interface ProfileIdentity {
  id: string;
  revision: number;
  fingerprint: string;
}

export interface Diagnostic {
  code: string;
  message: string;
  severity: 'info' | 'warning' | 'error';
}

export type SectionPayload =
  | { mode: 'structured'; blocks: SectionBlock[] }
  | {
      mode: 'legacy-markdown';
      markdown: string;
      sectionEvidenceIds: string[];
      traceability: 'section-level';
    };

export interface SectionIR {
  id: string;
  title: string;
  required: boolean;
  status: EvidenceStatus;
  payload: SectionPayload;
  children?: SectionIR[];
  diagnostics: Diagnostic[];
}

export interface DocumentPlan {
  schemaVersion: typeof DOCUMENT_PLAN_SCHEMA_VERSION;
  profile: ProfileIdentity;
  language: ResolvedLanguage;
  sourceCommit: string;
  moduleTree: ModuleTreeNode[];
  sections: SectionIR[];
  dependencyOrder: string[];
  status: 'planned' | 'reviewed' | 'generated' | 'partial' | 'failed';
}

export interface CreateDocumentPlanInput {
  profile: RegisteredTemplateProfile;
  language: ResolvedLanguage;
  sourceCommit: string;
  moduleTree: ModuleTreeNode[];
  evidence: EvidenceBundle;
}

export function evidenceKindsForRequirement(kind: EvidenceKind): readonly EvidenceRef['kind'][] {
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
    case 'external-call-graph':
      return ['relation'];
    case 'process':
      return ['process'];
  }
}

// 判断证据项是否满足某项证据要求;external-call-graph 仅匹配外部调用关系(incoming/outgoing),
// 排除模块内部调用,避免内部调用被误当作"外部调用关系"证据
export function requirementMatchesEvidence(
  requirement: EvidenceRequirement,
  item: EvidenceRef,
): boolean {
  if (!evidenceKindsForRequirement(requirement.kind).includes(item.kind)) return false;
  if (requirement.kind === 'external-call-graph' && item.kind === 'relation') {
    const separator = item.relation?.indexOf(':') ?? -1;
    const direction = separator > 0 ? item.relation!.slice(0, separator) : '';
    return direction === 'incoming' || direction === 'outgoing';
  }
  return true;
}

function planSection(
  section: SectionSpec,
  profile: RegisteredTemplateProfile,
  language: ResolvedLanguage,
  evidence: readonly EvidenceRef[],
  dependencyOrder: string[],
): SectionIR {
  const matchedEvidence = evidence.filter((item) =>
    section.evidenceRequirements.some((requirement) =>
      requirementMatchesEvidence(requirement, item),
    ),
  );
  const missingRequirements = section.evidenceRequirements.filter(
    (requirement) =>
      requirement.required &&
      !matchedEvidence.some((item) => requirementMatchesEvidence(requirement, item)),
  );
  const diagnostics: Diagnostic[] = missingRequirements.map((requirement) => ({
    code: 'required-evidence-missing',
    message: `Required evidence ${requirement.id} is unavailable.`,
    severity: 'warning',
  }));
  const children = section.children?.map((child) =>
    planSection(child, profile, language, evidence, dependencyOrder),
  );
  dependencyOrder.push(section.id);

  const sectionEvidenceIds = matchedEvidence.map((item) => item.id);
  return {
    id: section.id,
    title: localize(section.title, language),
    required: section.required,
    status: missingRequirements.length > 0 ? 'missing' : 'verified',
    payload:
      profile.profile.id === 'default'
        ? {
            mode: 'legacy-markdown',
            markdown: '',
            sectionEvidenceIds,
            traceability: 'section-level',
          }
        : { mode: 'structured', blocks: [] },
    ...(children && children.length > 0 ? { children } : {}),
    diagnostics,
  };
}

export function createDocumentPlan(input: CreateDocumentPlanInput): DocumentPlan {
  if (input.language.localeFingerprint.length !== 64) {
    throw new Error('DocumentPlan language identity is incomplete');
  }
  const dependencyOrder: string[] = [];
  const evidence = Array.from(
    new Map(
      [input.evidence.repository, ...Object.values(input.evidence.modules)]
        .flat()
        .map((item) => [item.id, item]),
    ).values(),
  ).sort((a, b) => a.id.localeCompare(b.id));
  const sections = input.profile.profile.sections.map((section) =>
    planSection(section, input.profile, input.language, evidence, dependencyOrder),
  );
  const plan: DocumentPlan = {
    schemaVersion: DOCUMENT_PLAN_SCHEMA_VERSION,
    profile: {
      id: input.profile.profile.id,
      revision: input.profile.profile.revision,
      fingerprint: input.profile.fingerprint,
    },
    language: input.language,
    sourceCommit: input.sourceCommit,
    moduleTree: input.moduleTree,
    sections,
    dependencyOrder,
    status: 'planned',
  };
  validateDocumentPlan(plan);
  return plan;
}

export function flattenSections(sections: readonly SectionIR[]): SectionIR[] {
  const flattened: SectionIR[] = [];
  for (const section of sections) {
    flattened.push(section);
    if (section.children) flattened.push(...flattenSections(section.children));
  }
  return flattened;
}

export function validateDocumentPlan(plan: DocumentPlan): void {
  if (plan.schemaVersion !== DOCUMENT_PLAN_SCHEMA_VERSION) {
    throw new Error(`Unsupported DocumentPlan schemaVersion: ${plan.schemaVersion}`);
  }
  const sections = flattenSections(plan.sections);
  const ids = sections.map((section) => section.id);
  if (new Set(ids).size !== ids.length)
    throw new Error('DocumentPlan contains duplicate section ids');
  if (
    plan.dependencyOrder.length !== ids.length ||
    new Set(plan.dependencyOrder).size !== plan.dependencyOrder.length ||
    plan.dependencyOrder.some((id) => !ids.includes(id))
  ) {
    throw new Error('DocumentPlan dependencyOrder must contain every section exactly once');
  }
  const positions = new Map(plan.dependencyOrder.map((id, index) => [id, index]));
  for (const section of sections) {
    for (const child of section.children ?? []) {
      if (positions.get(child.id)! > positions.get(section.id)!) {
        throw new Error(
          `DocumentPlan dependency order must place ${child.id} before ${section.id}`,
        );
      }
    }
  }
}
