/**
 * Graph Queries for Wiki Generation
 *
 * Encapsulated Cypher queries against the GitNexus knowledge graph.
 * Uses the MCP-style pooled lbug-adapter for connection management.
 */

import {
  initLbug,
  executeQuery,
  executeParameterized,
  closeLbug,
  touchRepo,
  pinRepo,
} from '../lbug/pool-adapter.js';
import { compareCodeUnits } from '../../lib/utils.js';

const REPO_ID = '__wiki__';

/** Rows kept by {@link getInterModuleCallEdges}, formerly the query's `LIMIT`. */
const INTER_MODULE_EDGE_LIMIT = 30;

/**
 * Touch the wiki DB connection to prevent idle timeout during long LLM calls.
 */
export function touchWikiDb(): void {
  touchRepo(REPO_ID);
}

/**
 * Keep the wiki DB resident for a full generation run. Wiki generation can spend
 * minutes inside LLM calls, and the pooled DB must survive both idle cleanup and
 * unrelated LRU pressure until the run reaches its final graph queries.
 */
export function pinWikiDb(): () => void {
  return pinRepo(REPO_ID);
}

export interface FileWithExports {
  filePath: string;
  symbols: Array<{ name: string; type: string }>;
}

export interface CallEdge {
  fromFile: string;
  fromName: string;
  toFile: string;
  toName: string;
}

export interface ProcessInfo {
  id: string;
  label: string;
  type: string;
  stepCount: number;
  steps: Array<{
    step: number;
    name: string;
    filePath: string;
    type: string;
  }>;
}

/** A process without its step trace — one row of the process header query. */
type ProcessHeader = Omit<ProcessInfo, 'steps'>;

/**
 * One result row. The pooled adapter yields rows keyed by column alias, and
 * every mapper here falls back to the positional form, so the row type has to
 * admit both.
 */
type QueryRow = Record<string | number, unknown>;

function toCallEdge(row: QueryRow): CallEdge {
  return {
    fromFile: (row.fromFile || row[0]) as string,
    fromName: (row.fromName || row[1]) as string,
    toFile: (row.toFile || row[2]) as string,
    toName: (row.toName || row[3]) as string,
  };
}

/** The `ORDER BY fromName, toName, fromFile, toFile` of the unbatched form. */
function compareCallEdges(a: CallEdge, b: CallEdge): number {
  return (
    compareCodeUnits(a.fromName, b.fromName) ||
    compareCodeUnits(a.toName, b.toName) ||
    compareCodeUnits(a.fromFile, b.fromFile) ||
    compareCodeUnits(a.toFile, b.toFile)
  );
}

function toProcessHeader(row: QueryRow): ProcessHeader {
  const id = (row.id || row[0]) as string;
  return {
    id,
    label: (row.label || row[1] || id) as string,
    type: (row.type || row[2] || 'unknown') as string,
    stepCount: (row.stepCount || row[3] || 0) as number,
  };
}

function toProcessStep(row: QueryRow): ProcessInfo['steps'][number] {
  return {
    step: (row.step || row[3] || 0) as number,
    name: (row.name || row[0]) as string,
    filePath: (row.filePath || row[1]) as string,
    type: (row.type || row[2]) as string,
  };
}

/**
 * Attach each header's full step trace, in one query for the whole set.
 *
 * One query per process cost 105ms for 20 processes against this repo's index;
 * grouping them on `p.id IN $ids` costs 13ms. `ORDER BY pid, r.step` keeps each
 * trace in step order, so the rows arrive already grouped.
 */
async function withSteps(headers: ProcessHeader[]): Promise<ProcessInfo[]> {
  if (headers.length === 0) return [];

  const stepRows = await executeParameterized(
    REPO_ID,
    `
      MATCH (s)-[r:CodeRelation {type: 'STEP_IN_PROCESS'}]->(p:Process)
      WHERE p.id IN $ids
      RETURN p.id AS pid, s.name AS name, s.filePath AS filePath,
             labels(s)[0] AS type, r.step AS step
      ORDER BY pid, r.step
    `,
    { ids: headers.map((header) => header.id) },
  );

  const stepsById = new Map<string, ProcessInfo['steps']>();
  for (const row of stepRows) {
    const pid = String(row.pid);
    const steps = stepsById.get(pid) ?? [];
    steps.push(toProcessStep(row));
    stepsById.set(pid, steps);
  }

  return headers.map((header) => ({ ...header, steps: stepsById.get(header.id) ?? [] }));
}

