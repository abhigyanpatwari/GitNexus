/**
 * `ImportVisibility` — the one access path to what a scope imports.
 *
 * Finalize decides how imports are stored. Consumers ask through this
 * interface, so a reader can never hold a collection that omits part of what a
 * scope reaches. Each operation names the question a consumer has:
 *
 *   - `edgesAt`          — which import edges are bound here (name, kind, def)?
 *   - `reaches`          — does this scope import that file? (one question)
 *   - `reachesDirectory` — does it import any file of that directory?
 *   - `membership`       — the same question asked many times at one scope
 *   - `forEachTarget`    — every imported file, in the order imports are written
 *
 * ## What `edgesAt` is complete for
 *
 * `edgesAt` returns every import of the scope that can be SELECTED: by a
 * non-empty local name, by a non-empty exported name, by the definition it
 * links to, or by any kind other than a nameless wildcard. For those
 * selections it is the whole answer, in statement order, whatever the storage.
 *
 * The one thing it may leave out is a nameless wildcard target: an import
 * that binds no name, links no definition and only says "this file is
 * reachable" (`isSelectableImport` is false). An implementation may store
 * those once per statement instead of once per file. They still answer
 * `reaches`, `reachesDirectory`, `membership` and `forEachTarget`, so a
 * consumer that needs "everything this scope can reach" uses those, never a
 * scan of `edgesAt`.
 */

import type { ImportEdge, ScopeId } from './types.js';

/** Can a reader pick this import out by name, definition or kind? False only
 *  for a nameless wildcard target, which carries nothing but a file. */
export function isSelectableImport(edge: ImportEdge): boolean {
  return (
    edge.kind !== 'wildcard-expanded' ||
    edge.localName !== '' ||
    edge.targetExportedName !== '' ||
    edge.targetDefId !== undefined
  );
}

/** Membership of one scope's import targets, for repeated queries. */
export interface ImportMembership {
  /** True when the scope imports `targetFile`. */
  has(targetFile: string): boolean;
  /** True when the scope imports at least one file other than `file`. */
  hasOtherThan(file: string): boolean;
}

export interface ImportVisibility {
  /** The scope's selectable imports (see the file header), in statement
   *  order; an implementation may also include nameless wildcard targets.
   *  `undefined` when finalize recorded nothing for the scope, which is
   *  different from an empty list: callers fall back to the scope's own
   *  pre-finalize imports only in the first case. */
  edgesAt(scope: ScopeId): readonly ImportEdge[] | undefined;

  /** Every scope finalize recorded imports for, in finalize order. */
  scopes(): IterableIterator<ScopeId>;

  /** Does `scope` import `targetFile`? Keeps nothing per scope; use
   *  `membership` when the same scope is asked repeatedly. */
  reaches(scope: ScopeId, targetFile: string): boolean;

  /** Does `scope` import any file directly inside `directory`? `directory` is
   *  a forward-slash path with no trailing slash; `''` is the root. */
  reachesDirectory(scope: ScopeId, directory: string): boolean;

  /** A reusable membership view of `scope`. The view is cached in this
   *  object and nowhere else, so it lives exactly as long as the finalize
   *  result it describes and cannot answer for a later one. It never copies
   *  imports that are stored once and shared between scopes. */
  membership(scope: ScopeId): ImportMembership;

  /** Visit every imported file of `scope` in statement order, with the edge
   *  that describes how it is imported. A file imported twice is visited
   *  twice. Imports with no resolved file are not visited. */
  forEachTarget(scope: ScopeId, visit: (targetFile: string, via: ImportEdge) => void): void;
}

/** Directory part of a forward-slash workspace path; `''` for a bare name. */
export function importTargetDirectory(filePath: string): string {
  const idx = filePath.lastIndexOf('/');
  return idx === -1 ? '' : filePath.slice(0, idx);
}

const NO_TARGETS: ImportMembership = Object.freeze({
  has: () => false,
  hasOtherThan: () => false,
});

/**
 * `ImportVisibility` over one edge per imported file — the representation
 * finalize has always produced. `edgesAt` returns the stored arrays themselves.
 */
export function createEagerImportVisibility(
  edgesByScope: ReadonlyMap<ScopeId, readonly ImportEdge[]>,
): ImportVisibility {
  const memberships = new Map<ScopeId, ImportMembership>();
  return {
    edgesAt: (scope) => edgesByScope.get(scope),
    scopes: () => edgesByScope.keys(),
    reaches(scope, targetFile) {
      const edges = edgesByScope.get(scope);
      if (edges === undefined) return false;
      for (const edge of edges) if (edge.targetFile === targetFile) return true;
      return false;
    },
    reachesDirectory(scope, directory) {
      const edges = edgesByScope.get(scope);
      if (edges === undefined) return false;
      for (const edge of edges) {
        if (edge.targetFile !== null && importTargetDirectory(edge.targetFile) === directory)
          return true;
      }
      return false;
    },
    membership(scope) {
      const cached = memberships.get(scope);
      if (cached !== undefined) return cached;
      const edges = edgesByScope.get(scope);
      const files = new Set<string>();
      for (const edge of edges ?? []) if (edge.targetFile !== null) files.add(edge.targetFile);
      const view: ImportMembership =
        files.size === 0
          ? NO_TARGETS
          : {
              has: (targetFile) => files.has(targetFile),
              hasOtherThan: (file) => files.size > 1 || !files.has(file),
            };
      memberships.set(scope, view);
      return view;
    },
    forEachTarget(scope, visit) {
      const edges = edgesByScope.get(scope);
      if (edges === undefined) return;
      for (const edge of edges) if (edge.targetFile !== null) visit(edge.targetFile, edge);
    },
  };
}
