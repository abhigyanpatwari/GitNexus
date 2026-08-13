export const TEMPLATE_PROFILE_SCHEMA_VERSION = 1 as const;

export type TemplateProfileId =
  | 'default'
  | 'arc42'
  | 'engineering-wiki'
  | 'ieee-1016-sdd'
  | 'iso-42010-ad';

export type BuiltinLocale = 'en' | 'zh-CN';

export interface LocalizedText {
  en: string;
  'zh-CN': string;
}

export type LocaleDiagnosticCode = 'invalid-language' | 'unsupported-locale-fallback';

export interface LocaleDiagnostic {
  code: LocaleDiagnosticCode;
  message: string;
}

export interface ResolvedLanguage {
  requestedLanguage: string;
  resolvedLocale: BuiltinLocale;
  fallbackFrom?: string;
  localeFingerprint: string;
  localeResolverVersion: number;
  diagnostics: readonly LocaleDiagnostic[];
}

export type EvidenceKind =
  | 'source'
  | 'config'
  | 'test'
  | 'documentation'
  | 'call-graph'
  | 'external-call-graph'
  | 'process';

export interface EvidenceRequirement {
  id: string;
  kind: EvidenceKind;
  required: boolean;
  description: LocalizedText;
}

export interface StandardAlignment {
  id: string;
  officialTitle: string;
  url: string;
  claim: 'inspired' | 'aligned';
  licenseNote: string;
  notice: LocalizedText;
}

export interface PromptSpec {
  system: string;
  user: string;
  requiredVariables: readonly string[];
  allowedVariables: readonly string[];
}

export interface SectionSpec {
  id: string;
  title: LocalizedText;
  required: boolean;
  concerns: readonly string[];
  evidenceRequirements: readonly EvidenceRequirement[];
  prompt?: PromptSpec;
  unknownPolicy: 'emit-status' | 'omit-optional';
  children?: readonly SectionSpec[];
}

export interface DiagramPolicy {
  allowed: boolean;
  maxNodes: number;
  kinds: readonly ('mermaid-flowchart' | 'mermaid-sequence' | 'c4-context' | 'c4-container')[];
}

export interface OutputContract {
  topology: 'legacy-tree' | 'standard-document';
  entryFile: string;
  aggregateFile?: string;
  coverageFile: string;
}

export interface TemplateProfile {
  schemaVersion: typeof TEMPLATE_PROFILE_SCHEMA_VERSION;
  id: TemplateProfileId;
  revision: number;
  displayName: LocalizedText;
  alignments: readonly StandardAlignment[];
  grouping: 'shared-default';
  sections: readonly SectionSpec[];
  prompts: {
    module: PromptSpec;
    parent: PromptSpec;
    overview: PromptSpec;
  };
  diagramPolicy: DiagramPolicy;
  output: OutputContract;
}

export interface RegisteredTemplateProfile {
  profile: TemplateProfile;
  fingerprint: string;
}
