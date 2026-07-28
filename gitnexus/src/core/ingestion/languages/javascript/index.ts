/**
 * JavaScript scope-resolution hooks (RFC #909 Ring 3, issue #928).
 *
 * Public API barrel. Consumers should import from this file rather
 * than the individual modules.
 *
 * Module layout (each file is a single concern):
 *
 *   - `query.ts`          — JS scope query string + lazy parser/query
 *                           singletons (`getJsParser`, `getJsScopeQuery`)
 *   - `captures.ts`       — `emitJsScopeCaptures` — runs the JS scope query,
 *                           synthesizes CJS require() imports and JSDoc-
 *                           derived type bindings, delegates arity synthesis
 *                           and destructuring/instanceof passes to shared
 *                           or TypeScript utilities
 *   - `interpret.ts`      — `interpretJsImport` / `interpretJsTypeBinding`
 *                           (delegate to TypeScript interpreters — same
 *                           capture-marker vocabulary)
 *   - `simple-hooks.ts`   — `jsBindingScopeFor` (var hoisting),
 *                           `jsImportOwningScope`, `jsReceiverBinding`
 *                           (all delegate to TypeScript counterparts)
 *   - `merge-bindings.ts` — `jsMergeBindings` (LEGB via typescriptMergeBindings)
 *   - `arity.ts`          — `jsArityCompatibility` (delegates to TS function)
 *   - `import-target.ts`  — `makeJsResolveImportTarget` (memoized adapter)
 *   - `scope-resolver.ts` — `javascriptScopeResolver` wiring object
 *
 * ## Known limitations
 *
 *   1. **JSDoc coverage** — `@param {T} name`, `@returns {T}` / `@return {T}`,
 *      and `@type {T}` on variable declarations are synthesized. `@typedef`
 *      is not yet synthesized (tracked in #1646).
 *   2. **CJS chained destructuring** — `const { X: { Y } } = require(...)`
 *      (nested destructuring) emits only the outer `X` binding; `Y` is not
 *      resolved.
 *   3. **Dynamic require** — `require(computedPath)` is skipped (non-literal
 *      argument — cannot statically resolve the target).
 *   4. **`module.exports = fn`** — an anonymous default export has no name to
 *      bind, so nothing declares it. The rest of the CJS export surface IS
 *      modeled (#2723); see below.
 *
 * ## CommonJS export forms (#2723)
 *
 * Each of these declares its name in the module scope, so importers resolve to
 * it by name — `const { foo } = require('./m')` matches directly and a
 * namespace `m.foo()` walks the module's defs:
 *
 *   - `exports.foo = function () {}` / `module.exports.foo = (a) => a`, in
 *     every value form (function, async, arrow, async arrow, generator).
 *   - `const e = exports; e.foo = fn` — an alias bound at module scope. The
 *     receiver cannot be pinned in a query, so the member-assignment rules
 *     match any identifier receiver and the emitters prune anything that is
 *     not the exports object.
 *   - `this.foo = fn` at MODULE level of a CommonJS file, where `this` is
 *     `module.exports`. Gated on the file being CommonJS — in ESM top-level
 *     `this` is undefined and the same line exports nothing.
 *   - `exports.foo = lib.imported` / `exports.foo = importedName` — forwarded
 *     as a re-export (`reexport-alias`), so callers reach the ORIGINAL
 *     definition. A plain import binding would not do: it is private to its
 *     module, exactly as in ESM.
 *
 * Two deliberate non-cases. `exports.foo = localFn`, where the value is a
 * locally declared function, needs nothing — the module scope already binds
 * `localFn` and importers already resolve through it. And a CJS export whose
 * name the module ALSO declares lexically is suppressed rather than declared
 * twice: two declarations of one name are ambiguous, and the resolver would
 * drop the intra-module edge entirely.
 *
 * Callable members assigned through a receiver are Methods with an owner edge
 * rather than free functions: `Foo.prototype.bar = fn` and `this.bar = fn`
 * inside a constructor. Ownership resolves to what the file declares, so an
 * owner it cannot see (`External.prototype.x = fn`) claims no edge.
 */

export { emitJsScopeCaptures } from './captures.js';
export { interpretJsImport, interpretJsTypeBinding } from './interpret.js';
export { jsMergeBindings } from './merge-bindings.js';
export { jsArityCompatibility } from './arity.js';
export { makeJsResolveImportTarget } from './import-target.js';
export { jsBindingScopeFor, jsImportOwningScope, jsReceiverBinding } from './simple-hooks.js';
