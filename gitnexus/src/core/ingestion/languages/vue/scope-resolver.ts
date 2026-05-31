/**
 * Vue `ScopeResolver` registered in `SCOPE_RESOLVERS` and consumed by
 * the generic `runScopeResolution` orchestrator (RFC #909 Ring 3, issue #940).
 *
 * ## Design rationale
 *
 * Vue SFCs compile down to TypeScript/JavaScript — the `<script>` /
 * `<script setup>` block is pure TS/JS, parsed with the TypeScript
 * grammar and captured by `emitVueScopeCaptures` (which delegates
 * to `emitTsScopeCaptures`).  Because of this, nearly all hooks are
 * identical to the TypeScript resolver:
 *
 *   - `mergeBindings` — TypeScript LEGB semantics apply in script blocks.
 *   - `arityCompatibility` — same positional + rest rules.
 *   - `buildMro` / `populateOwners` — shared with TypeScript.
 *   - `isSuperReceiver` — `super(...)` / `super.foo` / `super[x]` pattern.
 *   - `resolveImportTarget` — TypeScript resolver with `.vue` explicit-
 *                             extension support; tsconfig paths loaded via
 *                             `loadResolutionConfig`.
 *
 * ## Key differences from TypeScript
 *
 *   - `language: SupportedLanguages.Vue` — routes the resolver to Vue
 *     files only; TypeScript files use the TypeScript resolver.
 *   - `languageProvider: vueProvider` — the Vue-specific language
 *     provider supplies the right built-ins and export checker for
 *     `<script setup>` (all top-level bindings implicitly exported).
 *   - `importEdgeReason: 'vue-scope: import'` — distinct tag for
 *     debugging / edge provenance.
 *   - `allowGlobalFreeCallFallback: false` — Vue uses explicit imports;
 *     workspace-wide unique-name fallback is unnecessary and would
 *     produce spurious edges for Vue built-ins (ref, reactive, …).
 *
 * ## Options API / this-binding
 *
 * Options API (`defineComponent({ methods: { … } })`) stores methods
 * on the component instance, which tree-sitter sees as object property
 * values.  `this.X()` inside a method resolves via the existing
 * `tsReceiverBinding` hook (inherited from TypeScript), which walks to
 * the enclosing Class scope.  For Options API the enclosing "class" is
 * the `defineComponent({…})` object — not a true class — so `this`
 * calls may not resolve through the type-binding layer.  `fieldFallbackOnMethodLookup`
 * is therefore set to `true` so the field-name fallback catches common
 * patterns even without an explicit type annotation.
 *
 * ## `<script setup>` macro calls
 *
 * `defineProps`, `defineEmits`, `defineExpose`, `withDefaults`, etc.
 * are compiler macros available as globals inside `<script setup>`.
 * They are listed in `vueProvider.builtInNames` and therefore treated
 * as resolved without requiring an import edge.
 */

import type { ParsedFile } from 'gitnexus-shared';
import { SupportedLanguages } from 'gitnexus-shared';
import { buildMro, defaultLinearize } from '../../scope-resolution/passes/mro.js';
import { populateClassOwnedMembers } from '../../scope-resolution/scope/walkers.js';
import type { ScopeResolver } from '../../scope-resolution/contract/scope-resolver.js';
import { vueProvider } from '../vue.js';
import { loadTsconfigPaths } from '../../language-config.js';
import { typescriptArityCompatibility, typescriptMergeBindings } from '../typescript/index.js';
import { makeVueResolveImportTarget } from './import-target.js';

const vueScopeResolver: ScopeResolver = {
  language: SupportedLanguages.Vue,
  languageProvider: vueProvider,
  importEdgeReason: 'vue-scope: import',

  resolveImportTarget: makeVueResolveImportTarget(),

  // Vue projects universally use TypeScript — load tsconfig so path
  // aliases (`@/`, `~/`, `#/`) resolve through the standard branch.
  loadResolutionConfig: async (repoPath: string) => ({
    tsconfigPaths: await loadTsconfigPaths(repoPath),
  }),

  // TypeScript LEGB semantics apply inside `<script>` / `<script setup>`.
  mergeBindings: (existing, incoming) => [...typescriptMergeBindings([...existing, ...incoming])],

  // Adapter: typescriptArityCompatibility uses (def, callsite); contract is (callsite, def).
  arityCompatibility: (callsite, def) => typescriptArityCompatibility(def, callsite),

  buildMro: (graph, parsedFiles, nodeLookup) =>
    buildMro(graph, parsedFiles, nodeLookup, defaultLinearize),

  populateOwners: (parsed: ParsedFile) => populateClassOwnedMembers(parsed),

  isSuperReceiver: (text) => /^super(\s*\(|\s*\.|\s*\[|\s*$)/.test(text.trim()),

  // Options API `this.X()` calls may not resolve through the type-binding
  // layer (no formal class declaration), so enable the field-fallback
  // heuristic to catch them via declared field names.
  fieldFallbackOnMethodLookup: true,

  // Return-type propagation mirrors TypeScript.
  propagatesReturnTypesAcrossImports: true,
  hoistTypeBindingsToModule: true,

  // Vue uses explicit imports for all external symbols; no global free-
  // call fallback needed (would produce spurious edges for built-ins).
  allowGlobalFreeCallFallback: false,
};

export { vueScopeResolver };
