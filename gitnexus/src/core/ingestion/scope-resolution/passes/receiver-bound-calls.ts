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
 *   4. **Case 2 (class-name)** — receiver resolves to a Class binding →
 *      MRO walk on that class
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

/** Subset of `ScopeResolver` consumed by this pass. Accepting the
 *  subset rather than the full provider keeps tests and partial
 *  refactors lighter — callers only need to populate what we read. */
type ReceiverBoundProviderSubset = Pick<
  ScopeResolver,
  'isSuperReceiver' | 'fieldFallbackOnMethodLookup' | 'collapseMemberCallsByCallerTarget'
>;

export function emitReceiverBoundCalls(
  graph: KnowledgeGraph,
  scopes: ScopeResolutionIndexes,
  parsedFiles: readonly ParsedFile[],
  nodeLookup: GraphNodeLookup,
  handledSites: Set<string>,
  provider: ReceiverBoundProviderSubset,
  index: WorkspaceResolutionIndex,
): number {
  let emitted = 0;
  // Per-pass dedup so the multiple cases don't double-emit if two of
  // them resolve the same site to the same target. NEVER pre-seed
  // from the reference index — see Contract Invariant I5.
  const seen = new Set<string>();
  const fieldFallback = provider.fieldFallbackOnMethodLookup ?? true;
  const collapse = provider.collapseMemberCallsByCallerTarget === true;

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
            memberDef = findOwnedMember(ownerId, memberName, index);
            if (memberDef !== undefined) break;
          }
          if (memberDef !== undefined) {
            const ok = tryEmitEdge(
              graph,
              scopes,
              nodeLookup,
              site,
              memberDef,
              'scope-resolution: super-receiver',
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
          { fieldFallback },
        );
        if (currentClass !== undefined) {
          const chain = [currentClass.nodeId, ...scopes.methodDispatch.mroFor(currentClass.nodeId)];
          let memberDef: SymbolDefinition | undefined;
          for (const ownerId of chain) {
            memberDef = findOwnedMember(ownerId, memberName, index);
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
          memberDef = findOwnedMember(ownerId, memberName, index);
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
            const memberDef = findOwnedMember(classDef3.nodeId, memberName, index);
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
        // For collection-accessor suffixes (`.Values`, `.Keys`) the
        // raw typeRef already describes a plain dotted access that
        // `resolveCompoundReceiverClass` can walk directly — don't
        // append `()` which would misroute to its call-expression
        // branch.
        const tail = typeRef.rawName.split('.').pop() ?? '';
        const isAccessor = tail === 'Values' || tail === 'Keys';
        const ownerDef = resolveCompoundReceiverClass(
          isAccessor ? typeRef.rawName : typeRef.rawName + '()',
          typeRef.declaredAtScope,
          scopes,
          index,
          { fieldFallback },
        );
        if (ownerDef !== undefined) {
          const chain = [ownerDef.nodeId, ...scopes.methodDispatch.mroFor(ownerDef.nodeId)];
          let memberDef: SymbolDefinition | undefined;
          for (const ownerId of chain) {
            memberDef = findOwnedMember(ownerId, memberName, index);
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
            memberDef = findOwnedMember(ownerId, memberName, index);
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
            // Always mark handled when the site was resolved, even
            // if the edge was deduplicated (collapse mode), so
            // `emitReferencesViaLookup` doesn't re-emit from the
            // reference index.
            handledSites.add(siteKey);
            continue;
          }
        }
      }

      // ── Case 5: class-as-receiver (static call / type member) ────
      // `Animal.Classify()` — receiver name resolves to a Class
      // binding, not a typeBinding. Look up the member on the class's
      // MRO chain. Python syntactically collapses this with free
      // calls; C# (and other statically-typed languages) distinguish
      // via the member_access_expression shape.
      if (typeRef === undefined) {
        const classDef = findClassBindingInScope(site.inScope, receiverName, scopes);
        if (classDef !== undefined) {
          const chain = [classDef.nodeId, ...scopes.methodDispatch.mroFor(classDef.nodeId)];
          let memberDef: SymbolDefinition | undefined;
          for (const ownerId of chain) {
            memberDef = findOwnedMember(ownerId, memberName, index);
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
          }
        }
      }
    }
  }

  return emitted;
}
