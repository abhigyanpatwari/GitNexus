/**
 * Rust scope-resolution hooks (RFC #909 Ring 3).
 */
export { emitRustScopeCaptures } from './captures.js';
export { getRustCaptureCacheStats, resetRustCaptureCacheStats } from './cache-stats.js';
export {
  interpretRustImport,
  interpretRustTypeBinding,
  normalizeRustTypeName,
} from './interpret.js';
export { splitRustUseDeclaration } from './import-decomposer.js';
export { synthesizeRustReceiverBinding } from './receiver-binding.js';
export { rustArityCompatibility } from './arity.js';
export { rustMergeBindings } from './merge-bindings.js';
export { rustBindingScopeFor, rustImportOwningScope, rustReceiverBinding } from './simple-hooks.js';
export { resolveRustImportTarget, type RustResolveContext } from './import-target.js';
