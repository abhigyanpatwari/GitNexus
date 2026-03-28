/**
 * Graph Queries for Wiki Generation
 *
 * Encapsulated Cypher queries against the GitNexus knowledge graph.
 * Uses the MCP-style pooled lbug-adapter for connection management.
 */

import { initLbug, executeQuery, closeLbug, touchRepo } from '../../mcp/core/lbug-adapter.js';

const REPO_ID = '__wiki__';

/**
 * Touch the wiki DB connection to prevent idle timeout during long LLM calls.
 */
export function touchWikiDb(): void {
  touchRepo(REPO_ID);
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
 */
export async function getFilesWithExports(): Promise<FileWithExports[]> {
  const rows = await executeQuery(
    REPO_ID,
    `
    MATCH (f:File)-[:CodeRelation {type: 'DEFINES'}]->(n)
    WHERE n.isExported = true
    RETURN f.filePath AS filePath, n.name AS name, labels(n)[0] AS type
    ORDER BY f.filePath
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

  const fileList = filePaths.map((f) => `'${f.replace(/'/g, "''")}'`).join(', ');
  const rows = await executeQuery(
    REPO_ID,
    `
    MATCH (a)-[:CodeRelation {type: 'CALLS'}]->(b)
    WHERE a.filePath IN [${fileList}] AND b.filePath IN [${fileList}]
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
 * Get call edges crossing module boundaries (external calls from/to module files).
 */
export async function getInterModuleCallEdges(filePaths: string[]): Promise<{
  outgoing: CallEdge[];
  incoming: CallEdge[];
}> {
  if (filePaths.length === 0) return { outgoing: [], incoming: [] };

  const fileList = filePaths.map((f) => `'${f.replace(/'/g, "''")}'`).join(', ');

  const outRows = await executeQuery(
    REPO_ID,
    `
    MATCH (a)-[:CodeRelation {type: 'CALLS'}]->(b)
    WHERE a.filePath IN [${fileList}] AND NOT b.filePath IN [${fileList}]
    RETURN DISTINCT a.filePath AS fromFile, a.name AS fromName,
           b.filePath AS toFile, b.name AS toName
    LIMIT 30
  `,
  );

  const inRows = await executeQuery(
    REPO_ID,
    `
    MATCH (a)-[:CodeRelation {type: 'CALLS'}]->(b)
    WHERE NOT a.filePath IN [${fileList}] AND b.filePath IN [${fileList}]
    RETURN DISTINCT a.filePath AS fromFile, a.name AS fromName,
           b.filePath AS toFile, b.name AS toName
    LIMIT 30
  `,
  );

  return {
    outgoing: outRows.map((r) => ({
      fromFile: r.fromFile || r[0],
      fromName: r.fromName || r[1],
      toFile: r.toFile || r[2],
      toName: r.toName || r[3],
    })),
    incoming: inRows.map((r) => ({
      fromFile: r.fromFile || r[0],
      fromName: r.fromName || r[1],
      toFile: r.toFile || r[2],
      toName: r.toName || r[3],
    })),
  };
}

/**
 * Get processes (execution flows) that pass through a set of files.
 * Returns top N by step count.
 */
export async function getProcessesForFiles(filePaths: string[], limit = 5): Promise<ProcessInfo[]> {
  if (filePaths.length === 0) return [];

  const fileList = filePaths.map((f) => `'${f.replace(/'/g, "''")}'`).join(', ');

  // Find processes that have steps in the given files
  const procRows = await executeQuery(
    REPO_ID,
    `
    MATCH (s)-[r:CodeRelation {type: 'STEP_IN_PROCESS'}]->(p:Process)
    WHERE s.filePath IN [${fileList}]
    RETURN DISTINCT p.id AS id, p.heuristicLabel AS label,
           p.processType AS type, p.stepCount AS stepCount
    ORDER BY stepCount DESC
    LIMIT ${limit}
  `,
  );

  const processes: ProcessInfo[] = [];
  for (const row of procRows) {
    const procId = row.id || row[0];
    const label = row.label || row[1] || procId;
    const type = row.type || row[2] || 'unknown';
    const stepCount = row.stepCount || row[3] || 0;

    // Get the full step trace for this process
    const stepRows = await executeQuery(
      REPO_ID,
      `
      MATCH (s)-[r:CodeRelation {type: 'STEP_IN_PROCESS'}]->(p:Process {id: '${procId.replace(/'/g, "''")}'})
      RETURN s.name AS name, s.filePath AS filePath, labels(s)[0] AS type, r.step AS step
      ORDER BY r.step
    `,
    );

    processes.push({
      id: procId,
      label,
      type,
      stepCount,
      steps: stepRows.map((s) => ({
        step: s.step || s[3] || 0,
        name: s.name || s[0],
        filePath: s.filePath || s[1],
        type: s.type || s[2],
      })),
    });
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
    ORDER BY stepCount DESC
    LIMIT ${limit}
  `,
  );

  const processes: ProcessInfo[] = [];
  for (const row of procRows) {
    const procId = row.id || row[0];
    const label = row.label || row[1] || procId;
    const type = row.type || row[2] || 'unknown';
    const stepCount = row.stepCount || row[3] || 0;

    const stepRows = await executeQuery(
      REPO_ID,
      `
      MATCH (s)-[r:CodeRelation {type: 'STEP_IN_PROCESS'}]->(p:Process {id: '${procId.replace(/'/g, "''")}'})
      RETURN s.name AS name, s.filePath AS filePath, labels(s)[0] AS type, r.step AS step
      ORDER BY r.step
    `,
    );

    processes.push({
      id: procId,
      label,
      type,
      stepCount,
      steps: stepRows.map((s) => ({
        step: s.step || s[3] || 0,
        name: s.name || s[0],
        filePath: s.filePath || s[1],
        type: s.type || s[2],
      })),
    });
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
