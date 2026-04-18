/**
 * Local Backend (Multi-Repo)
 *
 * Provides tool implementations using local .gitnexus/ indexes.
 * Supports multiple indexed repositories via a global registry.
 * LadybugDB connections are opened lazily per repo on first query.
 */

import fs from 'fs/promises';
import path from 'path';
import {
  initLbug,
  executeQuery,
  executeParameterized,
  closeLbug,
  isLbugReady,
  isWriteQuery,
} from '../../core/lbug/pool-adapter.js';
export { isWriteQuery };
// Embedding imports are lazy (dynamic import) to avoid loading onnxruntime-node
// at MCP server startup — crashes on unsupported Node ABI versions (#89)
// git utilities available if needed
// import { isGitRepo, getCurrentCommit, getGitRoot } from '../../storage/git.js';
import { parseDiffHunks, type FileDiff } from '../../storage/git.js';
import {
  listRegisteredRepos,
  cleanupOldKuzuFiles,
  type RegistryEntry,
} from '../../storage/repo-manager.js';
import { GroupService, type GroupToolPort } from '../../core/group/service.js';
import { collectBestChunks } from '../../core/embeddings/types.js';
import { EMBEDDING_TABLE_NAME, EMBEDDING_INDEX_NAME } from '../../core/lbug/schema.js';
// AI context generation is CLI-only (gitnexus analyze)
// import { generateAIContextFiles } from '../../cli/ai-context.js';

/**
 * Quick test-file detection for filtering impact results.
 * Matches common test file patterns across all supported languages.
 */
export function isTestFilePath(filePath: string): boolean {
  const p = filePath.toLowerCase().replace(/\\/g, '/');
  return (
    p.includes('.test.') ||
    p.includes('.spec.') ||
    p.includes('__tests__/') ||
    p.includes('__mocks__/') ||
    p.includes('/test/') ||
    p.includes('/tests/') ||
    p.includes('/testing/') ||
    p.includes('/fixtures/') ||
    p.endsWith('_test.go') ||
    p.endsWith('_test.py') ||
    p.endsWith('_spec.rb') ||
    p.endsWith('_test.rb') ||
    p.includes('/spec/') ||
    p.includes('/test_') ||
    p.includes('/conftest.')
  );
}

/** Valid LadybugDB node labels for safe Cypher query construction */
export const VALID_NODE_LABELS = new Set([
  'File',
  'Folder',
  'Function',
  'Class',
  'Interface',
  'Method',
  'CodeElement',
  'Community',
  'Process',
  'Struct',
  'Enum',
  'Macro',
  'Typedef',
  'Union',
  'Namespace',
  'Trait',
  'Impl',
  'TypeAlias',
  'Const',
  'Static',
  'Property',
  'Record',
  'Delegate',
  'Annotation',
  'Constructor',
  'Template',
  'Module',
  'Route',
  'Tool',
]);

/** Valid relation types for impact analysis filtering */
export const VALID_RELATION_TYPES = new Set([
  'CALLS',
  'IMPORTS',
  'EXTENDS',
  'IMPLEMENTS',
  'HAS_METHOD',
  'HAS_PROPERTY',
  'METHOD_OVERRIDES',
  'OVERRIDES', // Legacy alias — dual-read for pre-rename indexes
  'METHOD_IMPLEMENTS',
  'ACCESSES',
  'HANDLES_ROUTE',
  'FETCHES',
  'HANDLES_TOOL',
  'ENTRY_POINT_OF',
  'WRAPS',
]);

/**
 * Per-relation-type confidence floor for impact analysis.
 *
 * When the graph stores a relation with a confidence value, that stored
 * value is used as-is (it reflects resolution-tier accuracy from analysis
 * time).  This map provides the floor for each edge type when no stored
 * confidence is available, and is also used for display / tooltip hints.
 *
 * Rationale:
 *   CALLS / IMPORTS  – direct, strongly-typed references → 0.9
 *   EXTENDS          – class hierarchy, statically verifiable → 0.85
 *   IMPLEMENTS       – interface contract, statically verifiable → 0.85
 *   METHOD_OVERRIDES  – method override, statically verifiable → 0.85
 *   METHOD_IMPLEMENTS – interface method implementation, statically verifiable → 0.85
 *   HAS_METHOD       – structural containment → 0.95
 *   HAS_PROPERTY     – structural containment → 0.95
 *   ACCESSES         – field read/write, may be indirect → 0.8
 *   CONTAINS         – folder/file containment → 0.95
 *   (unknown type)   – conservative fallback → 0.5
 */
export const IMPACT_RELATION_CONFIDENCE: Readonly<Record<string, number>> = {
  CALLS: 0.9,
  IMPORTS: 0.9,
  EXTENDS: 0.85,
  IMPLEMENTS: 0.85,
  METHOD_OVERRIDES: 0.85,
  METHOD_IMPLEMENTS: 0.85,
  HAS_METHOD: 0.95,
  HAS_PROPERTY: 0.95,
  ACCESSES: 0.8,
  CONTAINS: 0.95,
};

/**
 * Return the confidence floor for a given relation type.
 * Falls back to 0.5 for unknown types so they are not silently elevated.
 */
const confidenceForRelType = (relType: string | undefined): number =>
  IMPACT_RELATION_CONFIDENCE[relType ?? ''] ?? 0.5;

/** Structured error logging for query failures — replaces empty catch blocks */
function logQueryError(context: string, err: unknown): void {
  const msg = err instanceof Error ? err.message : String(err);
  console.error(`GitNexus [${context}]: ${msg}`);
}

export interface CodebaseContext {
  projectName: string;
  stats: {
    fileCount: number;
    functionCount: number;
    communityCount: number;
    processCount: number;
  };
}

interface RepoHandle {
  id: string; // unique key = repo name (basename)
  name: string;
  repoPath: string;
  storagePath: string;
  lbugPath: string;
  indexedAt: string;
  lastCommit: string;
  stats?: RegistryEntry['stats'];
}

export class LocalBackend {
  private repos: Map<string, RepoHandle> = new Map();
  private contextCache: Map<string, CodebaseContext> = new Map();
  private initializedRepos: Set<string> = new Set();
  private reinitPromises: Map<string, Promise<void>> = new Map();
  private lastStalenessCheck: Map<string, number> = new Map();
  private groupToolSvc: GroupService | null = null;

  /**
   * Cross-repo group tools (CLI). Shares logic with MCP `group_*` handlers.
   */
  getGroupService(): GroupService {
    if (!this.groupToolSvc) {
      const port: GroupToolPort = {
        resolveRepo: (p) => this.resolveRepo(p),
        impact: (r, p) => this.impact(r as RepoHandle, p),
        query: (r, p) => this.query(r as RepoHandle, p),
        impactByUid: (id, uid, d, o) => this.impactByUid(id, uid, d, o),
      };
      this.groupToolSvc = new GroupService(port);
    }
    return this.groupToolSvc;
  }

  /** Close all pooled LadybugDB connections (CLI one-shot; optional for long-lived MCP). */
  async dispose(): Promise<void> {
    await closeLbug();
  }

  // ─── Initialization ──────────────────────────────────────────────

  /**
   * Initialize from the global registry.
   * Returns true if at least one repo is available.
   */
  async init(): Promise<boolean> {
    await this.refreshRepos();
    return this.repos.size > 0;
  }

  /**
   * Re-read the global registry and update the in-memory repo map.
   * New repos are added, existing repos are updated, removed repos are pruned.
   * LadybugDB connections for removed repos are NOT closed (they idle-timeout naturally).
   */
  private async refreshRepos(): Promise<void> {
    const entries = await listRegisteredRepos({ validate: true });
    const freshIds = new Set<string>();

    for (const entry of entries) {
      const id = this.repoId(entry.name, entry.path);
      freshIds.add(id);

      const storagePath = entry.storagePath;
      const lbugPath = path.join(storagePath, 'lbug');

      // Clean up any leftover KuzuDB files from before the LadybugDB migration.
      // If kuzu exists but lbug doesn't, warn so the user knows to re-analyze.
      const kuzu = await cleanupOldKuzuFiles(storagePath);
      if (kuzu.found && kuzu.needsReindex) {
        console.error(
          `GitNexus: "${entry.name}" has a stale KuzuDB index. Run: gitnexus analyze ${entry.path}`,
        );
      }

      const handle: RepoHandle = {
        id,
        name: entry.name,
        repoPath: entry.path,
        storagePath,
        lbugPath,
        indexedAt: entry.indexedAt,
        lastCommit: entry.lastCommit,
        stats: entry.stats,
      };

      this.repos.set(id, handle);

      // Build lightweight context (no LadybugDB needed)
      const s = entry.stats || {};
      this.contextCache.set(id, {
        projectName: entry.name,
        stats: {
          fileCount: s.files || 0,
          functionCount: s.nodes || 0,
          communityCount: s.communities || 0,
          processCount: s.processes || 0,
        },
      });
    }

    // Prune repos that no longer exist in the registry
    for (const id of this.repos.keys()) {
      if (!freshIds.has(id)) {
        this.repos.delete(id);
        this.contextCache.delete(id);
        this.initializedRepos.delete(id);
      }
    }
  }

  /**
   * Generate a stable repo ID from name + path.
   * If names collide, append a hash of the path.
   */
  private repoId(name: string, repoPath: string): string {
    const base = name.toLowerCase();
    // Check for name collision with a different path
    for (const [id, handle] of this.repos) {
      if (id === base && handle.repoPath !== path.resolve(repoPath)) {
        // Collision — use path hash
        const hash = Buffer.from(repoPath).toString('base64url').slice(0, 6);
        return `${base}-${hash}`;
      }
    }
    return base;
  }

  // ─── Repo Resolution ─────────────────────────────────────────────

  /**
   * Resolve which repo to use.
   * - If repoParam is given, match by name or path
   * - If only 1 repo, use it
   * - If 0 or multiple without param, throw with helpful message
   *
   * On a miss, re-reads the registry once in case a new repo was indexed
   * while the MCP server was running.
   */
  async resolveRepo(repoParam?: string): Promise<RepoHandle> {
    const result = this.resolveRepoFromCache(repoParam);
    if (result) return result;

    // Miss — refresh registry and try once more
    await this.refreshRepos();
    const retried = this.resolveRepoFromCache(repoParam);
    if (retried) return retried;

    // Still no match — throw with helpful message
    if (this.repos.size === 0) {
      throw new Error('No indexed repositories. Run: gitnexus analyze');
    }
    if (repoParam) {
      const names = [...this.repos.values()].map((h) => h.name);
      throw new Error(`Repository "${repoParam}" not found. Available: ${names.join(', ')}`);
    }
    const names = [...this.repos.values()].map((h) => h.name);
    throw new Error(
      `Multiple repositories indexed. Specify which one with the "repo" parameter. Available: ${names.join(', ')}`,
    );
  }

  /**
   * Try to resolve a repo from the in-memory cache. Returns null on miss.
   */
  private resolveRepoFromCache(repoParam?: string): RepoHandle | null {
    if (this.repos.size === 0) return null;

    if (repoParam) {
      const paramLower = repoParam.toLowerCase();
      // Match by id
      if (this.repos.has(paramLower)) return this.repos.get(paramLower)!;
      // Match by name (case-insensitive)
      for (const handle of this.repos.values()) {
        if (handle.name.toLowerCase() === paramLower) return handle;
      }
      // Match by path (substring)
      const resolved = path.resolve(repoParam);
      for (const handle of this.repos.values()) {
        if (handle.repoPath === resolved) return handle;
      }
      // Match by partial name
      for (const handle of this.repos.values()) {
        if (handle.name.toLowerCase().includes(paramLower)) return handle;
      }
      return null;
    }

    if (this.repos.size === 1) {
      return this.repos.values().next().value!;
    }

    return null; // Multiple repos, no param — ambiguous
  }

  // ─── Lazy LadybugDB Init ────────────────────────────────────────────

  private async ensureInitialized(repoId: string): Promise<void> {
    // If a reinit is already in progress for this repo, wait for it
    const pending = this.reinitPromises.get(repoId);
    if (pending) return pending;

    const handle = this.repos.get(repoId);
    if (!handle) throw new Error(`Unknown repo: ${repoId}`);

    // Check if the index was rebuilt since we opened the connection (#297).
    // Throttle staleness checks to at most once per 5 seconds per repo to
    // avoid an fs.readFile round-trip on every tool invocation.
    if (this.initializedRepos.has(repoId) && isLbugReady(repoId)) {
      const now = Date.now();
      const lastCheck = this.lastStalenessCheck.get(repoId) ?? 0;
      if (now - lastCheck < 5000) return; // Checked recently — skip

      this.lastStalenessCheck.set(repoId, now);
      try {
        const metaPath = path.join(handle.storagePath, 'meta.json');
        const metaRaw = await fs.readFile(metaPath, 'utf-8');
        const meta = JSON.parse(metaRaw);
        if (meta.indexedAt && meta.indexedAt !== handle.indexedAt) {
          // Index was rebuilt — close stale connection and re-init.
          // Wrap in reinitPromises to prevent TOCTOU race where concurrent
          // callers both detect staleness and double-close the pool.
          const reinit = (async () => {
            try {
              await closeLbug(repoId);
              this.initializedRepos.delete(repoId);
              handle.indexedAt = meta.indexedAt;
              await initLbug(repoId, handle.lbugPath);
              this.initializedRepos.add(repoId);
            } finally {
              this.reinitPromises.delete(repoId);
            }
          })();
          this.reinitPromises.set(repoId, reinit);
          return reinit;
        } else {
          return; // Pool is current
        }
      } catch {
        return; // Can't read meta — assume pool is fine
      }
    }

    try {
      await initLbug(repoId, handle.lbugPath);
      this.initializedRepos.add(repoId);
    } catch (err: any) {
      // If lock error, mark as not initialized so next call retries
      this.initializedRepos.delete(repoId);
      throw err;
    }
  }

  // ─── Public Getters ──────────────────────────────────────────────

  /**
   * Get context for a specific repo (or the single repo if only one).
   */
  getContext(repoId?: string): CodebaseContext | null {
    if (repoId && this.contextCache.has(repoId)) {
      return this.contextCache.get(repoId)!;
    }
    if (this.repos.size === 1) {
      return this.contextCache.values().next().value ?? null;
    }
    return null;
  }

