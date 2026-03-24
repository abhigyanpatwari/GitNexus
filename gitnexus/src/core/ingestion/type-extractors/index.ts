/**
 * Per-language type extraction configurations — re-exports.
 *
 * Individual configs are imported directly by language providers.
 * This barrel re-exports shared types and utilities used elsewhere.
 */

export type {
  LanguageTypeConfig,
  TypeBindingExtractor,
  ParameterExtractor,
  ConstructorBindingScanner,
  ForLoopExtractor,
  PendingAssignmentExtractor,
  PatternBindingExtractor,
} from './types.js';
export { 
  TYPED_PARAMETER_TYPES,
  extractSimpleTypeName,
  extractGenericTypeArgs,
  extractVarName,
  extractRubyConstructorAssignment
} from './shared.js';
