import { createHash } from 'node:crypto';
import { DEFAULT_TEMPLATE_PROFILE } from './builtins/default.js';
import { ARC42_TEMPLATE_PROFILE } from './builtins/arc42.js';
import { ENGINEERING_WIKI_TEMPLATE_PROFILE } from './builtins/engineering-wiki.js';
import { IEEE_1016_SDD_TEMPLATE_PROFILE } from './builtins/ieee-1016-sdd.js';
import { ISO_42010_AD_TEMPLATE_PROFILE } from './builtins/iso-42010-ad.js';
import { validatePromptSpec } from './render-prompt.js';
import {
  TEMPLATE_PROFILE_SCHEMA_VERSION,
  type DiagramPolicy,
  type EvidenceRequirement,
  type LocalizedText,
  type OutputContract,
  type PromptSpec,
  type RegisteredTemplateProfile,
  type SectionSpec,
  type StandardAlignment,
  type TemplateProfile,
  type TemplateProfileId,
} from './types.js';

const PROFILE_VALIDATOR_CONTRACT_VERSION = 1;
const BUILTIN_PROFILE_IDS = new Set<TemplateProfileId>([
  'default',
  'arc42',
  'engineering-wiki',
  'ieee-1016-sdd',
  'iso-42010-ad',
]);

function assertClosedObject(
  value: unknown,
  allowedKeys: readonly string[],
  label: string,
): asserts value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  const unknownKeys = Object.keys(value).filter((key) => !allowedKeys.includes(key));
  if (unknownKeys.length > 0) {
    throw new Error(`${label} contains unknown fields: ${unknownKeys.join(', ')}`);
  }
}

