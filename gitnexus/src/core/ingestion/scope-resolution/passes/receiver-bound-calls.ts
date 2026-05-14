/**
 * Receiver-bound CALLS / ACCESSES emit pass — generic 7-case
 * dispatcher consuming `ScopeResolver` for the language-specific bits
 * (super recognizer, field-fallback toggle).
 *
 * **Contract Invariant I4 — case order is load-bearing.** The cases
 * are evaluated in this order; the FIRST that emits an edge wins:
 *
 *   1. **super branch** — `provider.isSuperReceiver(receiverName)` →
 *      MRO walk skipping self
 *   2. **Case 0 (compound)** — receiver has `.` or `(` → compound resolver
 *   3. **Case 1 (namespace)** — receiver in `namespaceTargets` → exported def
 *   4. **Case 2 (class-name / static receiver)** — receiver resolves to a
 *      class-like binding (Class/Interface/Struct/Record/Enum/Trait) → MRO
 *      walk on that class. Also handles static-style invocations
 *      (`ILogger.Warn(...)`) with kind-aware reason/confidence for
 *      read/write ACCESSES.
 *   5. **Case 3 (dotted typeBinding for namespace prefix)** —
 *      `typeRef.rawName` like `models.User`
 *   6. **Case 3b (chain-typebinding)** — `typeRef.rawName` has a dot
 *      but not a namespace prefix → compound resolver
 *   7. **Case 4 (simple typeBinding)** — `typeRef.rawName` has no dot →
 *      MRO walk + `findOwnedMember`
 *
 * Reordering or merging cases changes resolution semantics.
 *
 * **Contract Invariant I5 — pre-seeding `seen` is forbidden.** The
 * orchestrator runs this pass FIRST (before `emitReferencesViaLookup`)
 * and consumes the populated `handledSites` set. Pre-seeding `seen`
 * from the shared resolver's emissions (an old optimization) actively
 * suppresses correct emissions for sites the shared resolver also
 * resolved to a wrong target.
 */

import type { ParsedFile, SymbolDefinition } from 'gitnexus-shared';
import type { KnowledgeGraph } from '../../../graph/types.js';
import type { ScopeResolutionIndexes } from '../../model/scope-resolution-indexes.js';
import type { SemanticModel } from '../../model/semantic-model.js';
import type { ScopeResolver } from '../contract/scope-resolver.js';
import type { GraphNodeLookup } from '../graph-bridge/node-lookup.js';
import type { WorkspaceResolutionIndex } from '../workspace-index.js';
import { collectNamespaceTargets } from '../scope/namespace-targets.js';
import {
  findClassBindingInScope,
  findEnclosingClassDef,
  findExportedDef,
  findOwnedMember,
  findReceiverTypeBinding,
  isClassLike,
} from '../scope/walkers.js';
import { tryEmitEdge } from '../graph-bridge/edges.js';
import { resolveCompoundReceiverClass } from '../passes/compound-receiver.js';
import { resolveDefGraphId } from '../graph-bridge/ids.js';
import {
  narrowOverloadCandidates,
  isOverloadAmbiguousAfterNormalization,
} from './overload-narrowing.js';
import {
  extractTemplateArguments,
  stripTemplateArguments,
} from '../../utils/template-arguments.js';

/** Subset of `ScopeResolver` consumed by this pass. Accepting the
 *  subset rather than the full provider keeps tests and partial
 *  refactors lighter — callers only need to populate what we read. */
type ReceiverBoundProviderSubset = Pick<
  ScopeResolver,
  | 'isSuperReceiver'
  | 'isSuperReceiverInContext'
  | 'fieldFallbackOnMethodLookup'
  | 'collapseMemberCallsByCallerTarget'
  | 'unwrapCollectionAccessor'
  | 'hoistTypeBindingsToModule'
  | 'resolveQualifiedReceiverMember'
  | 'resolveThisViaEnclosingClass'
>;

function normalizeTemplateArgToken(value: string): string {
  return value.replace(/\s+/g, '');
}

