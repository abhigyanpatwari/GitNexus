/**
 * C++ scope-resolution hooks (RFC #909 Ring 3).
 */
export { emitCppScopeCaptures } from './captures.js';
export { interpretCppImport, interpretCppTypeBinding, normalizeCppTypeName } from './interpret.js';
export { splitCppInclude, splitCppUsingDecl } from './import-decomposer.js';
export { cppArityCompatibility } from './arity.js';
export { cppMergeBindings } from './merge-bindings.js';
export { cppBindingScopeFor, cppImportOwningScope, cppReceiverBinding } from './simple-hooks.js';
export { resolveCppImportTarget } from './import-target.js';
export {
  markFileLocal,
  isFileLocal,
  clearFileLocalNames,
  expandCppWildcardNames,
} from './file-local-linkage.js';
