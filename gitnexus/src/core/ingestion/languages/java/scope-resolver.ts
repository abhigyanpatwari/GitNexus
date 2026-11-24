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
  lookupNameClaim,
  namesAtScope,
  populateClassOwnedMembers,
} from '../../scope-resolution/scope/walkers.js';
import type { ScopeResolver } from '../../scope-resolution/contract/scope-resolver.js';
import type { ScopeResolutionIndexes } from '../../model/scope-resolution-indexes.js';
import { createChainFollower } from '../../scope-resolution/passes/imported-return-types.js';
import { javaProvider } from '../java.js';
import {
  javaArityCompatibility,
  javaMergeBindings,
  resolveJavaImportTarget,
  type JavaResolveContext,
} from './index.js';
import { javaOnDemandImportTargets } from './on-demand-imports.js';
import {
  indexJavaEnclosingLocalAliases,
  JAVA_ENCLOSING_LOCAL_ROUTE,
  javaAliasReadsInheritedField,
  javaEnclosingLocalAliasType,
} from './factory-alias-captures.js';
import { javaArrayElementType } from './type-spelling.js';
import {
  javaQualifiedTypeLookupSpelling,
  populateJavaQualifiedTypeBindings,
} from './qualified-type-bindings.js';
import {
  javaCallResultElementType,
  validateJavaQualifiedContextualBindings,
} from './qualified-contextual-bindings.js';
import {
  reconcileJavaWorkspaceReferences,
  emitJavaLombokWorkspaceCorrections,
} from './lombok-workspace-proof.js';
import { populateJavaPackageSiblings, resolveJavaSamePackageBase } from './package-siblings.js';
import {
  indexJavaSamLambdaTargets,
  javaCallResultAssignmentApplies,
  javaSamLambdaParameterType,
  selectJavaLambdaOverload,
} from './sam-lambda-types.js';
import { attachSpringBeanCandidateMetadata } from './spring-bean-metadata.js';
import { attachJavaSpringAopMetadata } from './spring-aop.js';
import { attachJavaSpringConfigBindings } from './spring-config-bindings.js';
import { attachJavaSpringConditionalMetadata } from './spring-conditionals.js';
import { attachJavaSpringDiMetadata } from './spring-di.js';
import { attachJavaSpringNonHttpHandlerMetadata } from './spring-non-http-handlers.js';
import { attachJavaSpringDynamicLookup } from './spring-dynamic-lookup.js';
import {
  applyJavaCaptureSideChannel,
  clearJavaClassAnnotationFacts,
} from './capture-side-channel.js';
import { clearJavaPackageFacts } from './package-facts.js';
import {
  resolveJavaReceiverMember,
  resolveJavaSelectedMethodImplementation,
  resolveJavaUnqualifiedCall,
  resolveJavaReceiverCallSite,
} from './overload-resolution.js';