function resolveClassBindingForName(
  scopeId: string,
  rawClassName: string,
  scopes: ScopeResolutionIndexes,
): SymbolDefinition | undefined {
  const direct = findClassBindingInScope(scopeId, rawClassName, scopes);
  if (direct !== undefined) return direct;

  if (!rawClassName.includes('<')) return undefined;
  const baseName = stripTemplateArguments(rawClassName).replace(/\s+/g, '');
  if (baseName.length === 0) return undefined;

  const wantedArgs = extractTemplateArguments(rawClassName)?.map(normalizeTemplateArgToken);
  if (wantedArgs !== undefined && wantedArgs.length > 0) {
    // qualifiedNames is a Map and may not contain the stripped base name at all
    // (e.g., unresolved type binding or only template-qualified entries), so
    // default to [] before checking `.length`.
    const qnameIds = scopes.qualifiedNames.get(baseName) ?? [];
    if (qnameIds.length === 0) {
      return findClassBindingInScope(scopeId, baseName, scopes);
    }
    const matches: SymbolDefinition[] = [];
    for (const id of qnameIds) {
      const def = scopes.defs.get(id);
      if (def === undefined || !isClassLike(def.type)) continue;
      const defArgs = def.templateArguments?.map(normalizeTemplateArgToken);
      if (
        defArgs !== undefined &&
        defArgs.length === wantedArgs.length &&
        defArgs.every((value, i) => value === wantedArgs[i])
      ) {
        matches.push(def);
      }
    }
    if (matches.length === 1) return matches[0];
    // Scope extractor only records class definitions with bodies in C++, so
    // forward declarations are not expected here. Keep fallback behavior for
    // safety in non-ODR or mixed-language edge cases.
  }

  return findClassBindingInScope(scopeId, baseName, scopes);
}

