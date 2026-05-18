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
 *   4. **`module.exports` / `exports.X`** — CJS export forms are not yet
 *      modeled as re-exports. The finalize algorithm treats the exporting
 *      module as a namespace; importers that do `const X = require('./m')`
 *      bind the module namespace, and member-call resolution walks the
 *      class graph from there.
 */

export { emitJsScopeCaptures } from './captures.js';
export { interpretJsImport, interpretJsTypeBinding } from './interpret.js';
export { jsMergeBindings } from './merge-bindings.js';
export { jsArityCompatibility } from './arity.js';
export { makeJsResolveImportTarget } from './import-target.js';
export { jsBindingScopeFor, jsImportOwningScope, jsReceiverBinding } from './simple-hooks.js';