  /**
   * List all registered repos with their metadata.
   * Re-reads the global registry so newly indexed repos are discovered
   * without restarting the MCP server.
   */
  async listRepos(): Promise<
    Array<{ name: string; path: string; indexedAt: string; lastCommit: string; stats?: any }>
  > {
    await this.refreshRepos();
    return [...this.repos.values()].map((h) => ({
      name: h.name,
      path: h.repoPath,
      indexedAt: h.indexedAt,
      lastCommit: h.lastCommit,
      stats: h.stats,
    }));
  }

  // ─── Tool Dispatch ───────────────────────────────────────────────

  async callTool(method: string, params: any): Promise<any> {
    if (method === 'list_repos') {
      return this.listRepos();
    }

    if (method.startsWith('group_')) {
      return this.handleGroupTool(method, params || {});
    }

    // Resolve repo from optional param (re-reads registry on miss)
    const repo = await this.resolveRepo(params?.repo);

    switch (method) {
      case 'query':
        return this.query(repo, params);
      case 'cypher': {
        const raw = await this.cypher(repo, params);
        return this.formatCypherAsMarkdown(raw);
      }
      case 'context':
        return this.context(repo, params);
      case 'impact':
        return this.impact(repo, params);
      case 'detect_changes':
        return this.detectChanges(repo, params);
      case 'rename':
        return this.rename(repo, params);
      // Legacy aliases for backwards compatibility
      case 'search':
        return this.query(repo, params);
      case 'explore':
        return this.context(repo, { name: params?.name, ...params });
      case 'overview':
        return this.overview(repo, params);
      case 'route_map':
        return this.routeMap(repo, params);
      case 'shape_check':
        return this.shapeCheck(repo, params);
      case 'tool_map':
        return this.toolMap(repo, params);
      case 'api_impact':
        return this.apiImpact(repo, params);
      default:
        throw new Error(`Unknown tool: ${method}`);
    }
  }

  // ─── Tool Implementations ────────────────────────────────────────

  /**
   * Query tool — process-grouped search.
   *
   * 1. Hybrid search (BM25 + semantic) to find matching symbols
   * 2. Trace each match to its process(es) via STEP_IN_PROCESS
   * 3. Group by process, rank by aggregate relevance + internal cluster cohesion
   * 4. Return: { processes, process_symbols, definitions }
   */
  private async query(
    repo: RepoHandle,
    params: {
      query: string;
      task_context?: string;
      goal?: string;
      limit?: number;
      max_symbols?: number;
      include_content?: boolean;
    },
  ): Promise<any> {
    if (!params.query?.trim()) {
      return { error: 'query parameter is required and cannot be empty.' };
    }

    await this.ensureInitialized(repo.id);

    const processLimit = params.limit || 5;
    const maxSymbolsPerProcess = params.max_symbols || 10;
    const includeContent = params.include_content ?? false;
    const searchQuery = params.query.trim();

    // Step 1: Run hybrid search to get matching symbols
    const searchLimit = processLimit * maxSymbolsPerProcess; // fetch enough raw results
    const [bm25SearchResult, semanticResults] = await Promise.all([
      this.bm25Search(repo, searchQuery, searchLimit),
      this.semanticSearch(repo, searchQuery, searchLimit),
    ]);

    const bm25Results = bm25SearchResult.results;
    const ftsUsed = bm25SearchResult.ftsUsed;

    // Merge via reciprocal rank fusion
    const scoreMap = new Map<string, { score: number; data: any }>();

    for (let i = 0; i < bm25Results.length; i++) {
      const result = bm25Results[i];
      const key = result.nodeId || result.filePath;
      const rrfScore = 1 / (60 + i);
      const existing = scoreMap.get(key);
      if (existing) {
        existing.score += rrfScore;
      } else {
        scoreMap.set(key, { score: rrfScore, data: result });
      }
    }

    for (let i = 0; i < semanticResults.length; i++) {
      const result = semanticResults[i];
      const key = result.nodeId || result.filePath;
      const rrfScore = 1 / (60 + i);
      const existing = scoreMap.get(key);
      if (existing) {
        existing.score += rrfScore;
      } else {
        scoreMap.set(key, { score: rrfScore, data: result });
      }
    }

    const merged = Array.from(scoreMap.entries())
      .sort((a, b) => b[1].score - a[1].score)
      .slice(0, searchLimit);

    // Step 2: For each match with a nodeId, trace to process(es)
    const processMap = new Map<
      string,
      {
        id: string;
        label: string;
        heuristicLabel: string;
        processType: string;
        stepCount: number;
        totalScore: number;
        cohesionBoost: number;
        symbols: any[];
      }
    >();
    const definitions: any[] = []; // standalone symbols not in any process

    for (const [_, item] of merged) {
      const sym = item.data;
      if (!sym.nodeId) {
        // File-level results go to definitions
        definitions.push({
          name: sym.name,
          type: sym.type || 'File',
          filePath: sym.filePath,
        });
        continue;
      }

      // Find processes this symbol participates in
      let processRows: any[] = [];
      try {
        processRows = await executeParameterized(
          repo.id,
          `
          MATCH (n {id: $nodeId})-[r:CodeRelation {type: 'STEP_IN_PROCESS'}]->(p:Process)
          RETURN p.id AS pid, p.label AS label, p.heuristicLabel AS heuristicLabel, p.processType AS processType, p.stepCount AS stepCount, r.step AS step
        `,
          { nodeId: sym.nodeId },
        );
      } catch (e) {
        logQueryError('query:process-lookup', e);
      }

      // Get cluster membership + cohesion (cohesion used as internal ranking signal)
      let cohesion = 0;
      let module: string | undefined;
      try {
        const cohesionRows = await executeParameterized(
          repo.id,
          `
          MATCH (n {id: $nodeId})-[:CodeRelation {type: 'MEMBER_OF'}]->(c:Community)
          RETURN c.cohesion AS cohesion, c.heuristicLabel AS module
          LIMIT 1
        `,
          { nodeId: sym.nodeId },
        );
        if (cohesionRows.length > 0) {
          cohesion = (cohesionRows[0].cohesion ?? cohesionRows[0][0]) || 0;
          module = cohesionRows[0].module ?? cohesionRows[0][1];
        }
      } catch (e) {
        logQueryError('query:cluster-info', e);
      }

      // Optionally fetch content
      let content: string | undefined;
      if (includeContent) {
        try {
          const contentRows = await executeParameterized(
            repo.id,
            `
            MATCH (n {id: $nodeId})
            RETURN n.content AS content
          `,
            { nodeId: sym.nodeId },
          );
          if (contentRows.length > 0) {
            content = contentRows[0].content ?? contentRows[0][0];
          }
        } catch (e) {
          logQueryError('query:content-fetch', e);
        }
      }

      const symbolEntry = {
        id: sym.nodeId,
        name: sym.name,
        type: sym.type,
        filePath: sym.filePath,
        startLine: sym.startLine,
        endLine: sym.endLine,
        ...(module ? { module } : {}),
        ...(includeContent && content ? { content } : {}),
      };

      if (processRows.length === 0) {
        // Symbol not in any process — goes to definitions
        definitions.push(symbolEntry);
      } else {
        // Add to each process it belongs to
        for (const row of processRows) {
          const pid = row.pid ?? row[0];
          const label = row.label ?? row[1];
          const hLabel = row.heuristicLabel ?? row[2];
          const pType = row.processType ?? row[3];
          const stepCount = row.stepCount ?? row[4];
          const step = row.step ?? row[5];

          if (!processMap.has(pid)) {
            processMap.set(pid, {
              id: pid,
              label,
              heuristicLabel: hLabel,
              processType: pType,
              stepCount,
              totalScore: 0,
              cohesionBoost: 0,
              symbols: [],
            });
          }

          const proc = processMap.get(pid)!;
          proc.totalScore += item.score;
          proc.cohesionBoost = Math.max(proc.cohesionBoost, cohesion);
          proc.symbols.push({
            ...symbolEntry,
            process_id: pid,
            step_index: step,
          });
        }
      }
    }

    // Step 3: Rank processes by aggregate score + internal cohesion boost
    const rankedProcesses = Array.from(processMap.values())
      .map((p) => ({
        ...p,
        priority: p.totalScore + p.cohesionBoost * 0.1, // cohesion as subtle ranking signal
      }))
      .sort((a, b) => b.priority - a.priority)
      .slice(0, processLimit);

    // Step 4: Build response
    const processes = rankedProcesses.map((p) => ({
      id: p.id,
      summary: p.heuristicLabel || p.label,
      priority: Math.round(p.priority * 1000) / 1000,
      symbol_count: p.symbols.length,
      process_type: p.processType,
      step_count: p.stepCount,
    }));

    const processSymbols = rankedProcesses.flatMap((p) =>
      p.symbols.slice(0, maxSymbolsPerProcess).map((s) => ({
        ...s,
        // remove internal fields
      })),
    );

    // Deduplicate process_symbols by id
    const seen = new Set<string>();
    const dedupedSymbols = processSymbols.filter((s) => {
      if (seen.has(s.id)) return false;
      seen.add(s.id);
      return true;
    });

    return {
      processes,
      process_symbols: dedupedSymbols,
      definitions: definitions.slice(0, 20), // cap standalone definitions
      ...(!ftsUsed && {
        warning:
          'FTS extension unavailable - keyword search degraded. Run: gitnexus analyze --force to rebuild indexes.',
      }),
    };
  }

  /**
   * BM25 keyword search helper - uses LadybugDB FTS for always-fresh results
   */
  private async bm25Search(
    repo: RepoHandle,
    query: string,
    limit: number,
  ): Promise<{ results: any[]; ftsUsed: boolean }> {
    const { searchFTSFromLbug } = await import('../../core/search/bm25-index.js');
    let bm25Results;
    try {
      bm25Results = await searchFTSFromLbug(query, limit, repo.id);
    } catch (err: any) {
      console.error('GitNexus: BM25/FTS search failed (FTS indexes may not exist) -', err.message);
      return { results: [], ftsUsed: false };
    }

    const ftsUsed = bm25Results.length === 0 || bm25Results[0]?.ftsUsed !== false;

    const results: any[] = [];

    for (const bm25Result of bm25Results) {
      const fullPath = bm25Result.filePath;
      try {
        const symbols = await executeParameterized(
          repo.id,
          `
          MATCH (n)
          WHERE n.filePath = $filePath
          RETURN n.id AS id, n.name AS name, labels(n)[0] AS type, n.filePath AS filePath, n.startLine AS startLine, n.endLine AS endLine
          LIMIT 3
        `,
          { filePath: fullPath },
        );

        if (symbols.length > 0) {
          for (const sym of symbols) {
            results.push({
              nodeId: sym.id || sym[0],
              name: sym.name || sym[1],
              type: sym.type || sym[2],
              filePath: sym.filePath || sym[3],
              startLine: sym.startLine || sym[4],
              endLine: sym.endLine || sym[5],
              bm25Score: bm25Result.score,
            });
          }
        } else {
          const fileName = fullPath.split('/').pop() || fullPath;
          results.push({
            name: fileName,
            type: 'File',
            filePath: bm25Result.filePath,
            bm25Score: bm25Result.score,
          });
        }
      } catch {
        const fileName = fullPath.split('/').pop() || fullPath;
        results.push({
          name: fileName,
          type: 'File',
          filePath: bm25Result.filePath,
          bm25Score: bm25Result.score,
        });
      }
    }

    return { results, ftsUsed };
  }

  /**
   * Semantic vector search helper
   */
  private async semanticSearch(repo: RepoHandle, query: string, limit: number): Promise<any[]> {
    try {
      // Check if embedding table exists before loading the model (avoids heavy model init when embeddings are off)
      const tableCheck = await executeQuery(
        repo.id,
        `MATCH (e:${EMBEDDING_TABLE_NAME}) RETURN COUNT(*) AS cnt LIMIT 1`,
      );
      if (!tableCheck.length || (tableCheck[0].cnt ?? tableCheck[0][0]) === 0) return [];

      const { embedQuery, getEmbeddingDims } = await import('../core/embedder.js');
      const queryVec = await embedQuery(query);
      const dims = getEmbeddingDims();
      const queryVecStr = `[${queryVec.join(',')}]`;

      const bestChunks = await collectBestChunks(limit, async (fetchLimit) => {
        const vectorQuery = `
          CALL QUERY_VECTOR_INDEX('${EMBEDDING_TABLE_NAME}', '${EMBEDDING_INDEX_NAME}',
            CAST(${queryVecStr} AS FLOAT[${dims}]), ${fetchLimit})
          YIELD node AS emb, distance
          WITH emb, distance
          WHERE distance < 0.6
          RETURN emb.nodeId AS nodeId, emb.chunkIndex AS chunkIndex,
                 emb.startLine AS startLine, emb.endLine AS endLine, distance
          ORDER BY distance
        `;

        const embResults = await executeQuery(repo.id, vectorQuery);
        return embResults.map((row) => ({
          nodeId: row.nodeId ?? row[0],
          chunkIndex: row.chunkIndex ?? row[1] ?? 0,
          startLine: row.startLine ?? row[2] ?? 0,
          endLine: row.endLine ?? row[3] ?? 0,
          distance: row.distance ?? row[4],
        }));
      });

      if (bestChunks.size === 0) return [];

      const results: any[] = [];

      for (const [nodeId, chunk] of Array.from(bestChunks.entries()).slice(0, limit)) {
        const labelEndIdx = nodeId.indexOf(':');
        const label = labelEndIdx > 0 ? nodeId.substring(0, labelEndIdx) : 'Unknown';

        // Validate label against known node types to prevent Cypher injection
        if (!VALID_NODE_LABELS.has(label)) continue;

        try {
          const nodeQuery =
            label === 'File'
              ? `MATCH (n:File {id: $nodeId}) RETURN n.name AS name, n.filePath AS filePath`
              : `MATCH (n:\`${label}\` {id: $nodeId}) RETURN n.name AS name, n.filePath AS filePath`;

          const nodeRows = await executeParameterized(repo.id, nodeQuery, { nodeId });
          if (nodeRows.length > 0) {
            const nodeRow = nodeRows[0];
            results.push({
              nodeId,
              name: nodeRow.name ?? nodeRow[0] ?? '',
              type: label,
              filePath: nodeRow.filePath ?? nodeRow[1] ?? '',
              distance: chunk.distance,
              startLine: chunk.startLine,
              endLine: chunk.endLine,
            });
          }
        } catch {}
      }

      return results;
    } catch {
      // Expected when embeddings are disabled — silently fall back to BM25-only
      return [];
    }
  }

