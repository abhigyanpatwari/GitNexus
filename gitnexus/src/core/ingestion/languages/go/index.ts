/**
 * Go scope-resolution hooks (RFC #909 Ring 3).
 */
export { emitGoScopeCaptures } from './captures.js';
export { getGoCaptureCacheStats, resetGoCaptureCacheStats } from './cache-stats.js';
export { interpretGoImport, interpretGoTypeBinding, normalizeGoTypeName } from './interpret.js';
export { splitGoImportStatement } from './import-decomposer.js';
export { synthesizeGoReceiverBinding } from './receiver-binding.js';
export { synthesizeGoTypeBindings } from './type-binding.js';
export { goArityCompatibility } from './arity.js';
export { goMergeBindings } from './merge-bindings.js';
export { goBindingScopeFor, goImportOwningScope, goReceiverBinding } from './simple-hooks.js';
export { resolveGoImportTarget, type GoResolveContext } from './import-target.js';
export { populateGoPackageSiblings } from './package-siblings.js';
export { populateGoRangeBindings } from './range-binding.js';
export { detectGoInterfaceImplementations } from './interface-impls.js';
export { mirrorGoNamespaceTypeBindings } from './namespace-mirror.js';
