export { emitKotlinScopeCaptures } from './captures.js';
export { getKotlinCaptureCacheStats, resetKotlinCaptureCacheStats } from './cache-stats.js';
export { interpretKotlinImport, interpretKotlinTypeBinding } from './interpret.js';
export { kotlinArityCompatibility } from './arity.js';
export { resolveKotlinImportTarget, type KotlinResolveContext } from './import-target.js';
export { kotlinMergeBindings } from './merge-bindings.js';
export { populateKotlinOwners } from './owners.js';
export {
  kotlinBindingScopeFor,
  kotlinImportOwningScope,
  kotlinReceiverBinding,
} from './simple-hooks.js';