  async executeCypher(repoName: string, query: string): Promise<any> {
    const repo = await this.resolveRepo(repoName);
    return this.cypher(repo, { query });
  }

  private async cypher(repo: RepoHandle, params: { query: string }): Promise<any> {
    await this.ensureInitialized(repo.id);

    if (!isLbugReady(repo.id)) {
      return { error: 'LadybugDB not ready. Index may be corrupted.' };
    }

    // Block write operations (defense-in-depth — DB is already read-only)
    if (isWriteQuery(params.query)) {
      return {
        error:
          'Write operations (CREATE, DELETE, SET, MERGE, REMOVE, DROP, ALTER, COPY, DETACH) are not allowed. The knowledge graph is read-only.',
      };
    }

    try {
      const result = await executeQuery(repo.id, params.query);
      return result;
    } catch (err: any) {
      return { error: err.message || 'Query failed' };
    }
  }

  /**
   * Format raw Cypher result rows as a markdown table for LLM readability.
   * Falls back to raw result if rows aren't tabular objects.
   */
  private formatCypherAsMarkdown(result: any): any {
    if (!Array.isArray(result) || result.length === 0) return result;

    const firstRow = result[0];
    if (typeof firstRow !== 'object' || firstRow === null) return result;

    const keys = Object.keys(firstRow);
    if (keys.length === 0) return result;

    const header = '| ' + keys.join(' | ') + ' |';
    const separator = '| ' + keys.map(() => '---').join(' | ') + ' |';
    const dataRows = result.map(
      (row: any) =>
        '| ' +
        keys
          .map((k) => {
            const v = row[k];
            if (v === null || v === undefined) return '';
            if (typeof v === 'object') return JSON.stringify(v);
            return String(v);
          })
          .join(' | ') +
        ' |',
    );

    return {
      markdown: [header, separator, ...dataRows].join('\n'),
      row_count: result.length,
    };
  }

  /**
   * Aggregate same-named clusters: group by heuristicLabel, sum symbols,
   * weighted-average cohesion, filter out tiny clusters (<5 symbols).
   * Raw communities stay intact in LadybugDB for Cypher queries.
   */
  private aggregateClusters(clusters: any[]): any[] {
    const groups = new Map<
      string,
      { ids: string[]; totalSymbols: number; weightedCohesion: number; largest: any }
    >();

    for (const c of clusters) {
      const label = c.heuristicLabel || c.label || 'Unknown';
      const symbols = c.symbolCount || 0;
      const cohesion = c.cohesion || 0;
      const existing = groups.get(label);

      if (!existing) {
        groups.set(label, {
          ids: [c.id],
          totalSymbols: symbols,
          weightedCohesion: cohesion * symbols,
          largest: c,
        });
      } else {
        existing.ids.push(c.id);
        existing.totalSymbols += symbols;
        existing.weightedCohesion += cohesion * symbols;
        if (symbols > (existing.largest.symbolCount || 0)) {
          existing.largest = c;
        }
      }
    }

    return Array.from(groups.entries())
      .map(([label, g]) => ({
        id: g.largest.id,
        label,
        heuristicLabel: label,
        symbolCount: g.totalSymbols,
        cohesion: g.totalSymbols > 0 ? g.weightedCohesion / g.totalSymbols : 0,
        subCommunities: g.ids.length,
      }))
      .filter((c) => c.symbolCount >= 5)
      .sort((a, b) => b.symbolCount - a.symbolCount);
  }

  private async overview(
    repo: RepoHandle,
    params: { showClusters?: boolean; showProcesses?: boolean; limit?: number },
  ): Promise<any> {
    await this.ensureInitialized(repo.id);

    const limit = params.limit || 20;
    const result: any = {
      repo: repo.name,
      repoPath: repo.repoPath,
      stats: repo.stats,
      indexedAt: repo.indexedAt,
      lastCommit: repo.lastCommit,
    };

    if (params.showClusters !== false) {
      try {
        // Fetch more raw communities than the display limit so aggregation has enough data
        const rawLimit = Math.max(limit * 5, 200);
        const clusters = await executeQuery(
          repo.id,
          `
          MATCH (c:Community)
          RETURN c.id AS id, c.label AS label, c.heuristicLabel AS heuristicLabel, c.cohesion AS cohesion, c.symbolCount AS symbolCount
          ORDER BY c.symbolCount DESC
          LIMIT ${rawLimit}
        `,
        );
        const rawClusters = clusters.map((c: any) => ({
          id: c.id || c[0],
          label: c.label || c[1],
          heuristicLabel: c.heuristicLabel || c[2],
          cohesion: c.cohesion || c[3],
          symbolCount: c.symbolCount || c[4],
        }));
        result.clusters = this.aggregateClusters(rawClusters).slice(0, limit);
      } catch {
        result.clusters = [];
      }
    }

    if (params.showProcesses !== false) {
      try {
        const processes = await executeQuery(
          repo.id,
          `
          MATCH (p:Process)
          RETURN p.id AS id, p.label AS label, p.heuristicLabel AS heuristicLabel, p.processType AS processType, p.stepCount AS stepCount
          ORDER BY p.stepCount DESC
          LIMIT ${limit}
        `,
        );
        result.processes = processes.map((p: any) => ({
          id: p.id || p[0],
          label: p.label || p[1],
          heuristicLabel: p.heuristicLabel || p[2],
          processType: p.processType || p[3],
          stepCount: p.stepCount || p[4],
        }));
      } catch {
        result.processes = [];
      }
    }

    return result;
  }

  /**
   * Patch the `type` field on candidates whose `labels(n)[0]` projection
   * came back empty — a known LadybugDB behaviour for several node types.
   *
   * Uses one scoped UNION query across the five priority labels rather
   * than per-candidate round-trips, so cost is a single DB call regardless
   * of how many candidates need enrichment. No-op when every candidate
   * already has a non-empty type.
   *
   * Failures are swallowed: label enrichment is an optimisation for
   * downstream scoring and #480 Class/Interface BFS seeding; if it fails
   * the symbol still resolves, just without the kind-priority bonus.
   */
  private async enrichCandidateLabels(
    repo: RepoHandle,
    candidates: Array<{ id: string; type: string }>,
  ): Promise<void> {
    const ids = candidates.filter((c) => c.type === '' && c.id).map((c) => c.id);
    if (ids.length === 0) return;
    try {
      const rows = await executeParameterized(
        repo.id,
        `
        MATCH (n:\`Class\`) WHERE n.id IN $ids RETURN n.id AS id, 'Class' AS label
        UNION ALL
        MATCH (n:\`Interface\`) WHERE n.id IN $ids RETURN n.id AS id, 'Interface' AS label
        UNION ALL
        MATCH (n:\`Function\`) WHERE n.id IN $ids RETURN n.id AS id, 'Function' AS label
        UNION ALL
        MATCH (n:\`Method\`) WHERE n.id IN $ids RETURN n.id AS id, 'Method' AS label
        UNION ALL
        MATCH (n:\`Constructor\`) WHERE n.id IN $ids RETURN n.id AS id, 'Constructor' AS label
        `,
        { ids },
      );
      const labelById = new Map<string, string>();
      for (const r of rows as any[]) {
        const id = (r.id ?? r[0]) as string;
        const label = (r.label ?? r[1]) as string;
        if (id && label && !labelById.has(id)) labelById.set(id, label);
      }
      for (const c of candidates) {
        if (c.type === '' && labelById.has(c.id)) c.type = labelById.get(c.id) as string;
      }
    } catch {
      /* best-effort — downstream resolvers still work without the label */
    }
  }

  /**
   * Score a symbol candidate for disambiguation ranking.
   *
   * Deterministic, no DB round-trip:
   *   - base 0.50
   *   - +0.40 when file_path hint matches (substring, case-insensitive)
   *   - +0.20 when kind hint exactly matches the candidate's kind
   *   - when no kind hint, a small priority bonus (Class > Interface >
   *     Function > Method > Constructor) to preserve the intuition that
   *     class-level names are usually what the user wanted.
   *
   * Capped at 1.0. Intentionally simple and inspectable — a future v2 can
   * plug in BM25/embedding signals here without changing the surrounding
   * resolver shape.
   */
  private scoreCandidate(
    c: { kind: string; filePath: string },
    hints: { file_path?: string; kind?: string },
  ): number {
    let s = 0.5;
    if (hints.file_path && c.filePath && typeof c.filePath === 'string') {
      if (c.filePath.toLowerCase().includes(hints.file_path.toLowerCase())) {
        s += 0.4;
      }
    }
    if (hints.kind && c.kind === hints.kind) {
      s += 0.2;
    }
    if (!hints.kind) {
      const priority: Record<string, number> = {
        Class: 5,
        Interface: 4,
        Function: 3,
        Method: 2,
        Constructor: 1,
      };
      s += (priority[c.kind] ?? 0) * 0.02;
    }
    return Math.min(1.0, s);
  }

