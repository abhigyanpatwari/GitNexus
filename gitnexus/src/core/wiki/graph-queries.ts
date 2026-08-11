/**
 * Graph Queries for Wiki Generation
 *
 * Encapsulated Cypher queries against the GitNexus knowledge graph.
 * Uses the MCP-style pooled lbug-adapter for connection management.
 */

import { initLbug, executeQuery, closeLbug, touchRepo, pinRepo } from '../lbug/pool-adapter.js';
import { escapeCypherString } from '../lbug/cypher-escape.js';
import { chunk } from '../lbug/query-batch.js';

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

/** The contents of a Cypher `IN [...]` literal: one quoted, escaped path each. */
function fileListLiteral(filePaths: readonly string[]): string {
  return filePaths.map((f) => `'${escapeCypherString(f)}'`).join(', ');
}

function toCallEdge(row: QueryRow): CallEdge {
  return {
    fromFile: (row.fromFile || row[0]) as string,
    fromName: (row.fromName || row[1]) as string,
    toFile: (row.toFile || row[2]) as string,
    toName: (row.toName || row[3]) as string,
  };
}

/**
 * Identity of a `RETURN DISTINCT` call-edge row. DISTINCT only holds within one
 * query, so batched runs have to re-establish it across batches; NUL occurs in
 * neither a file path nor a symbol name, so it cannot forge or split a key.
 */
function callEdgeKey(edge: CallEdge): string {
  return `${edge.fromFile}\u0000${edge.fromName}\u0000${edge.toFile}\u0000${edge.toName}`;
}

/**
 * Ordinal comparison, deliberately not `localeCompare`: its order depends on
 * the host's ICU data, and generated wiki pages must not differ by machine.
 */
