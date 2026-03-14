/**
 * Augmentation Engine
 * 
 * Lightweight, fast-path enrichment of search patterns with knowledge graph context.
 * Designed to be called from platform hooks (Claude Code PreToolUse, Cursor beforeShellExecution)
 * when an agent runs grep/glob/search.
 * 
 * Performance target: <500ms cold start, <200ms warm.
 * 
 * Design decisions:
 * - Uses only BM25 search (no semantic/embedding) for speed
 * - Clusters used internally for ranking, NEVER in output
 * - Output is pure relationships: callers, callees, process participation
 * - Graceful failure: any error → return empty string
 */

import path from 'path';
import { listRegisteredRepos } from '../../storage/repo-manager.js';

/**
 * Find the best matching repo for a given working directory.
 * Matches by checking if cwd is within the repo's path.
 */
async function findRepoForCwd(cwd: string): Promise<{
  name: string;
  storagePath: string;
  lbugPath: string;
} | null> {
  try {
    const entries = await listRegisteredRepos({ validate: true });
    const resolved = path.resolve(cwd);
    
    // Normalize to lowercase on Windows (drive letters can differ: D: vs d:)
    const isWindows = process.platform === 'win32';
    const normalizedCwd = isWindows ? resolved.toLowerCase() : resolved;
    const sep = path.sep;
    
    // Find the LONGEST matching repo path (most specific match wins)
    let bestMatch: typeof entries[0] | null = null;
    let bestLen = 0;
    
    for (const entry of entries) {
      const repoResolved = path.resolve(entry.path);
      const normalizedRepo = isWindows ? repoResolved.toLowerCase() : repoResolved;
      
      // Check if cwd is inside repo OR repo is inside cwd
      // Must match at a path separator boundary to avoid false positives
      // (e.g. /projects/gitnexusv2 should NOT match /projects/gitnexus)
      let matched = false;
      if (normalizedCwd === normalizedRepo) {
        matched = true;
      } else if (normalizedCwd.startsWith(normalizedRepo + sep)) {
        matched = true;
      } else if (normalizedRepo.startsWith(normalizedCwd + sep)) {
        matched = true;
      }
      
      if (matched && normalizedRepo.length > bestLen) {
        bestMatch = entry;
        bestLen = normalizedRepo.length;
      }
    }
    
    if (!bestMatch) return null;
    
    return {
      name: bestMatch.name,
      storagePath: bestMatch.storagePath,
      lbugPath: path.join(bestMatch.storagePath, 'lbug'),
    };
  } catch {
    return null;
  }
}

/**
 * Augment a search pattern with knowledge graph context.
 * 
 * 1. BM25 search for the pattern
 * 2. For top matches, fetch callers/callees/processes
 * 3. Rank by internal cluster cohesion (not exposed)
 * 4. Format as structured text block
 * 
 * Returns empty string on any error (graceful failure).
 */
