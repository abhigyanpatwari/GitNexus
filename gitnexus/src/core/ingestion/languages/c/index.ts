/**
 * C scope-resolution hooks (RFC #909 Ring 3).
 */
export { emitCScopeCaptures } from './captures.js';
export { interpretCImport, interpretCTypeBinding, normalizeCTypeName } from './interpret.js';
export { splitCInclude } from './import-decomposer.js';
export { cArityCompatibility } from './arity.js';
export { cMergeBindings } from './merge-bindings.js';
export { cBindingScopeFor, cImportOwningScope, cReceiverBinding } from './simple-hooks.js';
export { resolveCImportTarget } from './import-target.js';
export {
  markStaticName,
  isStaticName,
  clearStaticNames,
  expandCWildcardNames,
} from './static-linkage.js';
