import type { LanguageTypeConfig, ParameterExtractor, TypeBindingExtractor } from './types.js';

/**
 * Zig type extraction — minimal v1 stub.
 *
 * Type-flow inference (constructor binding, for-loop element types, pattern
 * binding, etc.) is intentionally out of scope for v1. The provider supplies
 * an empty `declarationNodeTypes` set and no-op extractors to satisfy the
 * `LanguageTypeConfig` contract; the central type-env builder will simply
 * record nothing for Zig files. Receiver resolution today operates without
 * type-env signal for languages that omit it.
 */

const noopDeclaration: TypeBindingExtractor = () => {};
const noopParameter: ParameterExtractor = () => {};

export const zigTypeConfig: LanguageTypeConfig = {
  declarationNodeTypes: new Set(),
  extractDeclaration: noopDeclaration,
  extractParameter: noopParameter,
};
