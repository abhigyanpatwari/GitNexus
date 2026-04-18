// Graph types
export type {
  NodeLabel,
  NodeProperties,
  RelationshipType,
  GraphNode,
  GraphRelationship,
} from './graph/types.js';

// Schema constants
export {
  NODE_TABLES,
  REL_TABLE_NAME,
  REL_TYPES,
  EMBEDDING_TABLE_NAME,
} from './lbug/schema-constants.js';
export type { NodeTableName, RelType } from './lbug/schema-constants.js';

// Language support
export { SupportedLanguages } from './languages.js';
export { getLanguageFromFilename, getSyntaxLanguageFromFilename } from './language-detection.js';
export type { MroStrategy } from './mro-strategy.js';

// Pipeline progress
export type { PipelinePhase, PipelineProgress } from './pipeline.js';

// ─── Scope-based resolution — RFC #909 (Ring 1 #910) ────────────────────────
// Data model (RFC §2)
export type { SymbolDefinition } from './scope-resolution/symbol-definition.js';
export type {
  ScopeId,
  DefId,
  ScopeKind,
  Range,
  Capture,
  CaptureMatch,
  BindingRef,
  ImportEdge,
  TypeRef,
  Scope,
  ResolutionEvidence,
  Resolution,
  Reference,
  ReferenceIndex,
  LookupParams,
  RegistryContributor,
  ParsedImport,
  ParsedTypeBinding,
  WorkspaceIndex,
  Callsite,
} from './scope-resolution/types.js';

// Evidence + tie-break constants (RFC Appendix A, Appendix B)
export { EvidenceWeights, typeBindingWeightAtDepth } from './scope-resolution/evidence-weights.js';
export { ORIGIN_PRIORITY } from './scope-resolution/origin-priority.js';
export type { OriginForTieBreak } from './scope-resolution/origin-priority.js';

// Language classification (RFC §6.1 Ring 3/4 governance)
export {
  LanguageClassifications,
  isProductionLanguage,
} from './scope-resolution/language-classification.js';
export type { LanguageClassification } from './scope-resolution/language-classification.js';

// Core indexes over per-file artifacts (RFC §3.1; Ring 2 SHARED #913)
export { buildDefIndex } from './scope-resolution/def-index.js';
export type { DefIndex } from './scope-resolution/def-index.js';
export { buildModuleScopeIndex } from './scope-resolution/module-scope-index.js';
export type { ModuleScopeIndex, ModuleScopeEntry } from './scope-resolution/module-scope-index.js';
export { buildQualifiedNameIndex } from './scope-resolution/qualified-name-index.js';
export type { QualifiedNameIndex } from './scope-resolution/qualified-name-index.js';

// Strict type-reference resolver (RFC §4.6; Ring 2 SHARED #916)
export { resolveTypeRef } from './scope-resolution/resolve-type-ref.js';
export type { ResolveTypeRefContext, ScopeLookup } from './scope-resolution/resolve-type-ref.js';

// Method-dispatch materialized view over HeritageMap (RFC §3.1; Ring 2 SHARED #914)
export { buildMethodDispatchIndex } from './scope-resolution/method-dispatch-index.js';
export type {
  MethodDispatchIndex,
  MethodDispatchInput,
} from './scope-resolution/method-dispatch-index.js';

// SCC-aware cross-file finalize (RFC §3.2 Phase 2; Ring 2 SHARED #915)
export { finalize } from './scope-resolution/finalize-algorithm.js';
export type {
  FinalizeInput,
  FinalizeFile,
  FinalizeHooks,
  FinalizeOutput,
  FinalizedScc,
  FinalizeStats,
} from './scope-resolution/finalize-algorithm.js';

// Scope-aware registries + 7-step lookup (RFC §4; Ring 2 SHARED #917)
export { buildClassRegistry } from './scope-resolution/registries/class-registry.js';
export type { ClassRegistry } from './scope-resolution/registries/class-registry.js';
export { buildMethodRegistry } from './scope-resolution/registries/method-registry.js';
export type {
  MethodRegistry,
  MethodLookupOptions,
} from './scope-resolution/registries/method-registry.js';
export { buildFieldRegistry } from './scope-resolution/registries/field-registry.js';
export type {
  FieldRegistry,
  FieldLookupOptions,
} from './scope-resolution/registries/field-registry.js';
export { lookupCore } from './scope-resolution/registries/lookup-core.js';
export type { CoreLookupParams } from './scope-resolution/registries/lookup-core.js';
export { lookupQualified } from './scope-resolution/registries/lookup-qualified.js';
export type { LookupQualifiedParams } from './scope-resolution/registries/lookup-qualified.js';
export { composeEvidence, confidenceFromEvidence } from './scope-resolution/registries/evidence.js';
export type { RawSignals } from './scope-resolution/registries/evidence.js';
export {
  compareByConfidenceWithTiebreaks,
  CONFIDENCE_EPSILON,
} from './scope-resolution/registries/tie-breaks.js';
export type { TieBreakKey } from './scope-resolution/registries/tie-breaks.js';
export { CLASS_KINDS, METHOD_KINDS, FIELD_KINDS } from './scope-resolution/registries/context.js';
export type {
  RegistryContext,
  RegistryProviders,
  OwnerScopedContributor,
  ArityVerdict,
} from './scope-resolution/registries/context.js';

// Scope tree spine + position lookup (RFC §2.2 + §3.1; Ring 2 SHARED #912)
export { makeScopeId, clearScopeIdInternPool } from './scope-resolution/scope-id.js';
export type { ScopeIdInput } from './scope-resolution/scope-id.js';
export { buildScopeTree, ScopeTreeInvariantError } from './scope-resolution/scope-tree.js';
export type { ScopeTree } from './scope-resolution/scope-tree.js';
export { buildPositionIndex } from './scope-resolution/position-index.js';
export type { PositionIndex } from './scope-resolution/position-index.js';

// Shadow-mode diff + aggregation (RFC §6.3; Ring 2 SHARED #918)
export { diffResolutions } from './scope-resolution/shadow/diff.js';
export type {
  ShadowAgreement,
  ShadowCallsite,
  ShadowDiff,
} from './scope-resolution/shadow/diff.js';
export { aggregateDiffs } from './scope-resolution/shadow/aggregate.js';
export type { LanguageParityRow, ShadowParityReport } from './scope-resolution/shadow/aggregate.js';
