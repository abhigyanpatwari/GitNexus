/**
 * Swift scope-resolution hooks (RFC #909 Ring 3, issue #937 — the final
 * per-language migration).
 *
 * Public API barrel. Consumers import from this file rather than the
 * individual modules.
 *
 * Module layout (each file is a single concern):
 *
 *   - `query.ts`             — tree-sitter query + lazy parser/query singletons
 *   - `captures.ts`          — `emitSwiftScopeCaptures` orchestrator
 *   - `import-decomposer.ts` — each `import` → ParsedImport-shaped captures
 *   - `interpret.ts`         — capture-match → `ParsedImport` / `ParsedTypeBinding`
 *   - `simple-hooks.ts`      — small/no-op hooks made explicit
 *   - `receiver-binding.ts`  — synthesize `self` / `super` type-bindings
 *   - `merge-bindings.ts`    — Swift import-vs-local precedence
 *   - `arity.ts`             — Swift arity compatibility (count-primary)
 *   - `arity-metadata.ts`    — synthesize arity metadata from declarations
 *   - `import-target.ts`     — `(ParsedImport, WorkspaceIndex) → file path` adapter
 *   - `target-grouping.ts`   — group same-module files by SPM target subtree
 *   - `target-siblings.ts`   — same-SPM-target implicit cross-file visibility
 *   - `implicit-imports.ts`  — same-SPM-target File→File IMPORTS edges
 *   - `sibling-type-bindings.ts` — mirror sibling return-type typeBindings
 *   - `scope-resolver.ts`    — `ScopeResolver` registered in `SCOPE_RESOLVERS`
 *   - `cache-stats.ts`       — PROF_SCOPE_RESOLUTION cache hit/miss counters
 */

export { emitSwiftScopeCaptures } from './captures.js';
export { getSwiftCaptureCacheStats, resetSwiftCaptureCacheStats } from './cache-stats.js';
export { interpretSwiftImport, interpretSwiftTypeBinding } from './interpret.js';
export { swiftMergeBindings } from './merge-bindings.js';
export { swiftArityCompatibility } from './arity.js';
export { resolveSwiftImportTarget, type SwiftResolveContext } from './import-target.js';
export { groupSwiftFilesBySpmTarget, coerceSwiftTargets } from './target-grouping.js';
export { populateSwiftTargetSiblings } from './target-siblings.js';
export { emitSwiftImplicitImportEdges } from './implicit-imports.js';
export { mirrorSwiftSiblingTypeBindings } from './sibling-type-bindings.js';
export {
  swiftBindingScopeFor,
  swiftImportOwningScope,
  swiftReceiverBinding,
} from './simple-hooks.js';
