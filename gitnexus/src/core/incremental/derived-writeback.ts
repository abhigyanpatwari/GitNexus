/**
 * Incremental derived-layer writeback helpers (#3016).
 *
 * The derived layers — Leiden communities, execution flows, and the FTS
 * indexes — are graph-wide, so every analyze run rebuilt all three in full no
 * matter how small the diff. A surgical incremental write can instead:
 *   - drop and rebuild only the FTS indexes whose tables hold rows in the
 *     write set (LadybugDB still cannot DML a table with a live FTS index —
 *     #2589 — so a table being written must still lose its index first);
 *   - leave the untouched tables' rows alone, so their indexes stay live;
 *   - reuse persisted Community/Process rows only when the file-hash diff is
 *     empty (no added, changed, or deleted files). Any content change can
 *     add, rename, or retarget symbols that Leiden and flow extraction
 *     consume — a no-deletion edit is not a validity proof.
 */
import { FTS_INDEXES } from '../search/fts-schema.js';
import type { KnowledgeGraph } from '../graph/types.js';
import type { FileHashDiff } from '../../storage/file-hash.js';

const FTS_TABLE_NAMES: ReadonlySet<string> = new Set(FTS_INDEXES.map((i) => i.table));

/** The FTS-backed members of `tables`. */
export const ftsTablesAmong = (tables: Iterable<string>): Set<string> => {
  const out = new Set<string>();
  for (const table of tables) {
    if (FTS_TABLE_NAMES.has(table)) out.add(table);
  }
  return out;
};

/**
 * Whether a surgical incremental write may reuse the persisted derived layer.
 *
 * Deletions disqualify it: the persisted Community/Process rows and their
 * MEMBER_OF / STEP_IN_PROCESS edges can reference nodes that no longer exist
 * after this run, and nothing short of re-deriving can tell which.
 *
 * Added or content-changed files also disqualify it: they can introduce,
 * rename, or retarget symbols and CALLS edges that Leiden and flow extraction
 * consume. File-deletion-only was too weak a proof that the derived graph is
 * still valid.
 */
export const shouldPreservePersistedDerivedGraph = (
  diff: Pick<FileHashDiff, 'deleted' | 'added' | 'changed'>,
): boolean => diff.deleted.length === 0 && diff.added.length === 0 && diff.changed.length === 0;

/**
 * FTS-backed node tables that the fresh graph will WRITE rows into for
 * `fileSet` — the inserting half of the DML.
 *
 * Callers must union this with a DB probe for the deleting half
 * (`nodeTablesWithRowsForFiles`): a table whose last row in these files was
 * just removed by the edit has nothing here, but still holds a stale row that
 * the writeback must delete, and deleting it means taking its index down too.
 */
export const incrementalFtsTablesFromGraph = (
  graph: KnowledgeGraph,
  fileSet: ReadonlySet<string>,
): Set<string> => {
  const touched = new Set<string>();
  graph.forEachNode((n) => {
    const filePath = n.properties?.filePath as string | undefined;
    if (!filePath || !fileSet.has(filePath)) return;
    if (FTS_TABLE_NAMES.has(n.label)) touched.add(n.label);
  });
  return touched;
};

/**
 * The node tables an incremental DETACH DELETE should target, given the FTS
 * tables this run is rebuilding.
 *
 * Every non-FTS table (Folder, CodeElement, …) deletes as before. An FTS-backed
 * table only deletes when its index is being rebuilt anyway, because deleting
 * from it otherwise would mean DML against a live FTS index (#2589).
 */
export const nodeTablesForIncrementalDelete = (
  allNodeTables: readonly string[],
  rebuildingFtsTables: ReadonlySet<string>,
): string[] =>
  allNodeTables.filter(
    (tableName) => !FTS_TABLE_NAMES.has(tableName) || rebuildingFtsTables.has(tableName),
  );
