/**
 * Dart `ScopeResolver` registered in `SCOPE_RESOLVERS` and consumed by the
 * generic `runScopeResolution` orchestrator (RFC #909 Ring 3, issue #939).
 *
 * Closest reference: Swift (`swiftScopeResolver`) — both are statically typed,
 * have no `new` keyword, and model `Type(...)` as a reference to the type.
 *
 * ## Dart specifics
 *
 *   - **`implements` / `with`.** Dart can implement (and mixes in) ordinary
 *     classes, so the edge type cannot be decided from the target's symbol
 *     kind (the generic `preEmitInheritanceEdges` pre-pass routes
 *     `Interface`/`Trait` → IMPLEMENTS, everything else → EXTENDS). `extends`
 *     is captured as `@reference.inherits` and rides the generic pre-pass
 *     (target is a class → EXTENDS); `implements`/`with` are carried as
 *     `__heritage__:` side-effect imports and emitted here as IMPLEMENTS by
 *     `emitDartHeritageEdges`. METHOD_IMPLEMENTS then falls out of the shared
 *     MRO/interface-dispatch phase.
 *   - **Mixin MRO.** `buildDartMro` augments the EXTENDS chain with mixin /
 *     interface ancestors (IMPLEMENTS edges) so mixed-in members participate
 *     in method lookup (PHP/Ruby trait pattern).
 *   - **No `new`.** `Type(...)` resolves to the Class node
 *     (`constructorCallTargetsClass`); the cross-file global free-call
 *     fallback is allowed (`allowGlobalFreeCallFallback`).
 *   - **Statically typed** → `fieldFallbackOnMethodLookup: false` (the
 *     field-walk heuristic over-connects when types are reliable).
 */

import type { ParsedFile } from 'gitnexus-shared';
import { SupportedLanguages } from 'gitnexus-shared';
import { buildMro, defaultLinearize } from '../../scope-resolution/passes/mro.js';
import { populateClassOwnedMembers, isClassLike } from '../../scope-resolution/scope/walkers.js';
import { resolveDefGraphId } from '../../scope-resolution/graph-bridge/ids.js';
import type { GraphNodeLookup } from '../../scope-resolution/graph-bridge/node-lookup.js';
import type { KnowledgeGraph } from '../../../graph/types.js';
import type { ScopeResolver } from '../../scope-resolution/contract/scope-resolver.js';
import { generateId } from '../../../../lib/utils.js';
import { dartProvider } from '../dart.js';
import { dartArityCompatibility, dartMergeBindings, resolveDartImportTarget } from './index.js';
import { decodeMarker } from '../../utils/heritage-marker.js';
import { expandDartWildcardNames } from './expand-wildcards.js';

interface ClassDefRef {
  readonly graphId: string;
  readonly filePath: string;
}

/**
 * Resolve a class simple name to a graph id with FILE AFFINITY: prefer a
 * definition in `preferredFile`, then a workspace-unique match, otherwise
 * refuse to guess (return undefined). This avoids the cross-file simple-name
 * collision a global last-write-wins map produces — two files each declaring
 * `Logger` where one `implements Logger` must bind its OWN file's `Logger`.
 */
function pickClassByName(
  name: string,
  preferredFile: string,
  defsByName: ReadonlyMap<string, readonly ClassDefRef[]>,
): string | undefined {
  const cands = defsByName.get(name);
  if (cands === undefined || cands.length === 0) return undefined;
  const sameFile = cands.find((c) => c.filePath === preferredFile);
  if (sameFile !== undefined) return sameFile.graphId;
  if (cands.length === 1) return cands[0]!.graphId;
  return undefined; // ambiguous across files, none same-file — don't emit a wrong edge
}

/**
 * Emit IMPLEMENTS edges for Dart `implements`/`with` clauses, carried from
 * `captures.ts` as `__heritage__:<kind>:<base>:<child>` side-effect imports.
 * The marker lives in the implementing class's `ParsedFile`, so both the child
 * and base names are resolved with same-file affinity (see `pickClassByName`),
 * which keeps cross-file same-name classes from collapsing (mirror of Ruby's
 * `emitRubyMixinEdges`, with the #1951-style file-affinity hardening).
 */
