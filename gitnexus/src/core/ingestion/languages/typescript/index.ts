/**
 * TypeScript scope-resolution hooks (RFC #909 Ring 3, RFC §5).
 *
 * Public API barrel. Consumers should import from this file rather
 * than the individual modules.
 *
 * Module layout (each file is a single concern):
 *
 *   - `query.ts`             — tree-sitter query + lazy parser/query singletons
 *   - `captures.ts`          — `emitTsScopeCaptures` orchestrator
 *   - `import-decomposer.ts` — each import/re-export/dynamic-import →
 *                              ParsedImport-shaped captures
 *   - `interpret.ts`         — capture-match → `ParsedImport` /
 *                              `ParsedTypeBinding`
 *   - `simple-hooks.ts`      — `bindingScopeFor` (var hoisting + return-
 *                              type hoisting), `importOwningScope`
 *                              (module/namespace default), `receiverBinding`
 *                              (`this` lookup on Function scope)
 *   - `receiver-binding.ts`  — synthesize `this` type-bindings on
 *                              instance-method entry (methods, interface
 *                              signatures, class-field arrow functions)
 *   - `merge-bindings.ts`    — TypeScript declaration merging
 *                              (value / type / namespace spaces) + LEGB
 *                              tier shadowing
 *   - `arity.ts`             — TypeScript arity compatibility (rest,
 *                              optional, default params)
 *   - `arity-metadata.ts`    — synthesize arity metadata from
 *                              declarations; includes generics + array-
 *                              suffix stripping on parameter types
 *   - `import-target.ts`     — `(ParsedImport, WorkspaceIndex) → file path`
 *                              adapter delegating to the shared standard
 *                              resolver (tsconfig paths, node_modules,
 *                              relative/extension suffix matching)
 *   - `cache-stats.ts`       — PROF_SCOPE_RESOLUTION cache hit/miss
 *                              counters
 *
 * ## Known limitations
 *
 * The TypeScript registry-primary path intentionally does NOT resolve
 * the following. Each is a conscious trade-off at migration time.
 *
 *   1. **Type-only import / export separation** — `import type { X }`
 *      and `import { X }` produce the same `ParsedImport` shape today;
 *      `def.type` on the resolved symbol is the only discriminator.
 *      Parity with the legacy path is preserved. Tracking in #927.
 *   2. **Declaration merging for imports** — when `import { Foo }`
 *      brings in a symbol that is BOTH a class and a namespace in the
 *      source module, we currently surface a single binding per the
 *      target `def.type`. Downstream type/value-space lookups still
 *      work for the primary space; the other space's members resolve
 *      via the same target (class statics reachable via dotted access).
 *   3. **Overload narrowing by argument type** — `@reference.parameter-
 *      types` carries static literal types inferred from the callsite
 *      (`string`, `number`, `Array`, etc.). Identifier / member-access
 *      arguments emit empty strings (unknown type); the registry's
 *      narrowing treats them as any-match. Full control-flow type
 *      narrowing is out of scope.
 *   4. **Computed member access** — `obj[key]()` / `obj['method']()`
 *      is classified as an index-access call; member-call resolution
 *      falls back to the identifier-indexed branch and matches only
 *      when the key is a string literal.
 *   5. **`this` for nested regular functions inside methods** — our
 *      scope-chain lookup returns the enclosing method's `this`, which
 *      is technically incorrect at runtime (a non-arrow nested function
 *      has its own `this` binding). Accepted false-positive; see
 *      `simple-hooks.ts` docstring.
 *   6. **`class_expression` receiver types** — `const C = class { }`
 *      skips `this` synthesis when the expression is anonymous (no
 *      type name to propagate). `const C = class Named { }` works via
 *      the class's own `name` field.
 *   7. **JSX element types** — JSX-specific constructs are ignored by
 *      the scope query; component references resolve via regular
 *      identifier / member-expression paths.
 *   8. **Ambient module declarations** (`declare module '…'`) — parsed
 *      but not indexed at this layer; same as today's legacy path.
 *   9. **Intersection types on parameters** (`(a: A & B)`) — treated
 *      as opaque (no strip); overload narrowing on intersections
 *      won't match.
 *  10. **`instanceof` member-expression narrowing** — only bare
 *      identifiers are narrowed (`user instanceof User`). Member paths
 *      such as `user.address instanceof Address` remain unresolved.
 *
 * Shadow-harness corpus parity on `test/integration/resolvers/
 * typescript.test.ts` is the authoritative signal for which of these
 * matter in practice. The CI parity gate blocks any PR that regresses
 * either the legacy or registry-primary run.
 */

export { emitTsScopeCaptures } from './captures.js';
export { getTypescriptCaptureCacheStats, resetTypescriptCaptureCacheStats } from './cache-stats.js';
export { interpretTsImport, interpretTsTypeBinding } from './interpret.js';
export { typescriptMergeBindings } from './merge-bindings.js';
export { typescriptArityCompatibility } from './arity.js';
export { resolveTsImportTarget, resolveTsTarget, type TsResolveContext } from './import-target.js';
export { tsBindingScopeFor, tsImportOwningScope, tsReceiverBinding } from './simple-hooks.js';
