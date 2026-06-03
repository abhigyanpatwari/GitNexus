/**
 * Vue SFC scope-resolution hooks (RFC #909 Ring 3, issue #940).
 *
 * Public API barrel. Consumers should import from this file rather
 * than the individual modules.
 *
 * Module layout (each file is a single concern):
 *
 *   - `captures.ts`       — `emitVueScopeCaptures` — extracts the
 *                           `<script>` / `<script setup>` block and
 *                           delegates to `emitTsScopeCaptures` (TypeScript
 *                           grammar, same grammar the parse-worker uses).
 *   - `import-target.ts`  — `makeVueResolveImportTarget` — memoized
 *                           adapter using the TypeScript resolver with
 *                           tsconfig path-alias support.
 *   - `scope-resolver.ts` — `vueScopeResolver` wiring object.
 *
 * ## Known limitations
 *
 *   1. **Template expressions** — Full template AST parsing is not performed.
 *      `vueScopeResolver.emitPostResolutionEdges` extracts five categories of
 *      template-derived edges via lightweight regex, all emitted after standard
 *      scope-resolution passes complete:
 *        - PascalCase/kebab-case component references → `vue-template-component` `CALLS`
 *        - `@event="handler"` on **native** elements → `vue-template-callback` `CALLS`
 *        - `@event="handler"` on **component** elements → `vue-event: @<name>` `BINDS_EVENT_HANDLER`
 *        - `emit(...)` / `this.$emit(...)` in script → `vue-emit: <name>` `EMITS_EVENT`
 *        - `:prop="varName"` single-identifier bindings → `vue-template-attribute` `ACCESSES`
 *      `BINDS_EVENT_HANDLER` and `EMITS_EVENT` are complementary "hanging" edges:
 *      a Cypher query joining on the shared component File node reveals which
 *      handlers receive which component's emitted events.
 *      Complex inline expressions (`@click="toggle(item)"`, `{{ a + b }}`,
 *      member-access bindings `:key="post.id"`) are intentionally excluded
 *      because they cannot be resolved to a single call/access target without
 *      a full template AST. Tracked in #1647.
 *   2. **Options API `this` resolution** — `this.X()` in Options API
 *      components does not resolve through type-binding when the component
 *      uses a plain object literal rather than a class. `fieldFallbackOnMethodLookup`
 *      recovers common cases via field-name matching.
 *   3. **`<script setup>` + `<script>` dual-block** — When both blocks are
 *      present, only `<script setup>` is processed (per `extractVueScript`
 *      priority). The non-setup block is skipped.
 *   4. **JSX in `<template>`** — Vue's template compiler is not a
 *      tree-sitter grammar; JSX-style bindings inside templates are not
 *      processed by the scope-resolution pipeline.
 */

export { emitVueScopeCaptures } from './captures.js';
export { makeVueResolveImportTarget } from './import-target.js';
export { vueScopeResolver } from './scope-resolver.js';