function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** The `ORDER BY fromName, toName, fromFile, toFile` of the unbatched form. */
function compareCallEdges(a: CallEdge, b: CallEdge): number {
  return (
    compareStrings(a.fromName, b.fromName) ||
    compareStrings(a.toName, b.toName) ||
    compareStrings(a.fromFile, b.fromFile) ||
    compareStrings(a.toFile, b.toFile)
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

/** The `ORDER BY stepCount DESC, id` of the unbatched form. */
function compareProcessHeaders(a: ProcessHeader, b: ProcessHeader): number {
  // Comparison operators rather than `b.stepCount - a.stepCount`: an integer
  // column can arrive as a BigInt, which throws on mixed arithmetic but
  // compares against a number fine.
  if (a.stepCount > b.stepCount) return -1;
  if (a.stepCount < b.stepCount) return 1;
  return compareStrings(a.id, b.id);
}

function toProcessStep(row: QueryRow): ProcessInfo['steps'][number] {
  return {
    step: (row.step || row[3] || 0) as number,
    name: (row.name || row[0]) as string,
    filePath: (row.filePath || row[1]) as string,
    type: (row.type || row[2]) as string,
  };
}

/** The full ordered step trace of one process. */
async function getProcessSteps(processId: string): Promise<ProcessInfo['steps']> {
  const stepRows = await executeQuery(
    REPO_ID,
    `
      MATCH (s)-[r:CodeRelation {type: 'STEP_IN_PROCESS'}]->(p:Process {id: '${escapeCypherString(processId)}'})
      RETURN s.name AS name, s.filePath AS filePath, labels(s)[0] AS type, r.step AS step
      ORDER BY r.step
    `,
  );
  return stepRows.map(toProcessStep);
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

  const inModule = new Set(filePaths);
  const edges = new Map<string, CallEdge>();

  // #2915: `filePaths` is caller-sized — every file of a module, and every file
  // under a parent module — so a single `IN [...]` literal holding all of them
  // grows the query text with the repo. Query one batch of callers at a time.
  //
  // The callee arm cannot ride along on the same batch: a caller in batch i may
  // call a file in batch j, and `b.filePath IN [batch]` would drop that edge.
  // It moves to JS against the whole set instead — the same predicate over the
  // same rows, paid for by also fetching each batch's calls that leave the set.
  for (const batch of chunk(filePaths)) {
    const rows = await executeQuery(
      REPO_ID,
      `
    MATCH (a)-[:CodeRelation {type: 'CALLS'}]->(b)
    WHERE a.filePath IN [${fileListLiteral(batch)}]
    RETURN DISTINCT a.filePath AS fromFile, a.name AS fromName,
           b.filePath AS toFile, b.name AS toName
  `,
    );

    for (const row of rows) {
      const edge = toCallEdge(row);
      // A callee with no filePath is not in the set — `IN` never matched a null
      // in the single-query form either.
      if (!inModule.has(edge.toFile)) continue;
      edges.set(callEdgeKey(edge), edge);
    }
  }

  // The single-query form had no ORDER BY, so its row order was whatever the
  // engine produced. Returning batch order instead would hand the whole 30-edge
  // window that `formatCallEdges` keeps (prompts.ts) to the first 100 files;
  // ordering on the symbol names spreads it across the set, for the same reason
  // getInterModuleCallEdges orders that way (#2787).
  return Array.from(edges.values()).sort(compareCallEdges);
}

/**
 * Get call edges crossing module boundaries (external calls from/to module files).
 */
export async function getInterModuleCallEdges(filePaths: string[]): Promise<{
  outgoing: CallEdge[];
  incoming: CallEdge[];
}> {
  if (filePaths.length === 0) return { outgoing: [], incoming: [] };

  const inModule = new Set(filePaths);
  const outgoing = new Map<string, CallEdge>();
  const incoming = new Map<string, CallEdge>();

  // #2915: one batch of module files per query, as in getIntraModuleCallEdges.
  //
  // The NOT arm keeps the SAME batch list rather than the whole set. That is
  // sound — a file outside the module is outside every batch, so the arm only
  // admits rows the JS filter below still rejects (a callee in another batch) —
  // and it is what preserves the null handling: `NOT null IN [...]` is null, so
  // the single-query form dropped edges to a node with no filePath, whereas a
  // JS-only `!inModule.has(undefined)` would have started admitting them.
  //
  // ORDER BY and LIMIT move to JS for the same reason: a per-batch LIMIT would
  // cut rows before the cross-batch membership filter ran, and could drop
  // members of the true top 30.
  for (const batch of chunk(filePaths)) {
    const fileList = fileListLiteral(batch);

    const outRows = await executeQuery(
      REPO_ID,
      `
    MATCH (a)-[:CodeRelation {type: 'CALLS'}]->(b)
    WHERE a.filePath IN [${fileList}] AND NOT b.filePath IN [${fileList}]
    RETURN DISTINCT a.filePath AS fromFile, a.name AS fromName,
           b.filePath AS toFile, b.name AS toName
  `,
    );
    for (const row of outRows) {
      const edge = toCallEdge(row);
      if (inModule.has(edge.toFile)) continue;
      outgoing.set(callEdgeKey(edge), edge);
    }

    const inRows = await executeQuery(
      REPO_ID,
      `
    MATCH (a)-[:CodeRelation {type: 'CALLS'}]->(b)
    WHERE NOT a.filePath IN [${fileList}] AND b.filePath IN [${fileList}]
    RETURN DISTINCT a.filePath AS fromFile, a.name AS fromName,
           b.filePath AS toFile, b.name AS toName
  `,
    );
    for (const row of inRows) {
      const edge = toCallEdge(row);
      if (inModule.has(edge.fromFile)) continue;
      incoming.set(callEdgeKey(edge), edge);
    }
  }

  // The sort leads with the symbol names, not the file paths. Ordering by
  // `fromFile` first makes the LIMIT a single-file prefix — on this repo's own
  // index the 30 outgoing edges of `core/wiki` all came from 1 of its 7 files,
  // so the module page described one file's external surface as the module's.
  // The four columns are the whole DISTINCT tuple, so any permutation is a
  // total order and equally deterministic (#2787); leading with the names just
  // spreads the window across files (1 → 7 of 7 here).
  return {
    outgoing: Array.from(outgoing.values())
      .sort(compareCallEdges)
      .slice(0, INTER_MODULE_EDGE_LIMIT),
    incoming: Array.from(incoming.values())
      .sort(compareCallEdges)
      .slice(0, INTER_MODULE_EDGE_LIMIT),
  };
}

/**
 * Get processes (execution flows) that pass through a set of files.
 * Returns top N by step count.
 */
export async function getProcessesForFiles(filePaths: string[], limit = 5): Promise<ProcessInfo[]> {
  if (filePaths.length === 0) return [];

  const byId = new Map<string, ProcessHeader>();

  // #2915: one batch of files per query. `LIMIT ${limit}` stays inside the
  // batch, unlike getInterModuleCallEdges: `stepCount DESC, id` is a total
  // order over the rows (p.id is unique), so a process in the global top
  // `limit` is in its own batch's top `limit` too, and nothing the merge would
  // have kept is cut here.
  for (const batch of chunk(filePaths)) {
    // Find processes that have steps in the given files
    const procRows = await executeQuery(
      REPO_ID,
      `
    MATCH (s)-[r:CodeRelation {type: 'STEP_IN_PROCESS'}]->(p:Process)
    WHERE s.filePath IN [${fileListLiteral(batch)}]
    RETURN DISTINCT p.id AS id, p.heuristicLabel AS label,
           p.processType AS type, p.stepCount AS stepCount
    ORDER BY stepCount DESC, id
    LIMIT ${limit}
  `,
    );

    // One process can have steps in files from several batches.
    for (const row of procRows) {
      const header = toProcessHeader(row);
      if (!byId.has(header.id)) byId.set(header.id, header);
    }
  }

  const top = Array.from(byId.values()).sort(compareProcessHeaders).slice(0, limit);

  const processes: ProcessInfo[] = [];
  for (const header of top) {
    // Get the full step trace for this process
    processes.push({ ...header, steps: await getProcessSteps(header.id) });
  }

  return processes;
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

  const processes: ProcessInfo[] = [];
  for (const row of procRows) {
    const header = toProcessHeader(row);
    processes.push({ ...header, steps: await getProcessSteps(header.id) });
  }

  return processes;
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