/**
 * Initialize the LadybugDB connection for wiki generation.
 */
export async function initWikiDb(lbugPath: string): Promise<void> {
  await initLbug(REPO_ID, lbugPath);
}

/**
 * Close the LadybugDB connection.
 */
export async function closeWikiDb(): Promise<void> {
  await closeLbug(REPO_ID);
}

/**
 * Get all source files with their exported symbol names and types.
 * Includes top-level exports (File→DEFINES→n) and exported class members
 * (File→DEFINES→Class→HAS_METHOD/HAS_PROPERTY→n) since class members no
 * longer have a direct File→DEFINES edge.
 */
export async function getFilesWithExports(): Promise<FileWithExports[]> {
  const rows = await executeQuery(
    REPO_ID,
    `
    MATCH (f:File)-[:CodeRelation {type: 'DEFINES'}]->(n)
    WHERE n.isExported = true
    RETURN f.filePath AS filePath, n.name AS name, labels(n)[0] AS type
    UNION
    MATCH (f:File)-[:CodeRelation {type: 'DEFINES'}]->(c)
          -[mr:CodeRelation]->(n)
    WHERE mr.type IN ['HAS_METHOD', 'HAS_PROPERTY'] AND n.isExported = true
    RETURN f.filePath AS filePath, n.name AS name, labels(n)[0] AS type
    ORDER BY filePath
  `,
  );

  const fileMap = new Map<string, FileWithExports>();
  for (const row of rows) {
    const fp = row.filePath || row[0];
    const name = row.name || row[1];
    const type = row.type || row[2];

    let entry = fileMap.get(fp);
    if (!entry) {
      entry = { filePath: fp, symbols: [] };
      fileMap.set(fp, entry);
    }
    entry.symbols.push({ name, type });
  }

  return Array.from(fileMap.values());
}

/**
 * Get all files tracked in the graph (including those with no exports).
 */
export async function getAllFiles(): Promise<string[]> {
  const rows = await executeQuery(
    REPO_ID,
    `
    MATCH (f:File)
    RETURN f.filePath AS filePath
    ORDER BY f.filePath
  `,
  );
  return rows.map((r) => r.filePath || r[0]);
}

/**
 * Get inter-file call edges (calls between different files).
 */
export async function getInterFileCallEdges(): Promise<CallEdge[]> {
  const rows = await executeQuery(
    REPO_ID,
    `
    MATCH (a)-[:CodeRelation {type: 'CALLS'}]->(b)
    WHERE a.filePath <> b.filePath
    RETURN DISTINCT a.filePath AS fromFile, a.name AS fromName,
           b.filePath AS toFile, b.name AS toName
  `,
  );

  return rows.map((r) => ({
    fromFile: r.fromFile || r[0],
    fromName: r.fromName || r[1],
    toFile: r.toFile || r[2],
    toName: r.toName || r[3],
  }));
}

/**
 * Get call edges between files within a specific set (intra-module).
 */
export async function getIntraModuleCallEdges(filePaths: string[]): Promise<CallEdge[]> {
  if (filePaths.length === 0) return [];

  // The file list is BOUND, not spliced into the query text. A module can hold
  // every file under a parent, so an `IN [...]` literal would grow the query
  // with the repo — the shape that crashed the engine in #2915 (see
  // `coalesceHunks` in src/storage/git.ts). As a parameter the text is constant
  // at any list length, and measured ~3x faster than the equivalent literal, so
  // both arms of the predicate can stay in Cypher where the engine can use them.
  const rows = await executeParameterized(
    REPO_ID,
    `
    MATCH (a)-[:CodeRelation {type: 'CALLS'}]->(b)
    WHERE a.filePath IN $paths AND b.filePath IN $paths
    RETURN DISTINCT a.filePath AS fromFile, a.name AS fromName,
           b.filePath AS toFile, b.name AS toName
  `,
    { paths: filePaths },
  );

  // Sorted, unlike the original, which had no ORDER BY and so returned whatever
  // the engine produced: `formatCallEdges` (prompts.ts) keeps only the first 30,
  // and an unordered cut keeps a different subset per machine (#2787).
  return rows.map(toCallEdge).sort(compareCallEdges);
}

/**
 * Get call edges crossing module boundaries (external calls from/to module files).
 */