export async function augment(pattern: string, cwd?: string): Promise<string> {
  if (!pattern || pattern.length < 3) return '';
  
  const workDir = cwd || process.cwd();
  
  try {
    const repo = await findRepoForCwd(workDir);
    if (!repo) return '';
    
    // Lazy-load lbug adapter (skip unnecessary init)
    const { initLbug, executeQuery, isLbugReady } = await import('../../mcp/core/lbug-adapter.js');
    const { searchFTSFromLbug } = await import('../search/bm25-index.js');

    const repoId = repo.name.toLowerCase();

    // Init LadybugDB if not already
    if (!isLbugReady(repoId)) {
      await initLbug(repoId, repo.lbugPath);
    }

    // Step 1: BM25 search (fast, no embeddings)
    const bm25Results = await searchFTSFromLbug(pattern, 10, repoId);
    
    if (bm25Results.length === 0) return '';
    
    // Step 2: Map BM25 file results to symbols
    const symbolMatches: Array<{
      nodeId: string;
      name: string;
      type: string;
      filePath: string;
      score: number;
    }> = [];
    
    for (const result of bm25Results.slice(0, 5)) {
      const escaped = result.filePath.replace(/'/g, "''");
      try {
        const symbols = await executeQuery(repoId, `
          MATCH (n) WHERE n.filePath = '${escaped}'
          AND n.name CONTAINS '${pattern.replace(/'/g, "''").split(/\s+/)[0]}'
          RETURN n.id AS id, n.name AS name, labels(n)[0] AS type, n.filePath AS filePath
          LIMIT 3
        `);
        for (const sym of symbols) {
          symbolMatches.push({
            nodeId: sym.id || sym[0],
            name: sym.name || sym[1],
            type: sym.type || sym[2],
            filePath: sym.filePath || sym[3],
            score: result.score,
          });
        }
      } catch { /* skip */ }
    }
    
    if (symbolMatches.length === 0) return '';
    
    // Step 3: For top matches, fetch callers/callees/processes
    // Also get cluster cohesion internally for ranking
    const enriched: Array<{
      name: string;
      filePath: string;
      callers: string[];
      callees: string[];
      processes: string[];
      cohesion: number;
    }> = [];
    
    const seen = new Set<string>();
    
    for (const sym of symbolMatches.slice(0, 5)) {
      if (seen.has(sym.nodeId)) continue;
      seen.add(sym.nodeId);
      
      const escaped = sym.nodeId.replace(/'/g, "''");
      
      // Callers
      let callers: string[] = [];
      try {
        const rows = await executeQuery(repoId, `
          MATCH (caller)-[:CodeRelation {type: 'CALLS'}]->(n {id: '${escaped}'})
          RETURN caller.name AS name
          LIMIT 3
        `);
        callers = rows.map((r: any) => r.name || r[0]).filter(Boolean);
      } catch { /* skip */ }
      
      // Callees
      let callees: string[] = [];
      try {
        const rows = await executeQuery(repoId, `
          MATCH (n {id: '${escaped}'})-[:CodeRelation {type: 'CALLS'}]->(callee)
          RETURN callee.name AS name
          LIMIT 3
        `);
        callees = rows.map((r: any) => r.name || r[0]).filter(Boolean);
      } catch { /* skip */ }
      
      // Processes
      let processes: string[] = [];
      try {
        const rows = await executeQuery(repoId, `
          MATCH (n {id: '${escaped}'})-[r:CodeRelation {type: 'STEP_IN_PROCESS'}]->(p:Process)
          RETURN p.heuristicLabel AS label, r.step AS step, p.stepCount AS stepCount
        `);
        processes = rows.map((r: any) => {
          const label = r.label || r[0];
          const step = r.step || r[1];
          const stepCount = r.stepCount || r[2];
          return `${label} (step ${step}/${stepCount})`;
        }).filter(Boolean);
      } catch { /* skip */ }
      
      // Cluster cohesion (internal ranking signal)
      let cohesion = 0;
      try {
        const rows = await executeQuery(repoId, `
          MATCH (n {id: '${escaped}'})-[:CodeRelation {type: 'MEMBER_OF'}]->(c:Community)
          RETURN c.cohesion AS cohesion
          LIMIT 1
        `);
        if (rows.length > 0) {
          cohesion = (rows[0].cohesion ?? rows[0][0]) || 0;
        }
      } catch { /* skip */ }
      
      enriched.push({
        name: sym.name,
        filePath: sym.filePath,
        callers,
        callees,
        processes,
        cohesion,
      });
    }
    
    if (enriched.length === 0) return '';
    
    // Step 4: Rank by cohesion (internal signal) and format
    enriched.sort((a, b) => b.cohesion - a.cohesion);
    
    const lines: string[] = [`[GitNexus] ${enriched.length} related symbols found:`, ''];
    
    for (const item of enriched) {
      lines.push(`${item.name} (${item.filePath})`);
      if (item.callers.length > 0) {
        lines.push(`  Called by: ${item.callers.join(', ')}`);
      }
      if (item.callees.length > 0) {
        lines.push(`  Calls: ${item.callees.join(', ')}`);
      }
      if (item.processes.length > 0) {
        lines.push(`  Flows: ${item.processes.join(', ')}`);
      }
      lines.push('');
    }
    
    return lines.join('\n').trim();
  } catch {
    // Graceful failure — never break the original tool
    return '';
  }
}
