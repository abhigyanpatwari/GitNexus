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
import { SupportedLanguages, getLanguageFromFilename } from 'gitnexus-shared';
import { generateId } from '../../../../lib/utils.js';
import { buildMro, defaultLinearize } from '../../scope-resolution/passes/mro.js';
import { populateClassOwnedMembers } from '../../scope-resolution/scope/walkers.js';
import type { ScopeResolver } from '../../scope-resolution/contract/scope-resolver.js';
import { simpleKey } from '../../scope-resolution/graph-bridge/node-lookup.js';
import { vueProvider } from '../vue.js';
import { loadTsconfigPaths } from '../../language-config.js';
import { typescriptArityCompatibility, typescriptMergeBindings } from '../typescript/index.js';
import { makeVueResolveImportTarget } from './import-target.js';
import { extractVueTemplateEdgeData } from '../../vue-sfc-extractor.js';
import { extractParsedFile } from '../../scope-extractor-bridge.js';

// Languages whose files may be pulled into the Vue scope-resolution pass
// as import-closure context (`.vue` → `.ts` / `.js` cross-file resolution).
const VUE_SCOPE_CONTEXT_LANGUAGES = new Set<SupportedLanguages>([
  SupportedLanguages.Vue,
  SupportedLanguages.TypeScript,
  SupportedLanguages.JavaScript,
]);

function isVueScopeContextLanguage(lang: SupportedLanguages | null): boolean {
  return lang !== null && VUE_SCOPE_CONTEXT_LANGUAGES.has(lang);
}

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
   * Expand the scope-resolution file universe for Vue by performing a
   * transitive closure over imports starting from the primary `.vue` files.
   *
   * Vue SFCs import TypeScript/JavaScript modules (`import { fn } from './api'`),
   * and those modules must be included in the Vue resolution pass for cross-file
   * IMPORTS/CALLS edges to resolve correctly.  Without this expansion, only
   * `.vue` files would be processed and all TS/JS imports would remain
   * unresolved.
   *
   * Keeping this logic here (rather than hard-coding it in `phase.ts`) ensures
   * that shared pipeline code remains language-agnostic.
   */
  collectScopeContextPaths({
    primaryFilePaths,
    preExtractedByPath,
    entryFileContents,
    allScannedPaths,
    resolutionConfig,
  }) {
    const resolveTargets = (targetRaw: string, fromFile: string): readonly string[] => {
      const resolved = vueScopeResolver.resolveImportTarget(
        targetRaw,
        fromFile,
        allScannedPaths,
        resolutionConfig,
      );
      if (resolved === null) return [];
      if (typeof resolved === 'string') return [resolved];
      return resolved;
    };

    const visited = new Set<string>(primaryFilePaths);
    const queue = [...primaryFilePaths];
    const fallbackParsed = new Map<string, ParsedFile>();

    while (queue.length > 0) {
      const current = queue.shift();
      if (current === undefined) break;
      let parsed = preExtractedByPath.get(current) ?? fallbackParsed.get(current) ?? undefined;
      if (parsed === undefined) {
        const source = entryFileContents.get(current);
        if (source !== undefined) {
          parsed = extractParsedFile(vueProvider, source, current);
          if (parsed !== undefined) fallbackParsed.set(current, parsed);
        }
      }
      if (parsed === undefined) continue;

      for (const parsedImport of parsed.parsedImports) {
        if (parsedImport.targetRaw.trim().length === 0) continue;
        for (const targetPath of resolveTargets(parsedImport.targetRaw, current)) {
          if (!allScannedPaths.has(targetPath)) continue;
          if (!isVueScopeContextLanguage(getLanguageFromFilename(targetPath))) continue;
          if (visited.has(targetPath)) continue;
          visited.add(targetPath);
          queue.push(targetPath);
        }
      }
    }

    return visited;
  },

  /**
   * Emit template-derived edges after standard scope-resolution passes.
   *
   * Six edge categories (all scoped to `.vue` files only):
   *
   *   1. **CALLS** (`vue-template-component`)
   *      PascalCase component elements → the imported component's File node.
   *      Source = the parent file (File node).
   *
   *   2. **CALLS** (`vue-template-callback`) — reserved for future use
   *      (see category 3 below).
   *
   *   3. **CALLS** (`vue-template-callback`)
   *      `@event="handler"` on a **native** HTML element (`<button>`, `<input>`).
   *      Source = the parent file (File node). Target = handler Function/Method.
   *
   *   4. **BINDS_EVENT_HANDLER** (`vue-event: @<eventName>`)
   *      `@event="handler"` on a **component** element.
   *      Source = the handler Function/Method node in the parent file.
   *      Target = the child component's File node.
   *
   *   5. **EMITS_EVENT** (`vue-emit: <eventName>`)
   *      `emit('eventName', …)` / `this.$emit('eventName', …)` in script block.
   *      Source = the file's own File node (self-referential annotation).
   *      Target = the same File node.
   *      These "hanging" edges join with BINDS_EVENT_HANDLER via Cypher query
   *      on the shared component File node to reveal handler/emitter pairs.
   *
   *   6. **ACCESSES** (`vue-template-attribute`)
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

      // Extract all template/script edge data in a single pass — avoids
      // re-running TEMPLATE_RE for each individual extractor call.
      const {
        templateComponents,
        nativeEventHandlers,
        componentEventBindings,
        scriptEmitCalls,
        templateAttributeBindings,
      } = extractVueTemplateEdgeData(content, { sourceKind: 'full-sfc' });

      // 1 — Component-reference CALLS
      for (const componentName of templateComponents) {
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

      // 3 — Native-element event-handler CALLS (@click="method" on <button> etc.)
      for (const handlerName of nativeEventHandlers) {
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

      // 4 — BINDS_EVENT_HANDLER: component event bindings (@event="handler" on component elements)
      for (const { componentName, eventName, handlerName } of componentEventBindings) {
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

      // 5 — EMITS_EVENT: emit() / this.$emit() calls (self-referential annotation)
      for (const { eventName } of scriptEmitCalls) {
        graph.addRelationship({
          id: generateId('EMITS_EVENT', `${fileId}:emit:${eventName}`),
          sourceId: fileId,
          targetId: fileId,
          type: 'EMITS_EVENT',
          confidence: 0.9,
          reason: `vue-emit: ${eventName}`,
        });
      }

      // 6 — ACCESSES: bound-attribute references (:prop="varName")
      for (const varName of templateAttributeBindings) {
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