  /**
   * Shared symbol resolver used by `context` and `impact`.
   *
   * Returns one of:
   *   - `{ kind: 'ok', symbol, resolvedLabel }` — single confident match
   *     (either direct UID, only one candidate after filtering, Class/
   *     Constructor collapse, or a top-scoring candidate with a clear gap
   *     to the runner-up).
   *   - `{ kind: 'ambiguous', candidates }` — multiple viable matches,
   *     sorted by score desc. Each candidate carries a relevance score.
   *   - `{ kind: 'not_found' }` — no matches at all.
   *
   * Preserves the #480 Class/Constructor preference: when the only
   * ambiguity is between a Class and its own Constructor (same name,
   * same filePath), the Class wins silently.
   */
  private async resolveSymbolCandidates(
    repo: RepoHandle,
    query: { uid?: string; name?: string; include_content?: boolean },
    hints: { file_path?: string; kind?: string },
  ): Promise<
    | {
        kind: 'ok';
        symbol: {
          id: string;
          name: string;
          type: string;
          filePath: string;
          startLine: number;
          endLine: number;
          content?: string;
        };
        resolvedLabel: string;
      }
    | {
        kind: 'ambiguous';
        candidates: Array<{
          id: string;
          name: string;
          type: string;
          filePath: string;
          startLine: number;
          endLine: number;
          score: number;
        }>;
      }
    | { kind: 'not_found' }
  > {
    const { uid, name, include_content } = query;
    const selectClause = `n.id AS id, n.name AS name, labels(n)[0] AS type, n.filePath AS filePath, n.startLine AS startLine, n.endLine AS endLine${include_content ? ', n.content AS content' : ''}`;

    // Direct UID — zero-ambiguity path.
    if (uid) {
      const rows = await executeParameterized(
        repo.id,
        `MATCH (n {id: $uid}) RETURN ${selectClause} LIMIT 1`,
        { uid },
      );
      if (rows.length === 0) return { kind: 'not_found' };
      const r = rows[0] as any;
      const symbol = {
        id: (r.id ?? r[0]) as string,
        name: (r.name ?? r[1]) as string,
        type: (r.type ?? r[2] ?? '') as string,
        filePath: (r.filePath ?? r[3]) as string,
        startLine: (r.startLine ?? r[4]) as number,
        endLine: (r.endLine ?? r[5]) as number,
        ...(include_content ? { content: (r.content ?? r[6]) as string | undefined } : {}),
      };
      // Same LadybugDB label-enrichment as the name-based path: a UID
      // pointing at a Class must still surface `type: 'Class'` so impact's
      // Class/Interface BFS seed fires. No-op when type is already set.
      await this.enrichCandidateLabels(repo, [symbol]);
      return { kind: 'ok', symbol, resolvedLabel: symbol.type };
    }

    if (!name) return { kind: 'not_found' };

    const isQualified = name.includes('/') || name.includes(':');
    let whereClause: string;
    const queryParams: Record<string, any> = { symName: name };
    if (hints.file_path) {
      whereClause = `WHERE n.name = $symName AND n.filePath CONTAINS $filePath`;
      queryParams.filePath = hints.file_path;
    } else if (isQualified) {
      whereClause = `WHERE n.id = $symName OR n.name = $symName`;
    } else {
      whereClause = `WHERE n.name = $symName`;
    }

    // LIMIT 20 (was 10) — scoring is the point now, so give the ranker
    // headroom instead of arbitrary truncation.
    const rows = await executeParameterized(
      repo.id,
      `MATCH (n) ${whereClause} RETURN ${selectClause} LIMIT 20`,
      queryParams,
    );

    if (rows.length === 0) return { kind: 'not_found' };

    // Normalise row shape across object / tuple returns from LadybugDB.
    const normalized = rows.map((r: any) => ({
      id: (r.id ?? r[0]) as string,
      name: (r.name ?? r[1]) as string,
      type: (r.type ?? r[2] ?? '') as string,
      filePath: (r.filePath ?? r[3]) as string,
      startLine: (r.startLine ?? r[4]) as number,
      endLine: (r.endLine ?? r[5]) as number,
      ...(include_content ? { content: (r.content ?? r[6]) as string | undefined } : {}),
    }));

    // Enrich labels for any candidates where `labels(n)[0]` came back empty.
    // LadybugDB returns an empty string for that projection on certain node
    // types (notably Class), which left downstream consumers (impact's
    // Class/Interface BFS seed, the kind-priority scoring bonus) unable to
    // distinguish a Class target from "unknown kind". One scoped UNION
    // across the five priority labels patches the type in-place without
    // per-candidate round-trips.
    await this.enrichCandidateLabels(repo, normalized);

    // Preserve #480 Class/Constructor collapse: if we have exactly one
    // Class (or Interface) candidate and one Constructor sharing name +
    // filePath, fold into the Class. This used to require a follow-up
    // label query because LadybugDB sometimes returns an empty labels()[0]
    // for Class nodes — enrichment above handles the empty-type case, but
    // the `type === 'Constructor'` gate still correctly triggers when a
    // Class and its Constructor share the name.
    if (!hints.kind && normalized.length > 1) {
      const ambiguousType = normalized.some((s) => s.type === '' || s.type === 'Constructor');
      if (ambiguousType) {
        const candidateIds = normalized.map((s) => s.id).filter(Boolean);
        for (const label of ['Class', 'Interface']) {
          const labelRows = await executeParameterized(
            repo.id,
            `MATCH (n:\`${label}\`) WHERE n.id IN $candidateIds RETURN n.id AS id LIMIT 1`,
            { candidateIds },
          ).catch(() => []);
          if (labelRows.length > 0) {
            const preferredId = (labelRows[0] as any).id ?? (labelRows[0] as any)[0];
            const preferred = normalized.find((s) => s.id === preferredId);
            if (preferred) {
              return {
                kind: 'ok',
                symbol: preferred,
                resolvedLabel: label,
              };
            }
          }
        }
      }
    }

    if (normalized.length === 1) {
      return {
        kind: 'ok',
        symbol: normalized[0],
        resolvedLabel: '',
      };
    }

    // Score, sort desc, stable tiebreak on shorter filePath then lex uid.
    const scored = normalized.map((s) => ({
      ...s,
      score: this.scoreCandidate({ kind: s.type, filePath: s.filePath || '' }, hints),
    }));
    scored.sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      const fpA = (a.filePath || '').length;
      const fpB = (b.filePath || '').length;
      if (fpA !== fpB) return fpA - fpB;
      return String(a.id).localeCompare(String(b.id));
    });

    // Confident single-result: top score ≥ 0.95 AND beats runner-up by a
    // clear margin. This lets a very strong file_path/kind hint resolve
    // cleanly instead of forcing the caller through a disambiguation
    // round-trip.
    //
    // The gap threshold uses `> 0.09` rather than `>= 0.10` on purpose:
    // IEEE754 addition of the scoring terms (0.50 + 0.40 + 0.20 - 0.90
    // yields 0.09999999999999998, not exactly 0.10) would otherwise break
    // the comparison for legitimate "top is 1.00, runner is 0.90" cases.
    // The intent is a clearly-dominant winner; 0.09 is a large enough
    // margin to mean that unambiguously.
    //
    // The `scored.length >= 2` guard is defensive. The `normalized.length === 1`
    // early return above already handles the single-candidate path, so in
    // practice `scored` always has at least two elements by the time we get
    // here — keeping the guard means changes to the upstream early-return
    // logic cannot accidentally index out of bounds at `scored[1]`.
    if (scored.length >= 2 && scored[0].score >= 0.95 && scored[0].score - scored[1].score > 0.09) {
      return { kind: 'ok', symbol: scored[0], resolvedLabel: scored[0].type };
    }

    return { kind: 'ambiguous', candidates: scored };
  }

  /**
   * Context tool — 360-degree symbol view with categorized refs.
   * Disambiguation (ranked) when multiple symbols share a name.
   * UID-based direct lookup. No cluster in output.
   */
  private async context(
    repo: RepoHandle,
    params: {
      name?: string;
      uid?: string;
      file_path?: string;
      kind?: string;
      include_content?: boolean;
    },
  ): Promise<any> {
    await this.ensureInitialized(repo.id);

    const { name, uid, file_path, kind, include_content } = params;

    if (!name && !uid) {
      return { error: 'Either "name" or "uid" parameter is required.' };
    }

    const outcome = await this.resolveSymbolCandidates(
      repo,
      { uid, name, include_content },
      { file_path, kind },
    );

    if (outcome.kind === 'not_found') {
      return { error: `Symbol '${name || uid}' not found` };
    }

    if (outcome.kind === 'ambiguous') {
      return {
        status: 'ambiguous',
        message: `Found ${outcome.candidates.length} symbols matching '${name}'. Use uid, file_path, or kind to disambiguate.`,
        candidates: outcome.candidates.map((c) => ({
          uid: c.id,
          name: c.name,
          kind: c.type,
          filePath: c.filePath,
          line: c.startLine,
          score: Number(c.score.toFixed(2)),
        })),
      };
    }

    // Step 3: Build full context
    const sym = outcome.symbol;
    const resolvedLabel = outcome.resolvedLabel;
    const symId = sym.id;

    // Categorized incoming refs
    const incomingRows = await executeParameterized(
      repo.id,
      `
      MATCH (caller)-[r:CodeRelation]->(n {id: $symId})
      WHERE r.type IN ['CALLS', 'IMPORTS', 'EXTENDS', 'IMPLEMENTS', 'HAS_METHOD', 'HAS_PROPERTY', 'METHOD_OVERRIDES', 'OVERRIDES', 'METHOD_IMPLEMENTS', 'ACCESSES']
      RETURN r.type AS relType, caller.id AS uid, caller.name AS name, caller.filePath AS filePath, labels(caller)[0] AS kind
      LIMIT 30
    `,
      { symId },
    );

    // Fix #480: Class/Interface nodes have no direct CALLS/IMPORTS edges —
    // those point to Constructor and File nodes respectively. Fetch those
    // extra incoming refs and merge them in so context() shows real callers.
    //
    // Determine if this is a Class/Interface node. If resolvedLabel was set
    // during disambiguation (Step 2), use it directly — no extra round-trip.
    // Otherwise fall back to a single label check only when the type field is
    // empty (LadybugDB labels(n)[0] limitation).
    const symRawType = sym.type || sym[2] || '';
    let isClassLike = resolvedLabel === 'Class' || resolvedLabel === 'Interface';
    if (!isClassLike && symRawType === '') {
      try {
        // Single UNION query instead of two serial round-trips.
        const typeCheck = await executeParameterized(
          repo.id,
          `
          MATCH (n:Class) WHERE n.id = $symId RETURN 'Class' AS label LIMIT 1
          UNION ALL
          MATCH (n:Interface) WHERE n.id = $symId RETURN 'Interface' AS label LIMIT 1
        `,
          { symId },
        );
        isClassLike = typeCheck.length > 0;
      } catch {
        /* not a Class/Interface node */
      }
    } else if (!isClassLike) {
      isClassLike = symRawType === 'Class' || symRawType === 'Interface';
    }

    if (isClassLike) {
      try {
        // Run both incoming-ref queries in parallel — they are independent.
        const [ctorIncoming, fileIncoming] = await Promise.all([
          executeParameterized(
            repo.id,
            `
            MATCH (n)-[hm:CodeRelation]->(ctor:Constructor)
            WHERE n.id = $symId AND hm.type = 'HAS_METHOD'
            MATCH (caller)-[r:CodeRelation]->(ctor)
            WHERE r.type IN ['CALLS', 'IMPORTS', 'EXTENDS', 'IMPLEMENTS', 'ACCESSES']
            RETURN r.type AS relType, caller.id AS uid, caller.name AS name, caller.filePath AS filePath, labels(caller)[0] AS kind
            LIMIT 30
          `,
            { symId },
          ),
          executeParameterized(
            repo.id,
            `
            MATCH (f:File)-[rel:CodeRelation]->(n)
            WHERE n.id = $symId AND rel.type = 'DEFINES'
            MATCH (caller)-[r:CodeRelation]->(f)
            WHERE r.type IN ['CALLS', 'IMPORTS']
            RETURN r.type AS relType, caller.id AS uid, caller.name AS name, caller.filePath AS filePath, labels(caller)[0] AS kind
            LIMIT 30
          `,
            { symId },
          ),
        ]);

        // Deduplicate by (relType, uid) — a caller can have multiple relation
        // types to the same target (e.g. both IMPORTS and CALLS), and each
        // must be preserved so every category appears in the output.
        const seenKeys = new Set(
          incomingRows.map((r: any) => `${r.relType || r[0]}:${r.uid || r[1]}`),
        );
        for (const r of [...ctorIncoming, ...fileIncoming]) {
          const key = `${r.relType || r[0]}:${r.uid || r[1]}`;
          if (!seenKeys.has(key)) {
            seenKeys.add(key);
            incomingRows.push(r);
          }
        }
      } catch (e) {
        logQueryError('context:class-incoming-expansion', e);
      }
    }

    // Categorized outgoing refs
    const outgoingRows = await executeParameterized(
      repo.id,
      `
      MATCH (n {id: $symId})-[r:CodeRelation]->(target)
      WHERE r.type IN ['CALLS', 'IMPORTS', 'EXTENDS', 'IMPLEMENTS', 'HAS_METHOD', 'HAS_PROPERTY', 'METHOD_OVERRIDES', 'OVERRIDES', 'METHOD_IMPLEMENTS', 'ACCESSES']
      RETURN r.type AS relType, target.id AS uid, target.name AS name, target.filePath AS filePath, labels(target)[0] AS kind
      LIMIT 30
    `,
      { symId },
    );

    // Process participation
    let processRows: any[] = [];
    try {
      processRows = await executeParameterized(
        repo.id,
        `
        MATCH (n {id: $symId})-[r:CodeRelation {type: 'STEP_IN_PROCESS'}]->(p:Process)
        RETURN p.id AS pid, p.heuristicLabel AS label, r.step AS step, p.stepCount AS stepCount
      `,
        { symId },
      );
    } catch (e) {
      logQueryError('context:process-participation', e);
    }

    // Helper to categorize refs
    const categorize = (rows: any[]) => {
      const cats: Record<string, any[]> = {};
      for (const row of rows) {
        const relType = (row.relType || row[0] || '').toLowerCase();
        const entry = {
          uid: row.uid || row[1],
          name: row.name || row[2],
          filePath: row.filePath || row[3],
          kind: row.kind || row[4],
        };
        if (!cats[relType]) cats[relType] = [];
        cats[relType].push(entry);
      }
      return cats;
    };

    // Method/Function/Constructor enrichment: fetch method-specific properties
    const symKind = isClassLike ? resolvedLabel || 'Class' : sym.type || sym[2];
    const isMethodLike =
      symKind === 'Method' || symKind === 'Function' || symKind === 'Constructor';
    let methodMetadata: Record<string, unknown> | undefined;
    if (isMethodLike) {
      try {
        const metaRows = await executeParameterized(
          repo.id,
          `
          MATCH (n {id: $symId})
          RETURN n.visibility AS visibility, n.isStatic AS isStatic, n.isAbstract AS isAbstract,
                 n.isFinal AS isFinal, n.isVirtual AS isVirtual, n.isOverride AS isOverride,
                 n.isAsync AS isAsync, n.isPartial AS isPartial, n.returnType AS returnType,
                 n.parameterCount AS parameterCount, n.isVariadic AS isVariadic,
                 n.requiredParameterCount AS requiredParameterCount,
                 n.parameterTypes AS parameterTypes, n.annotations AS annotations
          LIMIT 1
        `,
          { symId },
        );
        if (metaRows.length > 0) {
          const row = metaRows[0];
          const meta: Record<string, unknown> = {};
          // Only include defined properties to distinguish "not applicable" from "not enriched"
          for (const key of Object.keys(row)) {
            const val = row[key];
            if (val !== null && val !== undefined) meta[key] = val;
          }
          if (Object.keys(meta).length > 0) methodMetadata = meta;
        }
      } catch {
        /* method metadata unavailable — omit silently */
      }
    }

    return {
      status: 'found',
      symbol: {
        uid: sym.id || sym[0],
        name: sym.name || sym[1],
        kind: symKind,
        filePath: sym.filePath || sym[3],
        startLine: sym.startLine || sym[4],
        endLine: sym.endLine || sym[5],
        ...(include_content && (sym.content || sym[6]) ? { content: sym.content || sym[6] } : {}),
        ...(methodMetadata ? { methodMetadata } : {}),
      },
      incoming: categorize(incomingRows),
      outgoing: categorize(outgoingRows),
      processes: processRows.map((r: any) => ({
        id: r.pid || r[0],
        name: r.label || r[1],
        step_index: r.step || r[2],
        step_count: r.stepCount || r[3],
      })),
    };
  }

  /**
   * Legacy explore — kept for backwards compatibility with resources.ts.
   * Routes cluster/process types to direct graph queries.
   */
  private async explore(
    repo: RepoHandle,
    params: { name: string; type: 'symbol' | 'cluster' | 'process' },
  ): Promise<any> {
    await this.ensureInitialized(repo.id);
    const { name, type } = params;

    if (type === 'symbol') {
      return this.context(repo, { name });
    }

    if (type === 'cluster') {
      const clusters = await executeParameterized(
        repo.id,
        `
        MATCH (c:Community)
        WHERE c.label = $clusterName OR c.heuristicLabel = $clusterName
        RETURN c.id AS id, c.label AS label, c.heuristicLabel AS heuristicLabel, c.cohesion AS cohesion, c.symbolCount AS symbolCount
      `,
        { clusterName: name },
      );
      if (clusters.length === 0) return { error: `Cluster '${name}' not found` };

      const rawClusters = clusters.map((c: any) => ({
        id: c.id || c[0],
        label: c.label || c[1],
        heuristicLabel: c.heuristicLabel || c[2],
        cohesion: c.cohesion || c[3],
        symbolCount: c.symbolCount || c[4],
      }));

      let totalSymbols = 0,
        weightedCohesion = 0;
      for (const c of rawClusters) {
        const s = c.symbolCount || 0;
        totalSymbols += s;
        weightedCohesion += (c.cohesion || 0) * s;
      }

      const members = await executeParameterized(
        repo.id,
        `
        MATCH (n)-[:CodeRelation {type: 'MEMBER_OF'}]->(c:Community)
        WHERE c.label = $clusterName OR c.heuristicLabel = $clusterName
        RETURN DISTINCT n.name AS name, labels(n)[0] AS type, n.filePath AS filePath
        LIMIT 30
      `,
        { clusterName: name },
      );

      return {
        cluster: {
          id: rawClusters[0].id,
          label: rawClusters[0].heuristicLabel || rawClusters[0].label,
          heuristicLabel: rawClusters[0].heuristicLabel || rawClusters[0].label,
          cohesion: totalSymbols > 0 ? weightedCohesion / totalSymbols : 0,
          symbolCount: totalSymbols,
          subCommunities: rawClusters.length,
        },
        members: members.map((m: any) => ({
          name: m.name || m[0],
          type: m.type || m[1],
          filePath: m.filePath || m[2],
        })),
      };
    }

    if (type === 'process') {
      const processes = await executeParameterized(
        repo.id,
        `
        MATCH (p:Process)
        WHERE p.label = $processName OR p.heuristicLabel = $processName
        RETURN p.id AS id, p.label AS label, p.heuristicLabel AS heuristicLabel, p.processType AS processType, p.stepCount AS stepCount
        LIMIT 1
      `,
        { processName: name },
      );
      if (processes.length === 0) return { error: `Process '${name}' not found` };

      const proc = processes[0];
      const procId = proc.id || proc[0];
      const steps = await executeParameterized(
        repo.id,
        `
        MATCH (n)-[r:CodeRelation {type: 'STEP_IN_PROCESS'}]->(p {id: $procId})
        RETURN n.name AS name, labels(n)[0] AS type, n.filePath AS filePath, r.step AS step
        ORDER BY r.step
      `,
        { procId },
      );

      return {
        process: {
          id: procId,
          label: proc.label || proc[1],
          heuristicLabel: proc.heuristicLabel || proc[2],
          processType: proc.processType || proc[3],
          stepCount: proc.stepCount || proc[4],
        },
        steps: steps.map((s: any) => ({
          step: s.step || s[3],
          name: s.name || s[0],
          type: s.type || s[1],
          filePath: s.filePath || s[2],
        })),
      };
    }

    return { error: 'Invalid type. Use: symbol, cluster, or process' };
  }

  /**
   * Detect changes — git-diff based impact analysis.
   * Maps changed lines to indexed symbols, then finds affected processes.
   */
  private async detectChanges(
    repo: RepoHandle,
    params: {
      scope?: string;
      base_ref?: string;
    },
  ): Promise<any> {
    await this.ensureInitialized(repo.id);

    const scope = params.scope || 'unstaged';
    const { execFileSync } = await import('child_process');

    // Build git diff args based on scope (using execFileSync to avoid shell injection)
    let diffArgs: string[];
    switch (scope) {
      case 'staged':
        diffArgs = ['diff', '--staged', '-U0'];
        break;
      case 'all':
        diffArgs = ['diff', 'HEAD', '-U0'];
        break;
      case 'compare':
        if (!params.base_ref) return { error: 'base_ref is required for "compare" scope' };
        diffArgs = ['diff', params.base_ref, '-U0'];
        break;
      case 'unstaged':
      default:
        diffArgs = ['diff', '-U0'];
        break;
    }

    let diffOutput: string;
    try {
      // maxBuffer raised from Node's 1MB default to 256MB to avoid ENOBUFS on
      // repos with large unstaged/untracked diffs (e.g. unignored build folders).
      // See issue: spawnSync git ENOBUFS in detect_changes(scope="unstaged").
      diffOutput = execFileSync('git', diffArgs, {
        cwd: repo.repoPath,
        encoding: 'utf-8',
        maxBuffer: 256 * 1024 * 1024,
      });
    } catch (err: any) {
      return { error: `Git diff failed: ${err.message}` };
    }

    const fileDiffs: FileDiff[] = parseDiffHunks(diffOutput);

    if (fileDiffs.length === 0) {
      return {
        summary: {
          changed_count: 0,
          affected_count: 0,
          risk_level: 'none',
          message: 'No changes detected.',
        },
        changed_symbols: [],
        affected_processes: [],
      };
    }

    // Map diff hunks to indexed symbols via range overlap
    const changedSymbols: any[] = [];
    for (const fileDiff of fileDiffs) {
      if (fileDiff.hunks.length === 0) continue;

      // Build range overlap conditions for all hunks in this file
      const overlapConditions = fileDiff.hunks
        .map((_, i) => `(n.startLine <= $hunkEnd${i} AND n.endLine >= $hunkStart${i})`)
        .join(' OR ');

      const queryParams: Record<string, any> = { filePath: fileDiff.filePath };
      fileDiff.hunks.forEach((hunk, i) => {
        queryParams[`hunkStart${i}`] = hunk.startLine;
        queryParams[`hunkEnd${i}`] = hunk.endLine;
      });

      const symbolQuery = `
        MATCH (n) WHERE n.filePath ENDS WITH $filePath
          AND n.startLine IS NOT NULL AND n.endLine IS NOT NULL
          AND (${overlapConditions})
        RETURN n.id AS id, n.name AS name, labels(n)[0] AS type,
               n.filePath AS filePath, n.startLine AS startLine, n.endLine AS endLine
      `;

      try {
        const rows = await executeParameterized(repo.id, symbolQuery, queryParams);
        for (const sym of rows) {
          changedSymbols.push({
            id: sym.id || sym[0],
            name: sym.name || sym[1],
            type: sym.type || sym[2],
            filePath: sym.filePath || sym[3],
            change_type: 'touched',
          });
        }
      } catch (e) {
        logQueryError('detect-changes:file-symbols', e);
      }
    }

    // Find affected processes -- single batched query instead of N+1
    const affectedProcesses = new Map<string, any>();
    if (changedSymbols.length > 0) {
      const symIds = changedSymbols.map((s) => s.id);
      const symNameById = new Map(changedSymbols.map((s) => [s.id, s.name]));
      try {
        const procs = await executeParameterized(
          repo.id,
          `
          MATCH (n)-[r:CodeRelation {type: 'STEP_IN_PROCESS'}]->(p:Process)
          WHERE n.id IN $ids
          RETURN n.id AS nodeId, p.id AS pid, p.heuristicLabel AS label,
                 p.processType AS processType, p.stepCount AS stepCount, r.step AS step
        `,
          { ids: symIds },
        );
        for (const proc of procs) {
          const nodeId = proc.nodeId || proc[0];
          const pid = proc.pid || proc[1];
          if (!affectedProcesses.has(pid)) {
            affectedProcesses.set(pid, {
              id: pid,
              name: proc.label || proc[2],
              process_type: proc.processType || proc[3],
              step_count: proc.stepCount || proc[4],
              changed_steps: [],
            });
          }
          affectedProcesses.get(pid)!.changed_steps.push({
            symbol: symNameById.get(nodeId) ?? nodeId,
            step: proc.step || proc[5],
          });
        }
      } catch (e) {
        logQueryError('detect-changes:process-lookup', e);
      }
    }

    const processCount = affectedProcesses.size;
    const risk =
      processCount === 0
        ? 'low'
        : processCount <= 5
          ? 'medium'
          : processCount <= 15
            ? 'high'
            : 'critical';

    return {
      summary: {
        changed_count: changedSymbols.length,
        affected_count: processCount,
        changed_files: fileDiffs.length,
        risk_level: risk,
      },
      changed_symbols: changedSymbols,
      affected_processes: Array.from(affectedProcesses.values()),
    };
  }

  /**
   * Rename tool — multi-file coordinated rename using graph + text search.
   * Graph refs are tagged "graph" (high confidence).
   * Additional refs found via text search are tagged "text_search" (lower confidence).
   */
  private async rename(
    repo: RepoHandle,
    params: {
      symbol_name?: string;
      symbol_uid?: string;
      new_name: string;
      file_path?: string;
      dry_run?: boolean;
    },
  ): Promise<any> {
    await this.ensureInitialized(repo.id);

    const { new_name, file_path } = params;
    const dry_run = params.dry_run ?? true;

    if (!params.symbol_name && !params.symbol_uid) {
      return { error: 'Either symbol_name or symbol_uid is required.' };
    }

    /** Guard: ensure a file path resolves within the repo root (prevents path traversal) */
    const assertSafePath = (filePath: string): string => {
      const full = path.resolve(repo.repoPath, filePath);
      if (!full.startsWith(repo.repoPath + path.sep) && full !== repo.repoPath) {
        throw new Error(`Path traversal blocked: ${filePath}`);
      }
      return full;
    };

    // Step 1: Find the target symbol (reuse context's lookup)
    const lookupResult = await this.context(repo, {
      name: params.symbol_name,
      uid: params.symbol_uid,
      file_path,
    });

    if (lookupResult.status === 'ambiguous') {
      return lookupResult; // pass disambiguation through
    }
    if (lookupResult.error) {
      return lookupResult;
    }

    const sym = lookupResult.symbol;
    const oldName = sym.name;

    if (oldName === new_name) {
      return { error: 'New name is the same as the current name.' };
    }

    // Step 2: Collect edits from graph (high confidence)
    const changes = new Map<string, { file_path: string; edits: any[] }>();

    const addEdit = (
      filePath: string,
      line: number,
      oldText: string,
      newText: string,
      confidence: string,
    ) => {
      if (!changes.has(filePath)) {
        changes.set(filePath, { file_path: filePath, edits: [] });
      }
      changes.get(filePath)!.edits.push({ line, old_text: oldText, new_text: newText, confidence });
    };

    // The definition itself
    if (sym.filePath && sym.startLine) {
      try {
        const content = await fs.readFile(assertSafePath(sym.filePath), 'utf-8');
        const lines = content.split('\n');
        const lineIdx = sym.startLine - 1;
        if (lineIdx >= 0 && lineIdx < lines.length && lines[lineIdx].includes(oldName)) {
          const defRegex = new RegExp(
            `\\b${oldName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`,
            'g',
          );
          addEdit(
            sym.filePath,
            sym.startLine,
            lines[lineIdx].trim(),
            lines[lineIdx].replace(defRegex, new_name).trim(),
            'graph',
          );
        }
      } catch (e) {
        logQueryError('rename:read-definition', e);
      }
    }

    // All incoming refs from graph (callers, importers, etc.)
    const allIncoming = [
      ...(lookupResult.incoming.calls || []),
      ...(lookupResult.incoming.imports || []),
      ...(lookupResult.incoming.extends || []),
      ...(lookupResult.incoming.implements || []),
    ];

    let graphEdits = changes.size > 0 ? 1 : 0; // count definition edit

    for (const ref of allIncoming) {
      if (!ref.filePath) continue;
      try {
        const content = await fs.readFile(assertSafePath(ref.filePath), 'utf-8');
        const lines = content.split('\n');
        for (let i = 0; i < lines.length; i++) {
          if (lines[i].includes(oldName)) {
            addEdit(
              ref.filePath,
              i + 1,
              lines[i].trim(),
              lines[i]
                .replace(
                  new RegExp(`\\b${oldName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'g'),
                  new_name,
                )
                .trim(),
              'graph',
            );
            graphEdits++;
            break; // one edit per file from graph refs
          }
        }
      } catch (e) {
        logQueryError('rename:read-ref', e);
      }
    }

    // Step 3: Text search for refs the graph might have missed
    let astSearchEdits = 0;
    const graphFiles = new Set(
      [sym.filePath, ...allIncoming.map((r) => r.filePath)].filter(Boolean),
    );

    // Simple text search across the repo for the old name (in files not already covered by graph)
    try {
      const { execFileSync } = await import('child_process');
      const rgArgs = [
        '-l',
        '--type-add',
        'code:*.{ts,tsx,js,jsx,py,go,rs,java,c,h,cpp,cc,cxx,hpp,hxx,hh,cs,php,swift}',
        '-t',
        'code',
        `\\b${oldName}\\b`,
        '.',
      ];
      const output = execFileSync('rg', rgArgs, {
        cwd: repo.repoPath,
        encoding: 'utf-8',
        timeout: 5000,
        // Avoid ENOBUFS on large repos: rg -l can list many files.
        maxBuffer: 256 * 1024 * 1024,
      });
      const files = output
        .trim()
        .split('\n')
        .filter((f) => f.length > 0);

      for (const file of files) {
        const normalizedFile = file.replace(/\\/g, '/').replace(/^\.\//, '');
        if (graphFiles.has(normalizedFile)) continue; // already covered by graph

        try {
          const content = await fs.readFile(assertSafePath(normalizedFile), 'utf-8');
          const lines = content.split('\n');
          const regex = new RegExp(`\\b${oldName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'g');
          for (let i = 0; i < lines.length; i++) {
            regex.lastIndex = 0;
            if (regex.test(lines[i])) {
              regex.lastIndex = 0;
              addEdit(
                normalizedFile,
                i + 1,
                lines[i].trim(),
                lines[i].replace(regex, new_name).trim(),
                'text_search',
              );
              astSearchEdits++;
            }
          }
        } catch (e) {
          logQueryError('rename:text-search-read', e);
        }
      }
    } catch (e) {
      logQueryError('rename:ripgrep', e);
    }

    // Step 4: Apply or preview
    const allChanges = Array.from(changes.values());
    const totalEdits = allChanges.reduce((sum, c) => sum + c.edits.length, 0);

    if (!dry_run) {
      // Apply edits to files
      for (const change of allChanges) {
        try {
          const fullPath = assertSafePath(change.file_path);
          let content = await fs.readFile(fullPath, 'utf-8');
          const regex = new RegExp(`\\b${oldName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'g');
          content = content.replace(regex, new_name);
          await fs.writeFile(fullPath, content, 'utf-8');
        } catch (e) {
          logQueryError('rename:apply-edit', e);
        }
      }
    }

    return {
      status: 'success',
      old_name: oldName,
      new_name,
      files_affected: allChanges.length,
      total_edits: totalEdits,
      graph_edits: graphEdits,
      text_search_edits: astSearchEdits,
      changes: allChanges,
      applied: !dry_run,
    };
  }

  private async impact(
    repo: RepoHandle,
    params: {
      target: string;
      target_uid?: string;
      file_path?: string;
      kind?: string;
      direction: 'upstream' | 'downstream';
      maxDepth?: number;
      relationTypes?: string[];
      includeTests?: boolean;
      minConfidence?: number;
    },
  ): Promise<any> {
    try {
      return await this._impactImpl(repo, params);
    } catch (err: any) {
      // Return structured error instead of crashing (#321)
      return {
        error: (err instanceof Error ? err.message : String(err)) || 'Impact analysis failed',
        target: { name: params.target },
        direction: params.direction,
        impactedCount: 0,
        risk: 'UNKNOWN',
        suggestion: 'The graph query failed — try gitnexus context <symbol> as a fallback',
      };
    }
  }

  private async _impactImpl(
    repo: RepoHandle,
    params: {
      target: string;
      target_uid?: string;
      file_path?: string;
      kind?: string;
      direction: 'upstream' | 'downstream';
      maxDepth?: number;
      relationTypes?: string[];
      includeTests?: boolean;
      minConfidence?: number;
    },
  ): Promise<any> {
    await this.ensureInitialized(repo.id);

    const { target, direction } = params;
    const maxDepth = params.maxDepth || 3;
    // Map legacy relation type names before filtering (backward compat for OVERRIDES → METHOD_OVERRIDES)
    const mappedRelTypes = params.relationTypes?.flatMap((t: string) =>
      t === 'OVERRIDES' ? ['OVERRIDES', 'METHOD_OVERRIDES'] : [t],
    );
    const rawRelTypes =
      mappedRelTypes && mappedRelTypes.length > 0
        ? mappedRelTypes.filter((t: string) => VALID_RELATION_TYPES.has(t))
        : [
            'CALLS',
            'IMPORTS',
            'EXTENDS',
            'IMPLEMENTS',
            'METHOD_OVERRIDES',
            'OVERRIDES',
            'METHOD_IMPLEMENTS',
          ];
    const relationTypes =
      rawRelTypes.length > 0
        ? rawRelTypes
        : [
            'CALLS',
            'IMPORTS',
            'EXTENDS',
            'IMPLEMENTS',
            'METHOD_OVERRIDES',
            'OVERRIDES',
            'METHOD_IMPLEMENTS',
          ];
    const includeTests = params.includeTests ?? false;
    const minConfidence = params.minConfidence ?? 0;

    // Resolve target via the shared symbol resolver. When the caller passes
    // target_uid we skip the name lookup entirely (zero-ambiguity). Otherwise
    // we rank candidates (#470) and either proceed with a confident single
    // match, or return a structured ambiguous response instead of silently
    // picking the wrong symbol.
    //
    // The resolver preserves the #480 Class/Constructor preference heuristic:
    // when a Class and its Constructor share name + filePath, the Class is
    // selected silently.
    const outcome = await this.resolveSymbolCandidates(
      repo,
      { uid: params.target_uid, name: target },
      { file_path: params.file_path, kind: params.kind },
    );

    if (outcome.kind === 'not_found') {
      const missing = params.target_uid ?? target;
      return {
        error: `Target '${missing}' not found`,
        target: { name: target },
        direction,
        impactedCount: 0,
        risk: 'UNKNOWN',
      };
    }

    if (outcome.kind === 'ambiguous') {
      return {
        status: 'ambiguous',
        message: `Found ${outcome.candidates.length} symbols matching '${target}'. Use target_uid, file_path, or kind to disambiguate.`,
        target: { name: target },
        direction,
        impactedCount: 0,
        risk: 'UNKNOWN',
        candidates: outcome.candidates.map((c) => ({
          uid: c.id,
          name: c.name,
          kind: c.type,
          filePath: c.filePath,
          line: c.startLine,
          score: Number(c.score.toFixed(2)),
        })),
      };
    }

    const sym = {
      id: outcome.symbol.id,
      name: outcome.symbol.name,
      filePath: outcome.symbol.filePath,
    };
    const symType = outcome.resolvedLabel || outcome.symbol.type || '';

    return this._runImpactBFS(repo, sym, symType, direction, {
      maxDepth,
      relationTypes,
      includeTests,
      minConfidence,
    });
  }

  /**
   * Shared BFS traversal for impact analysis (name-resolved or UID-resolved symbol).
   */
  private async _runImpactBFS(
    repo: RepoHandle,
    sym: any,
    symType: string,
    direction: 'upstream' | 'downstream',
    opts: {
      maxDepth: number;
      relationTypes: string[];
      includeTests: boolean;
      minConfidence: number;
    },
  ): Promise<any> {
    const { maxDepth, relationTypes, includeTests, minConfidence } = opts;
    const relTypeFilter = relationTypes.map((t) => `'${t}'`).join(', ');
    const confidenceFilter = minConfidence > 0 ? ` AND r.confidence >= ${minConfidence}` : '';

    const symId = sym.id || sym[0];

    const impacted: any[] = [];
    const visited = new Set<string>([symId]);
    let frontier = [symId];
    let traversalComplete = true;

    // Fix #480: For Java (and other JVM) Class/Interface nodes, CALLS edges
    // point to Constructor nodes and IMPORTS edges point to File nodes — not
    // the Class/Interface itself. Seed the frontier with the Constructor(s)
    // and owning File so the BFS traversal finds those edges naturally.
    // The owning File is kept only as an internal seed (frontier/visited) and
    // is NOT added to impacted — it is the definition container, not an
    // upstream dependent. The BFS will discover IMPORTS edges on it naturally.
    if (symType === 'Class' || symType === 'Interface') {
      try {
        // Run both seed queries in parallel — they are independent.
        const [ctorRows, fileRows] = await Promise.all([
          executeParameterized(
            repo.id,
            `
            MATCH (n)-[hm:CodeRelation]->(c:Constructor)
            WHERE n.id = $symId AND hm.type = 'HAS_METHOD'
            RETURN c.id AS id, c.name AS name, labels(c)[0] AS type, c.filePath AS filePath
          `,
            { symId },
          ),
          // Restrict to DEFINES edges only — other File->Class edge types (if
          // any) should not be treated as the owning file relationship.
          executeParameterized(
            repo.id,
            `
            MATCH (f:File)-[rel:CodeRelation]->(n)
            WHERE n.id = $symId AND rel.type = 'DEFINES'
            RETURN f.id AS id, f.name AS name, labels(f)[0] AS type, f.filePath AS filePath
          `,
            { symId },
          ),
        ]);

        for (const r of ctorRows) {
          const rid = r.id || r[0];
          if (rid && !visited.has(rid)) {
            visited.add(rid);
            frontier.push(rid);
          }
        }
        for (const r of fileRows) {
          const rid = r.id || r[0];
          if (rid && !visited.has(rid)) {
            visited.add(rid);
            frontier.push(rid);
          }
        }
      } catch (e) {
        logQueryError('impact:class-node-expansion', e);
      }
    }

    for (let depth = 1; depth <= maxDepth && frontier.length > 0; depth++) {
      const nextFrontier: string[] = [];

      // Batch frontier nodes into a single Cypher query per depth level
      const idList = frontier.map((id) => `'${id.replace(/'/g, "''")}'`).join(', ');
      const query =
        direction === 'upstream'
          ? `MATCH (caller)-[r:CodeRelation]->(n) WHERE n.id IN [${idList}] AND r.type IN [${relTypeFilter}]${confidenceFilter} RETURN n.id AS sourceId, caller.id AS id, caller.name AS name, labels(caller)[0] AS type, caller.filePath AS filePath, r.type AS relType, r.confidence AS confidence`
          : `MATCH (n)-[r:CodeRelation]->(callee) WHERE n.id IN [${idList}] AND r.type IN [${relTypeFilter}]${confidenceFilter} RETURN n.id AS sourceId, callee.id AS id, callee.name AS name, labels(callee)[0] AS type, callee.filePath AS filePath, r.type AS relType, r.confidence AS confidence`;

      try {
        const related = await executeQuery(repo.id, query);

        for (const rel of related) {
          const relId = rel.id || rel[1];
          const filePath = rel.filePath || rel[4] || '';

          if (!includeTests && isTestFilePath(filePath)) continue;

          if (!visited.has(relId)) {
            visited.add(relId);
            nextFrontier.push(relId);
            const storedConfidence = rel.confidence ?? rel[6];
            const relationType = rel.relType || rel[5];
            // Prefer the stored confidence from the graph (set at analysis time);
            // fall back to the per-type floor for edges without a stored value.
            const effectiveConfidence =
              typeof storedConfidence === 'number' && storedConfidence > 0
                ? storedConfidence
                : confidenceForRelType(relationType);
            impacted.push({
              depth,
              id: relId,
              name: rel.name || rel[2],
              type: rel.type || rel[3],
              filePath,
              relationType,
              confidence: effectiveConfidence,
            });
          }
        }
      } catch (e) {
        logQueryError('impact:depth-traversal', e);
        // Break out of depth loop on query failure but return partial results
        // collected so far, rather than silently swallowing the error (#321)
        traversalComplete = false;
        break;
      }

      frontier = nextFrontier;
    }

    const grouped: Record<number, any[]> = {};
    for (const item of impacted) {
      if (!grouped[item.depth]) grouped[item.depth] = [];
      grouped[item.depth].push(item);
    }

    // ── Enrichment: affected processes, modules, risk ──────────────
    const directCount = (grouped[1] || []).length;
    let affectedProcesses: any[] = [];
    let affectedModules: any[] = [];

    if (impacted.length > 0) {
      const CHUNK_SIZE = 100;
      // Max number of chunks to process to avoid unbounded DB round-trips.
      // Configurable via env IMPACT_MAX_CHUNKS, default 10 => max items = 1000
      const MAX_CHUNKS = parseInt(process.env.IMPACT_MAX_CHUNKS || '10', 10);

      // ── Process enrichment: batched chunking (bounded by MAX_CHUNKS) ─
      // Uses merged Cypher query (WITH + OPTIONAL MATCH) to fetch
      // process + entry point info in 1 round-trip per chunk. Converted to
      // parameterized queries to avoid manual string escaping and long query strings.
      const entryPointMap = new Map<
        string,
        {
          name: string;
          type: string;
          filePath: string;
          affected_process_count: number;
          total_hits: number;
          earliest_broken_step: number;
        }
      >();

      // Map process id -> entryPointId to allow fixing missing minStep values later
      const processToEntryPoint = new Map<string, string>();
      // Collect process ids where MIN(r.step) returned null so we can retry in batch
      const processesMissingMinStep = new Set<string>();

      let chunksProcessed = 0;
      for (
        let i = 0;
        i < impacted.length && chunksProcessed < MAX_CHUNKS;
        i += CHUNK_SIZE, chunksProcessed++
      ) {
        const chunk = impacted.slice(i, i + CHUNK_SIZE);
        const ids = chunk.map((item) => String(item.id ?? ''));

        try {
          // Use parameterized list to avoid building long query strings
          const rows = await executeParameterized(
            repo.id,
            `
            MATCH (s)-[r:CodeRelation {type: 'STEP_IN_PROCESS'}]->(p:Process)
            WHERE s.id IN $ids
            WITH p, COUNT(DISTINCT s.id) AS hits, MIN(r.step) AS minStep
            OPTIONAL MATCH (ep {id: p.entryPointId})
            RETURN p.id AS pId, p.heuristicLabel AS name, p.processType AS processType,
                   p.entryPointId AS entryPointId, hits, minStep, p.stepCount AS stepCount,
                   ep.name AS epName, labels(ep)[0] AS epType, ep.filePath AS epFilePath
          `,
            { ids },
          ).catch(() => []);

          for (const row of rows) {
            const pId = row.pId ?? row[0];
            const epId = row.entryPointId ?? row[3] ?? row.pId ?? row[0];
            // Track mapping from process -> entryPoint so we can backfill missing minStep
            if (pId) processToEntryPoint.set(String(pId), String(epId));

            // Normalize epName: prefer epName, fall back to other columns, and
            // ensure we don't keep an empty string (labels(...) can return "").
            const epNameRaw = row.epName ?? row[7] ?? row.name ?? row[1] ?? 'unknown';
            const epName =
              typeof epNameRaw === 'string' && epNameRaw.trim().length > 0
                ? epNameRaw.trim()
                : 'unknown';

            // Normalize epType: labels(ep)[0] can return an empty string in
            // some DBs (LadybugDB). Using nullish coalescing (??) preserves
            // empty strings, which results in empty `type` values being
            // propagated. Treat empty-string labels as missing and fall back
            // to the next candidate or a sensible default.
            const epTypeRaw = row.epType ?? row[8] ?? '';
            const epType =
              typeof epTypeRaw === 'string' && epTypeRaw.trim().length > 0
                ? epTypeRaw.trim()
                : 'Function';

            const epFilePath = row.epFilePath ?? row[9] ?? '';
            const hits = row.hits ?? row[4] ?? 0;
            const minStep = row.minStep ?? row[5];
            // If the DB returned null for minStep, note the process id so we
            // can run a follow-up query using a different aggregation strategy.
            if (minStep === null || minStep === undefined) {
              if (pId) processesMissingMinStep.add(String(pId));
            }
            if (!entryPointMap.has(epId)) {
              entryPointMap.set(epId, {
                name: epName,
                type: epType,
                filePath: epFilePath,
                affected_process_count: 0,
                total_hits: 0,
                earliest_broken_step: Infinity,
              });
            }
            const ep = entryPointMap.get(epId)!;
            ep.affected_process_count += 1;
            ep.total_hits += hits;
            ep.earliest_broken_step = Math.min(ep.earliest_broken_step, minStep ?? Infinity);
          }
        } catch (e) {
          logQueryError('impact:process-chunk', e);
        }
      }

      // If some processes returned null minStep, try a batched follow-up query
      // using the full impacted id set. This handles older indexes or DBs
      // where MIN(r.step) can come back null even when step properties exist.
      if (processesMissingMinStep.size > 0) {
        try {
          const pIds = Array.from(processesMissingMinStep);
          const allImpactedIds = impacted.map((it) => String(it.id ?? ''));
          const missingRows = await executeParameterized(
            repo.id,
            `
            MATCH (s)-[r:CodeRelation {type: 'STEP_IN_PROCESS'}]->(p:Process)
            WHERE p.id IN $pIds AND s.id IN $ids
            RETURN p.id AS pid, MIN(r.step) AS minStep
          `,
            { pIds, ids: allImpactedIds },
          ).catch(() => []);

          for (const mr of missingRows) {
            const pid = mr.pid ?? mr[0];
            const minStep = mr.minStep ?? mr[1];
            const epId = processToEntryPoint.get(String(pid));
            if (!epId) continue;
            const ep = entryPointMap.get(epId);
            if (!ep) continue;
            if (typeof minStep === 'number') {
              ep.earliest_broken_step = Math.min(ep.earliest_broken_step, minStep);
            }
          }
        } catch (e) {
          logQueryError('impact:process-chunk-backfill', e);
        }
      }

      // If we capped chunks, mark traversal incomplete so caller knows results are partial
      if (chunksProcessed * CHUNK_SIZE < impacted.length) {
        traversalComplete = false;
      }

      affectedProcesses = Array.from(entryPointMap.values())
        .map((ep) => ({
          ...ep,
          earliest_broken_step:
            ep.earliest_broken_step === Infinity ? null : ep.earliest_broken_step,
        }))
        .sort((a, b) => b.total_hits - a.total_hits);

      // ── Module enrichment: use same cap as process enrichment and parameterized queries
      const maxItems = Math.min(impacted.length, MAX_CHUNKS * CHUNK_SIZE);
      const cappedImpacted = impacted.slice(0, maxItems);
      const allIdsArr = cappedImpacted.map((i: any) => String(i.id ?? ''));
      const d1Items = (grouped[1] || []).slice(0, maxItems);
      const d1IdsArr = d1Items.map((i: any) => String(i.id ?? ''));

      // Chunked module enrichment: run the MEMBER_OF queries in chunks
      // to avoid large single queries or concurrent Kuzu calls that can
      // crash (SIGSEGV) on arm64 macOS; behavior preserves existing maxItems cap and returns equivalent aggregated results.
      const moduleHitsMap = new Map<string, number>();
      const directModuleSet = new Set<string>();

      // Helper to run a single module chunk and accumulate hits by name
      const runModuleChunk = async (idsChunk: string[]) => {
        if (!idsChunk || idsChunk.length === 0) return;
        try {
          const rows = await executeParameterized(
            repo.id,
            `
            MATCH (s)-[:CodeRelation {type: 'MEMBER_OF'}]->(c:Community)
            WHERE s.id IN $ids
            RETURN c.heuristicLabel AS name, COUNT(DISTINCT s.id) AS hits
            ORDER BY hits DESC
            LIMIT 20
          `,
            { ids: idsChunk },
          ).catch(() => []);

          for (const r of rows) {
            const name = r.name ?? r[0] ?? null;
            const hits = (r.hits ?? r[1]) || 0;
            if (!name) continue;
            moduleHitsMap.set(name, (moduleHitsMap.get(name) || 0) + hits);
          }
        } catch (e) {
          logQueryError('impact:module-chunk', e);
        }
      };

      // Run module query chunks sequentially (safe on arm64 macOS)
      for (let i = 0; i < allIdsArr.length; i += CHUNK_SIZE) {
        const chunkIds = allIdsArr.slice(i, i + CHUNK_SIZE);
        await runModuleChunk(chunkIds);
      }

      // Run direct module query similarly (distinct heuristic labels for depth-1 items)
      const runDirectModuleChunk = async (idsChunk: string[]) => {
        if (!idsChunk || idsChunk.length === 0) return;
        try {
          const rows = await executeParameterized(
            repo.id,
            `
            MATCH (s)-[:CodeRelation {type: 'MEMBER_OF'}]->(c:Community)
            WHERE s.id IN $ids
            RETURN DISTINCT c.heuristicLabel AS name
          `,
            { ids: idsChunk },
          ).catch(() => []);
          for (const r of rows) {
            const name = r.name ?? r[0] ?? null;
            if (name) directModuleSet.add(name);
          }
        } catch (e) {
          logQueryError('impact:direct-module-chunk', e);
        }
      };

      for (let i = 0; i < d1IdsArr.length; i += CHUNK_SIZE) {
        const chunkIds = d1IdsArr.slice(i, i + CHUNK_SIZE);
        await runDirectModuleChunk(chunkIds);
      }

      // Build final moduleRows array from aggregated hits map, sorted & limited
      const moduleRows = Array.from(moduleHitsMap.entries())
        .map(([name, hits]) => ({ name, hits }))
        .sort((a, b) => b.hits - a.hits)
        .slice(0, 20);

      const directModuleRows = Array.from(directModuleSet).map((name) => ({ name }));

      // Build affectedModules in the same shape as original implementation
      const directModuleNameSet = new Set(directModuleRows.map((r: any) => r.name || r[0]));
      affectedModules = moduleRows.map((r: any) => {
        const name = r.name ?? r[0];
        const hits = r.hits ?? r[1] ?? 0;
        return {
          name,
          hits,
          impact: directModuleNameSet.has(name) ? 'direct' : 'indirect',
        };
      });
    }

    // Risk scoring
    const processCount = affectedProcesses.length;
    const moduleCount = affectedModules.length;
    let risk = 'LOW';
    if (directCount >= 30 || processCount >= 5 || moduleCount >= 5 || impacted.length >= 200) {
      risk = 'CRITICAL';
    } else if (
      directCount >= 15 ||
      processCount >= 3 ||
      moduleCount >= 3 ||
      impacted.length >= 100
    ) {
      risk = 'HIGH';
    } else if (directCount >= 5 || impacted.length >= 30) {
      risk = 'MEDIUM';
    }

    return {
      target: {
        id: symId,
        name: sym.name || sym[1],
        type: symType,
        filePath: sym.filePath || sym[2],
      },
      direction,
      impactedCount: impacted.length,
      risk,
      ...(!traversalComplete && { partial: true }),
      summary: {
        direct: directCount,
        processes_affected: processCount,
        modules_affected: moduleCount,
      },
      affected_processes: affectedProcesses,
      affected_modules: affectedModules,
      byDepth: grouped,
    };
  }

  /**
   * UID-based impact for cross-repo fan-out. Same result shape as `impact`.
   * Returns null if the repo is unknown, the UID is missing, or analysis fails.
   */
  async impactByUid(
    repoId: string,
    uid: string,
    direction: string,
    opts: {
      maxDepth: number;
      relationTypes: string[];
      minConfidence: number;
      includeTests: boolean;
    },
  ): Promise<any | null> {
    try {
      await this.refreshRepos();
      await this.ensureInitialized(repoId);
    } catch {
      return null;
    }

    const repo = this.repos.get(repoId);
    if (!repo) return null;

    const dir: 'upstream' | 'downstream' = direction === 'downstream' ? 'downstream' : 'upstream';

    let rows: any[];
    try {
      rows = await executeParameterized(
        repoId,
        `MATCH (n) WHERE n.id = $uid
         RETURN n.id AS id, n.name AS name, n.filePath AS filePath, labels(n)[0] AS type
         LIMIT 1`,
        { uid },
      );
    } catch {
      return null;
    }
    if (!rows?.length) return null;

    const sym = rows[0];
    const labelRaw = sym.type ?? sym[3];
    const symType =
      typeof labelRaw === 'string' && labelRaw.trim().length > 0 ? labelRaw.trim() : '';

    // Map legacy relation type names (backward compat for OVERRIDES → METHOD_OVERRIDES)
    const mappedRelTypes = opts.relationTypes?.flatMap((t: string) =>
      t === 'OVERRIDES' ? ['OVERRIDES', 'METHOD_OVERRIDES'] : [t],
    );
    const rawRelTypes =
      mappedRelTypes && mappedRelTypes.length > 0
        ? mappedRelTypes.filter((t: string) => VALID_RELATION_TYPES.has(t))
        : [
            'CALLS',
            'IMPORTS',
            'EXTENDS',
            'IMPLEMENTS',
            'METHOD_OVERRIDES',
            'OVERRIDES',
            'METHOD_IMPLEMENTS',
          ];
    const relationTypes =
      rawRelTypes.length > 0
        ? rawRelTypes
        : [
            'CALLS',
            'IMPORTS',
            'EXTENDS',
            'IMPLEMENTS',
            'METHOD_OVERRIDES',
            'OVERRIDES',
            'METHOD_IMPLEMENTS',
          ];

    try {
      return await this._runImpactBFS(repo, sym, symType, dir, {
        maxDepth: opts.maxDepth,
        relationTypes,
        includeTests: opts.includeTests,
        minConfidence: opts.minConfidence,
      });
    } catch {
      return null;
    }
  }

  private handleGroupTool(method: string, params: Record<string, unknown>): Promise<unknown> {
    switch (method) {
      case 'group_list':
        return this.groupList(params);
      case 'group_sync':
        return this.groupSync(params);
      case 'group_contracts':
        return this.groupContracts(params);
      case 'group_query':
        return this.groupQuery(params);
      case 'group_status':
        return this.groupStatus(params);
      default:
        throw new Error(`Unknown group tool: ${method}`);
    }
  }

  private async groupList(params: Record<string, unknown>): Promise<unknown> {
    return this.getGroupService().groupList(params);
  }

  private async groupSync(params: Record<string, unknown>): Promise<unknown> {
    return this.getGroupService().groupSync(params);
  }

  private async groupContracts(params: Record<string, unknown>): Promise<unknown> {
    return this.getGroupService().groupContracts(params);
  }

  private async groupQuery(params: Record<string, unknown>): Promise<unknown> {
    await this.refreshRepos();
    return this.getGroupService().groupQuery(params);
  }

  private async groupStatus(params: Record<string, unknown>): Promise<unknown> {
    await this.refreshRepos();
    return this.getGroupService().groupStatus(params);
  }

  /**
   * Fetch Route nodes with their consumers in a single query.
   * Shared by routeMap and shapeCheck to avoid N+1 query patterns.
   */
  private async fetchRoutesWithConsumers(
    repoId: string,
    routeFilter: string,
    params: Record<string, string>,
  ): Promise<
    Array<{
      id: string;
      name: string;
      filePath: string;
      responseKeys: string[] | null;
      errorKeys: string[] | null;
      middleware: string[] | null;
      consumers: Array<{
        name: string;
        filePath: string;
        accessedKeys?: string[];
        fetchCount?: number;
      }>;
    }>
  > {
    const rows = await executeParameterized(
      repoId,
      `
      MATCH (n:Route)
      WHERE n.id STARTS WITH 'Route:' ${routeFilter}
      OPTIONAL MATCH (consumer)-[r:CodeRelation]->(n)
      WHERE r.type = 'FETCHES'
      RETURN n.id AS routeId, n.name AS routeName, n.filePath AS handlerFile,
             n.responseKeys AS responseKeys, n.errorKeys AS errorKeys, n.middleware AS middleware,
             consumer.name AS consumerName, consumer.filePath AS consumerFile,
             r.reason AS fetchReason
    `,
      params,
    );

    // Strip wrapping quotes from DB array elements — CSV COPY stores ['key'] which
    // LadybugDB may return as "'key'" rather than "key"
    const stripQuotes = (keys: string[] | null): string[] | null =>
      keys ? keys.map((k) => k.replace(/^['"]|['"]$/g, '')) : null;

    const routeMap = new Map<
      string,
      {
        id: string;
        name: string;
        filePath: string;
        responseKeys: string[] | null;
        errorKeys: string[] | null;
        middleware: string[] | null;
        consumers: Array<{
          name: string;
          filePath: string;
          accessedKeys?: string[];
          fetchCount?: number;
        }>;
      }
    >();
    for (const row of rows) {
      const id = row.routeId ?? row[0];
      const name = row.routeName ?? row[1];
      const filePath = row.handlerFile ?? row[2];
      const responseKeys = stripQuotes(row.responseKeys ?? row[3] ?? null);
      const errorKeys = stripQuotes(row.errorKeys ?? row[4] ?? null);
      const middleware = stripQuotes(row.middleware ?? row[5] ?? null);
      const consumerName = row.consumerName ?? row[6];
      const consumerFile = row.consumerFile ?? row[7];
      const fetchReason: string | null = row.fetchReason ?? row[8] ?? null;

      if (!routeMap.has(id)) {
        routeMap.set(id, {
          id,
          name,
          filePath,
          responseKeys,
          errorKeys,
          middleware,
          consumers: [],
        });
      }
      if (consumerName && consumerFile) {
        // Parse accessed keys from reason field: "fetch-url-match|keys:data,pagination|fetches:3"
        let accessedKeys: string[] | undefined;
        let fetchCount: number | undefined;
        if (fetchReason) {
          const keysMatch = fetchReason.match(/\|keys:([^|]+)/);
          if (keysMatch) {
            accessedKeys = keysMatch[1].split(',').filter((k) => k.length > 0);
          }
          const fetchesMatch = fetchReason.match(/\|fetches:(\d+)/);
          if (fetchesMatch) {
            fetchCount = parseInt(fetchesMatch[1], 10);
          }
        }
        routeMap.get(id)!.consumers.push({
          name: consumerName,
          filePath: consumerFile,
          ...(accessedKeys ? { accessedKeys } : {}),
          ...(fetchCount && fetchCount > 1 ? { fetchCount } : {}),
        });
      }
    }

    return [...routeMap.values()];
  }

  /**
   * Batch-fetch execution flows linked to a set of Route or Tool nodes.
   * Single query instead of N+1.
   */
  private async fetchLinkedFlowsBatch(
    repoId: string,
    nodeIds: string[],
  ): Promise<Map<string, string[]>> {
    const result = new Map<string, string[]>();
    if (nodeIds.length === 0) return result;
    try {
      // Use list_contains to filter at DB level instead of fetching all and filtering in memory
      const rows = await executeParameterized(
        repoId,
        `
        MATCH (source)-[r:CodeRelation]->(proc:Process)
        WHERE r.type = 'ENTRY_POINT_OF'
          AND list_contains($nodeIds, source.id)
        RETURN source.id AS sourceId, proc.label AS name
      `,
        { nodeIds },
      );
      for (const row of rows) {
        const sourceId = row.sourceId ?? row[0];
        const name = row.name ?? row[1];
        if (!name) continue;
        let list = result.get(sourceId);
        if (!list) {
          list = [];
          result.set(sourceId, list);
        }
        list.push(name);
      }
    } catch {
      /* no ENTRY_POINT_OF edges yet */
    }
    return result;
  }

  private async routeMap(repo: RepoHandle, params: { route?: string }): Promise<any> {
    await this.ensureInitialized(repo.id);

    const routeFilter = params.route ? `AND n.name CONTAINS $route` : '';
    const queryParams = params.route ? { route: params.route } : {};
    const routes = await this.fetchRoutesWithConsumers(repo.id, routeFilter, queryParams);

    if (routes.length === 0) {
      return {
        routes: [],
        total: 0,
        message: params.route
          ? `No routes matching "${params.route}"`
          : 'No routes found in this project.',
      };
    }

    const flowMap = await this.fetchLinkedFlowsBatch(
      repo.id,
      routes.map((r) => r.id),
    );

    return {
      routes: routes.map((r) => ({
        route: r.name,
        handler: r.filePath,
        middleware: r.middleware || [],
        consumers: r.consumers,
        flows: flowMap.get(r.id) || [],
      })),
      total: routes.length,
    };
  }

  private async shapeCheck(repo: RepoHandle, params: { route?: string }): Promise<any> {
    await this.ensureInitialized(repo.id);

    const routeFilter = params.route ? `AND n.name CONTAINS $route` : '';
    const queryParams = params.route ? { route: params.route } : {};
    const allRoutes = await this.fetchRoutesWithConsumers(repo.id, routeFilter, queryParams);

    const results = allRoutes
      .filter(
        (r) =>
          ((r.responseKeys && r.responseKeys.length > 0) ||
            (r.errorKeys && r.errorKeys.length > 0)) &&
          r.consumers.length > 0,
      )
      .map((r) => {
        // Keys already normalized by fetchRoutesWithConsumers (quotes stripped)
        const responseKeys = r.responseKeys ?? [];
        const errorKeys = r.errorKeys ?? [];
        // Combined set: consumer accessing either success or error keys is valid
        const allKnownKeys = new Set([...responseKeys, ...errorKeys]);

        // Check each consumer's accessed keys against the route's response shape
        const responseKeySet = new Set(responseKeys);
        const consumers = r.consumers.map((c) => {
          if (!c.accessedKeys || c.accessedKeys.length === 0) {
            return { name: c.name, filePath: c.filePath };
          }
          const mismatched = c.accessedKeys.filter((k) => !allKnownKeys.has(k));
          // Keys in allKnownKeys but not in responseKeys — error-path access (e.g., .error from errorKeys)
          const errorPathKeys = c.accessedKeys.filter(
            (k) => allKnownKeys.has(k) && !responseKeySet.has(k),
          );
          const isMultiFetch = (c.fetchCount ?? 1) > 1;
          return {
            name: c.name,
            filePath: c.filePath,
            accessedKeys: c.accessedKeys,
            ...(mismatched.length > 0
              ? {
                  mismatched,
                  mismatchConfidence: isMultiFetch ? ('low' as const) : ('high' as const),
                }
              : {}),
            ...(errorPathKeys.length > 0 ? { errorPathKeys } : {}),
            ...(isMultiFetch
              ? {
                  attributionNote: `This file fetches ${c.fetchCount} routes — accessed keys may belong to a different route.`,
                }
              : {}),
          };
        });

        const hasMismatches = consumers.some(
          (c) => 'mismatched' in c && (c as any).mismatched.length > 0,
        );

        return {
          route: r.name,
          handler: r.filePath,
          ...(responseKeys.length > 0 ? { responseKeys } : {}),
          ...(errorKeys.length > 0 ? { errorKeys } : {}),
          consumers,
          ...(hasMismatches ? { status: 'MISMATCH' as const } : {}),
        };
      });

    const mismatchCount = results.filter((r) => r.status === 'MISMATCH').length;

    return {
      routes: results,
      total: results.length,
      routesWithShapes: results.length,
      ...(mismatchCount > 0 ? { mismatches: mismatchCount } : {}),
      message:
        results.length === 0
          ? 'No routes with both response shapes and consumers found.'
          : mismatchCount > 0
            ? `Found ${results.length} route(s) with response shape data. ${mismatchCount} route(s) have consumer/shape mismatches.`
            : `Found ${results.length} route(s) with response shape data and consumers.`,
    };
  }

  private async toolMap(repo: RepoHandle, params: { tool?: string }): Promise<any> {
    await this.ensureInitialized(repo.id);

    const toolFilter = params.tool ? `AND n.name CONTAINS $tool` : '';
    const queryParams = params.tool ? { tool: params.tool } : {};

    const rows = await executeParameterized(
      repo.id,
      `
      MATCH (n:Tool)
      WHERE n.id STARTS WITH 'Tool:' ${toolFilter}
      RETURN n.id AS id, n.name AS name, n.filePath AS filePath, n.description AS description
    `,
      queryParams,
    );

    if (rows.length === 0) {
      return {
        tools: [],
        total: 0,
        message: params.tool ? `No tools matching "${params.tool}"` : 'No tool definitions found.',
      };
    }

    const toolIds = rows.map((r: any) => r.id ?? r[0]);
    const flowMap = await this.fetchLinkedFlowsBatch(repo.id, toolIds);

    return {
      tools: rows.map((r: any) => {
        const id = r.id ?? r[0];
        return {
          name: r.name ?? r[1],
          filePath: r.filePath ?? r[2],
          description: (r.description ?? r[3] ?? '').slice(0, 200),
          flows: flowMap.get(id) || [],
        };
      }),
      total: rows.length,
    };
  }

  private async apiImpact(
    repo: RepoHandle,
    params: { route?: string; file?: string },
  ): Promise<any> {
    await this.ensureInitialized(repo.id);

    if (!params.route && !params.file) {
      return { error: 'Either "route" or "file" parameter is required.' };
    }

    // If file is provided but route is not, look up the route by file path
    let routeFilter = '';
    const queryParams: Record<string, string> = {};

    if (params.route) {
      routeFilter = `AND n.name CONTAINS $route`;
      queryParams.route = params.route;
    } else if (params.file) {
      routeFilter = `AND n.filePath CONTAINS $file`;
      queryParams.file = params.file;
    }

    const routes = await this.fetchRoutesWithConsumers(repo.id, routeFilter, queryParams);

    if (routes.length === 0) {
      const target = params.route || params.file;
      return { error: `No routes found matching "${target}".` };
    }

    const flowMap = await this.fetchLinkedFlowsBatch(
      repo.id,
      routes.map((r) => r.id),
    );

    // Count how many routes share the same handler file (for middleware partial detection)
    const routeCountByHandler = new Map<string, number>();
    for (const r of routes) {
      if (r.filePath) {
        routeCountByHandler.set(r.filePath, (routeCountByHandler.get(r.filePath) ?? 0) + 1);
      }
    }

    const results = routes.map((r) => {
      // Keys already normalized by fetchRoutesWithConsumers (quotes stripped)
      const responseKeys = r.responseKeys ?? [];
      const errorKeys = r.errorKeys ?? [];
      const allKnownKeys = new Set([...responseKeys, ...errorKeys]);

      // Build consumer list with mismatch detection
      const consumers = r.consumers.map((c) => ({
        name: c.name,
        file: c.filePath,
        accesses: c.accessedKeys ?? [],
        ...(c.fetchCount && c.fetchCount > 1
          ? {
              attributionNote: `This file fetches ${c.fetchCount} routes — accessed keys may belong to a different route.`,
            }
          : {}),
      }));

      // Detect mismatches: consumer accesses keys not in response shape
      const mismatches: Array<{
        consumer: string;
        field: string;
        reason: string;
        confidence: 'high' | 'low';
      }> = [];
      if (allKnownKeys.size > 0) {
        for (const c of r.consumers) {
          if (!c.accessedKeys) continue;
          const isMultiFetch = (c.fetchCount ?? 1) > 1;
          for (const key of c.accessedKeys) {
            if (!allKnownKeys.has(key)) {
              mismatches.push({
                consumer: c.filePath,
                field: key,
                reason: 'accessed but not in response shape',
                confidence: isMultiFetch ? 'low' : 'high',
              });
            }
          }
        }
      }

      const flows = flowMap.get(r.id) || [];
      const consumerCount = r.consumers.length;

      // Risk level heuristic
      let riskLevel: 'LOW' | 'MEDIUM' | 'HIGH';
      if (consumerCount >= 10) {
        riskLevel = 'HIGH';
      } else if (consumerCount >= 4) {
        riskLevel = 'MEDIUM';
      } else {
        riskLevel = 'LOW';
      }
      // Bump up one level if mismatches exist
      if (mismatches.length > 0) {
        if (riskLevel === 'LOW') riskLevel = 'MEDIUM';
        else if (riskLevel === 'MEDIUM') riskLevel = 'HIGH';
      }

      const warning =
        consumerCount > 0
          ? `Changing response shape will affect ${consumerCount} component${consumerCount === 1 ? '' : 's'}`
          : undefined;

      // Flag when middleware was detected but handler exports multiple HTTP methods
      // (middleware chain may only reflect one export)
      const middlewareArr = r.middleware || [];
      const handlerRouteCount = r.filePath ? (routeCountByHandler.get(r.filePath) ?? 1) : 1;
      const middlewarePartial = middlewareArr.length > 0 && handlerRouteCount > 1;

      return {
        route: r.name,
        handler: r.filePath,
        responseShape: {
          success: responseKeys,
          error: errorKeys,
        },
        middleware: middlewareArr,
        ...(middlewarePartial
          ? {
              middlewareDetection: 'partial' as const,
              middlewareNote:
                'Middleware captured from first HTTP method export only — other methods in this handler may use different middleware chains.',
            }
          : {}),
        consumers,
        ...(mismatches.length > 0 ? { mismatches } : {}),
        executionFlows: flows,
        impactSummary: {
          directConsumers: consumerCount,
          affectedFlows: flows.length,
          riskLevel,
          ...(warning ? { warning } : {}),
        },
      };
    });

    // If a single route was targeted, return it directly (not wrapped in array)
    if (results.length === 1) {
      return results[0];
    }

    return { routes: results, total: results.length };
  }

  // ─── Direct Graph Queries (for resources.ts) ────────────────────

  /**
   * Query clusters (communities) directly from graph.
   * Used by getClustersResource — avoids legacy overview() dispatch.
   */
  async queryClusters(repoName?: string, limit = 100): Promise<{ clusters: any[] }> {
    const repo = await this.resolveRepo(repoName);
    await this.ensureInitialized(repo.id);

    try {
      const rawLimit = Math.max(limit * 5, 200);
      const clusters = await executeQuery(
        repo.id,
        `
        MATCH (c:Community)
        RETURN c.id AS id, c.label AS label, c.heuristicLabel AS heuristicLabel, c.cohesion AS cohesion, c.symbolCount AS symbolCount
        ORDER BY c.symbolCount DESC
        LIMIT ${rawLimit}
      `,
      );
      const rawClusters = clusters.map((c: any) => ({
        id: c.id || c[0],
        label: c.label || c[1],
        heuristicLabel: c.heuristicLabel || c[2],
        cohesion: c.cohesion || c[3],
        symbolCount: c.symbolCount || c[4],
      }));
      return { clusters: this.aggregateClusters(rawClusters).slice(0, limit) };
    } catch {
      return { clusters: [] };
    }
  }

  /**
   * Query processes directly from graph.
   * Used by getProcessesResource — avoids legacy overview() dispatch.
   */
  async queryProcesses(repoName?: string, limit = 50): Promise<{ processes: any[] }> {
    const repo = await this.resolveRepo(repoName);
    await this.ensureInitialized(repo.id);

    try {
      const processes = await executeQuery(
        repo.id,
        `
        MATCH (p:Process)
        RETURN p.id AS id, p.label AS label, p.heuristicLabel AS heuristicLabel, p.processType AS processType, p.stepCount AS stepCount
        ORDER BY p.stepCount DESC
        LIMIT ${limit}
      `,
      );
      return {
        processes: processes.map((p: any) => ({
          id: p.id || p[0],
          label: p.label || p[1],
          heuristicLabel: p.heuristicLabel || p[2],
          processType: p.processType || p[3],
          stepCount: p.stepCount || p[4],
        })),
      };
    } catch {
      return { processes: [] };
    }
  }

  /**
   * Query cluster detail (members) directly from graph.
   * Used by getClusterDetailResource.
   */
  async queryClusterDetail(name: string, repoName?: string): Promise<any> {
    const repo = await this.resolveRepo(repoName);
    await this.ensureInitialized(repo.id);

    const clusters = await executeParameterized(
      repo.id,
      `
      MATCH (c:Community)
      WHERE c.label = $clusterName OR c.heuristicLabel = $clusterName
      RETURN c.id AS id, c.label AS label, c.heuristicLabel AS heuristicLabel, c.cohesion AS cohesion, c.symbolCount AS symbolCount
    `,
      { clusterName: name },
    );
    if (clusters.length === 0) return { error: `Cluster '${name}' not found` };

    const rawClusters = clusters.map((c: any) => ({
      id: c.id || c[0],
      label: c.label || c[1],
      heuristicLabel: c.heuristicLabel || c[2],
      cohesion: c.cohesion || c[3],
      symbolCount: c.symbolCount || c[4],
    }));

    let totalSymbols = 0,
      weightedCohesion = 0;
    for (const c of rawClusters) {
      const s = c.symbolCount || 0;
      totalSymbols += s;
      weightedCohesion += (c.cohesion || 0) * s;
    }

    const members = await executeParameterized(
      repo.id,
      `
      MATCH (n)-[:CodeRelation {type: 'MEMBER_OF'}]->(c:Community)
      WHERE c.label = $clusterName OR c.heuristicLabel = $clusterName
      RETURN DISTINCT n.name AS name, labels(n)[0] AS type, n.filePath AS filePath
      LIMIT 30
    `,
      { clusterName: name },
    );

    return {
      cluster: {
        id: rawClusters[0].id,
        label: rawClusters[0].heuristicLabel || rawClusters[0].label,
        heuristicLabel: rawClusters[0].heuristicLabel || rawClusters[0].label,
        cohesion: totalSymbols > 0 ? weightedCohesion / totalSymbols : 0,
        symbolCount: totalSymbols,
        subCommunities: rawClusters.length,
      },
      members: members.map((m: any) => ({
        name: m.name || m[0],
        type: m.type || m[1],
        filePath: m.filePath || m[2],
      })),
    };
  }

  /**
   * Query process detail (steps) directly from graph.
   * Used by getProcessDetailResource.
   */
  async queryProcessDetail(name: string, repoName?: string): Promise<any> {
    const repo = await this.resolveRepo(repoName);
    await this.ensureInitialized(repo.id);

    const processes = await executeParameterized(
      repo.id,
      `
      MATCH (p:Process)
      WHERE p.label = $processName OR p.heuristicLabel = $processName
      RETURN p.id AS id, p.label AS label, p.heuristicLabel AS heuristicLabel, p.processType AS processType, p.stepCount AS stepCount
      LIMIT 1
    `,
      { processName: name },
    );
    if (processes.length === 0) return { error: `Process '${name}' not found` };

    const proc = processes[0];
    const procId = proc.id || proc[0];
    const steps = await executeParameterized(
      repo.id,
      `
      MATCH (n)-[r:CodeRelation {type: 'STEP_IN_PROCESS'}]->(p {id: $procId})
      RETURN n.name AS name, labels(n)[0] AS type, n.filePath AS filePath, r.step AS step
      ORDER BY r.step
    `,
      { procId },
    );

    return {
      process: {
        id: procId,
        label: proc.label || proc[1],
        heuristicLabel: proc.heuristicLabel || proc[2],
        processType: proc.processType || proc[3],
        stepCount: proc.stepCount || proc[4],
      },
      steps: steps.map((s: any) => ({
        step: s.step || s[3],
        name: s.name || s[0],
        type: s.type || s[1],
        filePath: s.filePath || s[2],
      })),
    };
  }

  async disconnect(): Promise<void> {
    await closeLbug(); // close all connections
    // Note: we intentionally do NOT call disposeEmbedder() here.
    // ONNX Runtime's native cleanup segfaults on macOS and some Linux configs,
    // and importing the embedder module on Node v24+ crashes if onnxruntime
    // was never loaded during the session. Since process.exit(0) follows
    // immediately after disconnect(), the OS reclaims everything. See #38, #89.
    this.repos.clear();
    this.contextCache.clear();
    this.initializedRepos.clear();
  }
}
