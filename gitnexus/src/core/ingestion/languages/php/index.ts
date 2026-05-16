/**
 * PHP scope-resolution hooks (RFC #909 Ring 3 LANG-php, #938).
 *
 * Public API barrel. Consumers should import from this file rather than
 * the individual modules.
 *
 * Module layout (each file is a single concern):
 *
 *   - `query.ts`               — tree-sitter query + lazy parser/query singletons
 *   - `captures.ts`            — `emitPhpScopeCaptures` orchestrator
 *   - `import-decomposer.ts`   — each `namespace_use_declaration` → ParsedImport captures
 *   - `interpret.ts`           — capture-match → `ParsedImport` / `ParsedTypeBinding`
 *   - `simple-hooks.ts`        — small/no-op hooks made explicit
 *   - `receiver-binding.ts`    — synthesize `$this` / `parent` type-bindings on
 *                                instance-method entry
 *   - `merge-bindings.ts`      — PHP `use` precedence (local > import > wildcard)
 *   - `arity.ts`               — PHP arity compatibility (variadic, defaults)
 *   - `arity-metadata.ts`      — synthesize arity metadata from declarations
 *   - `import-target.ts`       — `(ParsedImport, WorkspaceIndex) → file path` adapter
 *                                wrapping `resolvePhpImportInternal` (PSR-4 + composer.json)
 *   - `scope-resolver.ts`      — `ScopeResolver` registered in `SCOPE_RESOLVERS`
 *   - `cache-stats.ts`         — PROF_SCOPE_RESOLUTION cache hit/miss counters
 *
 * ## Known limitations
 *
 * The PHP registry-primary path intentionally does NOT resolve the following.
 * Each is a conscious trade-off at migration time.
 *
 *   1. **Trait `$this` → using-class binding** — for methods defined in a
 *      trait, `$this` is synthesized as a binding to the trait itself.
 *      Resolving `$this` to the actual using-class type requires cross-file
 *      analysis of all `use TraitName;` declarations in class bodies.
 *      Deferred to a follow-up; trait method resolution falls back to the
 *      trait scope.
 *
 *   2. **Anonymous classes** — `new class extends Foo { }` have no stable
 *      class name and are skipped by receiver-binding synthesis. The class
 *      body is still scoped; member lookups inside it will fall back to
 *      free-call resolution.
 *
 *   3. **Dynamic property/method access** — `$obj->{$name}()` and
 *      `$$varName` are not followed. The dynamic receiver is ignored and
 *      the call falls through to the shared free-call resolver.
 *
 *   4. **Magic methods** — `__get`, `__set`, `__call`, `__callStatic` are
 *      not modeled as virtual dispatch; they appear as regular method
 *      declarations in the graph but calls that would route through them
 *      at runtime are not distinguished.
 *
 *   5. **Laravel facade magic** — `App::make(...)`, `Cache::get(...)` etc.
 *      resolve statically to the Facade class rather than the underlying
 *      bound implementation. Deferred to a Laravel-specific plugin.
 *
 *   6. **Intersection types in parameters** — `T&U $param` takes the first
 *      named part (`T`). This matches the legacy type-extractor's behavior.
 *
 * Shadow-harness corpus parity is the authoritative signal for which of
 * these matter in practice. The CI parity gate blocks any PR that regresses
 * either the legacy or registry-primary run of
 * `test/integration/resolvers/php.test.ts`.
 */

export { emitPhpScopeCaptures } from './captures.js';
export { getPhpCaptureCacheStats, resetPhpCaptureCacheStats } from './cache-stats.js';
export { interpretPhpImport, interpretPhpTypeBinding } from './interpret.js';
export { phpMergeBindings } from './merge-bindings.js';
export { phpArityCompatibility } from './arity.js';
export { resolvePhpImportTarget, type PhpResolveContext } from './import-target.js';
export { phpBindingScopeFor, phpImportOwningScope, phpReceiverBinding } from './simple-hooks.js';
// NOTE: phpScopeResolver is intentionally NOT re-exported from this barrel.
// Importing it here would create a circular dependency:
//   php.ts → php/index.js → php/scope-resolver.js → ../php.js
// Registry and other consumers must import directly from './php/scope-resolver.js'.