function assertNonEmptyString(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${label} must be a non-empty string`);
  }
}

function validateLocalizedText(value: LocalizedText, label: string): void {
  assertClosedObject(value, ['en', 'zh-CN'], label);
  assertNonEmptyString(value.en, `${label}.en`);
  assertNonEmptyString(value['zh-CN'], `${label}.zh-CN`);
}

function validateSafeId(value: string, label: string): void {
  if (!/^[a-z][a-z0-9-]{0,63}$/.test(value)) {
    throw new Error(`${label} must be a stable lowercase identifier`);
  }
}

function validateSafeOutputFile(value: string, label: string): void {
  assertNonEmptyString(value, label);
  if (value.includes('\\') || value.includes('/') || !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(value)) {
    throw new Error(`${label} must be a safe relative file name`);
  }
}

function validateStringArray(value: readonly string[], label: string): void {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  value.forEach((item, index) => assertNonEmptyString(item, `${label}[${index}]`));
  if (new Set(value).size !== value.length) throw new Error(`${label} contains duplicates`);
}

function validatePrompt(value: PromptSpec, label: string): void {
  assertClosedObject(value, ['system', 'user', 'requiredVariables', 'allowedVariables'], label);
  assertNonEmptyString(value.system, `${label}.system`);
  assertNonEmptyString(value.user, `${label}.user`);
  validateStringArray(value.requiredVariables, `${label}.requiredVariables`);
  validateStringArray(value.allowedVariables, `${label}.allowedVariables`);
  validatePromptSpec(value, label);
}

function validateEvidenceRequirement(value: EvidenceRequirement, label: string): void {
  assertClosedObject(value, ['id', 'kind', 'required', 'description'], label);
  validateSafeId(value.id, `${label}.id`);
  if (
    ![
      'source',
      'config',
      'test',
      'documentation',
      'call-graph',
      'external-call-graph',
      'process',
    ].includes(value.kind)
  ) {
    throw new Error(`${label}.kind is invalid`);
  }
  if (typeof value.required !== 'boolean') throw new Error(`${label}.required must be boolean`);
  validateLocalizedText(value.description, `${label}.description`);
}

function validateSection(value: SectionSpec, label: string, sectionIds: Set<string>): void {
  assertClosedObject(
    value,
    [
      'id',
      'title',
      'required',
      'concerns',
      'evidenceRequirements',
      'prompt',
      'unknownPolicy',
      'children',
    ],
    label,
  );
  validateSafeId(value.id, `${label}.id`);
  if (sectionIds.has(value.id)) throw new Error(`Duplicate section id: ${value.id}`);
  sectionIds.add(value.id);
  validateLocalizedText(value.title, `${label}.title`);
  if (typeof value.required !== 'boolean') throw new Error(`${label}.required must be boolean`);
  validateStringArray(value.concerns, `${label}.concerns`);
  if (!Array.isArray(value.evidenceRequirements)) {
    throw new Error(`${label}.evidenceRequirements must be an array`);
  }
  const evidenceIds = new Set<string>();
  value.evidenceRequirements.forEach((requirement, index) => {
    validateEvidenceRequirement(requirement, `${label}.evidenceRequirements[${index}]`);
    if (evidenceIds.has(requirement.id)) {
      throw new Error(`${label} has duplicate evidence requirement id: ${requirement.id}`);
    }
    evidenceIds.add(requirement.id);
  });
  if (value.prompt) validatePrompt(value.prompt, `${label}.prompt`);
  if (!['emit-status', 'omit-optional'].includes(value.unknownPolicy)) {
    throw new Error(`${label}.unknownPolicy is invalid`);
  }
  if (value.children !== undefined) {
    if (!Array.isArray(value.children)) throw new Error(`${label}.children must be an array`);
    value.children.forEach((child, index) =>
      validateSection(child, `${label}.children[${index}]`, sectionIds),
    );
  }
}

function validateAlignment(value: StandardAlignment, label: string): void {
  assertClosedObject(
    value,
    ['id', 'officialTitle', 'url', 'claim', 'licenseNote', 'notice'],
    label,
  );
  validateSafeId(value.id, `${label}.id`);
  assertNonEmptyString(value.officialTitle, `${label}.officialTitle`);
  assertNonEmptyString(value.licenseNote, `${label}.licenseNote`);
  if (!['inspired', 'aligned'].includes(value.claim)) throw new Error(`${label}.claim is invalid`);
  try {
    const url = new URL(value.url);
    if (url.protocol !== 'https:') throw new Error('not https');
  } catch {
    throw new Error(`${label}.url must be an HTTPS URL`);
  }
  validateLocalizedText(value.notice, `${label}.notice`);
  if (/\b(IEEE|ISO)\b/.test(value.officialTitle)) {
    if (!value.notice.en.toLowerCase().includes('conformance not assessed')) {
      throw new Error(`${label}.notice.en must state that conformance was not assessed`);
    }
    if (!value.notice['zh-CN'].includes('未进行标准符合性评估')) {
      throw new Error(`${label}.notice.zh-CN must state that conformance was not assessed`);
    }
  }
}

function validateDiagramPolicy(value: DiagramPolicy): void {
  assertClosedObject(value, ['allowed', 'maxNodes', 'kinds'], 'profile.diagramPolicy');
  if (typeof value.allowed !== 'boolean')
    throw new Error('profile.diagramPolicy.allowed must be boolean');
  if (!Number.isInteger(value.maxNodes) || value.maxNodes < 0) {
    throw new Error('profile.diagramPolicy.maxNodes must be a non-negative integer');
  }
  const kinds = ['mermaid-flowchart', 'mermaid-sequence', 'c4-context', 'c4-container'];
  if (!Array.isArray(value.kinds) || value.kinds.some((kind) => !kinds.includes(kind))) {
    throw new Error('profile.diagramPolicy.kinds contains an invalid kind');
  }
  if (new Set(value.kinds).size !== value.kinds.length) {
    throw new Error('profile.diagramPolicy.kinds contains duplicates');
  }
}

function validateOutput(value: OutputContract): void {
  assertClosedObject(
    value,
    ['topology', 'entryFile', 'aggregateFile', 'coverageFile'],
    'profile.output',
  );
  if (!['legacy-tree', 'standard-document'].includes(value.topology)) {
    throw new Error('profile.output.topology is invalid');
  }
  validateSafeOutputFile(value.entryFile, 'profile.output.entryFile');
  if (value.aggregateFile !== undefined) {
    validateSafeOutputFile(value.aggregateFile, 'profile.output.aggregateFile');
  }
  validateSafeOutputFile(value.coverageFile, 'profile.output.coverageFile');
  const files = [value.entryFile, value.aggregateFile, value.coverageFile].filter(Boolean);
  if (new Set(files).size !== files.length)
    throw new Error('profile.output file names must be unique');
}

function stableSerialize(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableSerialize).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableSerialize(record[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) {
      deepFreeze(child);
    }
    Object.freeze(value);
  }
  return value;
}

export function validateTemplateProfile(profile: TemplateProfile): void {
  assertClosedObject(
    profile,
    [
      'schemaVersion',
      'id',
      'revision',
      'displayName',
      'alignments',
      'grouping',
      'sections',
      'prompts',
      'diagramPolicy',
      'output',
    ],
    'profile',
  );
  if (profile.schemaVersion !== TEMPLATE_PROFILE_SCHEMA_VERSION) {
    throw new Error(`Unsupported profile schemaVersion: ${profile.schemaVersion}`);
  }
  if (!BUILTIN_PROFILE_IDS.has(profile.id)) throw new Error(`Unknown profile id: ${profile.id}`);
  if (!Number.isInteger(profile.revision) || profile.revision < 1) {
    throw new Error('profile.revision must be a positive integer');
  }
  validateLocalizedText(profile.displayName, 'profile.displayName');
  if (profile.grouping !== 'shared-default') throw new Error('profile.grouping is invalid');
  if (!Array.isArray(profile.alignments)) throw new Error('profile.alignments must be an array');
  const alignmentIds = new Set<string>();
  profile.alignments.forEach((alignment, index) => {
    validateAlignment(alignment, `profile.alignments[${index}]`);
    if (alignmentIds.has(alignment.id)) throw new Error(`Duplicate alignment id: ${alignment.id}`);
    alignmentIds.add(alignment.id);
  });
  if (!Array.isArray(profile.sections) || profile.sections.length === 0) {
    throw new Error('profile.sections must be a non-empty array');
  }
  const sectionIds = new Set<string>();
  profile.sections.forEach((section, index) =>
    validateSection(section, `profile.sections[${index}]`, sectionIds),
  );
  assertClosedObject(profile.prompts, ['module', 'parent', 'overview'], 'profile.prompts');
  validatePrompt(profile.prompts.module, 'profile.prompts.module');
  validatePrompt(profile.prompts.parent, 'profile.prompts.parent');
  validatePrompt(profile.prompts.overview, 'profile.prompts.overview');
  validateDiagramPolicy(profile.diagramPolicy);
  validateOutput(profile.output);
}

export function fingerprintTemplateProfile(profile: TemplateProfile): string {
  validateTemplateProfile(profile);
  return createHash('sha256')
    .update(
      stableSerialize({
        profileValidatorContractVersion: PROFILE_VALIDATOR_CONTRACT_VERSION,
        profile,
      }),
    )
    .digest('hex');
}

export class TemplateProfileRegistry {
  private readonly profiles = new Map<TemplateProfileId, RegisteredTemplateProfile>();

  register(profile: TemplateProfile): RegisteredTemplateProfile {
    validateTemplateProfile(profile);
    if (this.profiles.has(profile.id)) throw new Error(`Duplicate profile id: ${profile.id}`);
    const fingerprint = fingerprintTemplateProfile(profile);
    const registered = Object.freeze({
      profile: deepFreeze(profile),
      fingerprint,
    });
    this.profiles.set(profile.id, registered);
    return registered;
  }

  resolve(id: string): RegisteredTemplateProfile {
    const resolved = this.profiles.get(id as TemplateProfileId);
    if (!resolved) {
      throw new Error(
        `Unknown wiki profile ${JSON.stringify(id)}. Available profiles: ${this.list()
          .map((item) => item.profile.id)
          .join(', ')}`,
      );
    }
    return resolved;
  }

  list(): readonly RegisteredTemplateProfile[] {
    return Array.from(this.profiles.values()).sort((a, b) =>
      a.profile.id.localeCompare(b.profile.id),
    );
  }
}

export const templateProfileRegistry = new TemplateProfileRegistry();
templateProfileRegistry.register(DEFAULT_TEMPLATE_PROFILE);
templateProfileRegistry.register(ARC42_TEMPLATE_PROFILE);
templateProfileRegistry.register(ENGINEERING_WIKI_TEMPLATE_PROFILE);
templateProfileRegistry.register(IEEE_1016_SDD_TEMPLATE_PROFILE);
templateProfileRegistry.register(ISO_42010_AD_TEMPLATE_PROFILE);

export function resolveTemplateProfile(id = 'default'): RegisteredTemplateProfile {
  return templateProfileRegistry.resolve(id);
}

export function listTemplateProfiles(): readonly RegisteredTemplateProfile[] {
  return templateProfileRegistry.list();
}
