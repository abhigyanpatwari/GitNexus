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
import { generateId } from '../../../../lib/utils.js';
import { buildMro, defaultLinearize } from '../../scope-resolution/passes/mro.js';
import { populateClassOwnedMembers } from '../../scope-resolution/scope/walkers.js';
import type { ScopeResolver } from '../../scope-resolution/contract/scope-resolver.js';
import { simpleKey } from '../../scope-resolution/graph-bridge/node-lookup.js';
import { vueProvider } from '../vue.js';
import { loadTsconfigPaths } from '../../language-config.js';
import { typescriptArityCompatibility, typescriptMergeBindings } from '../typescript/index.js';
import { makeVueResolveImportTarget } from './import-target.js';
import {
  extractTemplateComponents,
  extractComponentEventBindings,
  extractNativeElementEventHandlers,
  extractScriptEmitCalls,
  extractTemplateAttributeBindings,
} from '../../vue-sfc-extractor.js';

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

  /**
   * Emit template-derived edges after standard scope-resolution passes.
   *
   * Four categories (all scoped to `.vue` files only):
   *
   *   1. **CALLS** (`vue-template-component`)
   *      PascalCase component elements → the imported component's File node.
   *      Source = the parent file (File node).
   *
   *   2. **BINDS_EVENT_HANDLER** (`vue-event: @<eventName>`)
   *      `@event="handler"` on a PascalCase component element.
   *      Source = the handler Function/Method node in the parent file.
   *      Target = the child component's File node.
   *
   *   3. **EMITS_EVENT** (`vue-emit: <eventName>`)
   *      `emit('eventName', …)` call inside the script block.
   *      Source = the file's own File node.
   *      Target = the same File node (self-referential annotation).
   *      These are "hanging" edges: a Cypher query joins them with
   *      BINDS_EVENT_HANDLER edges on the shared component File node to
   *      reveal which handlers receive which component's emitted events.
   *
   *   4. **ACCESSES** (`vue-template-attribute`)
   *      `:prop="varName"` bound-attribute references.
   *      Source = the file's File node. Target = resolved variable node.
   */
  emitPostResolutionEdges(graph, parsedFiles, nodeLookup, indexes, ctx) {
    for (const parsedFile of parsedFiles) {
      if (!parsedFile.filePath.endsWith('.vue')) continue;
      const content = ctx.fileContents.get(parsedFile.filePath);
      if (!content) continue;

      const fileId = generateId('File', parsedFile.filePath);

      // Build localName → resolved targetFile from finalized import edges.
      const importTargetByName = new Map<string, string>();
      for (const [scopeId, edges] of indexes.imports) {
        const scope = indexes.scopeTree.getScope(scopeId);
        if (scope?.filePath !== parsedFile.filePath) continue;
        for (const edge of edges) {
          if (edge.targetFile !== null && edge.localName) {
            importTargetByName.set(edge.localName, edge.targetFile);
          }
        }
      }

      // 1 — Component-reference CALLS
      for (const componentName of extractTemplateComponents(content)) {
        const targetFile = importTargetByName.get(componentName);
        if (!targetFile) continue;
        const targetFileId = generateId('File', targetFile);
        if (!graph.getNode(targetFileId)) continue;
        graph.addRelationship({
          id: generateId('CALLS', `${fileId}:${componentName}->${targetFileId}`),
          sourceId: fileId,
          targetId: targetFileId,
          type: 'CALLS',
          confidence: 0.9,
          reason: 'vue-template-component',
        });
      }

      // 2 — Native-element event-handler CALLS (@click="method" on <button> etc.)
      for (const handlerName of extractNativeElementEventHandlers(content)) {
        const handlerNodeId = nodeLookup.get(simpleKey(parsedFile.filePath, handlerName));
        if (!handlerNodeId) continue;
        graph.addRelationship({
          id: generateId('CALLS', `${fileId}:@native:${handlerName}->${handlerNodeId}`),
          sourceId: fileId,
          targetId: handlerNodeId,
          type: 'CALLS',
          confidence: 0.9,
          reason: 'vue-template-callback',
        });
      }

      // 4 — Component event bindings → BINDS_EVENT_HANDLER
      for (const { componentName, eventName, handlerName } of extractComponentEventBindings(
        content,
      )) {
        const targetFile = importTargetByName.get(componentName);
        if (!targetFile) continue;
        const targetFileId = generateId('File', targetFile);
        if (!graph.getNode(targetFileId)) continue;

        const handlerNodeId = nodeLookup.get(simpleKey(parsedFile.filePath, handlerName));
        if (!handlerNodeId) continue;

        graph.addRelationship({
          id: generateId('BINDS_EVENT_HANDLER', `${handlerNodeId}:@${eventName}->${targetFileId}`),
          sourceId: handlerNodeId,
          targetId: targetFileId,
          type: 'BINDS_EVENT_HANDLER',
          confidence: 0.9,
          reason: `vue-event: @${eventName}`,
        });
      }

      // 5 — emit() calls → EMITS_EVENT (self-referential annotation)
      for (const { eventName } of extractScriptEmitCalls(content, { sourceKind: 'full-sfc' })) {
        graph.addRelationship({
          id: generateId('EMITS_EVENT', `${fileId}:emit:${eventName}`),
          sourceId: fileId,
          targetId: fileId,
          type: 'EMITS_EVENT',
          confidence: 0.9,
          reason: `vue-emit: ${eventName}`,
        });
      }

      // 6 — Bound-attribute ACCESSES (:prop="varName")
      for (const varName of extractTemplateAttributeBindings(content)) {
        const varNodeId = nodeLookup.get(simpleKey(parsedFile.filePath, varName));
        if (!varNodeId) continue;
        graph.addRelationship({
          id: generateId('ACCESSES', `${fileId}:bind:${varName}->${varNodeId}`),
          sourceId: fileId,
          targetId: varNodeId,
          type: 'ACCESSES',
          confidence: 0.8,
          reason: 'vue-template-attribute',
        });
      }
    }
  },
};

export { vueScopeResolver };
