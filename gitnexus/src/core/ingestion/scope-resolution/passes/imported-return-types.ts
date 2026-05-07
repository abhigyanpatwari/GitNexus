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
 * **Ordering invariant (added 2026-04-24, RFC #909 Ring 3 / PR #1050):**
 * The pass walks files in `indexes.sccs` reverse-topological order
 * (leaves first per `tarjanSccs`). For each importer we chain-follow
 * the source module's typeBindings BEFORE mirroring, so a multi-hop
 * alias chain like
 *
 *   models.ts: function getUser(): User
 *   service.ts: export const user = getUser()        // user → getUser
 *   app.ts: import { user } from './service'         // user → ?
 *
 * collapses to `app.user → User` in a single pass instead of stopping
 * at the intermediate `getUser` ref. The motivating regression is the
 * `ts-simple` integration fixture (`gitnexus/test/fixtures/scope-
 * resolution/cross-file-binding/ts-simple/`), where `user.save()` and
 * `user.getName()` only resolve when the chain collapse happens
 * topologically.
 *
 * Cyclic SCCs reach a partial fixpoint via the same mirror step but
 * are not guaranteed to fully resolve — see the `ts-circular`
 * fixture, which only asserts pipeline-no-throw.
 *
 * Generic; promoted from `languages/python/scope-resolver.ts` per the
 * scope-resolution generalization plan.
 */

import type { ParsedFile, ScopeId, TypeRef } from 'gitnexus-shared';
import type { ScopeResolutionIndexes } from '../../model/scope-resolution-indexes.js';
import type { WorkspaceResolutionIndex } from '../workspace-index.js';
import { lookupBindingsAt, namesAtScope } from '../scope/walkers.js';

/**
 * Max chain depth for the post-finalize re-follow. Effective end-to-end
 * depth is roughly 2× this number, because chain-following runs once
 * inside each importer's source module before mirroring AND once on
 * the importer's own typeBindings after mirroring; deeply nested
 * intra-module aliases can compose with cross-file aliases of the same
 * depth. 8 covers all production fixtures with headroom.
 */
const RECHAIN_MAX_DEPTH = 8;

/** Walk `ref.rawName` through the scope chain's typeBindings looking
 *  for a terminal class-like rawName. Mirrors the in-extractor
 *  `followChainedRef` but operates on post-finalize Scope objects so
 *  it can see imported return-types propagated by
 *  `propagateImportedReturnTypes`. */
export function followChainPostFinalize(
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

  // Walk SCCs in reverse-topological order (`indexes.sccs` is leaves-
  // first per `tarjanSccs`). For each file we mirror import bindings
  // AFTER chain-following the source module's typeBindings, so a
  // multi-hop alias chain like
  //   models.ts: function getUser(): User
  //   service.ts: export const user = getUser()        // user → getUser
  //   app.ts: import { user } from './service'         // user → ?
  // collapses to `app.user → User` instead of stopping at the
  // intermediate `getUser` ref. Without topological ordering, app.ts
  // could be processed before service.ts had its own typeBindings
  // chain-followed, leaving the importer with an unresolvable interim
  // ref. Cyclic SCCs reach a partial fixpoint via the same mirror
  // step but are not guaranteed to fully resolve — see the
  // ts-circular cross-file-binding fixture which only asserts that
  // the pipeline does not throw.
  for (const scc of indexes.sccs) {
    for (const filePath of scc.files) {
      const importerModule = moduleScopeByFile.get(filePath);
      if (importerModule === undefined) continue;

      // Iterate finalized + augmented binding names at this scope so
      // post-finalize hooks (e.g. `using static` augmentations from
      // `populateCsharpNamespaceSiblings`) are visible to the
      // import-derived typeBinding mirror. Both helpers fast-path when
      // no augmentations exist for the scope, so the common case is
      // allocation-free. See I8.
      for (const localName of namesAtScope(importerModule.id, indexes)) {
        // Skip if importer already has a typeBinding for this name —
        // an explicit local annotation must win over import-derived.
        if (importerModule.typeBindings.has(localName)) continue;

        const refs = lookupBindingsAt(importerModule.id, localName, indexes);
        for (const ref of refs) {
          if (ref.origin !== 'import' && ref.origin !== 'reexport') continue;
          const sourceModule = moduleScopeByFile.get(ref.def.filePath);
          if (sourceModule === undefined) continue;

          // The source file's typeBinding is keyed by the def's simple
          // name (e.g. `get_user`), not the importer's local alias.
          const qn = ref.def.qualifiedName;
          if (qn === undefined) continue;
          const dot = qn.lastIndexOf('.');
          const sourceName = dot === -1 ? qn : qn.slice(dot + 1);

          const sourceTypeRef = sourceModule.typeBindings.get(sourceName);
          if (sourceTypeRef === undefined) continue;

          // Chain-follow inside the source module so we mirror the
          // terminal type, not an intermediate intra-source reference.
          const terminal = followChainPostFinalize(sourceTypeRef, sourceModule.id, indexes);

          // Mutating typeBindings is safe because draftToScope
          // produced a non-frozen Map (Contract Invariant I3/I8).
          (importerModule.typeBindings as Map<string, TypeRef>).set(localName, terminal);
          // First-write-wins for the local alias: if the same
          // `localName` was registered multiple times via
          // `mergeBindings` (rare; happens with conflicting
          // re-exports), only the first ref with a usable
          // typeBinding source is mirrored. Conflict resolution
          // among multiple sources is the merger's job, not ours.
          break;
        }
      }

      // Chain-follow this importer's own module typeBindings now —
      // any local `const x = importedFn()` resolves while we have
      // freshly-mirrored bindings, and downstream importers in a
      // later (closer-to-root) SCC will see x's terminal type rather
      // than an intra-module call ref.
      for (const [name, ref] of importerModule.typeBindings) {
        const resolved = followChainPostFinalize(ref, importerModule.id, indexes);
        if (resolved !== ref) {
          (importerModule.typeBindings as Map<string, TypeRef>).set(name, resolved);
        }
      }
    }
  }

  // Final pass: chain-follow non-module scopes (function-local
  // typeBindings). Module scopes were already followed inside the
  // SCC loop above.
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
