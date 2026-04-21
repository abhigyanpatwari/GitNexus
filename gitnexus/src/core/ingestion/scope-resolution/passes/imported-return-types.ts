/**
 * Cross-file return-type typeBinding propagation + post-finalize
 * chain re-follow.
 *
 * **Why this lives in scope-resolution:** the algorithm is language-agnostic.
 * Every language with cross-file callable imports needs the same
 * mirror-binding step, otherwise `u = f(); u.save()` only resolves
 * when `f` is in the same file as the call.
 *
 * **Mutation contract (Contract Invariant I3 + I6):**
 *   - Mutates `Scope.typeBindings` (a plain `new Map(...)` from
 *     `draftToScope`, NOT frozen — intentional, do not freeze).
 *   - MUST run AFTER `finalizeScopeModel` (so `indexes.bindings` is
 *     populated) but BEFORE `resolveReferenceSites` (so resolution
 *     sees the propagated types).
 *
 * Generic; promoted from `languages/python/scope-resolver.ts` per the scope-resolution
 * generalization plan.
 */

import type { ParsedFile, ScopeId, TypeRef } from 'gitnexus-shared';
import type { ScopeResolutionIndexes } from '../../model/scope-resolution-indexes.js';
import type { WorkspaceResolutionIndex } from '../workspace-index.js';

/** Max chain depth for the post-finalize re-follow. */
const RECHAIN_MAX_DEPTH = 8;

/** Walk `ref.rawName` through the scope chain's typeBindings looking
 *  for a terminal class-like rawName. Mirrors the in-extractor
 *  `followChainedRef` but operates on post-finalize Scope objects so
 *  it can see imported return-types propagated by
 *  `propagateImportedReturnTypes`. */
function followChainPostFinalize(
  start: TypeRef,
  fromScopeId: ScopeId,
  scopes: ScopeResolutionIndexes,
): TypeRef {
  let current = start;
  const visited = new Set<string>();
  for (let depth = 0; depth < RECHAIN_MAX_DEPTH; depth++) {
    if (current.rawName.includes('.')) return current;
    let scopeId: ScopeId | null = fromScopeId;
    let next: TypeRef | undefined;
    while (scopeId !== null) {
      const scope = scopes.scopeTree.getScope(scopeId);
      if (scope === undefined) break;
      next = scope.typeBindings.get(current.rawName);
      if (next !== undefined && next !== current) break;
      next = undefined;
      scopeId = scope.parent;
    }
    if (next === undefined) return current;
    if (visited.has(next.rawName)) return current;
    visited.add(next.rawName);
    current = next;
  }
  return current;
}

/**
 * Copy return-type typeBindings across module boundaries via import
 * bindings. For each module-scope import like `from x import f`, look
 * up `f` in the source file's module-scope typeBindings (which carries
 * `f → ReturnType` from the language's return-type annotation
 * capture) and mirror that binding into the importer's module scope.
 *
 * After propagation, re-runs the chain-follow on every scope's
 * typeBindings — the in-extractor pass-4 ran before propagation and
 * missed any chain whose terminal lived in a foreign file.
 *
 * Scope-chain concern (verified 2026-04-21): `pythonImportOwningScope`
 * documents that function-local `from x import y` binds `y` to the
 * inner function scope, which would make a module-only write miss
 * non-module importers. In practice `finalize-algorithm` hoists those
 * bindings into `indexes.bindings[moduleScope]` regardless of where
 * the `import` statement appears — the integration fixture
 * `python-function-local-import-chain` exercises a chained
 * receiver-bound call `u = get_user(); u.save()` inside a function
 * body and emits the expected `do_work → User.save` edge. The
 * module-scope write is sufficient today. If finalize routing ever
 * changes to honor the hook's per-scope contract, this pass must
 * iterate `indexes.bindings` over every scope and mirror into the
 * binding-owning scope's `typeBindings`, not just the module's.
 */
export function propagateImportedReturnTypes(
  parsedFiles: readonly ParsedFile[],
  indexes: ScopeResolutionIndexes,
  index: WorkspaceResolutionIndex,
): void {
  const moduleScopeByFile = index.moduleScopeByFile;

  for (const parsed of parsedFiles) {
    const importerModule = moduleScopeByFile.get(parsed.filePath);
    if (importerModule === undefined) continue;
    const finalizedBindings = indexes.bindings.get(importerModule.id);
    if (finalizedBindings === undefined) continue;

    for (const [localName, refs] of finalizedBindings) {
      // Skip if importer already has a typeBinding for this name (e.g.
      // an explicit local annotation should win over import-derived).
      if (importerModule.typeBindings.has(localName)) continue;

      for (const ref of refs) {
        if (ref.origin !== 'import' && ref.origin !== 'reexport') continue;
        const sourceModule = moduleScopeByFile.get(ref.def.filePath);
        if (sourceModule === undefined) continue;

        // The source file's typeBinding is keyed by the def's simple
        // name (e.g. `get_user`), not the importer's local alias. Use
        // the def's qualifiedName tail.
        const qn = ref.def.qualifiedName;
        if (qn === undefined) continue;
        const dot = qn.lastIndexOf('.');
        const sourceName = dot === -1 ? qn : qn.slice(dot + 1);

        const sourceTypeRef = sourceModule.typeBindings.get(sourceName);
        if (sourceTypeRef === undefined) continue;

        // Mirror the binding under the importer's local alias —
        // mutating typeBindings is safe because draftToScope produced
        // a non-frozen Map.
        (importerModule.typeBindings as Map<string, TypeRef>).set(localName, sourceTypeRef);
        break;
      }
    }
  }

  // Re-follow chains across every scope so chains terminating in a
  // freshly-propagated import binding resolve to their terminal type.
  for (const parsed of parsedFiles) {
    for (const scope of parsed.scopes) {
      for (const [name, ref] of scope.typeBindings) {
        const resolved = followChainPostFinalize(ref, scope.id, indexes);
        if (resolved !== ref) {
          (scope.typeBindings as Map<string, TypeRef>).set(name, resolved);
        }
      }
    }
  }
}