export function emitReceiverBoundCalls(
  graph: KnowledgeGraph,
  scopes: ScopeResolutionIndexes,
  parsedFiles: readonly ParsedFile[],
  nodeLookup: GraphNodeLookup,
  handledSites: Set<string>,
  provider: ReceiverBoundProviderSubset,
  index: WorkspaceResolutionIndex,
  model: SemanticModel,
): number {
  let emitted = 0;
  // Per-pass dedup so the multiple cases don't double-emit if two of
  // them resolve the same site to the same target. NEVER pre-seed
  // from the reference index — see Contract Invariant I5.
  const seen = new Set<string>();
  const fieldFallback = provider.fieldFallbackOnMethodLookup ?? true;
  const collapse = provider.collapseMemberCallsByCallerTarget === true;
  const hoistTypeBindingsToModule = provider.hoistTypeBindingsToModule === true;
  const compoundOpts = {
    fieldFallback,
    unwrapCollectionAccessor: provider.unwrapCollectionAccessor,
    hoistTypeBindingsToModule,
  };

  // Build an interface → implementors map from IMPLEMENTS edges.
  // Maps Interface graph-id → list of implementor class scope-def-ids.
  // We translate graph-ids back to scope-resolution DefIds via
  // `parsedFiles.localDefs` lookup so downstream `findOwnedMember`
  // (which keys by DefId) can find the implementor's members.
  const graphIdToClassDef = new Map<string, SymbolDefinition>();
  for (const parsed of parsedFiles) {
    for (const def of parsed.localDefs) {
      if (def.type !== 'Class' && def.type !== 'Interface') continue;
      const graphId = resolveDefGraphId(parsed.filePath, def, nodeLookup);
      if (graphId !== undefined) graphIdToClassDef.set(graphId, def);
    }
  }
  const implementorsByInterfaceDefId = new Map<string, SymbolDefinition[]>();
  for (const rel of graph.iterRelationshipsByType('IMPLEMENTS')) {
    const ifaceDef = graphIdToClassDef.get(rel.targetId);
    const implDef = graphIdToClassDef.get(rel.sourceId);
    if (ifaceDef === undefined || implDef === undefined) continue;
    let list = implementorsByInterfaceDefId.get(ifaceDef.nodeId);
    if (list === undefined) {
      list = [];
      implementorsByInterfaceDefId.set(ifaceDef.nodeId, list);
    }
    list.push(implDef);
  }

  /** Emit secondary CALLS edges with reason='interface-dispatch'
   *  when the primary receiver-typed edge targeted an Interface's
   *  method. Each implementing class's same-named method gets a
   *  secondary edge (excluding the primary target itself). */
  const emitInterfaceDispatchFor = (
    ownerDef: SymbolDefinition,
    memberName: string,
    primaryMemberDef: SymbolDefinition,
    site: ParsedFile['referenceSites'][number],
    confidence: number,
  ): number => {
    if (ownerDef.type !== 'Interface') return 0;
    const impls = implementorsByInterfaceDefId.get(ownerDef.nodeId);
    if (impls === undefined) return 0;
    let n = 0;
    for (const implDef of impls) {
      const implMember = findOwnedMember(implDef.nodeId, memberName, model);
      if (implMember === undefined) continue;
      if (implMember.nodeId === primaryMemberDef.nodeId) continue;
      const ok = tryEmitEdge(
        graph,
        scopes,
        nodeLookup,
        site,
        implMember,
        'interface-dispatch',
        seen,
        confidence,
        collapse,
      );
      if (ok) n++;
    }
    return n;
  };

  for (const parsed of parsedFiles) {
    const namespaceTargets = collectNamespaceTargets(parsed, scopes);

    for (const site of parsed.referenceSites) {
      if (site.kind !== 'call' && site.kind !== 'read' && site.kind !== 'write') continue;
      if (site.explicitReceiver === undefined) continue;

      const receiverName = site.explicitReceiver.name;
      const memberName = site.name;
      const siteKey = `${parsed.filePath}:${site.atRange.startLine}:${site.atRange.startCol}`;

      // ── super branch ─────────────────────────────────────────────
      // Languages with caller-context-dependent super classification
      // (C++) define `isSuperReceiverInContext`; we prefer it. Simple
      // text-only languages (Python, Java, PHP) use the plain hook.
      const isSuper =
        provider.isSuperReceiverInContext !== undefined
          ? provider.isSuperReceiverInContext(receiverName, site.inScope, scopes)
          : provider.isSuperReceiver(receiverName);
      if (isSuper) {
        const enclosingClass = findEnclosingClassDef(site.inScope, scopes);
        if (enclosingClass !== undefined) {
          // For super-receiver dispatch (`parent::`, `base.`, `super()`),
          // walk the inheritance-only ancestor chain when the language
          // exposes it. PHP's `parent::` semantically bypasses composed
          // traits; other languages without mixin augmentation have no
          // `extendsOnlyMroFor` and fall back to `mroFor`.
          const extendsOnly = scopes.methodDispatch.extendsOnlyMroFor;
          const ancestors =
            extendsOnly !== undefined
              ? extendsOnly(enclosingClass.nodeId)
              : scopes.methodDispatch.mroFor(enclosingClass.nodeId);
          let memberDef: SymbolDefinition | undefined;
          for (const ownerId of ancestors) {
            memberDef = findOwnedMember(ownerId, memberName, model);
            if (memberDef !== undefined) break;
          }
          if (memberDef !== undefined) {
            // Super/base calls resolve through the MRO chain, not
            // through imports — the ancestor method is found by
            // walking `methodDispatch.mroFor(enclosingClass)`, which
            // is independent of whether a `using` / `import` directive
            // brought the ancestor into scope. We emit the canonical
            // `'global'` tier (ARCHITECTURE.md § Scope-Resolution
            // Pipeline — edge vocabulary).
            //
            // Known legacy-path asymmetry: the C# legacy DAG also
            // classifies `base.Save()` as `'global'` (same-graph); the
            // Python legacy DAG classifies `super().save()` as
            // `'import-resolved'` because Python's ancestor lookup
            // flows through `typeEnv.lookup(...)` which resolves the
            // superclass via its `import`/`from … import …` binding.
            // Closing that gap requires realigning the legacy tier
            // classifier and is tracked separately.
            const ok = tryEmitEdge(
              graph,
              scopes,
              nodeLookup,
              site,
              memberDef,
              'global',
              seen,
              0.85,
              collapse,
            );
            if (ok) emitted++;
            // Always mark handled when the site was resolved, even
            // if the edge was deduplicated (collapse mode), so
            // `emitReferencesViaLookup` doesn't re-emit from the
            // reference index.
            handledSites.add(siteKey);
            continue;
          }
        }
      }

      // ── Case 0: compound receiver ────────────────────────────────
      if (receiverName.includes('.') || receiverName.includes('(')) {
        const currentClass = resolveCompoundReceiverClass(
          receiverName,
          site.inScope,
          scopes,
          index,
          compoundOpts,
        );
        if (currentClass !== undefined) {
          const chain = [currentClass.nodeId, ...scopes.methodDispatch.mroFor(currentClass.nodeId)];
          let memberDef: SymbolDefinition | undefined;
          for (const ownerId of chain) {
            memberDef = findOwnedMember(ownerId, memberName, model);
            if (memberDef !== undefined) break;
          }
          if (memberDef !== undefined) {
            const ok = tryEmitEdge(
              graph,
              scopes,
              nodeLookup,
              site,
              memberDef,
              memberDef.filePath !== parsed.filePath ? 'import-resolved' : 'global',
              seen,
              0.85,
              collapse,
            );
            if (ok) emitted++;
            // Always mark handled when the site was resolved, even
            // if the edge was deduplicated (collapse mode), so
            // `emitReferencesViaLookup` doesn't re-emit from the
            // reference index.
            handledSites.add(siteKey);
            continue;
          }
        }
      }

      // ── Case 0.5: implicit `this` receiver ───────────────────────
      // C++ `this->member()` (and same-shape receivers in other OO
      // languages) should resolve against the enclosing class + MRO
      // even when there is no explicit `this` typeBinding in scope.
      if (provider.resolveThisViaEnclosingClass === true && receiverName === 'this') {
        const enclosingClass = findEnclosingClassDef(site.inScope, scopes);
        if (enclosingClass !== undefined) {
          const chain = [
            enclosingClass.nodeId,
            ...scopes.methodDispatch.mroFor(enclosingClass.nodeId),
          ];
          let memberDef: SymbolDefinition | undefined;
          let ambiguous = false;
          let hiddenByName = false;
          for (const ownerId of chain) {
            const methodOverloads = model.methods.lookupAllByOwner(ownerId, memberName);
            if (methodOverloads.length > 0) {
              const narrowed = narrowOverloadCandidates(
                methodOverloads,
                site.arity,
                site.argumentTypes,
              );
              if (isOverloadAmbiguousAfterNormalization(narrowed, site.arity)) {
                ambiguous = true;
                break;
              }
              if (narrowed.length === 0) {
                // C++ name hiding: if the derived class declares `f`, base-class
                // overloads named `f` are hidden for member lookup
                // ([basic.lookup.classref]). A non-viable derived overload set
                // therefore terminates lookup instead of falling through to base.
                hiddenByName = true;
                break;
              }
              memberDef = narrowed[0] ?? methodOverloads[0];
              break;
            }

            // Field/property lookup intentionally runs only after the method
            // lookup above: in C++ member-name lookup, functions with this
            // name hide same-named base members; we therefore prefer method
            // candidates first and only target a field when no methods with
            // this name exist on the current owner.
            memberDef = model.fields.lookupFieldByOwner(ownerId, memberName);
            if (memberDef !== undefined) {
              break;
            }
          }
          if (ambiguous) {
            handledSites.add(siteKey);
            continue;
          }
          if (hiddenByName) {
            handledSites.add(siteKey);
            continue;
          }
          if (memberDef !== undefined) {
            const reason =
              site.kind === 'write' || site.kind === 'read'
                ? site.kind
                : memberDef.filePath !== parsed.filePath
                  ? 'import-resolved'
                  : 'global';
            const confidence = site.kind === 'write' || site.kind === 'read' ? 1.0 : 0.85;
            const ok = tryEmitEdge(
              graph,
              scopes,
              nodeLookup,
              site,
              memberDef,
              reason,
              seen,
              confidence,
              collapse,
            );
            if (ok) emitted++;
            handledSites.add(siteKey);
            continue;
          }
        }
      }

      // ── Case 1: namespace receiver ───────────────────────────────
      const targetFiles = namespaceTargets.get(receiverName);
      if (targetFiles !== undefined) {
        let found = false;
        for (const targetFile of targetFiles) {
          const memberDef = findExportedDef(targetFile, memberName, index);
          if (memberDef !== undefined) {
            const ok = tryEmitEdge(
              graph,
              scopes,
              nodeLookup,
              site,
              memberDef,
              memberDef.filePath !== parsed.filePath ? 'import-resolved' : 'global',
              seen,
              0.85,
              collapse,
            );
            if (ok) emitted++;
            handledSites.add(siteKey);
            found = true;
            break;
          }
        }
        if (found) continue;
      }

      // ── Case 1.5: qualified namespace-receiver (language-specific) ───
      // Languages whose qualified-name semantics need workspace-wide
      // namespace-scope walking (C++ `outer::foo()`, including inline-
      // namespace transitive traversal) implement `resolveQualifiedReceiverMember`.
      // Runs before Case 2 so namespace receivers don't accidentally match a
      // class with the same simple name.
      if (provider.resolveQualifiedReceiverMember !== undefined) {
        const memberDef = provider.resolveQualifiedReceiverMember(
          receiverName,
          memberName,
          site.inScope,
          scopes,
          parsedFiles,
        );
        if (memberDef === 'ambiguous') {
          // Same-name ambiguity across inline-namespace children (#1564):
          // suppress edge emission, mark site handled.
          handledSites.add(siteKey);
          continue;
        }
        if (memberDef !== undefined) {
          const ok = tryEmitEdge(
            graph,
            scopes,
            nodeLookup,
            site,
            memberDef,
            memberDef.filePath !== parsed.filePath ? 'import-resolved' : 'global',
            seen,
            0.85,
            collapse,
          );
          if (ok) emitted++;
          handledSites.add(siteKey);
          continue;
        }
      }

      // ── Case 2: class-name receiver ──────────────────────────────
      const classDef = findClassBindingInScope(site.inScope, receiverName, scopes);
      if (classDef !== undefined) {
        const chain = [classDef.nodeId, ...scopes.methodDispatch.mroFor(classDef.nodeId)];
        let memberDef: SymbolDefinition | undefined;
        for (const ownerId of chain) {
          memberDef = findOwnedMember(ownerId, memberName, model);
          if (memberDef !== undefined) {
            // The MRO chain is most-derived-first ([classDef, ...ancestors]).
            // If the most-derived definition is arity-incompatible with the
            // call site, PHP throws ArgumentCountError at runtime — it does
            // NOT silently dispatch to an ancestor. Terminate the chain walk
            // so no edge is emitted, rather than falling through to an
            // arity-compatible ancestor (which would be a false positive).
            if (
              narrowOverloadCandidates([memberDef], site.arity, site.argumentTypes).length === 0
            ) {
              memberDef = undefined;
              break;
            }
            break;
          }
        }
        if (memberDef !== undefined) {
          const reason =
            site.kind === 'write' || site.kind === 'read'
              ? site.kind
              : memberDef.filePath !== parsed.filePath
                ? 'import-resolved'
                : 'global';
          const confidence = site.kind === 'write' || site.kind === 'read' ? 1.0 : 0.85;
          const ok = tryEmitEdge(
            graph,
            scopes,
            nodeLookup,
            site,
            memberDef,
            reason,
            seen,
            confidence,
            collapse,
          );
          if (ok) emitted++;
          handledSites.add(siteKey);
          continue;
        }
      }

      // ── Case 3: dotted typeBinding (`u: models.User`) ────────────
      const typeRef = findReceiverTypeBinding(site.inScope, receiverName, scopes);
      if (typeRef !== undefined && typeRef.rawName.includes('.')) {
        const [nsName, ...classNameParts] = typeRef.rawName.split('.');
        const className = classNameParts.join('.');
        const targetFiles3 = namespaceTargets.get(nsName);
        if (targetFiles3 !== undefined && className.length > 0) {
          let found3 = false;
          for (const targetFile3 of targetFiles3) {
            const classDef3 = findExportedDef(targetFile3, className, index);
            if (classDef3 !== undefined) {
              const memberDef = findOwnedMember(classDef3.nodeId, memberName, model);
              if (memberDef !== undefined) {
                const ok = tryEmitEdge(
                  graph,
                  scopes,
                  nodeLookup,
                  site,
                  memberDef,
                  memberDef.filePath !== parsed.filePath ? 'import-resolved' : 'global',
                  seen,
                );
                if (ok) {
                  emitted++;
                  handledSites.add(siteKey);
                }
                found3 = true;
                break;
              }
            }
          }
          if (found3) continue;
        }
      }

      // ── Case 3b: chain-typebinding (`city → user.get_city`) ──────
      const chainHead =
        typeRef !== undefined && typeRef.rawName.includes('.') && !typeRef.rawName.includes('(')
          ? (typeRef.rawName.split('.', 1)[0] ?? '')
          : undefined;
      if (typeRef !== undefined && chainHead !== undefined && !namespaceTargets.has(chainHead)) {
        // Try the plain dotted-field walk first — covers property /
        // collection-accessor shapes (`.Values`, Kotlin `.size`) and
        // field chains. Fall back to call-form (`x()`) which treats
        // the last segment as a method invocation.
        let ownerDef = resolveCompoundReceiverClass(
          typeRef.rawName,
          typeRef.declaredAtScope,
          scopes,
          index,
          compoundOpts,
        );
        if (ownerDef === undefined) {
          ownerDef = resolveCompoundReceiverClass(
            typeRef.rawName + '()',
            typeRef.declaredAtScope,
            scopes,
            index,
            compoundOpts,
          );
        }
        if (ownerDef !== undefined) {
          const chain = [ownerDef.nodeId, ...scopes.methodDispatch.mroFor(ownerDef.nodeId)];
          let memberDef: SymbolDefinition | undefined;
          for (const ownerId of chain) {
            memberDef = findOwnedMember(ownerId, memberName, model);
            if (memberDef !== undefined) break;
          }
          if (memberDef !== undefined) {
            const ok = tryEmitEdge(
              graph,
              scopes,
              nodeLookup,
              site,
              memberDef,
              memberDef.filePath !== parsed.filePath ? 'import-resolved' : 'global',
              seen,
              0.85,
              collapse,
            );
            if (ok) emitted++;
            // Always mark handled when the site was resolved, even
            // if the edge was deduplicated (collapse mode), so
            // `emitReferencesViaLookup` doesn't re-emit from the
            // reference index.
            handledSites.add(siteKey);
            continue;
          }
        }
      }

      // ── Case 4: simple typeBinding (`u: U`) ──────────────────────
      if (typeRef !== undefined && !typeRef.rawName.includes('.')) {
        let ownerDef = resolveClassBindingForName(site.inScope, typeRef.rawName, scopes);
        // `findClassBindingInScope(..., typeRef.rawName)` only works when
        // rawName is itself a class symbol reachable through scope bindings.
        // For languages with namespace-style imports (Go), imported types
        // don't create bindings. Fall back to QualifiedNameIndex — single-
        // match wins; ambiguous/missing falls through.
        if (ownerDef === undefined) {
          const qnameIds = scopes.qualifiedNames.get(typeRef.rawName);
          if (qnameIds.length === 1) {
            const qdef = scopes.defs.get(qnameIds[0]!);
            if (qdef !== undefined && isClassLike(qdef.type)) ownerDef = qdef;
          }
        }
        // Map for-of tuple bindings (`__MAP_TUPLE_i__:mapId`), callable
        // aliases (`getUser` → User), and other compound-friendly shapes
        // need the compound resolver keyed by the receiver identifier.
        if (ownerDef === undefined) {
          ownerDef = resolveCompoundReceiverClass(
            receiverName,
            site.inScope,
            scopes,
            index,
            compoundOpts,
          );
        }
        if (ownerDef !== undefined) {
          const chain = [ownerDef.nodeId, ...scopes.methodDispatch.mroFor(ownerDef.nodeId)];
          let memberDef: SymbolDefinition | undefined;
          let ambiguous = false;
          for (const ownerId of chain) {
            const picked = pickOverload(ownerId, memberName, site, model);
            if (picked === OVERLOAD_AMBIGUOUS) {
              ambiguous = true;
              break;
            }
            if (picked !== undefined) {
              memberDef = picked;
              break;
            }
          }
          if (ambiguous) {
            // Suppress and mark handled so `emitReferencesViaLookup`
            // doesn't re-emit the pre-resolved reference. See
            // OVERLOAD_AMBIGUOUS docstring for the upstream cause.
            handledSites.add(siteKey);
            continue;
          }
          if (memberDef !== undefined) {
            // For read/write ACCESSES, mirror the legacy DAG's reason
            // convention so consumers asserting `reason === 'write'`
            // keep working.
            const reason =
              site.kind === 'write' || site.kind === 'read'
                ? site.kind
                : memberDef.filePath !== parsed.filePath
                  ? 'import-resolved'
                  : 'global';
            const confidence = site.kind === 'write' || site.kind === 'read' ? 1.0 : 0.85;
            const ok = tryEmitEdge(
              graph,
              scopes,
              nodeLookup,
              site,
              memberDef,
              reason,
              seen,
              confidence,
              collapse,
            );
            if (ok) emitted++;
            // Interface dispatch: when the primary owner is an
            // Interface, emit secondary CALLS edges to every
            // implementing class's same-named method.
            emitted += emitInterfaceDispatchFor(ownerDef, memberName, memberDef, site, confidence);
            // Always mark handled when the site was resolved, even
            // if the edge was deduplicated (collapse mode), so
            // `emitReferencesViaLookup` doesn't re-emit from the
            // reference index.
            handledSites.add(siteKey);
            continue;
          }
        }
      }
    }
  }

  return emitted;
}

