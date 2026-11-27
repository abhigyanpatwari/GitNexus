/**
 * `ImportVisibility` — the one access path to what a scope imports.
 *
 * Finalize decides how imports are stored. Consumers ask through this
 * interface, so a reader can never hold a collection that omits part of what a
 * scope reaches. Each operation names the question a consumer has:
 *
 *   - `edgesAt`          — which import edges are bound here (name, kind, def)?
 *   - `statementsAt`     — the same, with a grouped module import as one edge
 *   - `groupTargets`     — the files behind such a grouped statement edge
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
 * It may leave out a nameless wildcard target: an import that binds no
 * name, links no definition and only says "this file is reachable"
 * (`isSelectableImport` is false). An implementation may store those once per
 * statement instead of once per file. They still answer `reaches`,
 * `reachesDirectory`, `membership` and `forEachTarget`, so a consumer that
 * needs "everything this scope can reach" uses those, never a scan of
 * `edgesAt`.
 *
 * ## Grouped module imports
 *
 * The files of a namespace import of a multi-file module through which the
 * statement binds nothing (none links a definition under the imported name)
 * may also be stored once, as a group. A file that does link the definition
 * stays an ordinary per-file edge, so one statement can be a mix of groups
 * and edges, in the order of the statement's files. A group is selectable by
 * its local name, so it is left out of `edgesAt` but listed by
 * `statementsAt`: once, as a statement edge (`groupsFiles: true`,
 * `targetFile: null`, no `targetModuleScope`), in statement order among the
 * scope's other edges. `groupTargets` returns that edge's files. Written out
 * one edge per file (each with its file's module scope, without
 * `groupsFiles`), `statementsAt` is exactly the edges `edgesAt` would list had
 * nothing been grouped.
 *
 * A reader that selects imports by name or kind reads `statementsAt` and asks
 * `importEdgeNamesFiles` / `importEdgeFiles` instead of `targetFile`. Without
 * such a group, `statementsAt` returns the `edgesAt` array itself and
 * `groupTargets` is always undefined. Pipeline output alone cannot show that a
 * reader got this wrong (a claim's status, for example, is not in the graph);
 * the reader-parity harness compares every reader over both forms.
 */

import type { ImportEdge, ScopeId } from './types.js';

const NO_FILES: readonly string[] = Object.freeze([]);

/** Does `edge` name at least one file: a per-file edge with a target, or a
 *  grouped statement edge (`groupsFiles`)? */
export function importEdgeNamesFiles(edge: ImportEdge): boolean {
  return edge.targetFile !== null || edge.groupsFiles === true;
}

/** The files `edge` names, in statement order; empty when it names none. */
export function importEdgeFiles(
  edge: ImportEdge,
  visibility: Pick<ImportVisibility, 'groupTargets'> | undefined,
): readonly string[] {
  if (edge.targetFile !== null) return [edge.targetFile];
  return edge.groupsFiles === true ? (visibility?.groupTargets(edge) ?? NO_FILES) : NO_FILES;
}

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

  /** `edgesAt`, plus one statement edge (`groupsFiles`) per module import
   *  group of the scope, in statement order (see the file header). The same
   *  array as `edgesAt` when the scope has no such group. */
  statementsAt(scope: ScopeId): readonly ImportEdge[] | undefined;

  /** The files of a grouped statement edge returned by `statementsAt`, in
   *  the order the statement resolved them; undefined for any other edge. */
  groupTargets(edge: ImportEdge): readonly string[] | undefined;

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
   *  twice. Imports with no resolved file are not visited. Use the callback's
   *  `targetFile`: shared groups describe the statement in `via`, without a
   *  per-file `targetFile` or `targetModuleScope`. */
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
    statementsAt: (scope) => edgesByScope.get(scope),
    groupTargets: () => undefined,
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