function emitDartHeritageEdges(
  graph: KnowledgeGraph,
  parsedFiles: readonly ParsedFile[],
  nodeLookup: GraphNodeLookup,
): void {
  const defsByName = new Map<string, ClassDefRef[]>();
  for (const parsed of parsedFiles) {
    for (const def of parsed.localDefs) {
      if (!isClassLike(def.type)) continue;
      const graphId = resolveDefGraphId(parsed.filePath, def, nodeLookup);
      if (graphId === undefined) continue;
      const simpleName = def.qualifiedName?.split('.').pop() ?? def.qualifiedName ?? '';
      if (simpleName === '') continue;
      let list = defsByName.get(simpleName);
      if (list === undefined) {
        list = [];
        defsByName.set(simpleName, list);
      }
      list.push({ graphId, filePath: parsed.filePath });
    }
  }

  // Pre-seed with existing IMPLEMENTS edges (reason-qualified) so a class that
  // both `implements X` and `with X` keeps both distinct edges.
  const emitted = new Set<string>();
  for (const rel of graph.iterRelationshipsByType('IMPLEMENTS')) {
    emitted.add(`${rel.sourceId}->${rel.targetId}:${rel.reason}`);
  }

  for (const parsed of parsedFiles) {
    for (const imp of parsed.parsedImports) {
      const raw = imp.targetRaw;
      if (typeof raw !== 'string') continue;
      const decoded = decodeMarker(raw);
      if (decoded?.kind !== 'heritage') continue;
      const parts = decoded.fields;
      if (parts.length < 3) continue;
      const [kind, baseName, childName] = parts;
      const childId = pickClassByName(childName!, parsed.filePath, defsByName);
      const baseId = pickClassByName(baseName!, parsed.filePath, defsByName);
      if (childId === undefined || baseId === undefined || childId === baseId) continue;
      const key = `${childId}->${baseId}:${kind}`;
      if (emitted.has(key)) continue;
      emitted.add(key);
      graph.addRelationship({
        id: generateId('IMPLEMENTS', key),
        sourceId: childId,
        targetId: baseId,
        type: 'IMPLEMENTS',
        confidence: 0.9,
        reason: kind!,
      });
    }
  }
}

/**
 * Dart MRO: the EXTENDS superclass chain (`defaultLinearize`) augmented with
 * mixin / interface ancestors discovered via IMPLEMENTS edges, so mixed-in and
 * interface-default members participate in method lookup. Mixins are appended
 * after the superclass chain (first-seen approximates Dart linearization for
 * dispatch purposes).
 */
function buildDartMro(
  graph: KnowledgeGraph,
  parsedFiles: readonly ParsedFile[],
  nodeLookup: GraphNodeLookup,
): Map<string, string[]> {
  const mro = buildMro(graph, parsedFiles, nodeLookup, defaultLinearize);

  const defIdByGraphId = new Map<string, string>();
  for (const parsed of parsedFiles) {
    for (const def of parsed.localDefs) {
      if (!isClassLike(def.type)) continue;
      const graphId = resolveDefGraphId(parsed.filePath, def, nodeLookup);
      if (graphId !== undefined) defIdByGraphId.set(graphId, def.nodeId);
    }
  }

  const implsByChild = new Map<string, Set<string>>();
  for (const rel of graph.iterRelationshipsByType('IMPLEMENTS')) {
    const child = defIdByGraphId.get(rel.sourceId);
    const base = defIdByGraphId.get(rel.targetId);
    if (child === undefined || base === undefined) continue;
    let set = implsByChild.get(child);
    if (set === undefined) {
      set = new Set();
      implsByChild.set(child, set);
    }
    set.add(base);
  }

  for (const [childDefId, impls] of implsByChild) {
    const extendsChain = mro.get(childDefId) ?? [];
    const seen = new Set(extendsChain);
    const merged = [...extendsChain];
    for (const base of impls) {
      if (!seen.has(base)) {
        seen.add(base);
        merged.push(base);
      }
    }
    mro.set(childDefId, merged);
  }

  return mro;
}

export const dartScopeResolver: ScopeResolver = {
  language: SupportedLanguages.Dart,
  languageProvider: dartProvider,
  importEdgeReason: 'dart-scope: import',

  resolveImportTarget: (targetRaw, fromFile, allFilePaths) =>
    resolveDartImportTarget(targetRaw, fromFile, allFilePaths),

  // Dart `import` is whole-library: every public top-level symbol of the
  // target enters scope. Enumerating them lets `propagateImportedReturnTypes`
  // mirror imported functions' return types into the importer.
  expandsWildcardTo: (targetModuleScope, parsedFiles) =>
    expandDartWildcardNames(targetModuleScope, parsedFiles),

  // Dart shadowing: local declarations hide imports.
  mergeBindings: (existing, incoming) => [...dartMergeBindings([...existing, ...incoming])],

  // Adapter: dartArityCompatibility uses (def, callsite); contract is (callsite, def).
  arityCompatibility: (callsite, def) => dartArityCompatibility(def, callsite),

  buildMro: (graph, parsedFiles, nodeLookup) => buildDartMro(graph, parsedFiles, nodeLookup),

  // Methods/fields are owned by their enclosing class/mixin/extension.
  populateOwners: (parsed: ParsedFile) => populateClassOwnedMembers(parsed),

  // `super.method()` dispatches through the superclass + mixin chain.
  isSuperReceiver: (text) => text.trim() === 'super',

  // `implements` / `with` IMPLEMENTS edges (extends rides the generic
  // inherits pre-pass; these need an explicit, kind-independent edge type).
  emitHeritageEdges: (graph, parsedFiles, nodeLookup) =>
    emitDartHeritageEdges(graph, parsedFiles, nodeLookup),

  // Dart is statically typed — the field-fallback heuristic over-connects.
  fieldFallbackOnMethodLookup: false,
  propagatesReturnTypesAcrossImports: true,

  // No `new`: bare `Foo()` resolves to the type; with cross-file imports the
  // callee is reachable workspace-wide.
  allowGlobalFreeCallFallback: true,
  constructorCallTargetsClass: true,
};
