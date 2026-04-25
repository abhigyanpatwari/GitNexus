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
} from '../scope/walkers.js';
import { tryEmitEdge } from '../graph-bridge/edges.js';
import { resolveCompoundReceiverClass } from '../passes/compound-receiver.js';
import { resolveDefGraphId } from '../graph-bridge/ids.js';
import { narrowOverloadCandidates } from './overload-narrowing.js';

/** Subset of `ScopeResolver` consumed by this pass. Accepting the
 *  subset rather than the full provider keeps tests and partial
 *  refactors lighter — callers only need to populate what we read. */
type ReceiverBoundProviderSubset = Pick<
  ScopeResolver,
  | 'isSuperReceiver'
  | 'fieldFallbackOnMethodLookup'
  | 'collapseMemberCallsByCallerTarget'
  | 'unwrapCollectionAccessor'
  | 'hoistTypeBindingsToModule'
>;

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
      if (provider.isSuperReceiver(receiverName)) {
        const enclosingClass = findEnclosingClassDef(site.inScope, scopes);
        if (enclosingClass !== undefined) {
          const ancestors = scopes.methodDispatch.mroFor(enclosingClass.nodeId);
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

      // ── Case 1: namespace receiver ───────────────────────────────
      const targetFile = namespaceTargets.get(receiverName);
      if (targetFile !== undefined) {
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
          if (memberDef !== undefined) break;
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
        const targetFile3 = namespaceTargets.get(nsName);
        if (targetFile3 !== undefined && className.length > 0) {
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
              continue;
            }
          }
        }
      }

      // ── Case 3b: chain-typebinding (`city → user.get_city`) ──────
      if (
        typeRef !== undefined &&
        typeRef.rawName.includes('.') &&
        !typeRef.rawName.includes('(') &&
        !namespaceTargets.has(typeRef.rawName.split('.')[0]!)
      ) {
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
        const ownerDef = findClassBindingInScope(site.inScope, typeRef.rawName, scopes);
        if (ownerDef !== undefined) {
          const chain = [ownerDef.nodeId, ...scopes.methodDispatch.mroFor(ownerDef.nodeId)];
          let memberDef: SymbolDefinition | undefined;
          for (const ownerId of chain) {
            memberDef = pickOverload(ownerId, memberName, site, model);
            if (memberDef !== undefined) break;
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
): SymbolDefinition | undefined {
  const overloads = model.methods.lookupAllByOwner(ownerId, memberName);
  if (overloads.length === 0) {
    // Non-callable member (field / property / variable) — ACCESSES
    // write/read sites target these too. Fall back to the field
    // registry so owner-scoped attribute access resolves.
    return model.fields.lookupFieldByOwner(ownerId, memberName);
  }
  if (overloads.length === 1) return overloads[0];

  const candidates = narrowOverloadCandidates(overloads, site.arity, site.argumentTypes);
  return candidates[0] ?? overloads[0];
}