const javaScopeResolver: ScopeResolver = {
  language: SupportedLanguages.Java,
  languageProvider: javaProvider,
  importEdgeReason: 'java-scope: import',
  onDemandImportTargets: javaOnDemandImportTargets,
  // `import pkg.*;` binds no name here and `resolveJavaModule` answers every
  // importer of a package with the same list, so the package is stored once.
  groupsWildcardImportTargets: true,

  loadResolutionConfig: () => {
    // Worker capture facts are process-local and outlive a single analysis in
    // server mode. This hook runs once before each Java workspace pass, before
    // ParsedFile side channels are restored for the current files.
    clearJavaClassAnnotationFacts();
    clearJavaPackageFacts();
    return undefined;
  },

  resolveImportTarget: (targetRaw, fromFile, allFilePaths, _resolutionConfig, context) => {
    // `context.parsedFiles` is the whole input now: a Java import names a type
    // in a DECLARED package, and the declarations live on those files (#2953).
    const ws: JavaResolveContext = { fromFile, allFilePaths, parsedFiles: context?.parsedFiles };
    return resolveJavaImportTarget(
      { kind: 'named', localName: '_', importedName: '_', targetRaw },
      ws,
    );
  },

  mergeBindings: (existing, incoming) => [...javaMergeBindings([...existing, ...incoming])],
  // One merge of the whole ordered bucket equals folding it group by group:
  // a folded prefix keeps only its best tier, which the next merge would keep
  // or drop the same way, and de-dup keeps first position with last value.
  // Without it, every same-name append re-merges the growing prefix (N² for N
  // same-named member types, methods or fields bound at module scope).
  mergeBindingsAreAssociative: true,

  arityCompatibility: (callsite, def) => javaArityCompatibility(def, callsite),

  buildMro: buildJavaMro,

  populateOwners: (parsed: ParsedFile) => populateClassOwnedMembers(parsed),
  populateWorkspaceReferences: reconcileJavaWorkspaceReferences,
  emitHeritageEdges: emitJavaLombokWorkspaceCorrections,
  applyCaptureSideChannel: applyJavaCaptureSideChannel,
  // A call whose every argument is an implicitly typed lambda is decided by
  // potential applicability where the general selector has no evidence.
  resolveReceiverMember: (owner, member, site, scopes, model) =>
    selectJavaLambdaOverload(
      resolveJavaReceiverMember(owner, member, site, scopes, model),
      site,
      scopes,
    ),
  resolveUnqualifiedCall: (site, scopes, model) =>
    selectJavaLambdaOverload(resolveJavaUnqualifiedCall(site, scopes, model), site, scopes),
  resolveSelectedMethodImplementation: resolveJavaSelectedMethodImplementation,
  receiverMemberLookupCoversAllCalls: true,
  // A producer indexed by trailing subscripts (`make()[0].save()`) is typed
  // from its selected overload, one element per index step through
  // `elementTypeOf`; resolveJavaReceiverMember re-validates that selection.
  receiverCallSite: resolveJavaReceiverCallSite,
  elementTypeOf: javaArrayElementType,
  // `for (var x : xs)` over a selected method's result: only the element of
  // that method's own proven JDK container return type. An implicitly typed
  // lambda argument's parameter: the selected method's workspace functional
  // interface parameter type (`sam-lambda-types.ts`). A copy of an enclosing
  // method's local inside a local or anonymous class: the producer's own type,
  // once no supertype of that class can declare a field of the copied name.
  callResultElementType: (callee, returned, route, scopes) =>
    route.startsWith('lambda:')
      ? javaSamLambdaParameterType(callee, returned, route, scopes)
      : route.startsWith(JAVA_ENCLOSING_LOCAL_ROUTE)
        ? javaEnclosingLocalAliasType(returned, route, scopes)
        : javaCallResultElementType(callee, returned, route, scopes),
  // A lambda that capture typed through a JDK container reading of its
  // receiver falls back to that route only where the reading was refuted.
  callResultAssignmentApplies: (site, scopes) =>
    !javaAliasReadsInheritedField(site.element, scopes) &&
    javaCallResultAssignmentApplies(site, scopes),
  qualifiedTypeLookupSpelling: javaQualifiedTypeLookupSpelling,
  hoistedTypeBindingsRequireOwner: true,

  isSuperReceiver: (text) => text.trim() === 'super',

  fieldFallbackOnMethodLookup: false,
  propagatesReturnTypesAcrossImports: true,
  collapseMemberCallsByCallerTarget: true,
  hoistTypeBindingsToModule: true,
  stripReceiverCastExpressions: true,
  // #2550: every Java method belongs to a class instance — a free call may
  // resolve to a Method only when the caller's enclosing class chain
  // (self + MRO) contains the method's owner. Closes the finalize-bucket
  // leak (unqualified `run()` matching an unrelated same-file anonymous
  // class's method). C# is the intended next adopter.
  freeCallsRequireInstanceOwnership: true,

  populateNamespaceSiblings: (parsedFiles, indexes, ctx) => {
    populateJavaPackageSiblings(parsedFiles, indexes, ctx);
    populateJavaQualifiedTypeBindings(parsedFiles, indexes);
    validateJavaQualifiedContextualBindings(parsedFiles, indexes);
    indexJavaSamLambdaTargets(parsedFiles, indexes);
    indexJavaEnclosingLocalAliases(parsedFiles, indexes);
  },
  resolveImplicitInheritanceBase: resolveJavaSamePackageBase,
  populateRangeBindings: populateJavaCrossFileReturnTypes,
  emitPostResolutionEdges: (graph, parsedFiles, nodeLookup, indexes, ctx) => {
    attachSpringBeanCandidateMetadata(graph, parsedFiles, nodeLookup, indexes);
    attachJavaSpringAopMetadata(graph, parsedFiles, nodeLookup, indexes);
    attachJavaSpringConditionalMetadata(graph, parsedFiles, nodeLookup, indexes);
    attachJavaSpringDiMetadata(graph, parsedFiles, nodeLookup, indexes);
    attachJavaSpringNonHttpHandlerMetadata(graph, parsedFiles, nodeLookup, indexes);
    attachJavaSpringConfigBindings(graph, parsedFiles, nodeLookup, indexes, ctx);
    attachJavaSpringDynamicLookup(graph, parsedFiles, nodeLookup, indexes);
  },
};

