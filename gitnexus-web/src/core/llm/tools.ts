/**
 * Graph RAG Tools for LangChain Agent
 * 
 * Consolidated tools (7 total):
 * - search: Hybrid search (BM25 + semantic + RRF), grouped by process/cluster
 * - cypher: Execute Cypher queries (auto-embeds {{QUERY_VECTOR}} if present)
 * - grep: Regex pattern search across files
 * - read: Read file content by path
 * - overview: Codebase map (clusters + processes)
 * - explore: Deep dive on a symbol, cluster, or process
 * - impact: Impact analysis (what depends on / is affected by changes)
 */

import { tool } from '@langchain/core/tools';
import { z } from 'zod';
// Note: GRAPH_SCHEMA_DESCRIPTION from './types' is available if needed for additional context
import { WebGPUNotAvailableError, embedText, embeddingToArray, initEmbedder, isEmbedderReady } from '../embeddings/embedder';
import { NODE_TABLES, REL_TYPES } from '../lbug/schema';

const validLabel = (label: string): boolean =>
  (NODE_TABLES as readonly string[]).includes(label);

const validRelType = (t: string): boolean =>
  (REL_TYPES as readonly string[]).includes(t);

/**
 * Tool factory - creates tools bound to the LadybugDB query functions
 */
export const createGraphRAGTools = (
  executeQuery: (cypher: string) => Promise<any[]>,
  semanticSearch: (query: string, k?: number, maxDistance?: number) => Promise<any[]>,
  semanticSearchWithContext: (query: string, k?: number, hops?: number) => Promise<any[]>,
  hybridSearch: (query: string, k?: number) => Promise<any[]>,
  isEmbeddingReady: () => boolean,
  isBM25Ready: () => boolean,
  fileContents: Map<string, string>
) => {

  // ============================================================================
  // TOOL 1: SEARCH (Hybrid + 1-hop expansion)
  // ============================================================================
  
  /**
   * Unified search tool: BM25 + Semantic + RRF, with 1-hop graph context
   */
  const searchTool = tool(
    async ({ query, limit, groupByProcess }: { query: string; limit?: number; groupByProcess?: boolean }) => {
      const k = limit ?? 10;
      const shouldGroup = groupByProcess ?? true;
      
      // Step 1: Hybrid search (BM25 + semantic with RRF)
      let searchResults: any[] = [];
      
      if (isBM25Ready()) {
        try {
          searchResults = await hybridSearch(query, k);
        } catch (error) {
          // Fallback to semantic-only if hybrid fails
          if (isEmbeddingReady()) {
            searchResults = await semanticSearch(query, k);
          }
        }
      } else if (isEmbeddingReady()) {
        // Semantic only if BM25 not ready
        searchResults = await semanticSearch(query, k);
      } else {
        return 'Search is not available. Please load a repository first.';
      }
      
      if (searchResults.length === 0) {
        return `No code found matching "${query}". Try different terms or use grep for exact patterns.`;
      }
      
      type ProcessInfo = { id: string; label: string; step?: number; stepCount?: number };
      type ResultInfo = {
        idx: number;
        nodeId: string;
        name: string;
        label: string;
        filePath: string;
        location: string;
        sources: string;
        score: string;
        connections: string;
        clusterLabel: string;
        processes: ProcessInfo[];
      };
      
      const results: ResultInfo[] = [];
      
      for (let i = 0; i < Math.min(searchResults.length, k); i++) {
        const r = searchResults[i];
        const nodeId = r.nodeId || r.id || '';
        const name = r.name || r.filePath?.split('/').pop() || 'Unknown';
        const label = r.label || 'File';
        const filePath = r.filePath || '';
        const location = r.startLine ? ` (lines ${r.startLine}-${r.endLine})` : '';
        const sources = r.sources?.join('+') || 'hybrid';
        const score = r.score ? ` [score: ${r.score.toFixed(2)}]` : '';
        
        // Get 1-hop connections using single CodeRelation table
        let connections = '';
        if (nodeId) {
          try {
            const nodeLabel = nodeId.split(':')[0];
            if (!validLabel(nodeLabel)) throw new Error('invalid label');
            const connectionsQuery = `
              MATCH (n:${nodeLabel} {id: '${nodeId.replace(/'/g, "''")}'})
              OPTIONAL MATCH (n)-[r1:CodeRelation]->(dst)
              OPTIONAL MATCH (src)-[r2:CodeRelation]->(n)
              RETURN
                collect(DISTINCT {name: dst.name, type: r1.type, confidence: r1.confidence}) AS outgoing,
                collect(DISTINCT {name: src.name, type: r2.type, confidence: r2.confidence}) AS incoming
              LIMIT 1
            `;
            const connRes = await executeQuery(connectionsQuery);
            if (connRes.length > 0) {
              const row = connRes[0];
              const rawOutgoing = Array.isArray(row) ? row[0] : (row.outgoing || []);
              const rawIncoming = Array.isArray(row) ? row[1] : (row.incoming || []);
              const outgoing = (rawOutgoing || []).filter((c: any) => c && c.name).slice(0, 3);
              const incoming = (rawIncoming || []).filter((c: any) => c && c.name).slice(0, 3);
              
              const fmt = (c: any, dir: 'out' | 'in') => {
                const conf = c.confidence ? Math.round(c.confidence * 100) : 100;
                return dir === 'out' 
                  ? `-[${c.type} ${conf}%]-> ${c.name}`
                  : `<-[${c.type} ${conf}%]- ${c.name}`;
              };
              
              const outList = outgoing.map((c: any) => fmt(c, 'out'));
              const inList = incoming.map((c: any) => fmt(c, 'in'));
              if (outList.length || inList.length) {
                connections = `\n    Connections: ${[...outList, ...inList].join(', ')}`;
              }
            }
          } catch {
            // Skip connections if query fails
          }
        }
        
        // Cluster membership
        let clusterLabel = 'Unclustered';
        if (nodeId) {
          try {
            const nodeLabel = nodeId.split(':')[0];
            if (!validLabel(nodeLabel)) throw new Error('invalid label');
            const clusterQuery = `
              MATCH (n:${nodeLabel} {id: '${nodeId.replace(/'/g, "''")}'})
              MATCH (n)-[:CodeRelation {type: 'MEMBER_OF'}]->(c:Community)
              RETURN c.label AS label
              LIMIT 1
            `;
            const clusterRes = await executeQuery(clusterQuery);
            if (clusterRes.length > 0) {
              const row = clusterRes[0];
              const labelValue = Array.isArray(row) ? row[0] : row.label;
              if (labelValue) clusterLabel = labelValue;
            }
          } catch {
            // Skip cluster lookup if query fails
          }
        }
        
        // Process participation
        const processes: ProcessInfo[] = [];
        if (nodeId) {
          try {
            const nodeLabel = nodeId.split(':')[0];
            if (!validLabel(nodeLabel)) throw new Error('invalid label');
            const processQuery = `
              MATCH (n:${nodeLabel} {id: '${nodeId.replace(/'/g, "''")}'})
              MATCH (n)-[r:CodeRelation {type: 'STEP_IN_PROCESS'}]->(p:Process)
              RETURN p.id AS id, p.label AS label, r.step AS step, p.stepCount AS stepCount
              ORDER BY r.step
            `;
            const procRes = await executeQuery(processQuery);
            for (const row of procRes) {
              const id = Array.isArray(row) ? row[0] : row.id;
              const labelValue = Array.isArray(row) ? row[1] : row.label;
              const step = Array.isArray(row) ? row[2] : row.step;
              const stepCount = Array.isArray(row) ? row[3] : row.stepCount;
              if (id && labelValue) {
                processes.push({ id, label: labelValue, step, stepCount });
              }
            }
          } catch {
            // Skip process lookup if query fails
          }
        }
        
        results.push({
          idx: i + 1,
          nodeId,
          name,
          label,
          filePath,
          location,
          sources,
          score,
          connections,
          clusterLabel,
          processes,
        });
      }
      
      const formatResult = (r: ResultInfo, stepInfo?: ProcessInfo) => {
        const stepLabel = stepInfo?.step ? ` (step ${stepInfo.step}/${stepInfo.stepCount ?? '?'})` : '';
        return `[${r.idx}] ${r.label}: ${r.name}${r.score}${stepLabel}\n    ID: ${r.nodeId}\n    File: ${r.filePath}${r.location}\n    Cluster: ${r.clusterLabel}\n    Found by: ${r.sources}${r.connections}`;
      };
      
      if (!shouldGroup) {
        return `Found ${searchResults.length} matches:\n\n${results.map(r => formatResult(r)).join('\n\n')}`;
      }
      
      // Group by process (or "No process")
      const processMap = new Map<string, { label: string; stepCount?: number; entries: { result: ResultInfo; step?: number; stepCount?: number }[] }>();
      const noProcessKey = '__no_process__';
      
      for (const r of results) {
        if (r.processes.length === 0) {
          if (!processMap.has(noProcessKey)) {
            processMap.set(noProcessKey, { label: 'No process', entries: [] });
          }
          processMap.get(noProcessKey)!.entries.push({ result: r });
          continue;
        }
        
        for (const p of r.processes) {
          if (!processMap.has(p.id)) {
            processMap.set(p.id, { label: p.label, stepCount: p.stepCount, entries: [] });
          }
          processMap.get(p.id)!.entries.push({ result: r, step: p.step, stepCount: p.stepCount });
        }
      }
      
      const sortedProcesses = Array.from(processMap.entries()).sort((a, b) => {
        const aCount = a[1].entries.length;
        const bCount = b[1].entries.length;
        return bCount - aCount;
      });
      
      const lines: string[] = [];
      lines.push(`Found ${searchResults.length} matches grouped by process:`);
      lines.push('');
      
      for (const [pid, group] of sortedProcesses) {
        const stepInfo = group.stepCount ? `, ${group.stepCount} steps` : '';
        const header = pid === noProcessKey
          ? `NO PROCESS (${group.entries.length} matches)`
          : `PROCESS: ${group.label} (${group.entries.length} matches${stepInfo})`;
        lines.push(header);
        group.entries.forEach(entry => {
          const stepLabel = entry.step ? { id: pid, label: group.label, step: entry.step, stepCount: entry.stepCount } : undefined;
          lines.push(formatResult(entry.result, stepLabel));
        });
        lines.push('');
      }
      
      return lines.join('\n').trim();
    },
    {
      name: 'search',
      description: 'Search for code by keywords or concepts. Combines keyword matching and semantic understanding. Groups results by process with cluster context.',
      schema: z.object({
        query: z.string().describe('What you are looking for (e.g., "authentication middleware", "database connection")'),
        groupByProcess: z.boolean().optional().nullable().describe('Group results by process (default: true)'),
        limit: z.number().optional().nullable().describe('Max results to return (default: 10)'),
      }),
    }
  );

  // ============================================================================
  // TOOL 2: CYPHER (Raw Cypher, auto-embeds {{QUERY_VECTOR}} if present)
  // ============================================================================
  
  /**
   * Execute Cypher queries with optional vector embedding
   */
  const cypherTool = tool(
    async ({ query, cypher }: { query?: string; cypher: string }) => {
      try {
        let finalCypher = cypher;
        
        // Auto-embed if {{QUERY_VECTOR}} placeholder is present
        if (cypher.includes('{{QUERY_VECTOR}}')) {
          if (!query) {
            return "Error: Your Cypher contains {{QUERY_VECTOR}} but you didn't provide a 'query' to embed. Add a natural language query.";
          }
          
          if (!isEmbeddingReady()) {
            // Try to init embedder
            try {
              await initEmbedder();
            } catch (err) {
              if (err instanceof WebGPUNotAvailableError) {
                await initEmbedder(undefined, {}, 'wasm');
              } else {
                return 'Embeddings not available. Remove {{QUERY_VECTOR}} and use a non-vector query.';
              }
            }
          }
          
          const queryEmbedding = await embedText(query);
          const queryVec = embeddingToArray(queryEmbedding);
          const queryVecStr = `CAST([${queryVec.join(',')}] AS FLOAT[384])`;
          finalCypher = cypher.replace(/\{\{\s*QUERY_VECTOR\s*\}\}/g, queryVecStr);
        }
        
        const results = await executeQuery(finalCypher);
        
        if (results.length === 0) {
          return 'Query returned no results.';
        }
        
        // Get column names from first result (now objects from executeQuery)
        const firstRow = results[0];
        const columnNames = typeof firstRow === 'object' && !Array.isArray(firstRow)
          ? Object.keys(firstRow)
          : [];
        
        // Format as markdown table (more token efficient than JSON per row)
        if (columnNames.length > 0) {
          const header = `| ${columnNames.join(' | ')} |`;
          const separator = `|${columnNames.map(() => '---').join('|')}|`;
          
          const rows = results.slice(0, 50).map(row => {
            const values = columnNames.map(col => {
              const val = row[col];
              if (val === null || val === undefined) return '';
              if (typeof val === 'object') return JSON.stringify(val);
              // Truncate long values and escape pipe characters
              const str = String(val).replace(/\|/g, '\\|');
              return str.length > 60 ? str.slice(0, 57) + '...' : str;
            });
            return `| ${values.join(' | ')} |`;
          }).join('\n');
          
          const truncated = results.length > 50 ? `\n\n_(${results.length - 50} more rows)_` : '';
          return `**${results.length} results:**\n\n${header}\n${separator}\n${rows}${truncated}`;
        }
        
        // Fallback for non-object results
        const formatted = results.slice(0, 50).map((row, i) => {
          return `[${i + 1}] ${JSON.stringify(row)}`;
        });
        const truncated = results.length > 50 ? `\n... (${results.length - 50} more)` : '';
        return `${results.length} results:\n${formatted.join('\n')}${truncated}`;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return `Cypher error: ${message}\n\nCheck your query syntax. Node tables: File, Folder, Function, Class, Interface, Method, CodeElement. Relation: CodeRelation with type property (CONTAINS, DEFINES, IMPORTS, CALLS). Example: MATCH (f:File)-[:CodeRelation {type: 'IMPORTS'}]->(g:File) RETURN f, g`;
      }
    },
    {
      name: 'cypher',
      description: `Execute a Cypher query against the code graph. Use for structural queries like finding callers, tracing imports, class inheritance, or custom traversals.

Node tables: File, Folder, Function, Class, Interface, Method, CodeElement
Relation: CodeRelation (single table with 'type' property: CONTAINS, DEFINES, IMPORTS, CALLS, EXTENDS, IMPLEMENTS)

Example queries:
- Functions calling a function: MATCH (caller:Function)-[:CodeRelation {type: 'CALLS'}]->(fn:Function {name: 'validate'}) RETURN caller.name, caller.filePath
- Class inheritance: MATCH (child:Class)-[:CodeRelation {type: 'EXTENDS'}]->(parent:Class) RETURN child.name, parent.name
- Classes implementing interface: MATCH (c:Class)-[:CodeRelation {type: 'IMPLEMENTS'}]->(i:Interface) RETURN c.name, i.name
- Files importing a file: MATCH (f:File)-[:CodeRelation {type: 'IMPORTS'}]->(target:File) WHERE target.name = 'utils.ts' RETURN f.name
- All connections (with confidence): MATCH (n)-[r:CodeRelation]-(m) WHERE n.name = 'MyClass' AND r.confidence > 0.8 RETURN m.name, r.type, r.confidence
- Find fuzzy matches: MATCH (n)-[r:CodeRelation]-(m) WHERE r.confidence < 0.8 RETURN n.name, r.reason

For semantic+graph queries, include {{QUERY_VECTOR}} placeholder and provide a 'query' parameter:
CALL QUERY_VECTOR_INDEX('CodeEmbedding', 'code_embedding_idx', {{QUERY_VECTOR}}, 10) YIELD node AS emb, distance
WITH emb, distance WHERE distance < 0.5
MATCH (n:Function {id: emb.nodeId}) RETURN n`,
      schema: z.object({
        cypher: z.string().describe('The Cypher query to execute'),
        query: z.string().optional().nullable().describe('Natural language query to embed (required if cypher contains {{QUERY_VECTOR}})'),
      }),
    }
  );

  // ============================================================================
  // TOOL 3: GREP (Regex pattern search)
  // ============================================================================
  
  const grepTool = tool(
    async ({ pattern, fileFilter, caseSensitive, maxResults }: { 
      pattern: string; 
      fileFilter?: string;
      caseSensitive?: boolean;
      maxResults?: number;
    }) => {
      try {
        const flags = caseSensitive ? 'g' : 'gi';
        let regex: RegExp;
        try {
          regex = new RegExp(pattern, flags);
        } catch (e) {
          return `Invalid regex: ${pattern}. Error: ${e instanceof Error ? e.message : String(e)}`;
        }
        
        const results: Array<{ file: string; line: number; content: string }> = [];
        const limit = maxResults ?? 100;
        
        for (const [filePath, content] of fileContents.entries()) {
          if (fileFilter && !filePath.toLowerCase().includes(fileFilter.toLowerCase())) {
            continue;
          }
          
          const lines = content.split('\n');
          for (let i = 0; i < lines.length; i++) {
            if (regex.test(lines[i])) {
              results.push({
                file: filePath,
                line: i + 1,
                content: lines[i].trim().slice(0, 150),
              });
              if (results.length >= limit) break;
            }
            regex.lastIndex = 0;
          }
          if (results.length >= limit) break;
        }
        
        if (results.length === 0) {
          return `No matches for "${pattern}"${fileFilter ? ` in files matching "${fileFilter}"` : ''}`;
        }
        
        const formatted = results.map(r => `${r.file}:${r.line}: ${r.content}`).join('\n');
        const truncatedMsg = results.length >= limit ? `\n\n(Showing first ${limit} results)` : '';
        
        return `Found ${results.length} matches:\n\n${formatted}${truncatedMsg}`;
      } catch (error) {
        return `Grep error: ${error instanceof Error ? error.message : String(error)}`;
      }
    },
    {
      name: 'grep',
      description: 'Search for exact text patterns across all files using regex. Use for finding specific strings, error messages, TODOs, variable names, etc.',
      schema: z.object({
        pattern: z.string().describe('Regex pattern to search for (e.g., "TODO", "console\\.log", "API_KEY")'),
        fileFilter: z.string().optional().nullable().describe('Only search files containing this string (e.g., ".ts", "src/api")'),
        caseSensitive: z.boolean().optional().nullable().describe('Case-sensitive search (default: false)'),
        maxResults: z.number().optional().nullable().describe('Max results (default: 100)'),
      }),
    }
  );

  // ============================================================================
  // TOOL 4: READ (Read file content)
  // ============================================================================
  
  const readTool = tool(
    async ({ filePath }: { filePath: string }) => {
      const normalizedRequest = filePath.replace(/\\/g, '/').toLowerCase();
      
      // Try exact match first
      let content = fileContents.get(filePath);
      let actualPath = filePath;
      
      // Smart matching if not found
      if (!content) {
        const candidates: Array<{ path: string; score: number }> = [];
        
        for (const [path] of fileContents.entries()) {
          const normalizedPath = path.toLowerCase();
          
          if (normalizedPath === normalizedRequest) {
            candidates.push({ path, score: 1000 });
          } else if (normalizedPath.endsWith(normalizedRequest)) {
            candidates.push({ path, score: 100 + (200 - path.length) });
          } else {
            const requestSegments = normalizedRequest.split('/').filter(Boolean);
            const pathSegments = normalizedPath.split('/');
            let matchScore = 0;
            let lastMatchIdx = -1;
            
            for (const seg of requestSegments) {
              const idx = pathSegments.findIndex((s, i) => i > lastMatchIdx && s.includes(seg));
              if (idx > lastMatchIdx) {
                matchScore += 10;
                lastMatchIdx = idx;
              }
            }
            
            if (matchScore >= requestSegments.length * 5) {
              candidates.push({ path, score: matchScore });
            }
          }
        }
        
        candidates.sort((a, b) => b.score - a.score);
        if (candidates.length > 0) {
          actualPath = candidates[0].path;
          content = fileContents.get(actualPath);
        }
      }
      
      if (!content) {
        const fileName = filePath.split('/').pop()?.toLowerCase() || '';
        const similar = Array.from(fileContents.keys())
          .filter(p => p.toLowerCase().includes(fileName))
          .slice(0, 5);
        
        if (similar.length > 0) {
          return `File not found: "${filePath}"\n\nDid you mean:\n${similar.map(f => `  - ${f}`).join('\n')}`;
        }
        return `File not found: "${filePath}"`;
      }
      
      // Truncate large files
      const MAX_CONTENT = 50000;
      if (content.length > MAX_CONTENT) {
        const lines = content.split('\n').length;
        return `File: ${actualPath} (${lines} lines, truncated)\n\n${content.slice(0, MAX_CONTENT)}\n\n... [truncated]`;
      }
      
      const lines = content.split('\n').length;
      return `File: ${actualPath} (${lines} lines)\n\n${content}`;
    },
    {
      name: 'read',
      description: 'Read the full content of a file. Use to see source code after finding files via search or grep.',
      schema: z.object({
        filePath: z.string().describe('File path to read (can be partial like "src/utils.ts")'),
      }),
    }
  );

  // ============================================================================
  // TOOL 5: OVERVIEW (Codebase map)
  // ============================================================================
  
  const overviewTool = tool(
    async () => {
      try {
        const clustersQuery = `
          MATCH (c:Community)
          RETURN c.id AS id, c.label AS label, c.cohesion AS cohesion, c.symbolCount AS symbolCount, c.description AS description
          ORDER BY c.symbolCount DESC
          LIMIT 200
        `;
        const processesQuery = `
          MATCH (p:Process)
          RETURN p.id AS id, p.label AS label, p.processType AS type, p.stepCount AS stepCount, p.communities AS communities
          ORDER BY p.stepCount DESC
          LIMIT 200
        `;
        const depsQuery = `
          MATCH (a)-[:CodeRelation {type: 'CALLS'}]->(b)
          MATCH (a)-[:CodeRelation {type: 'MEMBER_OF'}]->(c1:Community)
          MATCH (b)-[:CodeRelation {type: 'MEMBER_OF'}]->(c2:Community)
          WHERE c1.id <> c2.id
          RETURN c1.label AS \`from\`, c2.label AS \`to\`, COUNT(*) AS calls
          ORDER BY calls DESC
          LIMIT 15
        `;
        const criticalQuery = `
          MATCH (s)-[r:CodeRelation {type: 'STEP_IN_PROCESS'}]->(p:Process)
          RETURN p.label AS label, COUNT(r) AS steps
          ORDER BY steps DESC
          LIMIT 10
        `;
        
        const [clusters, processes, deps, critical] = await Promise.all([
          executeQuery(clustersQuery),
          executeQuery(processesQuery),
          executeQuery(depsQuery),
          executeQuery(criticalQuery),
        ]);
        
        const clusterLines = clusters.map((row: any) => {
          const label = Array.isArray(row) ? row[1] : row.label;
          const symbols = Array.isArray(row) ? row[3] : row.symbolCount;
          const cohesion = Array.isArray(row) ? row[2] : row.cohesion;
          const desc = Array.isArray(row) ? row[4] : row.description;
          const cohesionText = cohesion !== null && cohesion !== undefined ? Number(cohesion).toFixed(2) : '';
          return `| ${label || ''} | ${symbols ?? ''} | ${cohesionText} | ${desc ?? ''} |`;
        });
        
        const processLines = processes.map((row: any) => {
          const label = Array.isArray(row) ? row[1] : row.label;
          const steps = Array.isArray(row) ? row[3] : row.stepCount;
          const type = Array.isArray(row) ? row[2] : row.type;
          const communities = Array.isArray(row) ? row[4] : row.communities;
          const clusterText = Array.isArray(communities) ? communities.length : (communities ? 1 : 0);
          return `| ${label || ''} | ${steps ?? ''} | ${type ?? ''} | ${clusterText} |`;
        });
        
        const depLines = deps.map((row: any) => {
          const from = Array.isArray(row) ? row[0] : row.from;
          const to = Array.isArray(row) ? row[1] : row.to;
          const calls = Array.isArray(row) ? row[2] : row.calls;
          return `- ${from} -> ${to} (${calls} calls)`;
        });
        
        const criticalLines = critical.map((row: any) => {
          const label = Array.isArray(row) ? row[0] : row.label;
          const steps = Array.isArray(row) ? row[1] : row.steps;
          return `- ${label} (${steps} steps)`;
        });
        
        return [
          `CLUSTERS (${clusters.length} total):`,
          `| Cluster | Symbols | Cohesion | Description |`,
          `| --- | --- | --- | --- |`,
          ...clusterLines,
          ``,
          `PROCESSES (${processes.length} total):`,
          `| Process | Steps | Type | Clusters |`,
          `| --- | --- | --- | --- |`,
          ...processLines,
          ``,
          `CLUSTER DEPENDENCIES:`,
          ...(depLines.length > 0 ? depLines : ['- None found']),
          ``,
          `CRITICAL PATHS:`,
          ...(criticalLines.length > 0 ? criticalLines : ['- None found']),
        ].join('\n');
      } catch (error) {
        return `Overview error: ${error instanceof Error ? error.message : String(error)}`;
      }
    },
    {
      name: 'overview',
      description: 'Codebase map showing all clusters and processes, plus cross-cluster dependencies.',
      schema: z.object({}),
    }
  );

  // ============================================================================
  // TOOL 6: EXPLORE (Deep dive on symbol, cluster, or process)
  // ============================================================================
  
  const exploreTool = tool(
    async ({ target, type }: { target: string; type?: 'symbol' | 'cluster' | 'process' | null }) => {
      const safeTarget = target.replace(/'/g, "''");
      let resolvedType = type ?? null;
      let processRow: any | null = null;
      let communityRow: any | null = null;
      let symbolRow: any | null = null;
      
      const getRowValue = (row: any, idx: number, key: string) => Array.isArray(row) ? row[idx] : row[key];
      
      if (!resolvedType || resolvedType === 'process') {
        const processQuery = `
          MATCH (p:Process)
          WHERE p.id = '${safeTarget}' OR p.label = '${safeTarget}'
          RETURN p.id AS id, p.label AS label, p.processType AS type, p.stepCount AS stepCount
          LIMIT 1
        `;
        const processRes = await executeQuery(processQuery);
        if (processRes.length > 0) {
          processRow = processRes[0];
          resolvedType = 'process';
        }
      }
      
      if (!resolvedType || resolvedType === 'cluster') {
        const communityQuery = `
          MATCH (c:Community)
          WHERE c.id = '${safeTarget}' OR c.label = '${safeTarget}' OR c.heuristicLabel = '${safeTarget}'
          RETURN c.id AS id, c.label AS label, c.cohesion AS cohesion, c.symbolCount AS symbolCount, c.description AS description
          LIMIT 1
        `;
        const communityRes = await executeQuery(communityQuery);
        if (communityRes.length > 0) {
          communityRow = communityRes[0];
          resolvedType = 'cluster';
        }
      }
      
      if (!resolvedType || resolvedType === 'symbol') {
        const symbolQuery = `
          MATCH (n)
          WHERE n.name = '${safeTarget}' OR n.id = '${safeTarget}' OR n.filePath = '${safeTarget}'
          RETURN n.id AS id, n.name AS name, n.filePath AS filePath, label(n) AS nodeType
          LIMIT 5
        `;
        const symbolRes = await executeQuery(symbolQuery);
        if (symbolRes.length > 0) {
          symbolRow = symbolRes[0];
          resolvedType = 'symbol';
        }
      }
      
      if (!resolvedType) {
        return `Could not find "${target}" as a symbol, cluster, or process. Try search first.`;
      }
      
      if (resolvedType === 'process') {
        const pid = getRowValue(processRow, 0, 'id');
        const label = getRowValue(processRow, 1, 'label');
        const ptype = getRowValue(processRow, 2, 'type');
        const stepCount = getRowValue(processRow, 3, 'stepCount');
        
        const stepsQuery = `
          MATCH (s)-[r:CodeRelation {type: 'STEP_IN_PROCESS'}]->(p:Process {id: '${pid.replace(/'/g, "''")}'})
          RETURN s.name AS name, s.filePath AS filePath, r.step AS step
          ORDER BY r.step
        `;
        const clustersQuery = `
          MATCH (c:Community)<-[:CodeRelation {type: 'MEMBER_OF'}]-(s)
          MATCH (s)-[:CodeRelation {type: 'STEP_IN_PROCESS'}]->(p:Process {id: '${pid.replace(/'/g, "''")}'})
          RETURN DISTINCT c.id AS id, c.label AS label, c.description AS description
          ORDER BY c.label
          LIMIT 20
        `;
        
        const [steps, clusters] = await Promise.all([
          executeQuery(stepsQuery),
          executeQuery(clustersQuery),
        ]);
        
        const stepLines = steps.map((row: any) => {
          const name = getRowValue(row, 0, 'name');
          const filePath = getRowValue(row, 1, 'filePath');
          const step = getRowValue(row, 2, 'step');
          return `- ${step}. ${name} (${filePath || 'n/a'})`;
        });
        
        const clusterLines = clusters.map((row: any) => {
          const clabel = getRowValue(row, 1, 'label');
          const desc = getRowValue(row, 2, 'description');
          return `- ${clabel}${desc ? ` — ${desc}` : ''}`;
        });
        
        return [
          `PROCESS: ${label}`,
          `Type: ${ptype || 'n/a'}`,
          `Steps: ${stepCount ?? steps.length}`,
          ``,
          `STEPS:`,
          ...(stepLines.length > 0 ? stepLines : ['- None found']),
          ``,
          `CLUSTERS TOUCHED:`,
          ...(clusterLines.length > 0 ? clusterLines : ['- None found']),
        ].join('\n');
      }
      
      if (resolvedType === 'cluster') {
        const cid = getRowValue(communityRow, 0, 'id');
        const label = getRowValue(communityRow, 1, 'label');
        const cohesion = getRowValue(communityRow, 2, 'cohesion');
        const symbolCount = getRowValue(communityRow, 3, 'symbolCount');
        const description = getRowValue(communityRow, 4, 'description');
        
        const membersQuery = `
          MATCH (c:Community {id: '${cid.replace(/'/g, "''")}'})<-[:CodeRelation {type: 'MEMBER_OF'}]-(m)
          RETURN m.name AS name, m.filePath AS filePath, label(m) AS nodeType
          LIMIT 50
        `;
        const processesQuery = `
          MATCH (c:Community {id: '${cid.replace(/'/g, "''")}'})<-[:CodeRelation {type: 'MEMBER_OF'}]-(s)
          MATCH (s)-[:CodeRelation {type: 'STEP_IN_PROCESS'}]->(p:Process)
          RETURN DISTINCT p.id AS id, p.label AS label, p.stepCount AS stepCount
          ORDER BY p.stepCount DESC
          LIMIT 20
        `;
        
        const [members, processes] = await Promise.all([
          executeQuery(membersQuery),
          executeQuery(processesQuery),
        ]);
        
        const memberLines = members.map((row: any) => {
          const name = getRowValue(row, 0, 'name');
          const filePath = getRowValue(row, 1, 'filePath');
          const nodeType = getRowValue(row, 2, 'nodeType');
          return `- ${nodeType}: ${name} (${filePath || 'n/a'})`;
        });
        
        const processLines = processes.map((row: any) => {
          const plabel = getRowValue(row, 1, 'label');
          const steps = getRowValue(row, 2, 'stepCount');
          return `- ${plabel} (${steps} steps)`;
        });
        
        return [
          `CLUSTER: ${label}`,
          `Symbols: ${symbolCount ?? members.length}`,
          `Cohesion: ${cohesion !== null && cohesion !== undefined ? Number(cohesion).toFixed(2) : 'n/a'}`,
          `Description: ${description || 'n/a'}`,
          ``,
          `TOP MEMBERS:`,
          ...(memberLines.length > 0 ? memberLines : ['- None found']),
          ``,
          `PROCESSES TOUCHING THIS CLUSTER:`,
          ...(processLines.length > 0 ? processLines : ['- None found']),
        ].join('\n');
      }
      
      if (resolvedType === 'symbol') {
        const nodeId = getRowValue(symbolRow, 0, 'id');
        const name = getRowValue(symbolRow, 1, 'name');
        const filePath = getRowValue(symbolRow, 2, 'filePath');
        const nodeType = getRowValue(symbolRow, 3, 'nodeType');

        if (!validLabel(nodeType)) {
          return `Unknown node type "${nodeType}" for symbol "${target}".`;
        }

        const clusterQuery = `
          MATCH (n:${nodeType} {id: '${String(nodeId).replace(/'/g, "''")}'})
          MATCH (n)-[:CodeRelation {type: 'MEMBER_OF'}]->(c:Community)
          RETURN c.label AS label, c.description AS description
          LIMIT 1
        `;
        const processQuery = `
          MATCH (n:${nodeType} {id: '${String(nodeId).replace(/'/g, "''")}'})
          MATCH (n)-[r:CodeRelation {type: 'STEP_IN_PROCESS'}]->(p:Process)
          RETURN p.label AS label, r.step AS step, p.stepCount AS stepCount
          ORDER BY r.step
        `;
        const connectionsQuery = `
          MATCH (n:${nodeType} {id: '${String(nodeId).replace(/'/g, "''")}'})
          OPTIONAL MATCH (n)-[r1:CodeRelation]->(dst)
          OPTIONAL MATCH (src)-[r2:CodeRelation]->(n)
          RETURN 
            collect(DISTINCT {name: dst.name, type: r1.type, confidence: r1.confidence}) AS outgoing,
            collect(DISTINCT {name: src.name, type: r2.type, confidence: r2.confidence}) AS incoming
          LIMIT 1
        `;
        
        const [clusterRes, processRes, connRes] = await Promise.all([
          executeQuery(clusterQuery),
          executeQuery(processQuery),
          executeQuery(connectionsQuery),
        ]);
        
        const clusterLabel = clusterRes.length > 0 ? getRowValue(clusterRes[0], 0, 'label') : 'Unclustered';
        const clusterDesc = clusterRes.length > 0 ? getRowValue(clusterRes[0], 1, 'description') : '';
        
        const processLines = processRes.map((row: any) => {
          const plabel = getRowValue(row, 0, 'label');
          const step = getRowValue(row, 1, 'step');
          const stepCount = getRowValue(row, 2, 'stepCount');
          return `- ${plabel} (step ${step}/${stepCount ?? '?'})`;
        });
        
        let connections = 'None';
        if (connRes.length > 0) {
          const row = connRes[0];
          const rawOutgoing = Array.isArray(row) ? row[0] : (row.outgoing || []);
          const rawIncoming = Array.isArray(row) ? row[1] : (row.incoming || []);
          const outgoing = (rawOutgoing || []).filter((c: any) => c && c.name).slice(0, 5);
          const incoming = (rawIncoming || []).filter((c: any) => c && c.name).slice(0, 5);
          
          const fmt = (c: any, dir: 'out' | 'in') => {
            const conf = c.confidence ? Math.round(c.confidence * 100) : 100;
            return dir === 'out' 
              ? `-[${c.type} ${conf}%]-> ${c.name}`
              : `<-[${c.type} ${conf}%]- ${c.name}`;
          };
          const outList = outgoing.map((c: any) => fmt(c, 'out'));
          const inList = incoming.map((c: any) => fmt(c, 'in'));
          if (outList.length || inList.length) {
            connections = [...outList, ...inList].join(', ');
          }
        }
        
        return [
          `SYMBOL: ${nodeType} ${name}`,
          `ID: ${nodeId}`,
          `File: ${filePath || 'n/a'}`,
          `Cluster: ${clusterLabel}${clusterDesc ? ` — ${clusterDesc}` : ''}`,
          ``,
          `PROCESSES:`,
          ...(processLines.length > 0 ? processLines : ['- None found']),
          ``,
          `CONNECTIONS:`,
          connections,
        ].join('\n');
      }
      
      return `Unable to explore "${target}".`;
    },
    {
      name: 'explore',
      description: 'Deep dive on a symbol, cluster, or process. Shows membership, participation, and connections.',
      schema: z.object({
        target: z.string().describe('Name or ID of a symbol, cluster, or process'),
        type: z.enum(['symbol', 'cluster', 'process']).optional().nullable().describe('Optional target type (auto-detected if omitted)'),
      }),
    }
  );

  // ============================================================================
  // TOOL 7: IMPACT (Impact analysis)
  // ============================================================================
  
  const impactTool = tool(
    async ({ target, direction, maxDepth, relationTypes, includeTests, minConfidence }: { 
      target: string; 
      direction: 'upstream' | 'downstream';
      maxDepth?: number;
      relationTypes?: string[];
      includeTests?: boolean;
      minConfidence?: number;
    }) => {
      const depth = Math.min(maxDepth ?? 3, 10);
      const showTests = includeTests ?? false; // Default: exclude test files
      const minConf = minConfidence ?? 0.7; // Default: exclude fuzzy matches (<70% confidence)
      
      // Test file patterns
      const isTestFile = (path: string): boolean => {
        if (!path) return false;
        const p = path.toLowerCase();
        return p.includes('.test.') || p.includes('.spec.') || 
               p.includes('__tests__') || p.includes('__mocks__') ||
               p.endsWith('.test.ts') || p.endsWith('.test.tsx') ||
               p.endsWith('.spec.ts') || p.endsWith('.spec.tsx');
      };
      
      // Default to usage-based relation types (exclude CONTAINS, DEFINES for impact analysis)
      const defaultRelTypes = ['CALLS', 'IMPORTS', 'EXTENDS', 'IMPLEMENTS'];
      const activeRelTypes = relationTypes && relationTypes.length > 0
        ? relationTypes.filter(t => validRelType(t))
        : defaultRelTypes;
      if (activeRelTypes.length === 0) {
        return `No valid relation types provided. Valid types: ${(REL_TYPES as readonly string[]).join(', ')}`;
      }
      const relTypeFilter = activeRelTypes.map(t => `'${t.replace(/'/g, "''")}'`).join(', ');
      
      const directionLabel = direction === 'upstream' 
        ? 'Files that DEPEND ON this (breakage risk)'
        : 'Dependencies this RELIES ON';
      
      // Try to find the target node first
      // If target contains '/', search by filePath; otherwise by name
      const isPathQuery = target.includes('/');
      const escapedTarget = target.replace(/'/g, "''");
      
      const findTargetQuery = isPathQuery
        ? `
          MATCH (n) 
          WHERE n.filePath IS NOT NULL AND n.filePath CONTAINS '${escapedTarget}'
          RETURN n.id AS id, label(n) AS nodeType, n.filePath AS filePath
          LIMIT 10
        `
        : `
          MATCH (n) 
          WHERE n.name = '${escapedTarget}'
          RETURN n.id AS id, label(n) AS nodeType, n.filePath AS filePath
          LIMIT 10
        `;
      
      let targetResults;
      try {
        targetResults = await executeQuery(findTargetQuery);
      } catch (error) {
        return `Error finding target "${target}": ${error}`;
      }
      
      if (!targetResults || targetResults.length === 0) {
        return `Could not find "${target}" in the codebase. Try using the search tool first to find the exact name.`;
      }
      
      // Handle multiple matches - require disambiguation
      const allPaths = targetResults.map((r: any) => Array.isArray(r) ? r[2] : r.filePath).filter(Boolean);
      
      // If multiple matches and target doesn't look like a specific path, ask for clarification
      if (targetResults.length > 1 && !target.includes('/')) {
        return `⚠️ AMBIGUOUS TARGET: Multiple files named "${target}" found:\n\n${allPaths.map((p: string, i: number) => `${i + 1}. ${p}`).join('\n')}\n\nPlease specify which file you mean by using a more specific path, e.g.:\n- impact("${allPaths[0].split('/').slice(-3).join('/')}")\n- impact("${allPaths[1]?.split('/').slice(-3).join('/') || allPaths[0]}")`;
      }
      
      // If target contains a path, try to find matching file
      let targetNode = targetResults[0];
      if (target.includes('/') && targetResults.length > 1) {
        const exactMatch = targetResults.find((r: any) => {
          const path = Array.isArray(r) ? r[2] : r.filePath;
          return path && path.toLowerCase().includes(target.toLowerCase());
        });
        if (exactMatch) {
          targetNode = exactMatch;
        } else {
          // Still ambiguous even with path
          return `⚠️ AMBIGUOUS TARGET: Could not uniquely match "${target}". Found:\n\n${allPaths.map((p: string, i: number) => `${i + 1}. ${p}`).join('\n')}\n\nPlease use a more specific path.`;
        }
      }
      
      const targetId = Array.isArray(targetNode) ? targetNode[0] : targetNode.id;
      const targetType = Array.isArray(targetNode) ? targetNode[1] : targetNode.nodeType;
      const targetFilePath = Array.isArray(targetNode) ? targetNode[2] : targetNode.filePath;
      
      if (import.meta.env.DEV) {
        console.log(`🎯 Impact: Found target "${target}" → id=${targetId}, type=${targetType}, filePath=${targetFilePath}`);
      }
      
      // No more multipleMatchWarning needed - we either disambiguated or returned early
      const multipleMatchWarning = '';
      
      // For File targets, find what calls code INSIDE the file (by filePath)
      // For code elements (Function, Class, etc.), use the direct id
      const isFileTarget = targetType === 'File';
      
      // Query each depth level separately (LadybugDB doesn't support list comprehensions on paths)
      // For depth 1: direct connections only
      // For depth 2+: chain multiple single-hop queries
      const depthQueries: Promise<any[]>[] = [];
      
      // Depth 1 query - direct connections with edge metadata
      // For File targets: find callers of any code element with matching filePath
      const d1Query = direction === 'upstream'
        ? isFileTarget
          ? `
            MATCH (affected)-[r:CodeRelation]->(callee)
            WHERE callee.filePath = '${(targetFilePath || target).replace(/'/g, "''")}'
              AND r.type IN [${relTypeFilter}]
              AND affected.filePath <> callee.filePath
              AND (r.confidence IS NULL OR r.confidence >= ${minConf})
            RETURN DISTINCT 
              affected.id AS id, 
              affected.name AS name, 
              label(affected) AS nodeType, 
              affected.filePath AS filePath,
              affected.startLine AS startLine,
              1 AS depth,
              r.type AS edgeType,
              r.confidence AS confidence,
              r.reason AS reason
            LIMIT 300
          `
          : `
            MATCH (target {id: '${targetId.replace(/'/g, "''")}'})
            MATCH (affected)-[r:CodeRelation]->(target)
            WHERE r.type IN [${relTypeFilter}]
              AND (r.confidence IS NULL OR r.confidence >= ${minConf})
            RETURN DISTINCT 
              affected.id AS id, 
              affected.name AS name, 
              label(affected) AS nodeType, 
              affected.filePath AS filePath,
              affected.startLine AS startLine,
              1 AS depth,
              r.type AS edgeType,
              r.confidence AS confidence,
              r.reason AS reason
            LIMIT 300
          `
        : isFileTarget
          ? `
            MATCH (caller)-[r:CodeRelation]->(affected)
            WHERE caller.filePath = '${(targetFilePath || target).replace(/'/g, "''")}'
              AND r.type IN [${relTypeFilter}]
              AND caller.filePath <> affected.filePath
              AND (r.confidence IS NULL OR r.confidence >= ${minConf})
            RETURN DISTINCT 
              affected.id AS id, 
              affected.name AS name, 
              label(affected) AS nodeType, 
              affected.filePath AS filePath,
              affected.startLine AS startLine,
              1 AS depth,
              r.type AS edgeType,
              r.confidence AS confidence,
              r.reason AS reason
            LIMIT 300
          `
          : `
            MATCH (target {id: '${targetId.replace(/'/g, "''")}'})
            MATCH (target)-[r:CodeRelation]->(affected)
            WHERE r.type IN [${relTypeFilter}]
              AND (r.confidence IS NULL OR r.confidence >= ${minConf})
            RETURN DISTINCT 
              affected.id AS id, 
              affected.name AS name, 
              label(affected) AS nodeType, 
              affected.filePath AS filePath,
              affected.startLine AS startLine,
              1 AS depth,
              r.type AS edgeType,
              r.confidence AS confidence,
              r.reason AS reason
            LIMIT 300
          `;
      if (import.meta.env.DEV) {
        console.log(`🔍 Impact d=1 query:\n${d1Query}`);
      }
      depthQueries.push(executeQuery(d1Query).then(results => {
        if (import.meta.env.DEV) {
          console.log(`📊 Impact d=1 results: ${results.length} rows`);
          if (results.length > 0) {
            console.log('   Sample:', results.slice(0, 3));
          }
        }
        return results;
      }).catch(err => {
        if (import.meta.env.DEV) console.warn('Impact d=1 query failed:', err);
        return [];
      }));
      
      // Depth 2 query - 2 hops
      if (depth >= 2) {
        const d2Query = direction === 'upstream'
          ? `
            MATCH (target {id: '${targetId.replace(/'/g, "''")}'})
            MATCH (a)-[r1:CodeRelation]->(target)
            MATCH (affected)-[r2:CodeRelation]->(a)
            WHERE r1.type IN [${relTypeFilter}] AND r2.type IN [${relTypeFilter}]
              AND affected.id <> target.id
              AND (r1.confidence IS NULL OR r1.confidence >= ${minConf})
              AND (r2.confidence IS NULL OR r2.confidence >= ${minConf})
            RETURN DISTINCT 
              affected.id AS id, 
              affected.name AS name, 
              label(affected) AS nodeType, 
              affected.filePath AS filePath,
              affected.startLine AS startLine,
              2 AS depth,
              r2.type AS edgeType,
              r2.confidence AS confidence,
              r2.reason AS reason
            LIMIT 200
          `
          : `
            MATCH (target {id: '${targetId.replace(/'/g, "''")}'})
            MATCH (target)-[r1:CodeRelation]->(a)
            MATCH (a)-[r2:CodeRelation]->(affected)
            WHERE r1.type IN [${relTypeFilter}] AND r2.type IN [${relTypeFilter}]
              AND affected.id <> target.id
              AND (r1.confidence IS NULL OR r1.confidence >= ${minConf})
              AND (r2.confidence IS NULL OR r2.confidence >= ${minConf})
            RETURN DISTINCT 
              affected.id AS id, 
              affected.name AS name, 
              label(affected) AS nodeType, 
              affected.filePath AS filePath,
              affected.startLine AS startLine,
              2 AS depth,
              r2.type AS edgeType,
              r2.confidence AS confidence,
              r2.reason AS reason
            LIMIT 200
          `;
        depthQueries.push(executeQuery(d2Query).catch(err => {
          if (import.meta.env.DEV) console.warn('Impact d=2 query failed:', err);
          return [];
        }));
      }
      
      // Depth 3 query - 3 hops
      if (depth >= 3) {
        const d3Query = direction === 'upstream'
          ? `
            MATCH (target {id: '${targetId.replace(/'/g, "''")}'})
            MATCH (a)-[r1:CodeRelation]->(target)
            MATCH (b)-[r2:CodeRelation]->(a)
            MATCH (affected)-[r3:CodeRelation]->(b)
            WHERE r1.type IN [${relTypeFilter}] AND r2.type IN [${relTypeFilter}] AND r3.type IN [${relTypeFilter}]
              AND affected.id <> target.id AND affected.id <> a.id
              AND (r1.confidence IS NULL OR r1.confidence >= ${minConf})
              AND (r2.confidence IS NULL OR r2.confidence >= ${minConf})
              AND (r3.confidence IS NULL OR r3.confidence >= ${minConf})
            RETURN DISTINCT 
              affected.id AS id, 
              affected.name AS name, 
              label(affected) AS nodeType, 
              affected.filePath AS filePath,
              affected.startLine AS startLine,
              3 AS depth,
              r3.type AS edgeType,
              r3.confidence AS confidence,
              r3.reason AS reason
            LIMIT 100
          `
          : `
            MATCH (target {id: '${targetId.replace(/'/g, "''")}'})
            MATCH (target)-[r1:CodeRelation]->(a)
            MATCH (a)-[r2:CodeRelation]->(b)
            MATCH (b)-[r3:CodeRelation]->(affected)
            WHERE r1.type IN [${relTypeFilter}] AND r2.type IN [${relTypeFilter}] AND r3.type IN [${relTypeFilter}]
              AND affected.id <> target.id AND affected.id <> a.id
              AND (r1.confidence IS NULL OR r1.confidence >= ${minConf})
              AND (r2.confidence IS NULL OR r2.confidence >= ${minConf})
              AND (r3.confidence IS NULL OR r3.confidence >= ${minConf})
            RETURN DISTINCT 
              affected.id AS id, 
              affected.name AS name, 
              label(affected) AS nodeType, 
              affected.filePath AS filePath,
              affected.startLine AS startLine,
              3 AS depth,
              r3.type AS edgeType,
              r3.confidence AS confidence,
              r3.reason AS reason
            LIMIT 100
          `;
        depthQueries.push(executeQuery(d3Query).catch(err => {
          if (import.meta.env.DEV) console.warn('Impact d=3 query failed:', err);
          return [];
        }));
      }
      
      // Wait for all depth queries
      const depthResults = await Promise.all(depthQueries);
      
      // Combine results by depth
      interface NodeInfo {
        id: string;
        name: string;
        nodeType: string;
        filePath: string;
        startLine?: number;
        edgeType: string;
        confidence: number;
        reason: string;
      }
      const byDepth: Map<number, NodeInfo[]> = new Map();
      const allNodeIds: string[] = [];
      const seenIds = new Set<string>();
      
      depthResults.forEach((results, idx) => {
        const d = idx + 1;
        results.forEach((row: any) => {
          const nodeId = Array.isArray(row) ? row[0] : row.id;
          const filePath = Array.isArray(row) ? row[3] : row.filePath;
          
          // Skip test files if includeTests is false
          if (!showTests && isTestFile(filePath)) return;
          
          // Avoid duplicates (a node might appear at multiple depths)
          if (nodeId && !seenIds.has(nodeId)) {
            seenIds.add(nodeId);
            if (!byDepth.has(d)) byDepth.set(d, []);
            
            const info: NodeInfo = {
              id: nodeId,
              name: Array.isArray(row) ? row[1] : row.name,
              nodeType: Array.isArray(row) ? row[2] : row.nodeType,
              filePath: filePath,
              startLine: Array.isArray(row) ? row[4] : row.startLine,
              edgeType: Array.isArray(row) ? row[5] : row.edgeType || 'CALLS',
              confidence: Array.isArray(row) ? row[6] : row.confidence ?? 1.0,
              reason: Array.isArray(row) ? row[7] : row.reason || '',
            };
            byDepth.get(d)!.push(info);
            allNodeIds.push(nodeId);
          }
        });
      });
      
      const totalAffected = allNodeIds.length;
      
      if (totalAffected === 0) {
        if (isFileTarget) {
          const escapeRegex = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
          const targetFileName = (targetFilePath || target).split('/').pop() || target;
          const baseName = targetFileName.replace(/\.[^/.]+$/, '');
          const refRegex = new RegExp(`\\b${escapeRegex(baseName)}\\b`, 'g');
          const hints: Array<{ file: string; line: number; content: string }> = [];
          const hintLimit = 15;
          
          for (const [filePath, content] of fileContents.entries()) {
            if (filePath === targetFilePath) continue;
            const lines = content.split('\n');
            for (let i = 0; i < lines.length; i++) {
              if (refRegex.test(lines[i])) {
                hints.push({
                  file: filePath,
                  line: i + 1,
                  content: lines[i].trim().slice(0, 150),
                });
                if (hints.length >= hintLimit) break;
              }
              refRegex.lastIndex = 0;
            }
            if (hints.length >= hintLimit) break;
          }
          
          if (hints.length > 0) {
            const formatted = hints.map(h => `${h.file}:${h.line}: ${h.content}`).join('\n');
            return `No ${direction} dependencies found for "${target}" (types: ${activeRelTypes.join(', ')}), but textual references were detected (graph may be incomplete):\n\n${formatted}${multipleMatchWarning}`;
          }
        }

        return `No ${direction} dependencies found for "${target}" (types: ${activeRelTypes.join(', ')}). This code appears to be ${direction === 'upstream' ? 'unused (not called by anything)' : 'self-contained (no outgoing dependencies)'}.${multipleMatchWarning}`;
      }
      
      const depth1 = byDepth.get(1) || [];
      const depth2 = byDepth.get(2) || [];
      const depth3 = byDepth.get(3) || [];
      
      // Confidence buckets
      const confidenceBuckets = { high: 0, medium: 0, low: 0 };
      for (const nodes of byDepth.values()) {
        for (const n of nodes) {
          const conf = n.confidence ?? 1;
          if (conf >= 0.9) confidenceBuckets.high += 1;
          else if (conf >= 0.8) confidenceBuckets.medium += 1;
          else confidenceBuckets.low += 1;
        }
      }
      
      // Affected processes and clusters
      const maxIdsForContext = 500;
      const trimmedIds = allNodeIds.slice(0, maxIdsForContext);
      const idList = trimmedIds.map(id => `'${id.replace(/'/g, "''")}'`).join(', ');
      let affectedProcesses: Array<{ label: string; hits: number; minStep: number | null; stepCount: number | null }> = [];
      let affectedClusters: Array<{ label: string; hits: number; impact: string }> = [];
      
      if (trimmedIds.length > 0) {
        const processQuery = `
          MATCH (s)-[r:CodeRelation {type: 'STEP_IN_PROCESS'}]->(p:Process)
          WHERE s.id IN [${idList}]
          RETURN p.label AS label, COUNT(DISTINCT s.id) AS hits, MIN(r.step) AS minStep, p.stepCount AS stepCount
          ORDER BY hits DESC
          LIMIT 20
        `;
        const clusterQuery = `
          MATCH (s)-[:CodeRelation {type: 'MEMBER_OF'}]->(c:Community)
          WHERE s.id IN [${idList}]
          RETURN c.label AS label, COUNT(DISTINCT s.id) AS hits
          ORDER BY hits DESC
          LIMIT 20
        `;
        const directIdList = depth1.map(n => `'${n.id.replace(/'/g, "''")}'`).join(', ');
        const directClusterQuery = depth1.length > 0 ? `
          MATCH (s)-[:CodeRelation {type: 'MEMBER_OF'}]->(c:Community)
          WHERE s.id IN [${directIdList}]
          RETURN DISTINCT c.label AS label
        ` : '';
        
        const [processRes, clusterRes, directClusterRes] = await Promise.all([
          executeQuery(processQuery),
          executeQuery(clusterQuery),
          directClusterQuery ? executeQuery(directClusterQuery) : Promise.resolve([]),
        ]);
        
        const directClusterSet = new Set<string>();
        directClusterRes.forEach((row: any) => {
          const label = Array.isArray(row) ? row[0] : row.label;
          if (label) directClusterSet.add(label);
        });
        
        affectedProcesses = processRes.map((row: any) => ({
          label: Array.isArray(row) ? row[0] : row.label,
          hits: Array.isArray(row) ? row[1] : row.hits,
          minStep: Array.isArray(row) ? row[2] : row.minStep,
          stepCount: Array.isArray(row) ? row[3] : row.stepCount,
        }));
        
        affectedClusters = clusterRes.map((row: any) => {
          const label = Array.isArray(row) ? row[0] : row.label;
          const hits = Array.isArray(row) ? row[1] : row.hits;
          const impact = directClusterSet.has(label) ? 'direct' : 'indirect';
          return { label, hits, impact };
        });
      }
      
      const directCount = depth1.length;
      const processCount = affectedProcesses.length;
      const clusterCount = affectedClusters.length;
      let risk = 'LOW';
      if (directCount >= 30 || processCount >= 5 || clusterCount >= 5 || totalAffected >= 200) {
        risk = 'CRITICAL';
      } else if (directCount >= 15 || processCount >= 3 || clusterCount >= 3 || totalAffected >= 100) {
        risk = 'HIGH';
      } else if (directCount >= 5 || totalAffected >= 30) {
        risk = 'MEDIUM';
      }
      
      // ===== COMPACT TABULAR OUTPUT =====
      const lines: string[] = [
        `🔴 IMPACT: ${target} | ${direction} | ${totalAffected} affected`,
        `Confidence: High ${confidenceBuckets.high} | Medium ${confidenceBuckets.medium} | Low ${confidenceBuckets.low}`,
        ``,
        `AFFECTED PROCESSES:`,
        ...(affectedProcesses.length > 0
          ? affectedProcesses.map(p => `- ${p.label} - BROKEN at step ${p.minStep ?? '?'} (${p.hits} symbols, ${p.stepCount ?? '?'} steps)`)
          : ['- None found']),
        ``,
        `AFFECTED CLUSTERS:`,
        ...(affectedClusters.length > 0
          ? affectedClusters.map(c => `- ${c.label} (${c.impact}, ${c.hits} symbols)`)
          : ['- None found']),
        ``,
        `RISK: ${risk}`,
        `- Direct callers: ${directCount}`,
        `- Processes affected: ${processCount}`,
        `- Clusters affected: ${clusterCount}`,
        ``,
      ];
      
      // Format helper: Type|Name|File:Line|EdgeType|Confidence
      const formatNode = (n: NodeInfo): string => {
        const fileName = n.filePath?.split('/').pop() || '';
        const loc = n.startLine ? `${fileName}:${n.startLine}` : fileName;
        const confPct = Math.round((n.confidence ?? 1) * 100);
        const fuzzyMarker = confPct < 80 ? '[fuzzy]' : '';
        return `  ${n.nodeType}|${n.name}|${loc}|${n.edgeType}|${confPct}%${fuzzyMarker}`;
      };
      
      // Helper to get code snippet for a node (call site context)
      const getCallSiteSnippet = (n: NodeInfo): string | null => {
        if (!n.filePath || !n.startLine) return null;
        
        // Find the file in fileContents (try multiple path formats)
        let content: string | undefined;
        const normalizedPath = n.filePath.replace(/\\/g, '/');
        
        for (const [path, c] of fileContents.entries()) {
          const normalizedKey = path.replace(/\\/g, '/');
          if (normalizedKey === normalizedPath || 
              normalizedKey.endsWith(normalizedPath) || 
              normalizedPath.endsWith(normalizedKey)) {
            content = c;
            break;
          }
        }
        
        if (!content) return null;
        
        const lines = content.split('\n');
        const lineIdx = n.startLine - 1;
        if (lineIdx < 0 || lineIdx >= lines.length) return null;
        
        // Get the line and trim it, max 80 chars
        let snippet = lines[lineIdx].trim();
        if (snippet.length > 80) snippet = snippet.slice(0, 77) + '...';
        return snippet;
      };
      
      // Depth 1 - Critical (with call site snippets)
      if (depth1.length > 0) {
        const header = direction === 'upstream'
          ? `d=1 (Directly DEPEND ON ${target}):`
          : `d=1 (${target} USES these):`;
        lines.push(header);
        depth1.slice(0, 15).forEach(n => {
          lines.push(formatNode(n));
          // Add call site snippet for d=1 results
          const snippet = getCallSiteSnippet(n);
          if (snippet) {
            lines.push(`    ↳ "${snippet}"`);
          }
        });
        if (depth1.length > 15) lines.push(`  ... +${depth1.length - 15} more`);
        lines.push(``);
      }
      
      // Depth 2 - High impact
      if (depth2.length > 0) {
        const header = direction === 'upstream'
          ? `d=2 (Indirectly DEPEND ON ${target}):`
          : `d=2 (${target} USES these indirectly):`;
        lines.push(header);
        depth2.slice(0, 15).forEach(n => lines.push(formatNode(n)));
        if (depth2.length > 15) lines.push(`  ... +${depth2.length - 15} more`);
        lines.push(``);
      }
      
      // Depth 3 - Transitive
      if (depth3.length > 0) {
        lines.push(`d=3 (Deep impact/dependency):`);
        depth3.slice(0, 5).forEach(n => lines.push(formatNode(n)));
        if (depth3.length > 5) lines.push(`  ... +${depth3.length - 5} more`);
        lines.push(``);
      }
      
      // Compact footer
      lines.push(`✅ GRAPH ANALYSIS COMPLETE (trusted)`);
      lines.push(`⚠️ Optional: grep("${target}") for dynamic patterns`);
      if (multipleMatchWarning) {
        lines.push(multipleMatchWarning);
      }
      lines.push(``);
      
      return lines.join('\n');
    },
    {
      name: 'impact',
      description: `Analyze the impact of changing a function, class, or file.

Use when users ask:
- "What would break if I changed X?"
- "What depends on X?"
- "Impact analysis for X"

Direction:
- upstream: Find what CALLS/IMPORTS/EXTENDS this target (what would break)
- downstream: Find what this target CALLS/IMPORTS/EXTENDS (dependencies)

Output format (compact tabular):
  Type|Name|File:Line|EdgeType|Confidence%
  
EdgeType: CALLS, IMPORTS, EXTENDS, IMPLEMENTS
Confidence: 100% = certain, <80% = fuzzy match (may be false positive)

relationTypes filter (optional):
- Default: CALLS, IMPORTS, EXTENDS, IMPLEMENTS (usage-based)
- Can add CONTAINS, DEFINES for structural analysis

Additional output sections:
- Affected processes (with step impact)
- Affected clusters (direct/indirect)
- Risk summary (based on direct callers, processes, clusters)`,
      schema: z.object({
        target: z.string().describe('Name of the function, class, or file to analyze'),
        direction: z.enum(['upstream', 'downstream']).describe('upstream = what depends on this; downstream = what this depends on'),
        maxDepth: z.number().optional().nullable().describe('Max traversal depth (default: 3, max: 10)'),
        relationTypes: z.array(z.string()).optional().nullable().describe('Filter by relation types: CALLS, IMPORTS, EXTENDS, IMPLEMENTS, CONTAINS, DEFINES (default: usage-based)'),
        includeTests: z.boolean().optional().nullable().describe('Include test files in results (default: false, excludes .test.ts, .spec.ts, __tests__)'),
        minConfidence: z.number().optional().nullable().describe('Minimum edge confidence 0-1 (default: 0.7, excludes fuzzy/inferred matches)'),
      }),
    }
  );

  // ============================================================================
  // RETURN ALL TOOLS
  // ============================================================================
  
  return [
    searchTool,
    cypherTool,
    grepTool,
    readTool,
    overviewTool,
    exploreTool,
    impactTool,
  ];
};
