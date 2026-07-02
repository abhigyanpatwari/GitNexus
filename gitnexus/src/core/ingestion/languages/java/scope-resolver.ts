/**
 * Java `ScopeResolver` registered in `SCOPE_RESOLVERS` and consumed by
 * the generic `runScopeResolution` orchestrator (RFC #909 Ring 3).
 *
 * Java resolves via the scope-resolution registry — the sole
 * call-resolution path.
 */

import type { ParsedFile, TypeRef } from 'gitnexus-shared';
import { SupportedLanguages } from 'gitnexus-shared';
import type { KnowledgeGraph } from '../../../graph/types.js';
import { buildMro, defaultLinearize } from '../../scope-resolution/passes/mro.js';
import { resolveDefGraphId } from '../../scope-resolution/graph-bridge/ids.js';
import type { GraphNodeLookup } from '../../scope-resolution/graph-bridge/node-lookup.js';
import {
  isClassLike,
  lookupBindingsAt,
  namesAtScope,
  populateClassOwnedMembers,
} from '../../scope-resolution/scope/walkers.js';
import type { ScopeResolver } from '../../scope-resolution/contract/scope-resolver.js';
import type { ScopeResolutionIndexes } from '../../model/scope-resolution-indexes.js';
import { followChainPostFinalize } from '../../scope-resolution/passes/imported-return-types.js';
import { javaProvider } from '../java.js';
import {
  javaArityCompatibility,
  javaMergeBindings,
  resolveJavaImportTarget,
  type JavaResolveContext,
} from './index.js';
import { populateJavaPackageSiblings } from './package-siblings.js';

const javaScopeResolver: ScopeResolver = {
  language: SupportedLanguages.Java,
  languageProvider: javaProvider,
  importEdgeReason: 'java-scope: import',

  resolveImportTarget: (targetRaw, fromFile, allFilePaths) => {
    const ws: JavaResolveContext = { fromFile, allFilePaths };
    return resolveJavaImportTarget(
      { kind: 'named', localName: '_', importedName: '_', targetRaw },
      ws,
    );
  },

  mergeBindings: (existing, incoming) => [...javaMergeBindings([...existing, ...incoming])],

  arityCompatibility: (callsite, def) => javaArityCompatibility(def, callsite),

  buildMro: buildJavaMro,

  populateOwners: (parsed: ParsedFile) => populateClassOwnedMembers(parsed),

  isSuperReceiver: (text) => text.trim() === 'super',

  fieldFallbackOnMethodLookup: false,
  propagatesReturnTypesAcrossImports: true,
  collapseMemberCallsByCallerTarget: true,
  hoistTypeBindingsToModule: true,
  stripReceiverCastExpressions: true,

  populateNamespaceSiblings: populateJavaPackageSiblings,
  populateRangeBindings: populateJavaCrossFileReturnTypes,
};

export { javaScopeResolver };