export { javaScopeResolver };

function populateJavaCrossFileReturnTypes(
  parsedFiles: readonly ParsedFile[],
  indexes: ScopeResolutionIndexes,
): void {
  const moduleScopeByFile = new Map<string, ParsedFile['scopes'][number]>();
  const moduleReturnTypesByFile = new Map<string, Map<string, TypeRef>>();
  const returnNames = new Set<string>();
  const importedFamiliesByFile = new Map<string, string[][]>();
  const ambiguousByFile = new Map<string, Set<string>>();
  const returnTypeIds = new Map<TypeRef, string | undefined>();
  const returnTypeId = (ref: TypeRef): string | undefined => {
    if (!returnTypeIds.has(ref)) {
      const ids = new Set(
        lookupNameClaim(ref.declaredAtScope, ref.rawName, indexes, { purpose: 'type' })
          .bindings.filter((binding) => isClassLike(binding.def.type))
          .map((binding) => binding.def.nodeId),
      );
      returnTypeIds.set(ref, ids.size === 1 ? ids.values().next().value : undefined);
    }
    return returnTypeIds.get(ref);
  };
  const classScopesByFile = new Map<string, ParsedFile['scopes'][number][]>();
  for (const parsed of parsedFiles) {
    const ms = parsed.scopes.find((s) => s.kind === 'Module');
    if (ms !== undefined) {
      moduleScopeByFile.set(parsed.filePath, ms);
      // Keep producer facts once. Missing transitive facts are looked up on
      // demand below instead of copying every dependency's table (#3695).
      const returns = new Map(
        [...ms.typeBindings].filter(([, ref]) => ref.source === 'return-annotation'),
      );
      moduleReturnTypesByFile.set(parsed.filePath, returns);
      for (const name of returns.keys()) returnNames.add(name);
    }
    const cs = parsed.scopes.filter((s) => s.kind === 'Class');
    if (cs.length > 0) classScopesByFile.set(parsed.filePath, cs);
  }

  for (const parsed of parsedFiles) {
    const importerModule = moduleScopeByFile.get(parsed.filePath);
    if (importerModule === undefined) continue;

    const ambiguousMirrors = new Set<string>();
    ambiguousByFile.set(parsed.filePath, ambiguousMirrors);
    const importedFamilies: { readonly files: string[]; readonly key: string }[] = [];
    // Mirroring a family or a file's class scopes a second time changes
    // nothing (a name is only set when absent, and ambiguity is permanent), so
    // N imports of one file mirror it once instead of N times.
    const mirroredFamilies = new Set<string>();
    const mirroredClassFiles = new Set<string>();
    for (const name of namesAtScope(importerModule.id, indexes)) {
      const refs = lookupBindingsAt(importerModule.id, name, indexes);
      for (const ref of refs) {
        if (ref.origin !== 'import' && ref.origin !== 'reexport') continue;
        if (!isClassLike(ref.def.type)) continue;

        const sourceModule = moduleScopeByFile.get(ref.def.filePath);
        if (sourceModule === undefined) continue;

        const tb = importerModule.typeBindings as Map<string, TypeRef>;
        const sourceFiles = new Set([ref.def.filePath]);
        for (const ancestorId of indexes.methodDispatch.mroFor(ref.def.nodeId)) {
          const ancestor = indexes.defs.get(ancestorId);
          if (ancestor !== undefined) sourceFiles.add(ancestor.filePath);
        }
        const family = [...sourceFiles];
        const familyKey = family.join('\0');
        importedFamilies.push({ files: family, key: familyKey });
        if (!mirroredFamilies.has(familyKey)) {
          mirroredFamilies.add(familyKey);
          const familyNames = new Set<string>();
          for (const sourceFile of sourceFiles) {
            for (const [srcName, srcRef] of moduleReturnTypesByFile.get(sourceFile) ?? []) {
              if (familyNames.has(srcName)) continue;
              familyNames.add(srcName);
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

        if (!mirroredClassFiles.has(ref.def.filePath)) {
          mirroredClassFiles.add(ref.def.filePath);
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
    }
    // The walk below pops from the end, so keeping each family's LAST copy
    // keeps its visiting order; a repeated family is a no-op when popped again.
    const seenFamilies = new Set<string>();
    const distinctFamilies: string[][] = [];
    for (let i = importedFamilies.length - 1; i >= 0; i--) {
      const { files, key } = importedFamilies[i]!;
      if (seenFamilies.has(key)) continue;
      seenFamilies.add(key);
      distinctFamilies.push(files);
    }
    importedFamiliesByFile.set(parsed.filePath, distinctFamilies.reverse());
  }

  // Every sibling module holds the package's return facts: follow each once.
  const follower = createChainFollower(indexes);
  for (const parsed of parsedFiles) {
    const importerModule = moduleScopeByFile.get(parsed.filePath);
    if (importerModule === undefined) continue;
    const tb = importerModule.typeBindings as Map<string, TypeRef>;
    const needed = new Set(parsed.referenceSites.map((site) => site.name));
    for (const scope of parsed.scopes) {
      for (const ref of scope.typeBindings.values()) needed.add(ref.rawName);
    }

    for (const name of needed) {
      if (tb.has(name) || !returnNames.has(name) || ambiguousByFile.get(parsed.filePath)?.has(name))
        continue;
      const pending = [...(importedFamiliesByFile.get(parsed.filePath) ?? [])];
      const visited = new Set([parsed.filePath]);
      let candidate: TypeRef | undefined;
      let ambiguous = false;
      while (pending.length > 0) {
        const family = pending.pop();
        if (family === undefined) break;
        let found: TypeRef | undefined;
        // The first declaration in the MRO owns an overridden method.
        for (const file of family) {
          found = moduleReturnTypesByFile.get(file)?.get(name);
          if (found !== undefined) break;
        }
        if (found !== undefined) {
          if (candidate !== undefined) {
            // A simple name can denote different classes in different packages.
            // Preserve shared return types only when their producer scopes agree.
            const sameType =
              candidate.rawName === found.rawName &&
              (candidate.declaredAtScope === found.declaredAtScope ||
                (returnTypeId(candidate) !== undefined &&
                  returnTypeId(candidate) === returnTypeId(found)));
            if (!sameType) {
              ambiguous = true;
              break;
            }
          }
          candidate ??= found;
          continue;
        }
        for (const file of family) {
          if (visited.has(file)) continue;
          visited.add(file);
          for (const dependency of importedFamiliesByFile.get(file) ?? []) pending.push(dependency);
        }
      }
      if (!ambiguous && candidate !== undefined) {
        tb.set(name, candidate);
        follower.clear();
      }
    }

    for (const [name, ref] of importerModule.typeBindings) {
      const resolved = follower.follow(ref, importerModule.id);
      if (resolved !== ref) {
        (importerModule.typeBindings as Map<string, TypeRef>).set(name, resolved);
        follower.clear();
      }
    }
  }

  for (const parsed of parsedFiles) {
    const moduleScopeId = moduleScopeByFile.get(parsed.filePath)?.id;
    for (const scope of parsed.scopes) {
      if (scope.id === moduleScopeId) continue;
      for (const [name, ref] of scope.typeBindings) {
        const resolved = follower.follow(ref, scope.id);
        if (resolved !== ref) {
          (scope.typeBindings as Map<string, TypeRef>).set(name, resolved);
          follower.clear();
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