/** Resolve a member by name on a class def, narrowing by argument
 *  types when multiple overloads share the name. Falls back to the
 *  first-seen def (legacy `findOwnedMember` semantics) when there's
 *  no narrowing signal or when `argumentTypes` is unavailable. */
function pickOverload(
  ownerId: string,
  memberName: string,
  site: ParsedFile['referenceSites'][number],
  model: SemanticModel,
): SymbolDefinition | typeof OVERLOAD_AMBIGUOUS | undefined {
  const overloads = model.methods.lookupAllByOwner(ownerId, memberName);
  if (overloads.length === 0) {
    // Non-callable member (field / property / variable) — ACCESSES
    // write/read sites target these too. Fall back to the field
    // registry so owner-scoped attribute access resolves.
    return model.fields.lookupFieldByOwner(ownerId, memberName);
  }
  if (overloads.length === 1) return overloads[0];

  const candidates = narrowOverloadCandidates(overloads, site.arity, site.argumentTypes);
  // When narrowing leaves >1 candidate that share identical normalized
  // parameter-types (e.g., C++ `f(int)` vs `f(long)` both collapsed to
  // `['int']` by `normalizeCppParamType`), suppress the edge entirely.
  // The graph schema has no ambiguous-target edge model, so emitting one
  // would arbitrarily pick a candidate and lie about the call's target.
  // PR #1520 review follow-up plan U2 / Claude review Finding 5.
  if (isOverloadAmbiguousAfterNormalization(candidates, site.arity)) return OVERLOAD_AMBIGUOUS;
  return candidates[0] ?? overloads[0];
}

/**
 * Sentinel returned by `pickOverload` when narrowing leaves >1 candidate
 * sharing identical normalized parameter-types. Callers should suppress
 * the CALLS edge AND mark the site as handled so `emitReferencesViaLookup`
 * does not re-emit from the pre-resolved reference index. See
 * `pickOverload` JSDoc for the upstream cause (per-language normalizer
 * collapses distinct types in arity-metadata).
 */
export const OVERLOAD_AMBIGUOUS = Symbol('overload-ambiguous');
