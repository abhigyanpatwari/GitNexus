/**
 * C# scope-resolution hooks (RFC #909 Ring 3, RFC §5).
 *
 * Public API barrel. Consumers should import from this file rather than
 * the individual modules.
 *
 * Module layout (each file is a single concern):
 *
 *   - `query.ts`               — tree-sitter query + lazy parser/query singletons
 *   - `captures.ts`            — `emitCsharpScopeCaptures` orchestrator
 *   - `import-decomposer.ts`   — each `using` → ParsedImport-shaped captures
 *   - `interpret.ts`           — capture-match → `ParsedImport` / `ParsedTypeBinding`
 *   - `simple-hooks.ts`        — small/no-op hooks made explicit
 *   - `receiver-binding.ts`    — synthesize `this`/`base` type-bindings on
 *                                instance-method entry
 *   - `merge-bindings.ts`      — C# `using` precedence
 *   - `arity.ts`               — C# arity compatibility (`params`, default values)
 *   - `arity-metadata.ts`      — synthesize arity metadata from declarations
 *   - `accessor-unwrap.ts`     — `.Values` / `.Keys` receiver-type unwrap for
 *                                `Dictionary<K,V>` chains
 *   - `namespace-siblings.ts`  — AST-driven cross-file implicit-namespace
 *                                visibility (file/namespace attribution, no
 *                                regex; reuses orchestrator's treeCache)
 *   - `import-target.ts`       — `(ParsedImport, WorkspaceIndex) → file path` adapter
 *   - `scope-resolver.ts`      — `ScopeResolver` registered in `SCOPE_RESOLVERS`
 *   - `cache-stats.ts`         — PROF_SCOPE_RESOLUTION cache hit/miss counters
 *
 * ## Known limitations
 *
 * The C# registry-primary path intentionally does NOT resolve the
 * following. Each is a conscious trade-off at migration time.
 *
 *   1. **csproj-driven namespace resolution** — the legacy path
 *      consults `csharpConfigs` (the parsed .csproj workspace) to map
 *      `using X.Y;` back to the exact files declaring `namespace X.Y`.
 *      The scope-resolver contract passes only `allFilePaths`, so we
 *      fall back to suffix matching on `.cs` files. Unit 7's parity
 *      gate flags any divergence.
 *   2. **Multi-file namespace expansion** — a single `using X.Y;` in
 *      the legacy path can emit multiple IMPORTS edges (every file
 *      declaring that namespace). The scope-resolver contract returns
 *      a single target, so we pick the first match; partial-class
 *      aggregation runs at graph-bridge time.
 *   3. **Overload resolution by parameter type** — arity narrowing is
 *      wired (`arity.ts` + `arity-metadata.ts`), but type-based
 *      disambiguation (`F(int)` vs `F(string)` at a call with a typed
 *      argument) is left to the registry's type-binding layer.
 *   4. **Generic type parameter resolution** — `List<User>` binds the
 *      bound name to `User` via the single-arg-generic stripper;
 *      nested generics (`Dictionary<K, List<V>>`) fall through the
 *      receiver-type heuristic.
 *   5. **`dynamic` typed expressions** — runtime dispatch through
 *      `dynamic` is not followed.
 *   6. **Preprocessor-conditional code** — `#if DEBUG` blocks parse
 *      as usual; branch selection is ignored, so both arms contribute
 *      bindings.
 *   7. **Global using propagation across files** — treated as a
 *      file-scoped using for the declaring file. Unit 7 parity gate
 *      will flag cases where this matters.
 *   8. **Expression-bodied `=>` members** — handled by the method
 *      extractor, but receiver synthesis for `=> this.Field` shortcuts
 *      follows the same path as block-bodied methods.
 *   9. **Multi-namespace file attribution** — when a single file
 *      declares two namespaces (rare), all top-level classes are
 *      attributed to the first declared namespace via a `first-wins`
 *      rule in `namespace-siblings.ts`. Namespace detection itself is
 *      AST-driven (tree-sitter), so `global using static`, aliased
 *      `using static X = Y.Z;`, attributes, and preprocessor-gated
 *      declarations are all recognized correctly.
 *
 * Shadow-harness corpus parity is the authoritative signal for which
 * of these matter in practice. The CI parity gate blocks any PR that
 * regresses either the legacy or registry-primary run of
 * `test/integration/resolvers/csharp.test.ts`.
 */

export { emitCsharpScopeCaptures } from './captures.js';
export { getCsharpCaptureCacheStats, resetCsharpCaptureCacheStats } from './cache-stats.js';
export { interpretCsharpImport, interpretCsharpTypeBinding } from './interpret.js';
export { csharpMergeBindings } from './merge-bindings.js';
export { csharpArityCompatibility } from './arity.js';
export { resolveCsharpImportTarget, type CsharpResolveContext } from './import-target.js';
export {
  csharpBindingScopeFor,
  csharpImportOwningScope,
  csharpReceiverBinding,
} from './simple-hooks.js';
