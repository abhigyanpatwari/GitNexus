/**
 * Python scope-resolution hooks (RFC #909 Ring 3, RFC §5).
 *
 * Public API barrel. Consumers should import from this file rather than
 * the individual modules — that keeps the per-hook organization an
 * implementation detail we can refactor without touching the provider
 * wiring.
 *
 * Module layout (each file is a single concern):
 *
 *   - `query.ts`                — tree-sitter query string + lazy parser/query singletons
 *   - `ast-utils.ts`            — generic `SyntaxNode` helpers
 *   - `import-decomposer.ts`    — `import a, b` / `from m import x, y` → one match per name
 *   - `receiver-binding.ts`     — synthesize `self`/`cls` type bindings on methods
 *   - `captures.ts`             — `emitPythonScopeCaptures` (top-level orchestrator)
 *   - `cache-stats.ts`          — PROF_SCOPE_RESOLUTION cache hit/miss counters
 *   - `interpret.ts`            — capture-match → `ParsedImport` / `ParsedTypeBinding`
 *   - `merge-bindings.ts`       — Python LEGB precedence
 *   - `arity.ts`                — Python arity check (`*args`, `**kwargs`, defaults)
 *   - `import-target.ts`        — `(ParsedImport, WorkspaceIndex) → file path` adapter
 *   - `simple-hooks.ts`         — small/no-op hooks made explicit
 *
 * ## Known limitations
 *
 * The Python registry-primary path intentionally does NOT resolve the
 * following. Each is a conscious trade-off at migration time; lifting any
 * of them is tracked as a separate follow-up rather than silently
 * "maybe-resolving" and emitting low-confidence edges.
 *
 *   1. **Dynamic attribute access** — `getattr(obj, 'name')` and
 *      `setattr` bind at runtime. We emit no edge; the call site
 *      surfaces as an unresolved reference.
 *   2. **Dynamic imports** — `importlib.import_module(...)` and
 *      `__import__(...)` are not followed. Static `import x` and
 *      `from m import x` are fully resolved.
 *   3. **Metaclass-driven dispatch** — C3 linearization drives MRO
 *      (see `mro-processor.ts`), but method resolution that depends
 *      on `__getattribute__` overrides or metaclass `__call__`
 *      remains unresolved.
 *   4. **Union / Optional type hints** — `def f(x: Union[A, B])` or
 *      `x: Optional[A]`: `arity.ts` validates parameter count only;
 *      receiver-binding and field-type resolution pick the first arm
 *      and emit a single edge rather than branching. `List[T]` /
 *      `Dict[K, V]` strip the outer generic for receiver typing (see
 *      `interpret.ts`).
 *   5. **Decorators that rewrite signatures** — `@dataclass`,
 *      `@property`, `@classmethod`, `@staticmethod` are recognized
 *      by `receiver-binding.ts`. Arbitrary decorators (e.g.
 *      `functools.wraps`, custom retry wrappers) preserve the wrapped
 *      function's declared signature; a decorator that returns a
 *      different callable is followed only through the declared
 *      return type.
 *   6. **`typing.TYPE_CHECKING`-guarded imports** — treated like any
 *      other `import` for reference resolution. We do not distinguish
 *      runtime-visible from type-checker-only imports; this is
 *      intentional (type-only imports are still structurally valid
 *      type references).
 *   7. **`*args` / `**kwargs` type flow-through** — `arity.ts`
 *      accepts any call count when a variadic is present, but no
 *      type information flows through the variadic into the callee
 *      body. Receiver-binding still works for explicit parameters.
 *   8. **`super()` outside a method with a literal class binding** —
 *      resolved for the standard `class Child(Parent): def m(self):
 *      super().m()` pattern. Zero-arg `super()` inside a nested
 *      function, a `functools.wraps`-rewrapped method, or a call
 *      site where the enclosing class can't be statically determined
 *      is left unresolved.
 *
 * Shadow-harness corpus parity is the authoritative signal for which
 * of these matter in practice. The CI parity gate blocks any PR that
 * regresses either the legacy or registry-primary run of
 * `test/integration/resolvers/python.test.ts`.
 */

export { emitPythonScopeCaptures } from './captures.js';
export { getPythonCaptureCacheStats, resetPythonCaptureCacheStats } from './cache-stats.js';
export { interpretPythonImport, interpretPythonTypeBinding } from './interpret.js';
export { pythonMergeBindings } from './merge-bindings.js';
export { pythonArityCompatibility } from './arity.js';
export { resolvePythonImportTarget, type PythonResolveContext } from './import-target.js';
export {
  pythonBindingScopeFor,
  pythonFunctionDefinitionLabel,
  pythonImportOwningScope,
  pythonReceiverBinding,
} from './simple-hooks.js';