function populateJavaCrossFileReturnTypes(
  parsedFiles: readonly ParsedFile[],
  indexes: ScopeResolutionIndexes,
): void {
  const moduleScopeByFile = new Map<string, ParsedFile['scopes'][number]>();
  const classScopesByFile = new Map<string, ParsedFile['scopes'][number][]>();
  for (const parsed of parsedFiles) {
    const ms = parsed.scopes.find((s) => s.kind === 'Module');
    if (ms !== undefined) moduleScopeByFile.set(parsed.filePath, ms);
    const cs = parsed.scopes.filter((s) => s.kind === 'Class');
    if (cs.length > 0) classScopesByFile.set(parsed.filePath, cs);
  }

  for (const parsed of parsedFiles) {
    const importerModule = moduleScopeByFile.get(parsed.filePath);
    if (importerModule === undefined) continue;

    const ambiguousMirrors = new Set<string>();
    for (const name of namesAtScope(importerModule.id, indexes)) {
      const refs = lookupBindingsAt(importerModule.id, name, indexes);
      for (const ref of refs) {
        if (ref.origin !== 'import' && ref.origin !== 'reexport') continue;
        if (!isClassLike(ref.def.type)) continue;

        const sourceModule = moduleScopeByFile.get(ref.def.filePath);
        if (sourceModule === undefined) continue;

        const tb = importerModule.typeBindings as Map<string, TypeRef>;
        for (const [srcName, srcRef] of sourceModule.typeBindings) {
          if (srcRef.source !== 'return-annotation') continue;
          if (ambiguousMirrors.has(srcName)) continue;
          const existing = tb.get(srcName);
          if (existing !== undefined && existing.rawName !== srcRef.rawName) {
            ambiguousMirrors.add(srcName);
            tb.delete(srcName);
            continue;
          }
          if (existing === undefined) tb.set(srcName, srcRef);
        }

        for (const classScope of classScopesByFile.get(ref.def.filePath) ?? []) {
          for (const [srcName, srcRef] of classScope.typeBindings) {
            if (srcRef.source === 'self' || srcRef.source === 'parameter-annotation') continue;
            if (ambiguousMirrors.has(srcName)) continue;
            const existing = tb.get(srcName);
            if (existing !== undefined && existing.rawName !== srcRef.rawName) {
              ambiguousMirrors.add(srcName);
              tb.delete(srcName);
              continue;
            }
            if (existing === undefined) tb.set(srcName, srcRef);
          }
        }
      }
    }

    for (const [name, ref] of importerModule.typeBindings) {
      const resolved = followChainPostFinalize(ref, importerModule.id, indexes);
      if (resolved !== ref) {
        (importerModule.typeBindings as Map<string, TypeRef>).set(name, resolved);
      }
    }
  }

  for (const parsed of parsedFiles) {
    const moduleScopeId = moduleScopeByFile.get(parsed.filePath)?.id;
    for (const scope of parsed.scopes) {
      if (scope.id === moduleScopeId) continue;
      for (const [name, ref] of scope.typeBindings) {
        const resolved = followChainPostFinalize(ref, scope.id, indexes);
        if (resolved !== ref) {
          (scope.typeBindings as Map<string, TypeRef>).set(name, resolved);
        }
      }
    }
  }
}

function buildJavaMro(
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

  const directImpls = new Map<string, string[]>();
  for (const rel of graph.iterRelationshipsByType('IMPLEMENTS')) {
    const source = defIdByGraphId.get(rel.sourceId);
    const target = defIdByGraphId.get(rel.targetId);
    if (source === undefined || target === undefined) continue;
    let list = directImpls.get(source);
    if (list === undefined) {
      list = [];
      directImpls.set(source, list);
    }
    if (!list.includes(target)) list.push(target);
  }

  for (const [classDefId, extendsMro] of mro) {
    const ancestorChain = [classDefId, ...extendsMro];
    const seeds: string[] = [];
    for (const ancestorId of ancestorChain) {
      for (const ifaceId of directImpls.get(ancestorId) ?? []) {
        seeds.push(ifaceId);
      }
    }
    if (seeds.length === 0) continue;
    const interfaces = closeInterfaces(seeds, directImpls);
    mro.set(classDefId, [...extendsMro, ...interfaces.filter((i) => !extendsMro.includes(i))]);
  }

  for (const [classDefId, ifaces] of directImpls) {
    if (mro.has(classDefId)) continue;
    mro.set(classDefId, closeInterfaces([...ifaces], directImpls));
  }

  return mro;
}

function closeInterfaces(
  seeds: readonly string[],
  directImpls: ReadonlyMap<string, readonly string[]>,
): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const queue: string[] = [...seeds];
  let head = 0;
  while (head < queue.length) {
    const cur = queue[head++]!;
    if (seen.has(cur)) continue;
    seen.add(cur);
    out.push(cur);
    for (const next of directImpls.get(cur) ?? []) {
      if (!seen.has(next)) queue.push(next);
    }
  }
  return out;
}