export async function getInterModuleCallEdges(filePaths: string[]): Promise<{
  outgoing: CallEdge[];
  incoming: CallEdge[];
}> {
  if (filePaths.length === 0) return { outgoing: [], incoming: [] };

  // Bound list, as in getIntraModuleCallEdges — which also keeps the `NOT ...
  // IN` arm honest: `NOT null IN [...]` is null, so a callee with no filePath
  // is dropped by the engine, where a JS membership test would admit it.
  //
  // The sort leads with the symbol names, not the file paths. Ordering by
  // `fromFile` first makes the LIMIT a single-file prefix — on this repo's own
  // index the 30 outgoing edges of `core/wiki` all came from 1 of its 7 files,
  // so the module page described one file's external surface as the module's.
  // The four columns are the whole DISTINCT tuple, so any permutation is a
  // total order and equally deterministic (#2787); leading with the names just
  // spreads the window across files (1 → 7 of 7 here).
  const edgeQuery = (membership: string): string => `
    MATCH (a)-[:CodeRelation {type: 'CALLS'}]->(b)
    WHERE ${membership}
    RETURN DISTINCT a.filePath AS fromFile, a.name AS fromName,
           b.filePath AS toFile, b.name AS toName
    ORDER BY fromName, toName, fromFile, toFile
    LIMIT ${INTER_MODULE_EDGE_LIMIT}
  `;

  const [outRows, inRows] = await Promise.all([
    executeParameterized(REPO_ID, edgeQuery('a.filePath IN $paths AND NOT b.filePath IN $paths'), {
      paths: filePaths,
    }),
    executeParameterized(REPO_ID, edgeQuery('NOT a.filePath IN $paths AND b.filePath IN $paths'), {
      paths: filePaths,
    }),
  ]);

  return { outgoing: outRows.map(toCallEdge), incoming: inRows.map(toCallEdge) };
}

/**
 * Get processes (execution flows) that pass through a set of files.
 * Returns top N by step count.
 */
export async function getProcessesForFiles(filePaths: string[], limit = 5): Promise<ProcessInfo[]> {
  if (filePaths.length === 0) return [];

  // Bound list, as in getIntraModuleCallEdges, so `LIMIT` can stay in Cypher
  // over the whole set instead of being applied per batch and re-merged.
  const procRows = await executeParameterized(
    REPO_ID,
    `
    MATCH (s)-[r:CodeRelation {type: 'STEP_IN_PROCESS'}]->(p:Process)
    WHERE s.filePath IN $paths
    RETURN DISTINCT p.id AS id, p.heuristicLabel AS label,
           p.processType AS type, p.stepCount AS stepCount
    ORDER BY stepCount DESC, id
    LIMIT ${limit}
  `,
    { paths: filePaths },
  );

  return withSteps(procRows.map(toProcessHeader));
}

/**
 * Get all processes in the graph (for overview page).
 */
export async function getAllProcesses(limit = 20): Promise<ProcessInfo[]> {
  const procRows = await executeQuery(
    REPO_ID,
    `
    MATCH (p:Process)
    RETURN p.id AS id, p.heuristicLabel AS label,
           p.processType AS type, p.stepCount AS stepCount
    ORDER BY stepCount DESC, id
    LIMIT ${limit}
  `,
  );

  return withSteps(procRows.map(toProcessHeader));
}

/**
 * Get inter-module edges for overview architecture diagram.
 * Groups call edges by source/target module.
 */
export async function getInterModuleEdgesForOverview(
  moduleFiles: Record<string, string[]>,
): Promise<Array<{ from: string; to: string; count: number }>> {
  // Build file-to-module lookup
  const fileToModule = new Map<string, string>();
  for (const [mod, files] of Object.entries(moduleFiles)) {
    for (const f of files) {
      fileToModule.set(f, mod);
    }
  }

  const allEdges = await getInterFileCallEdges();
  const moduleEdgeCounts = new Map<string, number>();

  for (const edge of allEdges) {
    const fromMod = fileToModule.get(edge.fromFile);
    const toMod = fileToModule.get(edge.toFile);
    if (fromMod && toMod && fromMod !== toMod) {
      const key = `${fromMod}|||${toMod}`;
      moduleEdgeCounts.set(key, (moduleEdgeCounts.get(key) || 0) + 1);
    }
  }

  return Array.from(moduleEdgeCounts.entries())
    .map(([key, count]) => {
      const [from, to] = key.split('|||');
      return { from, to, count };
    })
    .sort((a, b) => b.count - a.count);
}
