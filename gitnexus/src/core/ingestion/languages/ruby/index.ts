/**
 * Ruby scope-resolution hooks (RFC #909 Ring 3).
 */
export { emitRubyScopeCaptures } from './captures.js';
export { getRubyCaptureCacheStats, resetRubyCaptureCacheStats } from './cache-stats.js';
export {
  interpretRubyImport,
  interpretRubyTypeBinding,
  normalizeRubyTypeName,
} from './interpret.js';
export { rubyArityCompatibility } from './arity.js';
export { rubyMergeBindings } from './merge-bindings.js';
export { synthesizeRubyReceiverBinding, findEnclosingClassOrModule } from './receiver-binding.js';
export {
  rubyBindingScopeFor,
  rubyImportOwningScope,
  rubyReceiverBinding,
  rubyFunctionDefinitionLabel,
} from './simple-hooks.js';
export { resolveRubyImportTarget, type RubyResolveContext } from './import-target.js';
