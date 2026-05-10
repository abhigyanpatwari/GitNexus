/**
 * Java scope-resolution hooks (RFC #909 Ring 3).
 *
 * Public API barrel. Consumers should import from this file rather than
 * the individual modules.
 *
 * Module layout:
 *
 *   - `query.ts`               — tree-sitter query + lazy parser/query singletons
 *   - `captures.ts`            — `emitJavaScopeCaptures` orchestrator
 *   - `import-decomposer.ts`   — each `import` → ParsedImport-shaped captures
 *   - `interpret.ts`           — capture-match → `ParsedImport` / `ParsedTypeBinding`
 *   - `simple-hooks.ts`        — small hooks made explicit
 *   - `receiver-binding.ts`    — synthesize `this`/`super` type-bindings on
 *                                instance-method entry
 *   - `merge-bindings.ts`      — Java import precedence
 *   - `arity.ts`               — Java arity compatibility (varargs)
 *   - `arity-metadata.ts`      — synthesize arity metadata from declarations
 *   - `import-target.ts`       — `(ParsedImport, WorkspaceIndex) → file path` adapter
 *   - `scope-resolver.ts`      — `ScopeResolver` registered in `SCOPE_RESOLVERS`
 *   - `cache-stats.ts`         — PROF_SCOPE_RESOLUTION cache hit/miss counters
 */

export { emitJavaScopeCaptures } from './captures.js';
export { getJavaCaptureCacheStats, resetJavaCaptureCacheStats } from './cache-stats.js';
export { interpretJavaImport, interpretJavaTypeBinding } from './interpret.js';
export { javaMergeBindings } from './merge-bindings.js';
export { javaArityCompatibility } from './arity.js';
export { resolveJavaImportTarget, type JavaResolveContext } from './import-target.js';
export { javaBindingScopeFor, javaImportOwningScope, javaReceiverBinding } from './simple-hooks.js';
