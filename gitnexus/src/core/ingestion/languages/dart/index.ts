/**
 * Dart scope-resolution hooks (RFC #909 Ring 3, issue #939).
 *
 * Public API barrel. Consumers import from this file rather than the
 * individual modules.
 *
 * Module layout (each file is a single concern):
 *
 *   - `query.ts`             — tree-sitter scope query + lazy parser/query
 *   - `captures.ts`          — `emitDartScopeCaptures` orchestrator
 *   - `interpret.ts`         — capture-match → `ParsedImport` / `ParsedTypeBinding`
 *   - `import-target.ts`     — `(targetRaw, fromFile, allFilePaths) → file path`
 *   - `receiver-binding.ts`  — synthesize `this` / `super` type-bindings
 *   - `signature-bindings.ts`— synthesize parameter / return type-bindings
 *   - `arity.ts`             — Dart arity compatibility (count-primary)
 *   - `arity-metadata.ts`    — synthesize arity metadata from declarations
 *   - `merge-bindings.ts`    — Dart import-vs-local precedence
 *   - `simple-hooks.ts`      — `bindingScopeFor` / `importOwningScope` / `receiverBinding`
 *   - `scope-resolver.ts`    — `ScopeResolver` registered in `SCOPE_RESOLVERS`
 *   - `cache-stats.ts`       — PROF_SCOPE_RESOLUTION cache hit/miss counters
 */

export { emitDartScopeCaptures } from './captures.js';
export { getDartCaptureCacheStats, resetDartCaptureCacheStats } from './cache-stats.js';
export {
  interpretDartImport,
  interpretDartTypeBinding,
  normalizeDartType,
  DART_HERITAGE_PREFIX,
} from './interpret.js';
export { dartMergeBindings } from './merge-bindings.js';
export { dartArityCompatibility } from './arity.js';
export { resolveDartImportTarget } from './import-target.js';
export { dartBindingScopeFor, dartImportOwningScope, dartReceiverBinding } from './simple-hooks.js';
