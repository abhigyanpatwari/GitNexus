/**
 * Local Backend (Multi-Repo)
 * 
 * Provides tool implementations using local .gitnexus/ indexes.
 * Supports multiple indexed repositories via a global registry.
 * LadybugDB connections are opened lazily per repo on first query.
 */

import fs from 'fs/promises';
import path from 'path';
import { initLbug, executeQuery, executeParameterized, closeLbug, isLbugReady } from '../core/lbug-adapter.js';
// Embedding imports are lazy (dynamic import) to avoid loading onnxruntime-node
// at MCP server startup — crashes on unsupported Node ABI versions (#89)
// git utilities available if needed
// import { isGitRepo, getCurrentCommit, getGitRoot } from '../../storage/git.js';
import {
  listRegisteredRepos,
  cleanupOldKuzuFiles,
  loadMeta,
  type RegistryEntry,
} from '../../storage/repo-manager.js';
import { SCHEMA_VERSION } from '../../core/lbug/schema.js';
import { readManifest, type RepoManifest } from '../../storage/repo-manifest.js';
import { CrossRepoRegistry } from '../../core/ingestion/cross-repo-registry.js';
import { documentEndpoint, type DocumentEndpointOptions, type DocumentEndpointResult, type OpenApiModeResult } from './document-endpoint.js';
import type { CrossRepoContext } from './cross-repo-context.js';
import { CrossRepoResolver, type ChangedSymbol, type RepoHandle as ResolverRepoHandle } from './cross-repo-resolver.js';
import { queryEndpoints, type EndpointInfo } from './endpoint-query.js';
import { parseMethodLevelMapping, parseClassLevelPrefix, combinePaths } from './route-annotation-parser.js';
import { parseDiffOutputWithLines, type FileDiffWithLines, type LineRange } from './parse-diff-lines.js';
// AI context generation is CLI-only (gitnexus analyze)
// import { generateAIContextFiles } from '../../cli/ai-context.js';

/**
 * Quick test-file detection for filtering impact results.
 * Matches common test file patterns across all supported languages.
 */
export function isTestFilePath(filePath: string): boolean {
  const p = filePath.toLowerCase().replace(/\\/g, '/');
  return (
    p.includes('.test.') || p.includes('.spec.') ||
    p.includes('__tests__/') || p.includes('__mocks__/') ||
    p.includes('/test/') || p.includes('/tests/') ||
    p.includes('/testing/') || p.includes('/fixtures/') ||
    p.endsWith('_test.go') || p.endsWith('_test.py') ||
    p.endsWith('_spec.rb') || p.endsWith('_test.rb') || p.includes('/spec/') ||
    p.includes('/test_') || p.includes('/conftest.')
  );
}

/** Valid LadybugDB node labels for safe Cypher query construction */
export const VALID_NODE_LABELS = new Set([
  'File', 'Folder', 'Function', 'Class', 'Interface', 'Method', 'CodeElement',
  'Community', 'Process', 'Struct', 'Enum', 'Macro', 'Typedef', 'Union',
  'Namespace', 'Trait', 'Impl', 'TypeAlias', 'Const', 'Static', 'Property',
  'Record', 'Delegate', 'Annotation', 'Constructor', 'Template', 'Module',
]);

/** Valid relation types for impact analysis filtering */
export const VALID_RELATION_TYPES = new Set([
  'CALLS', 'IMPORTS', 'EXTENDS', 'IMPLEMENTS', 'HAS_METHOD', 'HAS_PROPERTY',
  'OVERRIDES', 'ACCESSES', 'HANDLES_ROUTE', 'FETCHES', 'HANDLES_TOOL',
  'ENTRY_POINT_OF', 'WRAPS', 'CONTAINS'
]);

/**
 * Confidence floors per relation type for impact analysis.
 * Used when no stored graph confidence is available.
 * Higher = more trustworthy relationship (structural containment).
 * Lower = potentially indirect/observational relationship.
 */
export const IMPACT_RELATION_CONFIDENCE: Record<string, number> = {
  CALLS: 0.9,          // direct function reference
  IMPORTS: 0.9,        // direct module import
  EXTENDS: 0.85,       // statically verifiable inheritance
  IMPLEMENTS: 0.85,    // statically verifiable contract
  OVERRIDES: 0.85,     // statically verifiable override
  HAS_METHOD: 0.95,    // structural containment (method in class)
  HAS_PROPERTY: 0.95,  // structural containment (field in class)
  ACCESSES: 0.8,       // may be indirect read/write
  CONTAINS: 0.95,      // folder/file structural containment
};

/** Regex to detect write operations in user-supplied Cypher queries */
export const CYPHER_WRITE_RE = /(?<!:)\b(CREATE|DELETE|SET|MERGE|REMOVE|DROP|ALTER|COPY|DETACH)\b/i;

/** Check if a Cypher query contains write operations */
export function isWriteQuery(query: string): boolean {
  return CYPHER_WRITE_RE.test(query);
}

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

export interface RepoHandle {
  id: string;          // unique key = repo name (basename)
  name: string;
  repoPath: string;
  storagePath: string;
  lbugPath: string;
  indexedAt: string;
  lastCommit: string;
  stats?: RegistryEntry['stats'];
}

/** Summary shape for impacted_endpoints — always uses Record<string, number> for per-repo counts. */
interface ImpactedEndpointsSummary {
  changed_files: Record<string, number>;
  changed_symbols: Record<string, number>;
  impacted_endpoints: Record<string, number>;
  risk_level: string;
}

/** Asserts that a value is a non-null object (Record<string, number>), not a bare number. */
function assertObjectType(value: unknown, fieldName: string): asserts value is Record<string, number> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`Unexpected ${fieldName} type: ${typeof value}. Expected Record<string, number>.`);
  }
}

export class LocalBackend {
  private repos: Map<string, RepoHandle> = new Map();
  private contextCache: Map<string, CodebaseContext> = new Map();
  private initializedRepos: Set<string> = new Set();
  private crossRepoRegistry: CrossRepoRegistry | null = null;
  private crossRepoInitPromise: Promise<void> | null = null;

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
        console.error(`GitNexus: "${entry.name}" has a stale KuzuDB index. Run: gitnexus analyze ${entry.path}`);
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
      const names = [...this.repos.values()].map(h => h.name);
      throw new Error(`Repository "${repoParam}" not found. Available: ${names.join(', ')}`);
    }
    const names = [...this.repos.values()].map(h => h.name);
    throw new Error(
      `Multiple repositories indexed. Specify which one with the "repo" parameter. Available: ${names.join(', ')}`
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

    // Multiple repos, no param — try to resolve from cwd
    const cwd = process.cwd();
    const cwdMatch = this.resolveRepoFromCwd(cwd);
    if (cwdMatch) {
      console.error(`GitNexus: auto-resolved repo "${cwdMatch.name}" from working directory`);
      return cwdMatch;
    }

    return null; // Ambiguous — resolveRepo will throw
  }

  /**
   * Returns the indexed repo whose repoPath contains cwd (longest-prefix wins).
   * Guards with path.sep so /foo does NOT match /foo-bar.
   */
  private resolveRepoFromCwd(cwd: string): RepoHandle | null {
    let best: RepoHandle | null = null;
    let bestLen = -1;
    for (const handle of this.repos.values()) {
      const root = handle.repoPath;
      if (cwd === root || cwd.startsWith(root + path.sep)) {
        if (root.length > bestLen) {
          best = handle;
          bestLen = root.length;
        }
      }
    }
    return best;
  }

  // ─── Lazy LadybugDB Init ────────────────────────────────────────────

  private async ensureInitialized(repoId: string): Promise<void> {
    // Always check the actual pool — the idle timer may have evicted the connection
    if (this.initializedRepos.has(repoId) && isLbugReady(repoId)) return;

    const handle = this.repos.get(repoId);
    if (!handle) throw new Error(`Unknown repo: ${repoId}`);

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
  async listRepos(): Promise<Array<{ name: string; path: string; indexedAt: string; lastCommit: string; stats?: any }>> {
    await this.refreshRepos();
    return [...this.repos.values()].map(h => ({
      name: h.name,
      path: h.repoPath,
      indexedAt: h.indexedAt,
      lastCommit: h.lastCommit,
      stats: h.stats,
    }));
  }

  // ─── Tool Dispatch ───────────────────────────────────────────────

  async callTool<T = unknown>(method: string, params: any): Promise<T> {
    if (method === 'list_repos') {
      return this.listRepos() as T;
    }

    // Cross-repo routing: if repos[] is provided, use multi-repo handler
    if (params?.repos && Array.isArray(params.repos) && params.repos.length > 0) {
      return this.callToolMultiRepo(method, params) as T;
    }

    // Auto-expand impacted_endpoints to include consumer repos (WI-4)
    // When called without explicit repos, discover dependents via CrossRepoRegistry
    // and route to multi-repo handler. Falls back to single-repo if no consumers found.
    if (method === 'impacted_endpoints') {
      // (#21) Respect explicit `repo` parameter as a hard scope. Without
      // this guard, `expandToConsumers` would silently fan out to consumer
      // repos and the response would include changes from those other
      // repos — making the `repo` parameter appear to be ignored. Only
      // auto-expand when the caller did NOT pin a specific repo.
      const repo = await this.resolveRepo(params?.repo);
      const explicitScope = !!params?.repo;
      if (explicitScope) {
        // Single-repo path — strict scope, no auto-expansion.
        const result = await this._impactedEndpointsImpl(repo, params);
        if (!result.error) {
          assertObjectType(result.summary?.changed_files, 'changed_files');
        }
        return result as T;
      }
      // No explicit repo: try to expand to consumer repos. Falls back to
      // single-repo if no consumers found or registry not available.
      const expanded = await this.expandToConsumers(repo.id);
      if (expanded) {
        return this.callToolMultiRepo(method, { ...params, repos: expanded }) as T;
      }
      // No consumers found or registry not available — single-repo fallback
      const result = await this._impactedEndpointsImpl(repo, params);
      if (!result.error) {
        assertObjectType(result.summary?.changed_files, 'changed_files');
      }
      return result as T;
    }

    // Single-repo routing (backward compatible)
    // Resolve repo from optional param (re-reads registry on miss)
    const repo = await this.resolveRepo(params?.repo);

    switch (method) {
      case 'query':
        return this.query(repo, params) as T;
      case 'cypher': {
        const raw = await this.cypher(repo, params);
        return this.formatCypherAsMarkdown(raw) as T;
      }
      case 'context':
        return this.context(repo, params) as T;
      case 'impact':
        return this.impact(repo, params) as T;
      case 'detect_changes':
        return this.detectChanges(repo, params) as T;
      case 'rename':
        return this.rename(repo, params) as T;
      case 'endpoints':
        return this.endpoints(repo, params) as T;
      case 'document-endpoint':
        return this.documentEndpoint(repo, params) as T;
      case 'api_impact':
        return this.apiImpact(repo, params) as T;
      case 'route_map':
        return this.routeMap(repo, params) as T;
      case 'shape_check':
        return this.shapeCheck(repo, params) as T;
      // Legacy aliases for backwards compatibility
      case 'search':
        return this.query(repo, params) as T;
      case 'explore':
        return this.context(repo, { name: params?.name, ...params }) as T;
      case 'overview':
        return this.overview(repo, params) as T;
      default:
        throw new Error(`Unknown tool: ${method}`);
    }
  }

  /**
   * Multi-repo tool dispatch.
   * Executes queries across multiple repos in parallel and aggregates results.
   * Each result includes _repoId attribution.
   */
  private async callToolMultiRepo(method: string, params: any): Promise<any> {
    const repoIds: string[] = params.repos;

    switch (method) {
      case 'query': {
        // Query each repo in parallel and aggregate results
        const results = await Promise.all(
          repoIds.map(async (repoId) => {
            try {
              const handle = await this.resolveRepo(repoId);
              const result = await this.query(handle, params);
              return { repoId, result, error: null };
            } catch (err: any) {
              return { repoId, result: null, error: err.message };
            }
          })
        );

        // Aggregate results with _repoId attribution
        const aggregated = {
          processes: [] as any[],
          process_symbols: [] as any[],
          definitions: [] as any[],
          errors: [] as { repoId: string; error: string }[],
        };

        for (const { repoId, result, error } of results) {
          if (error) {
            aggregated.errors.push({ repoId, error });
          } else if (result) {
            // Add _repoId to each item
            if (result.processes) {
              aggregated.processes.push(...result.processes.map((p: any) => ({ ...p, _repoId: repoId })));
            }
            if (result.process_symbols) {
              aggregated.process_symbols.push(...result.process_symbols.map((s: any) => ({ ...s, _repoId: repoId })));
            }
            if (result.definitions) {
              aggregated.definitions.push(...result.definitions.map((d: any) => ({ ...d, _repoId: repoId })));
            }
          }
        }

        return aggregated;
      }

      case 'cypher': {
        // Execute cypher on multiple repos in parallel
        const cypherQuery = params.query;
        const raw = await this.queryMultipleRepos(repoIds, cypherQuery);
        // Aggregate results with _repoId and format as markdown
        return this.formatMultiRepoCypherResult(raw);
      }

      case 'context': {
        // Query context from multiple repos
        const results = await Promise.all(
          repoIds.map(async (repoId) => {
            try {
              const handle = await this.resolveRepo(repoId);
              const result = await this.context(handle, params);
              return { repoId, result, error: null };
            } catch (err: any) {
              return { repoId, result: null, error: err.message };
            }
          })
        );

        // Aggregate candidates from all repos
        const aggregated: any = {
          status: 'found',
          candidates: [] as any[],
          errors: [] as { repoId: string; error: string }[],
        };

        for (const { repoId, result, error } of results) {
          if (error) {
            aggregated.errors.push({ repoId, error });
          } else if (result) {
            if (result.status === 'ambiguous' && result.candidates) {
              // Add _repoId to each candidate
              aggregated.candidates.push(...result.candidates.map((c: any) => ({ ...c, _repoId: repoId })));
            } else if (result.status === 'found' && result.symbol) {
              // First-repo wins: skip if already found in an earlier repo
              if (!aggregated.symbol) {
                aggregated.symbol = { ...result.symbol, _repoId: repoId };
                aggregated.repoId = repoId;
                // Preserve relationship data with _repoId attribution
                if (result.incoming) {
                  aggregated.incoming = Object.fromEntries(
                    Object.entries(result.incoming).map(([cat, entries]) => [
                      cat,
                      (entries as any[]).map((e: any) => ({ ...e, _repoId: repoId })),
                    ]),
                  );
                }
                if (result.outgoing) {
                  aggregated.outgoing = Object.fromEntries(
                    Object.entries(result.outgoing).map(([cat, entries]) => [
                      cat,
                      (entries as any[]).map((e: any) => ({ ...e, _repoId: repoId })),
                    ]),
                  );
                }
                if (result.processes) {
                  aggregated.processes = result.processes.map((p: any) => ({ ...p, _repoId: repoId }));
                }
              }
            }
          }
        }

        // If we found an exact match, return it with relationships
        if (aggregated.symbol) {
          const found: any = {
            status: 'found',
            symbol: aggregated.symbol,
            incoming: aggregated.incoming || {},
            outgoing: aggregated.outgoing || {},
            processes: aggregated.processes || [],
            _repoId: aggregated.repoId,
          };
          if (aggregated.errors.length > 0) {
            found.errors = aggregated.errors;
          }
          return found;
        }

        // Otherwise return aggregated candidates
        if (aggregated.candidates.length > 0) {
          aggregated.status = 'ambiguous';
        } else {
          aggregated.status = 'not_found';
        }

        return aggregated;
      }

      case 'endpoints': {
        // (#12) Query Route nodes for HTTP endpoints across multiple repos.
        // Mirrors the single-repo `endpoints` contract: each repo contributes
        // its EndpointInfo[]; results are tagged with `_repoId`. Failed repos
        // surface in `errors[]` rather than aborting the whole call.
        const results = await Promise.all(
          repoIds.map(async (repoId) => {
            try {
              const handle = await this.resolveRepo(repoId);
              const result = await this.endpoints(handle, params);
              return { repoId, result, error: null };
            } catch (err: any) {
              return { repoId, result: null, error: err.message };
            }
          })
        );

        const aggregated: any = {
          endpoints: [] as any[],
          errors: [] as { repoId: string; error: string }[],
        };

        for (const { repoId, result, error } of results) {
          if (error) {
            aggregated.errors.push({ repoId, error });
          } else if (result?.endpoints) {
            aggregated.endpoints.push(
              ...result.endpoints.map((e: any) => ({ ...e, _repoId: repoId })),
            );
          }
        }

        return aggregated;
      }

      case 'impact': {
        // Run impact analysis on multiple repos
        const results = await Promise.all(
          repoIds.map(async (repoId) => {
            try {
              const handle = await this.resolveRepo(repoId);
              const result = await this.impact(handle, params);
              return { repoId, result, error: null };
            } catch (err: any) {
              return { repoId, result: null, error: err.message };
            }
          })
        );

        // Aggregate impact results
        const aggregated: any = {
          target: params.target,
          direction: params.direction,
          byDepth: { d1: [], d2: [], d3: [] },
          affected_processes: [],
          affected_modules: [],
          errors: [],
        };

        for (const { repoId, result, error } of results) {
          if (error) {
            aggregated.errors.push({ repoId, error });
          } else if (result) {
            // Aggregate byDepth with _repoId
            if (result.byDepth?.d1) {
              aggregated.byDepth.d1.push(...result.byDepth.d1.map((s: any) => ({ ...s, _repoId: repoId })));
            }
            if (result.byDepth?.d2) {
              aggregated.byDepth.d2.push(...result.byDepth.d2.map((s: any) => ({ ...s, _repoId: repoId })));
            }
            if (result.byDepth?.d3) {
              aggregated.byDepth.d3.push(...result.byDepth.d3.map((s: any) => ({ ...s, _repoId: repoId })));
            }
            if (result.affected_processes) {
              aggregated.affected_processes.push(...result.affected_processes.map((p: any) => ({ ...p, _repoId: repoId })));
            }
            if (result.affected_modules) {
              aggregated.affected_modules.push(...result.affected_modules.map((m: any) => ({ ...m, _repoId: repoId })));
            }
          }
        }

        // Calculate aggregate risk
        aggregated.risk = this.calculateAggregateRisk(results.map((r) => r.result));

        return aggregated;
      }

      case 'impacted_endpoints': {
        // Lazy-initialize cross-repo registry for multi-repo queries
        if (!this.crossRepoRegistry) {
          if (!this.crossRepoInitPromise) {
            this.crossRepoInitPromise = this.initCrossRepoRegistry();
          }
          await this.crossRepoInitPromise;
        }

        const results = await Promise.all(
          repoIds.map(async (repoId) => {
            try {
              const handle = await this.resolveRepo(repoId);
              // Create cross-repo context for this repo
              let crossRepo: CrossRepoContext | undefined;
              if (this.crossRepoRegistry && repoIds.length > 1) {
                crossRepo = {
                  findDepRepo: (prefix: string) => this.findDepRepo(prefix),
                  queryMultipleRepos: (ids: string[], query: string, p: Record<string, unknown>) =>
                    this.queryMultipleRepos(ids, query, p),
                  listDepRepos: async () => {
                    const repos = this.crossRepoRegistry!.listRepos();
                    return repos.map(r => r.repoId).filter(id => id !== repoId);
                  },
                };
              }
              const result = await this._impactedEndpointsImpl(handle, params, crossRepo);
              return { repoId, result, error: null };
            } catch (err: any) {
              return { repoId, result: null, error: err.message };
            }
          })
        );

        const aggregated: any = {
          // (#28, #49) Every count field is a per-repo Record so the
          // single-repo and multi-repo shapes are identical. `changed_symbols`
          // was previously omitted from the multi-repo summary entirely
          // (issue #49) and `changed_files` could be a number in the
          // single-repo path (issue #28). Now both are uniformly
          // Record<string, number>.
          summary: {
            changed_files: {} as Record<string, number>,
            changed_symbols: {} as Record<string, number>,
            impacted_endpoints: {} as Record<string, number>,
          },
          impacted_endpoints: { WILL_BREAK: [] as any[], LIKELY_AFFECTED: [] as any[], MAY_NEED_TESTING: [] as any[] },
          changed_symbols: [] as any[],
          affected_processes: [] as any[],
          affected_modules: [] as any[],
          errors: [] as { repoId: string; error: string }[],
        };

        for (const { repoId, result, error } of results) {
          if (error) {
            aggregated.errors.push({ repoId, error });
          } else if (result) {
            // Merge changed_files: Record format or coerce bare number (backward compat)
            const cf = result.summary?.changed_files;
            if (typeof cf === 'object' && cf !== null) {
              Object.assign(aggregated.summary.changed_files, cf);
            } else if (typeof cf === 'number') {
              aggregated.summary.changed_files[repoId] = cf;
            }
            // (#49) Aggregate changed_symbols into the per-repo summary
            // Record. Tolerate both the new Record shape and the legacy
            // bare number for backward compatibility with single-repo
            // callers that may still return the old shape.
            const cs = result.summary?.changed_symbols;
            if (typeof cs === 'object' && cs !== null && !Array.isArray(cs)) {
              Object.assign(aggregated.summary.changed_symbols, cs);
            } else if (typeof cs === 'number') {
              aggregated.summary.changed_symbols[repoId] = cs;
            }
            // Merge impacted_endpoints: Record format or coerce bare number (backward compat)
            const ie = result.summary?.impacted_endpoints;
            if (typeof ie === 'object' && ie !== null) {
              Object.assign(aggregated.summary.impacted_endpoints, ie);
            } else if (typeof ie === 'number') {
              aggregated.summary.impacted_endpoints[repoId] = ie;
            }
            if (result.changed_symbols) {
              aggregated.changed_symbols.push(...result.changed_symbols.map((s: any) => ({ ...s, _repoId: repoId })));
            }
            if (result.impacted_endpoints) {
              for (const tier of ['WILL_BREAK', 'LIKELY_AFFECTED', 'MAY_NEED_TESTING'] as const) {
                if (result.impacted_endpoints[tier]) {
                  aggregated.impacted_endpoints[tier].push(...result.impacted_endpoints[tier].map((e: any) => ({ ...e, _repoId: repoId })));
                }
              }
            }
            if (result.affected_processes) {
              aggregated.affected_processes.push(...result.affected_processes.map((p: any) => ({ ...p, _repoId: repoId })));
            }
            if (result.affected_modules) {
              aggregated.affected_modules.push(...result.affected_modules.map((m: any) => ({ ...m, _repoId: repoId })));
            }
          }
        }

        // Filter null results before risk calculation; impacted_endpoints uses summary.risk_level
        const nonNullResults = results.map(r => r.result).filter((r): r is NonNullable<typeof r> => r != null);
        const riskLevels = nonNullResults.map(r => r.summary?.risk_level ?? r.risk).filter(Boolean);
        aggregated.summary.risk_level = this.calculateAggregateRisk(
          riskLevels.map(r => ({ risk: r }))
        );
        // Aggregate _meta: mark partial if any individual result is partial
        const anyPartial = nonNullResults.some(r => r._meta?.partial === true);
        aggregated._meta = {
          version: '1.0',
          generated_at: new Date().toISOString(),
          ...(anyPartial && { partial: true }),
        };
        return aggregated;
      }

      default:
        throw new Error(`Tool '${method}' does not support multi-repo queries. Use single 'repo' parameter instead.`);
    }
  }

  /**
   * Format multi-repo cypher results as markdown.
   */
  private formatMultiRepoCypherResult(results: Array<{ repoId: string; results: unknown[] }>): any {
    // Check if any repo had errors
    const allRows: any[] = [];
    const errors: { repoId: string; error: string }[] = [];

    for (const { repoId, results: rows } of results) {
      if (Array.isArray(rows)) {
        for (const row of rows) {
          if (row && typeof row === 'object' && 'error' in row) {
            errors.push({ repoId, error: (row as any).error });
          } else {
            allRows.push({ ...(row as object), _repoId: repoId });
          }
        }
      }
    }

    if (allRows.length === 0 && errors.length > 0) {
      return { error: errors.map((e) => `${e.repoId}: ${e.error}`).join('; ') };
    }

    if (allRows.length === 0) {
      return [];
    }

    // Format as markdown table
    return this.formatCypherAsMarkdown(allRows);
  }

  /**
   * Calculate aggregate risk from multi-repo impact results.
   */
  private calculateAggregateRisk(results: any[]): string {
    const risks = results
      .filter((r) => r && r.risk)
      .map((r) => r.risk);

    if (risks.includes('CRITICAL')) return 'CRITICAL';
    if (risks.includes('HIGH')) return 'HIGH';
    if (risks.includes('MEDIUM')) return 'MEDIUM';
    if (risks.includes('LOW')) return 'LOW';
    return 'NONE';
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
  private async query(repo: RepoHandle, params: {
    query: string;
    limit?: number;
    max_symbols?: number;
    include_content?: boolean;
  }): Promise<any> {
    if (!params.query?.trim()) {
      return { error: 'query parameter is required and cannot be empty.' };
    }
    
    await this.ensureInitialized(repo.id);
    
    const processLimit = params.limit || 5;
    const maxSymbolsPerProcess = params.max_symbols || 10;
    const includeContent = params.include_content ?? false;
    const searchQuery = params.query.trim();

    // Step 1: Run hybrid search to get matching symbols
    // (#58) Decouple search quality from `max_symbols`. The previous formula
    // `processLimit * maxSymbolsPerProcess` made `max_symbols=1` shrink the
    // raw result set to 2*1=2 per channel — missing entire processes. Use a
    // fixed floor so results are stable regardless of output density settings.
    const searchLimit = Math.max(100, processLimit * 20);
    const [bm25Results, semanticResults] = await Promise.all([
      this.bm25Search(repo, searchQuery, searchLimit),
      this.semanticSearch(repo, searchQuery, searchLimit),
    ]);
    
    // Merge via reciprocal rank fusion
    // (#57) Apply test-file demotion: multiply RRF scores from test/fixture
    // files by TEST_FILE_DEMOTION so production code naturally ranks higher.
    // This mirrors how `impacted_endpoints` already uses `isTestFilePath`.
    const TEST_FILE_DEMOTION = 0.5;
    const scoreMap = new Map<string, { score: number; data: any }>();

    for (let i = 0; i < bm25Results.length; i++) {
      const result = bm25Results[i];
      const key = result.nodeId || result.filePath;
      let rrfScore = 1 / (60 + i);
      if (result.filePath && isTestFilePath(result.filePath)) {
        rrfScore *= TEST_FILE_DEMOTION;
      }
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
      let rrfScore = 1 / (60 + i);
      if (result.filePath && isTestFilePath(result.filePath)) {
        rrfScore *= TEST_FILE_DEMOTION;
      }
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
    const processMap = new Map<string, { id: string; label: string; heuristicLabel: string; processType: string; stepCount: number; totalScore: number; cohesionBoost: number; symbols: any[] }>();
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
        processRows = await executeParameterized(repo.id, `
          MATCH (n {id: $nodeId})-[r:CodeRelation {type: 'STEP_IN_PROCESS'}]->(p:Process)
          RETURN p.id AS pid, p.label AS label, p.heuristicLabel AS heuristicLabel, p.processType AS processType, p.stepCount AS stepCount, r.step AS step
        `, { nodeId: sym.nodeId });
      } catch (e) { logQueryError('query:process-lookup', e); }

      // Get cluster membership + cohesion (cohesion used as internal ranking signal)
      let cohesion = 0;
      let module: string | undefined;
      try {
        const cohesionRows = await executeParameterized(repo.id, `
          MATCH (n {id: $nodeId})-[:CodeRelation {type: 'MEMBER_OF'}]->(c:Community)
          RETURN c.cohesion AS cohesion, c.heuristicLabel AS module
          LIMIT 1
        `, { nodeId: sym.nodeId });
        if (cohesionRows.length > 0) {
          cohesion = (cohesionRows[0].cohesion ?? cohesionRows[0][0]) || 0;
          module = cohesionRows[0].module ?? cohesionRows[0][1];
        }
      } catch (e) { logQueryError('query:cluster-info', e); }

      // Optionally fetch content
      let content: string | undefined;
      if (includeContent) {
        try {
          const contentRows = await executeParameterized(repo.id, `
            MATCH (n {id: $nodeId})
            RETURN n.content AS content
          `, { nodeId: sym.nodeId });
          if (contentRows.length > 0) {
            content = contentRows[0].content ?? contentRows[0][0];
          }
        } catch (e) { logQueryError('query:content-fetch', e); }
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
      .map(p => ({
        ...p,
        priority: p.totalScore + (p.cohesionBoost * 0.1), // cohesion as subtle ranking signal
      }))
      .sort((a, b) => b.priority - a.priority)
      .slice(0, processLimit);
    
    // Step 4: Build response
    const processes = rankedProcesses.map(p => ({
      id: p.id,
      summary: p.heuristicLabel || p.label,
      priority: Math.round(p.priority * 1000) / 1000,
      symbol_count: p.symbols.length,
      process_type: p.processType,
      step_count: p.stepCount,
    }));
    
    const processSymbols = rankedProcesses.flatMap(p =>
      p.symbols.slice(0, maxSymbolsPerProcess).map(s => ({
        ...s,
        // remove internal fields
      }))
    );
    
    // Deduplicate process_symbols by id
    const seen = new Set<string>();
    const dedupedSymbols = processSymbols.filter(s => {
      if (seen.has(s.id)) return false;
      seen.add(s.id);
      return true;
    });
    
    // Filter out non-code File nodes from definitions
    if (definitions.length > 0) {
      const filePaths = definitions
        .filter(d => d.type === 'File')
        .map(d => d.filePath);
      
      if (filePaths.length > 0) {
        try {
          // Batch lookup fileType for all File definitions
          const fileTypeRows = await executeParameterized(repo.id, `
            MATCH (n:File)
            WHERE n.filePath IN $filePaths
            RETURN n.filePath AS filePath, n.fileType AS fileType
          `, { filePaths });
          
          const nonCodePaths = new Set(
            fileTypeRows
              .filter(r => {
                const ft = r.fileType || r[1];
                return ft && ft !== 'code';
              })
              .map(r => r.filePath || r[0])
          );
          
          // Remove non-code File definitions (backward compat: keep if fileType is null/undefined)
          for (let i = definitions.length - 1; i >= 0; i--) {
            if (definitions[i].type === 'File' && nonCodePaths.has(definitions[i].filePath)) {
              definitions.splice(i, 1);
            }
          }
        } catch (e) { logQueryError('query:fileType-filter', e); }
      }
    }
    
    return {
      processes,
      process_symbols: dedupedSymbols,
      definitions: definitions.slice(0, 20), // cap standalone definitions
    };
  }

  /**
   * BM25 keyword search helper - uses LadybugDB FTS for always-fresh results
   */
  private async bm25Search(repo: RepoHandle, query: string, limit: number): Promise<any[]> {
    const { searchFTSFromLbug } = await import('../../core/search/bm25-index.js');
    let bm25Results;
    try {
      bm25Results = await searchFTSFromLbug(query, limit, repo.id);
    } catch (err: any) {
      console.error('GitNexus: BM25/FTS search failed (FTS indexes may not exist) -', err.message);
      return [];
    }
    
    const results: any[] = [];
    
    for (const bm25Result of bm25Results) {
      const fullPath = bm25Result.filePath;
      try {
        const symbols = await executeParameterized(repo.id, `
          MATCH (n)
          WHERE n.filePath = $filePath
          RETURN n.id AS id, n.name AS name, labels(n)[0] AS type, n.filePath AS filePath, n.startLine AS startLine, n.endLine AS endLine, n.fileType AS fileType
          LIMIT 3
        `, { filePath: fullPath });
        
        if (symbols.length > 0) {
          // Check if all symbols are File nodes — if any are non-code, skip the entire result
          const codeSymbols = symbols.filter(sym => {
            const type = sym.type || sym[2];
            const fileType = sym.fileType || sym[6];
            // Keep non-File symbols, and File symbols with fileType='code' or no fileType
            if (type !== 'File') return true;
            return !fileType || fileType === 'code';
          });
          
          if (codeSymbols.length === 0) {
            // All symbols are non-code File nodes — skip this bm25Result
            continue;
          }
          
          for (const sym of codeSymbols) {
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
    
    return results;
  }

  /**
   * Semantic vector search helper
   */
  private async semanticSearch(repo: RepoHandle, query: string, limit: number): Promise<any[]> {
    try {
      // Check if embedding table exists before loading the model (avoids heavy model init when embeddings are off)
      const tableCheck = await executeQuery(repo.id, `MATCH (e:CodeEmbedding) RETURN COUNT(*) AS cnt LIMIT 1`);
      if (!tableCheck.length || (tableCheck[0].cnt ?? tableCheck[0][0]) === 0) return [];

      const { embedQuery, getEmbeddingDims } = await import('../core/embedder.js');
      const queryVec = await embedQuery(query);
      const dims = getEmbeddingDims();
      const queryVecStr = `[${queryVec.join(',')}]`;
      
      const vectorQuery = `
        CALL QUERY_VECTOR_INDEX('CodeEmbedding', 'code_embedding_idx', 
          CAST(${queryVecStr} AS FLOAT[${dims}]), ${limit})
        YIELD node AS emb, distance
        WITH emb, distance
        WHERE distance < 0.6
        RETURN emb.nodeId AS nodeId, distance
        ORDER BY distance
      `;
      
      const embResults = await executeQuery(repo.id, vectorQuery);
      
      if (embResults.length === 0) return [];
      
      const results: any[] = [];
      
      for (const embRow of embResults) {
        const nodeId = embRow.nodeId ?? embRow[0];
        const distance = embRow.distance ?? embRow[1];
        
        const labelEndIdx = nodeId.indexOf(':');
        const label = labelEndIdx > 0 ? nodeId.substring(0, labelEndIdx) : 'Unknown';
        
        // Validate label against known node types to prevent Cypher injection
        if (!VALID_NODE_LABELS.has(label)) continue;
        
        try {
          const nodeQuery = label === 'File'
            ? `MATCH (n:File {id: $nodeId}) RETURN n.name AS name, n.filePath AS filePath`
            : `MATCH (n:\`${label}\` {id: $nodeId}) RETURN n.name AS name, n.filePath AS filePath, n.startLine AS startLine, n.endLine AS endLine`;

          const nodeRows = await executeParameterized(repo.id, nodeQuery, { nodeId });
          if (nodeRows.length > 0) {
            const nodeRow = nodeRows[0];
            results.push({
              nodeId,
              name: nodeRow.name ?? nodeRow[0] ?? '',
              type: label,
              filePath: nodeRow.filePath ?? nodeRow[1] ?? '',
              distance,
              startLine: label !== 'File' ? (nodeRow.startLine ?? nodeRow[2]) : undefined,
              endLine: label !== 'File' ? (nodeRow.endLine ?? nodeRow[3]) : undefined,
            });
          }
        } catch {}
      }
      
      // Batch filter: remove non-code File nodes (avoids N+1 per-node query)
      const fileNodeIds = results
        .filter(r => r.type === 'File' && r.nodeId)
        .map(r => r.nodeId);

      if (fileNodeIds.length > 0) {
        try {
          const fileTypeRows = await executeParameterized(repo.id, `
            MATCH (n:File)
            WHERE n.id IN $nodeIds
            RETURN n.id AS nodeId, n.fileType AS fileType
          `, { nodeIds: fileNodeIds });

          const nonCodeNodeIds = new Set(
            fileTypeRows
              .filter(r => {
                const ft = r.fileType || r[1];
                return ft && ft !== 'code';
              })
              .map(r => r.nodeId || r[0])
          );

          for (let i = results.length - 1; i >= 0; i--) {
            if (results[i].type === 'File' && nonCodeNodeIds.has(results[i].nodeId)) {
              results.splice(i, 1);
            }
          }
        } catch (e) { logQueryError('semanticSearch:fileType-batch-filter', e); }
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
    if (CYPHER_WRITE_RE.test(params.query)) {
      return { error: 'Write operations (CREATE, DELETE, SET, MERGE, REMOVE, DROP, ALTER, COPY, DETACH) are not allowed. The knowledge graph is read-only.' };
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
    const dataRows = result.map((row: any) =>
      '| ' + keys.map(k => {
        const v = row[k];
        if (v === null || v === undefined) return '';
        if (typeof v === 'object') return JSON.stringify(v);
        return String(v);
      }).join(' | ') + ' |'
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
    const groups = new Map<string, { ids: string[]; totalSymbols: number; weightedCohesion: number; largest: any }>();

    for (const c of clusters) {
      const label = c.heuristicLabel || c.label || 'Unknown';
      const symbols = c.symbolCount || 0;
      const cohesion = c.cohesion || 0;
      const existing = groups.get(label);

      if (!existing) {
        groups.set(label, { ids: [c.id], totalSymbols: symbols, weightedCohesion: cohesion * symbols, largest: c });
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
      .filter(c => c.symbolCount >= 5)
      .sort((a, b) => b.symbolCount - a.symbolCount);
  }

  private async overview(repo: RepoHandle, params: { showClusters?: boolean; showProcesses?: boolean; limit?: number }): Promise<any> {
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
        const clusters = await executeQuery(repo.id, `
          MATCH (c:Community)
          RETURN c.id AS id, c.label AS label, c.heuristicLabel AS heuristicLabel, c.cohesion AS cohesion, c.symbolCount AS symbolCount
          ORDER BY c.symbolCount DESC
          LIMIT ${rawLimit}
        `);
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
        const processes = await executeQuery(repo.id, `
          MATCH (p:Process)
          RETURN p.id AS id, p.label AS label, p.heuristicLabel AS heuristicLabel, p.processType AS processType, p.stepCount AS stepCount
          ORDER BY p.stepCount DESC
          LIMIT ${limit}
        `);
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
   * Context tool — 360-degree symbol view with categorized refs.
   * Disambiguation when multiple symbols share a name.
   * UID-based direct lookup. No cluster in output.
   */
  private async context(repo: RepoHandle, params: {
    name?: string;
    uid?: string;
    file_path?: string;
    include_content?: boolean;
  }): Promise<any> {
    await this.ensureInitialized(repo.id);
    
    const { name, uid, file_path, include_content } = params;
    
    if (!name && !uid) {
      return { error: 'Either "name" or "uid" parameter is required.' };
    }
    
    // Step 1: Find the symbol
    let symbols: any[];
    
    if (uid) {
      symbols = await executeParameterized(repo.id, `
        MATCH (n {id: $uid})
        RETURN n.id AS id, n.name AS name, labels(n)[0] AS type, n.filePath AS filePath, n.startLine AS startLine, n.endLine AS endLine${include_content ? ', n.content AS content' : ''}
        LIMIT 1
      `, { uid });
    } else {
      const isQualified = name!.includes('/') || name!.includes(':');

      let whereClause: string;
      let queryParams: Record<string, any>;
      if (file_path) {
        whereClause = `WHERE n.name = $symName AND n.filePath CONTAINS $filePath`;
        queryParams = { symName: name!, filePath: file_path };
      } else if (isQualified) {
        whereClause = `WHERE n.id = $symName OR n.name = $symName`;
        queryParams = { symName: name! };
      } else {
        whereClause = `WHERE n.name = $symName`;
        queryParams = { symName: name! };
      }

      symbols = await executeParameterized(repo.id, `
        MATCH (n) ${whereClause}
        RETURN n.id AS id, n.name AS name, labels(n)[0] AS type, n.filePath AS filePath, n.startLine AS startLine, n.endLine AS endLine${include_content ? ', n.content AS content' : ''}
        LIMIT 10
      `, queryParams);
    }
    
    if (symbols.length === 0) {
      return { error: `Symbol '${name || uid}' not found` };
    }
    
    // context() returns the semantically meaningful result rather than
    // triggering ambiguous disambiguation (#480).
    // labels(n)[0] returns empty string in LadybugDB, so we resolve the
    // preferred node by re-querying with explicit label filters, scoped to
    // the candidate IDs already in symbols.
    //
    // Guard: only attempt Class-preference when at least one candidate has an
    // empty/unknown type (LadybugDB limitation) or is a Constructor — meaning
    // the ambiguity may be a Class/Constructor name collision rather than two
    // genuinely distinct symbols (e.g. two Functions in different files).
    //
    // resolvedLabel is set here and threaded to Step 3 to avoid a redundant
    // classCheck round-trip later.
    let resolvedLabel = '';
    if (symbols.length > 1 && !uid) {
      const hasAmbiguousType = symbols.some((s: any) => {
        const t = s.type || s[2] || '';
        return t === '' || t === 'Constructor';
      });
      if (hasAmbiguousType) {
        const candidateIds = symbols.map((s: any) => s.id || s[0]).filter(Boolean);
        const PREFER_LABELS = ['Class', 'Interface'];
        let preferred: any = null;
        for (const label of PREFER_LABELS) {
          const match = await executeParameterized(repo.id, `
            MATCH (n:\`${label}\`) WHERE n.id IN $candidateIds RETURN n.id AS id LIMIT 1
          `, { candidateIds }).catch(() => []);
          if (match.length > 0) {
            preferred = symbols.find((s: any) => (s.id || s[0]) === (match[0].id || match[0][0]));
            if (preferred) { resolvedLabel = label; break; }
          }
        }
        if (preferred) symbols = [preferred];
      }
    }

    // If still multiple symbols after disambiguation, return ambiguous status
    if (symbols.length > 1) {
      return {
        status: 'ambiguous',
        candidates: symbols.map((s: any) => ({
          uid: s.id || s[0],
          name: s.name || s[1],
          kind: s.type || s[2],
          filePath: s.filePath || s[3],
          startLine: s.startLine || s[4],
          endLine: s.endLine || s[5],
        })),
      };
    }

    // Step 3: Build full context
    const sym = symbols[0];
    const symId = sym.id || sym[0];

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
        const typeCheck = await executeParameterized(repo.id, `
          MATCH (n:Class) WHERE n.id = $symId RETURN 'Class' AS label LIMIT 1
          UNION ALL
          MATCH (n:Interface) WHERE n.id = $symId RETURN 'Interface' AS label LIMIT 1
        `, { symId });
        isClassLike = typeCheck.length > 0;
      } catch { /* not a Class/Interface node */ }
    } else if (!isClassLike) {
      isClassLike = symRawType === 'Class' || symRawType === 'Interface';
    }

    // Categorized incoming refs
    const incomingRows = await executeParameterized(repo.id, `
      MATCH (caller)-[r:CodeRelation]->(n {id: $symId})
      WHERE r.type IN ['CALLS', 'IMPORTS', 'EXTENDS', 'IMPLEMENTS']
      RETURN r.type AS relType, caller.id AS uid, caller.name AS name, caller.filePath AS filePath, labels(caller)[0] AS kind
      LIMIT 30
    `, { symId });

    // Expand incoming refs for Class/Interface nodes: callers via Constructor/File/Method
    if (isClassLike) {
      try {
        // Run all three incoming-ref queries in parallel — they are
        // independent. The third query (#56) covers callers of the
        // class's METHODS — without it, a query like
        // `context(name="CashServiceV2Impl")` returns no incoming
        // refs even though 8 controllers call its methods at the
        // method level. We aggregate those method-level CALLS edges
        // into the class context, similar to how outgoing
        // `has_method` already shows method-level outgoing edges.
        const [ctorIncoming, fileIncoming, methodIncoming] = await Promise.all([
          executeParameterized(repo.id, `
            MATCH (n)-[hm:CodeRelation]->(ctor:Constructor)
            WHERE n.id = $symId AND hm.type = 'HAS_METHOD'
            MATCH (caller)-[r:CodeRelation]->(ctor)
            WHERE r.type IN ['CALLS', 'IMPORTS', 'EXTENDS', 'IMPLEMENTS', 'ACCESSES']
            RETURN r.type AS relType, caller.id AS uid, caller.name AS name, caller.filePath AS filePath, labels(caller)[0] AS kind
            LIMIT 30
          `, { symId }),
          executeParameterized(repo.id, `
            MATCH (f:File)-[rel:CodeRelation]->(n)
            WHERE n.id = $symId AND rel.type = 'DEFINES'
            MATCH (caller)-[r:CodeRelation]->(f)
            WHERE r.type IN ['CALLS', 'IMPORTS']
            RETURN r.type AS relType, caller.id AS uid, caller.name AS name, caller.filePath AS filePath, labels(caller)[0] AS kind
            LIMIT 30
          `, { symId }),
          executeParameterized(repo.id, `
            // (#56) Find callers of the class's methods. This walks
            // HAS_METHOD from the class to its Method nodes, then
            // finds CALLS edges from any caller to those methods. The
            // relation type is reported as CALLS so it sorts into
            // the same incoming.calls bucket as direct method-level
            // context queries. The caller.uid, name, filePath come
            // from the caller (the source of the CALLS edge), and
            // targetMethod identifies which method on the class was
            // called — useful for the consumer to show a backtrace.
            MATCH (n)-[hm:CodeRelation {type: 'HAS_METHOD'}]->(target:Method)
            WHERE n.id = $symId
            MATCH (caller)-[r:CodeRelation {type: 'CALLS'}]->(target)
            RETURN r.type AS relType, caller.id AS uid, caller.name AS name, caller.filePath AS filePath, labels(caller)[0] AS kind, target.name AS targetMethod
            LIMIT 30
          `, { symId }),
        ]);

        // Deduplicate by (relType, uid) — a caller can have multiple relation
        // types to the same target (e.g. both IMPORTS and CALLS), and each
        // must be preserved so every category appears in the output.
        const seenKeys = new Set(
          incomingRows.map((r: any) => `${r.relType || r[0]}:${r.uid || r[1]}`),
        );
        for (const r of [...ctorIncoming, ...fileIncoming, ...methodIncoming]) {
          const key = `${r.relType || r[0]}:${r.uid || r[1]}`;
          if (!seenKeys.has(key)) { seenKeys.add(key); incomingRows.push(r); }
        }
      } catch (e) {
        logQueryError('context:class-incoming-expansion', e);
      }
    }

    // Categorized outgoing refs
    const outgoingRows = await executeParameterized(repo.id, `
      MATCH (n {id: $symId})-[r:CodeRelation]->(target)
      WHERE r.type IN ['CALLS', 'IMPORTS', 'EXTENDS', 'IMPLEMENTS', 'HAS_METHOD', 'HAS_PROPERTY', 'OVERRIDES', 'ACCESSES']
      RETURN r.type AS relType, target.id AS uid, target.name AS name, target.filePath AS filePath, labels(target)[0] AS kind
      LIMIT 30
    `, { symId });

    // Process participation
    let processRows: any[] = [];
    try {
      processRows = await executeParameterized(repo.id, `
        MATCH (n {id: $symId})-[r:CodeRelation {type: 'STEP_IN_PROCESS'}]->(p:Process)
        RETURN p.id AS pid, p.heuristicLabel AS label, r.step AS step, p.stepCount AS stepCount
      `, { symId });
    } catch (e) { logQueryError('context:process-participation', e); }
    
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
    
    return {
      status: 'found',
      symbol: {
        uid: sym.id || sym[0],
        name: sym.name || sym[1],
        // (#30) When isClassLike is true but sym.type is empty
        // (LadybugDB limitation on `labels(n)[0]` for some Cypher
        // projections) and the disambiguation path did not set
        // resolvedLabel, the kind defaulted to 'Class' even for
        // nodes whose uid prefix is `Interface:`. The disambiguation
        // query at line 1517 also only checks one label at a time
        // and prefers Class, so a node with both a Class and
        // Interface label in the graph (e.g. a Spring @Repository
        // interface that Spring auto-generates a class for) would
        // resolve as Class even when the user is asking about the
        // interface. We now derive kind from the uid prefix when
        // resolvedLabel is empty and sym.type is empty, so the
        // kind always matches the uid.
        kind: isClassLike
          ? (resolvedLabel || (symId.startsWith('Interface:') ? 'Interface' : 'Class'))
          : (sym.type || sym[2]),
        filePath: sym.filePath || sym[3],
        startLine: sym.startLine || sym[4],
        endLine: sym.endLine || sym[5],
        ...(include_content && (sym.content || sym[6]) ? { content: sym.content || sym[6] } : {}),
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
  private async explore(repo: RepoHandle, params: { name: string; type: 'symbol' | 'cluster' | 'process' }): Promise<any> {
    await this.ensureInitialized(repo.id);
    const { name, type } = params;
    
    if (type === 'symbol') {
      return this.context(repo, { name });
    }
    
    if (type === 'cluster') {
      const clusters = await executeParameterized(repo.id, `
        MATCH (c:Community)
        WHERE c.label = $clusterName OR c.heuristicLabel = $clusterName
        RETURN c.id AS id, c.label AS label, c.heuristicLabel AS heuristicLabel, c.cohesion AS cohesion, c.symbolCount AS symbolCount
      `, { clusterName: name });
      if (clusters.length === 0) return { error: `Cluster '${name}' not found` };

      const rawClusters = clusters.map((c: any) => ({
        id: c.id || c[0], label: c.label || c[1], heuristicLabel: c.heuristicLabel || c[2],
        cohesion: c.cohesion || c[3], symbolCount: c.symbolCount || c[4],
      }));

      let totalSymbols = 0, weightedCohesion = 0;
      for (const c of rawClusters) {
        const s = c.symbolCount || 0;
        totalSymbols += s;
        weightedCohesion += (c.cohesion || 0) * s;
      }

      const members = await executeParameterized(repo.id, `
        MATCH (n)-[:CodeRelation {type: 'MEMBER_OF'}]->(c:Community)
        WHERE c.label = $clusterName OR c.heuristicLabel = $clusterName
        RETURN DISTINCT n.name AS name, labels(n)[0] AS type, n.filePath AS filePath
        LIMIT 30
      `, { clusterName: name });
      
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
          name: m.name || m[0], type: m.type || m[1], filePath: m.filePath || m[2],
        })),
      };
    }
    
    if (type === 'process') {
      const processes = await executeParameterized(repo.id, `
        MATCH (p:Process)
        WHERE p.label = $processName OR p.heuristicLabel = $processName
        RETURN p.id AS id, p.label AS label, p.heuristicLabel AS heuristicLabel, p.processType AS processType, p.stepCount AS stepCount
        LIMIT 1
      `, { processName: name });
      if (processes.length === 0) return { error: `Process '${name}' not found` };

      const proc = processes[0];
      const procId = proc.id || proc[0];
      const steps = await executeParameterized(repo.id, `
        MATCH (n)-[r:CodeRelation {type: 'STEP_IN_PROCESS'}]->(p {id: $procId})
        RETURN n.name AS name, labels(n)[0] AS type, n.filePath AS filePath, r.step AS step
        ORDER BY r.step
      `, { procId });
      
      return {
        process: {
          id: procId, label: proc.label || proc[1], heuristicLabel: proc.heuristicLabel || proc[2],
          processType: proc.processType || proc[3], stepCount: proc.stepCount || proc[4],
        },
        steps: steps.map((s: any) => ({
          step: s.step || s[3], name: s.name || s[0], type: s.type || s[1], filePath: s.filePath || s[2],
        })),
      };
    }
    
    return { error: 'Invalid type. Use: symbol, cluster, or process' };
  }

  /**
   * Detect changes — git-diff based impact analysis.
   * Maps changed lines to indexed symbols, then finds affected processes.
   */
  private async execGitDiff(
    scope: string,
    baseRef: string | undefined,
    cwd: string
  ): Promise<string[] | { error: string }> {
    const { execFileSync } = await import('child_process');

    let diffArgs: string[];
    switch (scope) {
      case 'staged':
        diffArgs = ['diff', '--staged', '--name-only'];
        break;
      case 'all':
        diffArgs = ['diff', 'HEAD', '--name-only'];
        break;
      case 'compare':
        if (!baseRef) return { error: 'base_ref is required for "compare" scope' };
        diffArgs = ['diff', baseRef, '--name-only'];
        break;
      case 'unstaged':
      default:
        diffArgs = ['diff', '--name-only'];
        break;
    }

    try {
      const output = execFileSync('git', diffArgs, { cwd, encoding: 'utf-8' });
      return output.trim().split('\n').filter(f => f.length > 0);
    } catch (err: any) {
      return { error: `Git diff failed: ${err.message}` };
    }
  }

  private async execGitDiffWithLines(
    scope: string,
    baseRef: string | undefined,
    cwd: string
  ): Promise<FileDiffWithLines[] | { error: string }> {
    const { execFileSync } = await import('child_process');

    let diffArgs: string[];
    switch (scope) {
      case 'staged':
        diffArgs = ['diff', '--staged', '--unified=0'];
        break;
      case 'all':
        diffArgs = ['diff', 'HEAD', '--unified=0'];
        break;
      case 'compare':
        if (!baseRef) return { error: 'base_ref is required for "compare" scope' };
        diffArgs = ['diff', baseRef, '--unified=0'];
        break;
      case 'unstaged':
      default:
        diffArgs = ['diff', '--unified=0'];
        break;
    }

    try {
      const output = execFileSync('git', diffArgs, { cwd, encoding: 'utf-8' });
      return parseDiffOutputWithLines(output);
    } catch (err: any) {
      return { error: `Git diff failed: ${err.message}` };
    }
  }

  private async detectChanges(repo: RepoHandle, params: {
    scope?: string;
    base_ref?: string;
  }): Promise<any> {
    await this.ensureInitialized(repo.id);
    
    const scope = params.scope || 'unstaged';
    const diffResult = await this.execGitDiff(scope, params.base_ref, repo.repoPath);
    
    if ('error' in diffResult) {
      return { error: diffResult.error };
    }
    
    const changedFiles = diffResult;
    
    if (changedFiles.length === 0) {
      return {
        summary: { changed_count: 0, affected_count: 0, risk_level: 'none', message: 'No changes detected.' },
        changed_symbols: [],
        affected_processes: [],
      };
    }
    
    // Map changed files to indexed symbols
    const changedSymbols: any[] = [];
    for (const file of changedFiles) {
      const normalizedFile = file.replace(/\\/g, '/');
      try {
        const symbols = await executeParameterized(repo.id, `
          MATCH (n) WHERE n.filePath CONTAINS $filePath
          RETURN n.id AS id, n.name AS name, labels(n)[0] AS type, n.filePath AS filePath, n.fileType AS fileType
          LIMIT 20
        `, { filePath: normalizedFile });
        for (const sym of symbols) {
          const type = sym.type || sym[2];
          const fileType = sym.fileType || sym[4];
          // Skip non-code File nodes (backward compat: include if fileType is null)
          if (type === 'File' && fileType && fileType !== 'code') continue;
          
          changedSymbols.push({
            id: sym.id || sym[0],
            name: sym.name || sym[1],
            type: type,
            filePath: sym.filePath || sym[3],
            change_type: 'Modified',
          });
        }
      } catch (e) { logQueryError('detect-changes:file-symbols', e); }
    }

    // Find affected processes
    const affectedProcesses = new Map<string, any>();
    for (const sym of changedSymbols) {
      try {
        const procs = await executeParameterized(repo.id, `
          MATCH (n {id: $nodeId})-[r:CodeRelation {type: 'STEP_IN_PROCESS'}]->(p:Process)
          RETURN p.id AS pid, p.heuristicLabel AS label, p.processType AS processType, p.stepCount AS stepCount, r.step AS step
        `, { nodeId: sym.id });
        for (const proc of procs) {
          const pid = proc.pid || proc[0];
          if (!affectedProcesses.has(pid)) {
            affectedProcesses.set(pid, {
              id: pid,
              name: proc.label || proc[1],
              process_type: proc.processType || proc[2],
              step_count: proc.stepCount || proc[3],
              changed_steps: [],
            });
          }
          affectedProcesses.get(pid)!.changed_steps.push({
            symbol: sym.name,
            step: proc.step || proc[4],
          });
        }
      } catch (e) { logQueryError('detect-changes:process-lookup', e); }
    }

    const processCount = affectedProcesses.size;
    const risk = processCount === 0 ? 'low' : processCount <= 5 ? 'medium' : processCount <= 15 ? 'high' : 'critical';
    
    return {
      summary: {
        changed_count: changedSymbols.length,
        affected_count: processCount,
        changed_files: changedFiles.length,
        risk_level: risk,
      },
      changed_symbols: changedSymbols,
      affected_processes: Array.from(affectedProcesses.values()),
    };
  }

  /**
   * impacted_endpoints tool — find API routes affected by code changes.
   *
   * 1. execGitDiff → changed files
   * 2. Map files → indexed symbols
   * 3. BFS upstream traversal (CALLS, IMPORTS, EXTENDS, IMPLEMENTS, HAS_METHOD)
   * 4. Route discovery: reverse-CALLS, DEFINES/HANDLES_ROUTE, FETCHES
   * 5. Dedup + tier classification (WILL_BREAK / LIKELY_AFFECTED / MAY_NEED_TESTING)
   * 6. Enrichment: processes, modules, risk
   */
  private async _impactedEndpointsImpl(
    repo: RepoHandle,
    params: {
      scope?: string;
      base_ref?: string;
      max_depth?: number;
      min_confidence?: number;
    },
    crossRepo?: CrossRepoContext
  ): Promise<any> {
    await this.ensureInitialized(repo.id);

    // (#64) Use `??` (nullish coalescing) instead of `||` so that a user-
    // supplied `max_depth=0` is honored as "no upstream traversal" rather
    // than coerced to the default 3. The `||` operator treats 0 as falsy,
    // which silently turned `max_depth=0` into `max_depth=3` and made all
    // four documented values (0/1/5/10) return identical results.
    const maxDepth = params.max_depth ?? 3;
    const minConfidence = params.min_confidence ?? 0.7;

    // ── 1. Git diff → changed files with line ranges ─────────────────
    const lineDiffResult = await this.execGitDiffWithLines(
      params.scope || 'unstaged',
      params.base_ref,
      repo.repoPath
    );

    let changedFiles: string[];
    let fileLineRanges: Map<string, LineRange[]>;

    if ('error' in lineDiffResult) {
      // Fallback: try original file-level diff
      const fallbackResult = await this.execGitDiff(
        params.scope || 'unstaged',
        params.base_ref,
        repo.repoPath
      );
      if ('error' in fallbackResult) {
        return { error: fallbackResult.error };
      }
      changedFiles = fallbackResult;
      fileLineRanges = new Map(); // empty = whole-file resolution
    } else if (lineDiffResult.length === 0) {
      return {
        // (#28, #49) summary fields use per-repo Record<string, number>
        // consistently — both in the single-repo and multi-repo aggregator
        // paths, so consumers can rely on a uniform shape.
        summary: { changed_files: { [repo.id]: 0 }, changed_symbols: { [repo.id]: 0 }, impacted_endpoints: { [repo.id]: 0 }, risk_level: 'none' },
        impacted_endpoints: { WILL_BREAK: [], LIKELY_AFFECTED: [], MAY_NEED_TESTING: [] },
        changed_symbols: [], affected_processes: [], affected_modules: [],
        _meta: { version: '1.0', generated_at: new Date().toISOString() },
      };
    } else {
      changedFiles = lineDiffResult.map(f => f.filePath.replace(/\\/g, '/'));
      fileLineRanges = new Map(
        lineDiffResult.map(f => [f.filePath.replace(/\\/g, '/'), f.changedLineRanges])
      );
    }

    if (changedFiles.length === 0) {
      return {
        // (#28, #49) see comment on the lineDiffResult.length === 0 branch
        summary: { changed_files: { [repo.id]: 0 }, changed_symbols: { [repo.id]: 0 }, impacted_endpoints: { [repo.id]: 0 }, risk_level: 'none' },
        impacted_endpoints: { WILL_BREAK: [], LIKELY_AFFECTED: [], MAY_NEED_TESTING: [] },
        changed_symbols: [], affected_processes: [], affected_modules: [],
        _meta: { version: '1.0', generated_at: new Date().toISOString() },
      };
    }

    // ── 2. Map files → symbols with line-range filtering ──────────────
    const changedSymbols: any[] = [];
    for (const file of changedFiles) {
      const normalizedFile = file.replace(/\\/g, '/');
      const ranges = fileLineRanges.get(normalizedFile) ?? [];
      const isWholeFile = ranges.length === 0;

      try {
        const symbols = await executeParameterized(repo.id, `
          MATCH (n) WHERE n.filePath CONTAINS $filePath
          RETURN n.id AS id, n.name AS name, labels(n)[0] AS type, n.filePath AS filePath,
                 n.startLine AS startLine, n.endLine AS endLine
          LIMIT 50
        `, { filePath: normalizedFile });

        for (const sym of symbols) {
          const symStart = sym.startLine ?? null;
          const symEnd = sym.endLine ?? null;

          // File nodes (no line range) always included — they carry DEFINES edges to Route nodes
          // Also include symbols with no line info (fallback to whole-file behavior for that symbol)
          if (isWholeFile || symStart === null || symEnd === null) {
            changedSymbols.push({
              id: sym.id || sym[0],
              name: sym.name || sym[1],
              type: sym.type || sym[2],
              filePath: sym.filePath || sym[3],
              change_type: 'Modified',
            });
            continue;
          }

          // Check if ANY changed line range overlaps with this symbol's range
          const overlaps = ranges.some(
            r => symStart <= r.endLine && symEnd >= r.startLine
          );
          if (overlaps) {
            changedSymbols.push({
              id: sym.id || sym[0],
              name: sym.name || sym[1],
              type: sym.type || sym[2],
              filePath: sym.filePath || sym[3],
              change_type: 'Modified',
            });
          }
        }
      } catch (e) { logQueryError('impacted-endpoints:file-symbols', e); }
    }

    if (changedSymbols.length === 0) {
      return {
        // (#28, #49) see comment on the lineDiffResult.length === 0 branch
        summary: {
          changed_files: { [repo.id]: changedFiles.length },
          changed_symbols: { [repo.id]: 0 },
          impacted_endpoints: { [repo.id]: 0 },
          risk_level: 'none',
        },
        impacted_endpoints: {
          WILL_BREAK: [],
          LIKELY_AFFECTED: [],
          MAY_NEED_TESTING: [],
        },
        changed_symbols: [],
        affected_processes: [],
        affected_modules: [],
        _meta: { version: '1.0', generated_at: new Date().toISOString() },
      };
    }

    // ── 2b. Index health check (non-blocking diagnostics) ──────────
    interface IndexDiagnostics {
      index_health: 'stale' | 'healthy';
      missing_tables?: string[];
      schema_version?: { current: number; indexed: number | null };
      commit_drift?: { indexed: string; current: string };
      low_node_count?: boolean;
      recommendation: string;
    }

    let _diagnostics: IndexDiagnostics | undefined;

    try {
      const diagnostics: IndexDiagnostics = { index_health: 'healthy', recommendation: '' };
      let isStale = false;

      // Check 1: Route table exists
      try {
        await executeParameterized(repo.id, 'MATCH (r:Route) RETURN count(r) AS cnt LIMIT 1', {});
      } catch (routeErr: any) {
        const msg = routeErr?.message || String(routeErr);
        if (msg.includes('does not exist')) {
          diagnostics.missing_tables = ['Route'];
          diagnostics.index_health = 'stale';
          isStale = true;
        }
      }

      // Check 2: Schema version match
      try {
        const meta = await loadMeta(repo.storagePath);
        const indexedVersion = meta?.schemaVersion ?? null;
        if (indexedVersion !== SCHEMA_VERSION) {
          diagnostics.schema_version = { current: SCHEMA_VERSION, indexed: indexedVersion };
          diagnostics.index_health = 'stale';
          isStale = true;
        }
        // Check 2b: Commit drift (indexed commit vs registry's last-known commit).
        // The registry's `repo.lastCommit` is updated by every analyze run; if meta.json
        // disagrees with the registry, the index is at a different commit than the
        // registry thinks — i.e. a stale write or a manual `analyze` on a different branch.
        // We deliberately avoid `git rev-parse HEAD` here: the index's freshness story
        // is about *what was indexed*, not *what the working tree currently looks like*,
        // and the registry is the source of truth for the former.
        if (meta?.lastCommit && repo.lastCommit && meta.lastCommit !== repo.lastCommit) {
          diagnostics.commit_drift = { indexed: meta.lastCommit, current: repo.lastCommit };
          diagnostics.index_health = 'stale';
          isStale = true;
        }
      } catch { /* meta.json read failure is non-blocking */ }

      // Check 3: Low node count
      const nodeCount = repo.stats?.nodes ?? 0;
      const fileCount = repo.stats?.files ?? 0;
      if (nodeCount > 0 && nodeCount < 100 && fileCount > 50) {
        diagnostics.low_node_count = true;
        diagnostics.index_health = 'stale';
        isStale = true;
      }

      if (isStale) {
        const parts: string[] = [];
        if (diagnostics.missing_tables?.length) {
          parts.push(`Missing tables: ${diagnostics.missing_tables.join(', ')}`);
        }
        if (diagnostics.schema_version) {
          parts.push(`Schema version mismatch: indexed=${diagnostics.schema_version.indexed}, current=${diagnostics.schema_version.current}`);
        }
        if (diagnostics.commit_drift) {
          parts.push(`Index is at commit ${diagnostics.commit_drift.indexed.slice(0, 7)} but HEAD is ${diagnostics.commit_drift.current.slice(0, 7)}`);
        }
        if (diagnostics.low_node_count) {
          parts.push(`Low node count (${nodeCount}) for ${fileCount} files — index may be incomplete`);
        }
        diagnostics.recommendation = `Index may be stale. ${parts.join('; ')}. Consider re-running \`gitnexus analyze\`.`;
      }

      if (diagnostics.index_health === 'stale') {
        _diagnostics = diagnostics;
      }
    } catch { /* Health check failures are non-blocking */ }

    // ── 3. BFS upstream traversal ───────────────────────────────────
    const changedIds = changedSymbols.map(s => s.id);
    const visited = new Set<string>(changedIds);
    let frontier = [...changedIds];
    const expandedMeta = new Map<string, { depth: number; confidence: number; relationType: string }>();
    // changed symbols are depth 0
    for (const id of changedIds) {
      expandedMeta.set(id, { depth: 0, confidence: 1.0, relationType: 'DIRECT_CHANGE' });
    }

    // Track which dep-repo symbols triggered cross-repo discoveries.
    // Maps expanded symbol ID → array of "repoId:symbolName" triggers.
    const triggeredByMap = new Map<string, string[]>();

    const relTypes = ['CALLS', 'IMPORTS', 'EXTENDS', 'IMPLEMENTS', 'HAS_METHOD', 'OVERRIDES'];
    const relTypeFilter = relTypes.map(t => `'${t}'`).join(', ');
    const MAX_EXPANDED_NODES = 10000;
    let traversalComplete = true;

    for (let depth = 1; depth <= maxDepth && frontier.length > 0; depth++) {
      if (visited.size >= MAX_EXPANDED_NODES) {
        traversalComplete = false;
        break;
      }

      const nextFrontier: string[] = [];
      // Safety filter: exclude IDs with characters that could break Cypher syntax
      const safeFrontier = frontier.filter(id => !/[}{]/.test(id));
      const idList = safeFrontier.map(id => `'${id.replace(/'/g, "''")}'`).join(', ');

      const confidenceFilter = minConfidence > 0
        ? ` AND r.confidence >= ${minConfidence}`
        : '';

      const query = `MATCH (caller)-[r:CodeRelation]->(n) ` +
        `WHERE n.id IN [${idList}] ` +
        `AND r.type IN [${relTypeFilter}]${confidenceFilter} ` +
        `RETURN n.id AS sourceId, caller.id AS id, caller.name AS name, ` +
        `labels(caller)[0] AS type, caller.filePath AS filePath, ` +
        `r.type AS relType, r.confidence AS confidence`;

      try {
        const related = await executeQuery(repo.id, query);

        for (const rel of related) {
          const relId = rel.id || rel[1];
          const filePath = rel.filePath || rel[4] || '';
          const relConfidence = rel.confidence || rel[6] || 0;
          const relType = rel.relType || rel[5] || '';

          // Skip test files
          if (isTestFilePath(filePath)) continue;

          // Apply confidence floor when stored confidence is missing/0
          const effectiveConfidence = relConfidence > 0
            ? relConfidence
            : (IMPACT_RELATION_CONFIDENCE[relType] ?? 0.7);

          if (effectiveConfidence < minConfidence) continue;

          if (!visited.has(relId)) {
            visited.add(relId);
            nextFrontier.push(relId);
            expandedMeta.set(relId, {
              depth,
              confidence: effectiveConfidence,
              relationType: relType,
            });
          }
        }
      } catch (e) {
        logQueryError('impacted-endpoints:depth-traversal', e);
        traversalComplete = false;
        break;
      }

      if (visited.size >= MAX_EXPANDED_NODES) {
        traversalComplete = false;
        break;
      }

      // ── 3b. Interface resolution ───────────────────────────────────
      // After BFS expansion, check if any frontier nodes implement interfaces.
      // Add those interfaces to nextFrontier so BFS can find callers of the
      // interface methods in subsequent depths. This bridges the gap where
      // controllers call CashService.method() but the graph only has an edge
      // from the controller to the interface, not to the implementation.
      const safeFrontierForImplements = frontier.filter(id => !/[}{]/.test(id) && (expandedMeta.get(id)?.depth ?? 0) <= 2);
      if (safeFrontierForImplements.length > 0) {
        const implIdList = safeFrontierForImplements.map(id => `'${id.replace(/'/g, "''")}'`).join(', ');
        const implementsQuery = `MATCH (impl)-[r:CodeRelation {type: 'IMPLEMENTS'}]->(iface) ` +
          `WHERE impl.id IN [${implIdList}] ` +
          `RETURN iface.id AS id, iface.name AS name, labels(iface)[0] AS type, iface.filePath AS filePath, ` +
          `r.type AS relType, r.confidence AS confidence, impl.id AS implId`;
        try {
          const interfaceResults = await executeQuery(repo.id, implementsQuery);
          for (const iface of interfaceResults) {
            const ifaceId = iface.id || iface[0];
            const ifaceFilePath = iface.filePath || iface[3] || '';
            if (isTestFilePath(ifaceFilePath)) continue;
            if (!visited.has(ifaceId)) {
              visited.add(ifaceId);
              nextFrontier.push(ifaceId);
              expandedMeta.set(ifaceId, {
                depth: expandedMeta.get(iface.implId || iface[6])?.depth ?? maxDepth,
                confidence: iface.confidence || iface[5] || 0.85,
                relationType: 'IMPLEMENTS',
              });
            }
          }
        } catch (e) {
          logQueryError('impacted-endpoints:implements-resolution', e);
          // Non-fatal — continue without interface resolution
        }
      }

      frontier = nextFrontier;
    }

    // ── 3c. Cross-repo BFS bridging via CrossRepoResolver ──────────────
    // If CrossRepoContext is provided, use CrossRepoResolver to find consumer-repo
    // symbols that depend on changed dep-repo symbols. The resolver uses a 3-stage
    // strategy (file-path IMPORTS, class-name, package-path) instead of the old
    // direct ID-matching approach which failed because IMPORTS edges are File→File.
    if (crossRepo && changedSymbols.length > 0) {
      try {
        const depRepoIds = await crossRepo.listDepRepos();
        if (depRepoIds.length > 0) {
          const resolver = new CrossRepoResolver();

          // Build ChangedSymbol array for resolver
          const changedSymbolsForResolver: ChangedSymbol[] = changedSymbols.map(s => ({
            id: s.id,
            name: s.name,
            filePath: s.filePath,
          }));

          // Map from dep symbol ID → name for _triggered_by format "repoId:symbolName"
          const changedSymIdToName = new Map<string, string>(
            changedSymbols.map(s => [s.id, s.name] as [string, string]),
          );

          // For each dep repo, resolve which consumer-repo symbols depend on changed dep symbols
          const consumerRepo: ResolverRepoHandle = {
            repoId: repo.id,
            query: async (query: string, params: Record<string, unknown>) =>
              executeParameterized(repo.id, query, params),
          };

          for (const depRepoId of depRepoIds) {
            const depRepo: ResolverRepoHandle = {
              repoId: depRepoId,
              query: async (query: string, params: Record<string, unknown>) => {
                const results = await crossRepo.queryMultipleRepos(
                  [depRepoId], query, params
                );
                // Extract results for this repo
                const match = results.find(r => r.repoId === depRepoId);
                return match?.results ?? [];
              },
            };

            const resolvedConsumers = await resolver.resolveDepConsumers(
              consumerRepo, depRepo, changedSymbolsForResolver
            );

            // Add resolved consumers to BFS frontier
            for (const consumer of resolvedConsumers) {
              // Build trigger key: "repoId:symbolName" for cross-repo attribution
              const depSymbolName = changedSymIdToName.get(consumer.matchedDepSymbol) ?? consumer.matchedDepSymbol;
              const triggerKey = `${depRepoId}:${depSymbolName}`;

              // Find all Method/Class symbols in the importing file
              try {
                const fileSymbols = await executeParameterized(repo.id,
                  `MATCH (s) WHERE s.filePath = $filePath
                   RETURN s.id AS id, s.name AS name, s.filePath AS filePath, labels(s)[0] AS type`,
                  { filePath: consumer.filePath }
                );

                for (const sym of fileSymbols) {
                  const symId = sym.id || sym[0];
                  const symType = sym.type || sym[3] || '';
                  const symFilePath = sym.filePath || sym[2] || '';
                  // Only include Method and Class symbols (skip File, Route, etc.)
                  if (symType !== 'Method' && symType !== 'Class') continue;
                  if (isTestFilePath(symFilePath)) continue;
                  if (!visited.has(symId)) {
                    visited.add(symId);
                    expandedMeta.set(symId, {
                      depth: 1,
                      confidence: consumer.confidence,
                      relationType: `CROSS_REPO_${consumer.matchMethod.toUpperCase()}`,
                    });
                    // Track which dep symbol triggered this cross-repo discovery
                    const existing = triggeredByMap.get(symId) ?? [];
                    if (!existing.includes(triggerKey)) {
                      existing.push(triggerKey);
                    }
                    triggeredByMap.set(symId, existing);
                  }
                }
              } catch (e) {
                logQueryError('impacted-endpoints:cross-repo-file-symbols', e);
                // Non-fatal — add the consumer itself as fallback
                if (!visited.has(consumer.id)) {
                  visited.add(consumer.id);
                  expandedMeta.set(consumer.id, {
                    depth: 1,
                    confidence: consumer.confidence,
                    relationType: `CROSS_REPO_${consumer.matchMethod.toUpperCase()}`,
                  });
                  // Track trigger for fallback consumer too
                  const existing = triggeredByMap.get(consumer.id) ?? [];
                  if (!existing.includes(triggerKey)) {
                    existing.push(triggerKey);
                  }
                  triggeredByMap.set(consumer.id, existing);
                }
              }
            }
          }
        }
      } catch (e) {
        logQueryError('impacted-endpoints:cross-repo-bridging', e);
        // Non-fatal — continue without cross-repo results
      }
    }

    // ── 4. Route Discovery (4 parallel queries) ────────────────────
    const expandedIds = Array.from(visited);
    const changedIdSet = new Set(changedIds);

    // Helper: for each Route, track which original changed symbols led to it
    // We build a mapping from expanded symbol → original changed ancestors via BFS metadata
    // Simplified: any expanded symbol that is a changed symbol (depth 0) is the root cause

    const [handlerRows, ownershipRows, fetchesRows, annotationRows] = await Promise.all([
      // Query 1: reverse-CALLS (handler methods)
      executeParameterized(repo.id, `
        MATCH (m:Method)-[c:CodeRelation {type: 'CALLS'}]->(s)
        WHERE s.id IN $expandedIds AND c.confidence >= $minConfidence
        MATCH (r:Route)-[rc:CodeRelation {type: 'CALLS'}]->(m)
        RETURN r.routePath AS path, r.httpMethod AS method,
               r.filePath AS file_path, r.lineNumber AS line,
               r.controllerName AS controller, r.methodName AS handler,
               s.name AS affected_name, s.id AS affected_id,
               c.type AS relation, 'reverse-CALLS' AS discovery_path
      `, { expandedIds, minConfidence }).catch((e) => {
        logQueryError('impacted-endpoints:reverse-calls', e);
        return [];
      }),

      // Query 2: DEFINES/HANDLES_ROUTE (direct ownership)
      executeParameterized(repo.id, `
        MATCH (s)-[d:CodeRelation]->(r:Route)
        WHERE s.id IN $expandedIds
          AND d.type IN ['DEFINES', 'HANDLES_ROUTE']
          AND d.confidence >= $minConfidence
        RETURN r.routePath AS path, r.httpMethod AS method,
               r.filePath AS file_path, r.lineNumber AS line,
               r.controllerName AS controller, r.methodName AS handler,
               s.name AS affected_name, s.id AS affected_id,
               d.type AS relation, 'DEFINES/HANDLES_ROUTE' AS discovery_path
      `, { expandedIds, minConfidence }).catch((e) => {
        logQueryError('impacted-endpoints:defines-handles', e);
        return [];
      }),

      // Query 3: FETCHES (API consumers)
      executeParameterized(repo.id, `
        MATCH (s)-[f:CodeRelation {type: 'FETCHES'}]->(r:Route)
        WHERE s.id IN $expandedIds AND f.confidence >= $minConfidence
        RETURN r.routePath AS path, r.httpMethod AS method,
               r.filePath AS file_path, r.lineNumber AS line,
               r.controllerName AS controller, r.methodName AS handler,
               s.name AS affected_name, s.id AS affected_id,
               f.type AS relation, 'FETCHES' AS discovery_path
      `, { expandedIds, minConfidence }).catch((e) => {
        logQueryError('impacted-endpoints:fetches', e);
        return [];
      }),

      // Query 4: Annotation-based route fallback
      // Find expanded Method nodes in Controller files that contain mapping annotations
      executeParameterized(repo.id, `
        MATCH (m:Method)
        WHERE m.id IN $expandedIds
          AND m.filePath CONTAINS 'Controller'
        RETURN m.id AS id, m.name AS handler, m.filePath AS filePath,
               m.content AS content, m.startLine AS line
      `, { expandedIds }).catch((e) => {
        logQueryError('impacted-endpoints:annotation-fallback', e);
        return [];
      }),
    ]);

    const allRouteRows = [...handlerRows, ...ownershipRows, ...fetchesRows];

    // ── 4b. Annotation-based route fallback processing ──────────────
    // For each Method node returned by Query 4, parse @XxxMapping annotations
    // to discover routes when Route nodes don't exist in the graph.
    const annotationFallbackRows: any[] = [];
    if (annotationRows && annotationRows.length > 0) {
      // Batch-query class-level @RequestMapping prefixes (one query per unique controller filePath)
      const controllerFiles = [...new Set(annotationRows.map((r: any) => r.filePath || r[2] || '').filter(Boolean))];
      const classPrefixCache = new Map<string, string | undefined>();

      for (const filePath of controllerFiles) {
        try {
          const classRows = await executeParameterized(repo.id, `
            MATCH (c:Class)
            WHERE c.filePath = $filePath
            RETURN c.content AS classContent
            LIMIT 1
          `, { filePath });
          if (classRows && classRows.length > 0) {
            const classContent = classRows[0].classContent ?? classRows[0][0] ?? '';
            const prefix = parseClassLevelPrefix(classContent);
            classPrefixCache.set(filePath, prefix ?? undefined);
          }
        } catch (e) {
          logQueryError('impacted-endpoints:class-prefix', e);
          // Non-fatal — continue without class prefix
        }
      }

      // Process each annotation method
      for (const row of annotationRows) {
        const methodId = row.id || row[0] || '';
        const handler = row.handler || row[1] || '';
        const filePath = row.filePath || row[2] || '';
        const content = row.content || row[3] || '';
        const line = row.line || row[4] || 0;

        if (!content) continue; // Skip methods without content

        const parsed = parseMethodLevelMapping(content);
        if (!parsed) continue; // No mapping annotation found

        const { httpMethod, routePath } = parsed;

        // Combine class prefix with method path
        const classPrefix = classPrefixCache.get(filePath);
        const fullPath = combinePaths(classPrefix, routePath);

        // Derive controller name from filePath
        const fileName = filePath.split('/').pop() ?? 'Unknown';
        const controller = fileName.replace(/\.[^.]+$/, '');

        annotationFallbackRows.push({
          method: httpMethod === '*' ? 'GET' : httpMethod.toUpperCase(), // Default '*' to GET for tier classification
          path: fullPath,
          file_path: filePath,
          line,
          controller,
          handler,
          affected_name: handler,
          affected_id: methodId,
          relation: 'CALLS',
          discovery_path: 'annotation-fallback',
        });
      }
    }

    // Dedup annotation-fallback rows against route-node rows
    // Route-node entries take precedence (higher confidence)
    const routeNodeKeys = new Set(allRouteRows.map((r: any) => {
      const m = (r.method || r[1] || '').toUpperCase();
      const p = r.path || r[0] || '';
      return `${m} ${p}`;
    }));

    for (const fallbackRow of annotationFallbackRows) {
      const key = `${fallbackRow.method} ${fallbackRow.path}`;
      if (!routeNodeKeys.has(key)) {
        allRouteRows.push(fallbackRow);
      }
    }

    // ── 5. Dedup + Tier Classification ──────────────────────────────
    // Dedup by (method, path); keep shallowest depth; worst-tier wins
    const routeMap = new Map<string, {
      method: string; path: string; file_path: string; line: number;
      controller: string; handler: string;
      depth: number; confidence: number;
      affected_by: Set<string>;
      discovery_paths: Set<string>;
      affected_id: string;
    }>();

    for (const row of allRouteRows) {
      const method = (row.method || row[1] || '').toUpperCase();
      const path = row.path || row[0] || '';
      const key = `${method} ${path}`;
      if (!method || !path) continue;

      const affectedId = row.affected_id || row[6] || '';
      const discoveryPath = row.discovery_path || row[9] || '';

      // Determine depth: if the affected_id is a changed symbol, depth=0;
      // otherwise look up BFS metadata
      const depth = changedIdSet.has(affectedId)
        ? 0
        : (expandedMeta.get(affectedId)?.depth ?? maxDepth + 1);

      // Confidence along the path: minimum of the edge to the affected symbol
      // Annotation-fallback confidence is capped at 0.8 (lower than Route-node confidence)
      const baseConfidence = changedIdSet.has(affectedId)
        ? 1.0
        : (expandedMeta.get(affectedId)?.confidence ?? 0.5);
      const confidence = discoveryPath === 'annotation-fallback'
        ? Math.min(baseConfidence, 0.8)
        : baseConfidence;

      if (!routeMap.has(key) || depth < routeMap.get(key)!.depth) {
        // Preserve existing affected_by when overwriting with shallower depth
        const existingAffectedBy = routeMap.has(key)
          ? routeMap.get(key)!.affected_by
          : new Set<string>();
        if (changedIdSet.has(affectedId)) existingAffectedBy.add(affectedId);
        routeMap.set(key, {
          method, path,
          file_path: row.file_path || row[2] || '',
          line: row.line || row[3] || 0,
          controller: row.controller || row[4] || '',
          handler: row.handler || row[5] || '',
          depth,
          confidence,
          affected_by: existingAffectedBy,
          discovery_paths: routeMap.has(key)
            ? routeMap.get(key)!.discovery_paths
            : new Set([discoveryPath]),
          affected_id: affectedId,
        });
      } else {
        const existing = routeMap.get(key)!;
        // Merge affected_by from additional paths
        if (changedIdSet.has(affectedId)) {
          existing.affected_by.add(affectedId);
        }
        existing.discovery_paths.add(discoveryPath);
        // Keep shallowest depth (worst tier wins)
        if (depth < existing.depth) {
          existing.depth = depth;
          existing.confidence = Math.min(existing.confidence, confidence);
        }
      }
    }

    // Track which changed symbols lead to each expanded symbol (for affected_by tracing)
    // For efficiency, build a simple parent map from BFS traversal metadata
    // We trace back: for each non-changed expanded symbol, find changed symbols at depth 0
    // that are reachable. Simplification: use changedIds as the root set.
    // For Routes whose affected_id is NOT a changed symbol, trace via the expanded set.
    // We'll do a separate query to find which changed symbols are upstream of each
    // intermediate symbol. For now, use a simpler approach: mark the affected_id directly.

    // Assign tiers
    const WILL_BREAK: any[] = [];
    const LIKELY_AFFECTED: any[] = [];
    const MAY_NEED_TESTING: any[] = [];

    for (const [key, route] of routeMap) {
      // Collect _triggered_by entries from all affected symbols in this route.
      // A route may be discovered via multiple expanded symbols; merge triggers from all.
      const triggeredByEntries = new Set<string>();
      for (const affId of route.affected_by) {
        const triggers = triggeredByMap.get(affId);
        if (triggers) {
          for (const t of triggers) triggeredByEntries.add(t);
        }
      }
      // Also check the primary affected_id for cross-repo triggers
      if (route.affected_id && triggeredByMap.has(route.affected_id)) {
        for (const t of triggeredByMap.get(route.affected_id)!) triggeredByEntries.add(t);
      }

      const entry: Record<string, unknown> = {
        method: route.method,
        path: route.path,
        file_path: route.file_path,
        line: route.line,
        controller: route.controller,
        handler: route.handler,
        confidence: route.confidence,
        affected_by: Array.from(route.affected_by),
        discovery_paths: Array.from(route.discovery_paths),
      };

      // Only add _triggered_by for cross-repo discoveries
      if (triggeredByEntries.size > 0) {
        entry._triggered_by = Array.from(triggeredByEntries);
      }

      if (route.depth <= 1 && route.confidence >= 0.85) {
        WILL_BREAK.push(entry);
      } else if (route.depth <= 3 && route.confidence >= 0.7) {
        LIKELY_AFFECTED.push(entry);
      } else {
        MAY_NEED_TESTING.push(entry);
      }
    }

    // ── 6. Enrichment: affected processes and modules ───────────────
    const expandedSymbols = Array.from(expandedMeta.entries())
      .filter(([id]) => !changedIdSet.has(id))
      .map(([id, meta]) => ({
        id,
        depth: meta.depth,
        confidence: meta.confidence,
        relationType: meta.relationType,
      }));

    let affectedProcesses: any[] = [];
    let affectedModules: any[] = [];

    const allImpactedIds = Array.from(visited);
    const d1Ids = Array.from(expandedMeta.entries())
      .filter(([, m]) => m.depth === 1)
      .map(([id]) => id);

    const CHUNK_SIZE = 100;
    const chunkIds = (ids: string[]): string[][] => {
      const chunks: string[][] = [];
      for (let i = 0; i < ids.length; i += CHUNK_SIZE) {
        chunks.push(ids.slice(i, i + CHUNK_SIZE));
      }
      return chunks;
    };

    // Affected processes
    const maxChunks = parseInt(process.env.IMPACT_MAX_CHUNKS || '999999', 10);
    const processChunks = chunkIds(allImpactedIds);
    const processRows: any[] = [];
    const processedIds: string[] = [];
    let chunksProcessed = 0;
    for (const chunk of processChunks) {
      if (chunksProcessed >= maxChunks) {
        traversalComplete = false;
        break;
      }
      processedIds.push(...chunk);
      const result = await executeParameterized(repo.id, `
        MATCH (s)-[r:CodeRelation {type: 'STEP_IN_PROCESS'}]->(p:Process)
        WHERE s.id IN $ids
        RETURN p.heuristicLabel AS name, COUNT(DISTINCT s.id) AS hits,
               MIN(r.step) AS minStep, p.stepCount AS stepCount
        ORDER BY hits DESC
        LIMIT 20
      `, { ids: chunk }).catch(() => []);
      processRows.push(...result);
      chunksProcessed++;
    }

    // Re-aggregate across chunks
    const aggregatedProcesses = new Map<string, any>();
    for (const row of processRows) {
      const procName = row.name || row[0];
      if (aggregatedProcesses.has(procName)) {
        const existing = aggregatedProcesses.get(procName);
        existing.hits += row.hits || row[1] || 0;
        if ((row.minStep ?? row[2]) < existing.minStep) {
          existing.minStep = row.minStep ?? row[2];
        }
      } else {
        aggregatedProcesses.set(procName, {
          name: procName,
          hits: row.hits || row[1] || 0,
          minStep: row.minStep ?? row[2],
          stepCount: row.stepCount ?? row[3],
        });
      }
    }
    affectedProcesses = Array.from(aggregatedProcesses.values())
      .sort((a, b) => b.hits - a.hits)
      .slice(0, 20)
      .map(r => ({
        name: r.name,
        total_hits: r.hits,
        broken_at_step: r.minStep,
        step_count: r.stepCount,
      }));

    // Affected modules — chunked + parameterized (same pattern as process enrichment)
    if (processedIds.length > 0) {
      const moduleChunks = chunkIds(processedIds);
      const d1FilteredIds = d1Ids.filter(id => processedIds.includes(id));
      const d1Chunks = chunkIds(d1FilteredIds);
      let moduleRows: any[] = [];
      let directModuleRows: any[] = [];
      let moduleChunksProcessed = 0;

      for (const chunk of moduleChunks) {
        if (moduleChunksProcessed >= maxChunks) {
          traversalComplete = false;
          break;
        }
        const result = await executeParameterized(repo.id, `
          MATCH (s)-[:CodeRelation {type: 'MEMBER_OF'}]->(c:Community)
          WHERE s.id IN $ids
          RETURN c.heuristicLabel AS name, COUNT(DISTINCT s.id) AS hits
          ORDER BY hits DESC
          LIMIT 20
        `, { ids: chunk }).catch(() => []);
        moduleRows.push(...result);
        moduleChunksProcessed++;
      }

      // Aggregate module hits across chunks
      const aggregatedModules = new Map<string, number>();
      for (const row of moduleRows) {
        const name = row.name || row[0];
        const hits = row.hits || row[1] || 0;
        aggregatedModules.set(name, (aggregatedModules.get(name) ?? 0) + hits);
      }
      // Re-sort and limit to 20 after aggregation
      moduleRows = Array.from(aggregatedModules.entries())
        .sort((a, b) => b[1] - a[1])
        .slice(0, 20)
        .map(([name, hits]) => ({ name, hits }));

      for (const chunk of d1Chunks) {
        const result = await executeParameterized(repo.id, `
          MATCH (s)-[:CodeRelation {type: 'MEMBER_OF'}]->(c:Community)
          WHERE s.id IN $ids
          RETURN DISTINCT c.heuristicLabel AS name
        `, { ids: chunk }).catch(() => []);
        directModuleRows.push(...result);
      }

      const directModuleSet = new Set(directModuleRows.map((r: any) => r.name || r[0]));
      affectedModules = moduleRows.map((r: any) => {
        const name = r.name || r[0];
        return {
          name,
          hits: r.hits || r[1],
          impact: directModuleSet.has(name) ? 'direct' : 'indirect',
        };
      });
    }

    // ── 7. Risk scoring ────────────────────────────────────────────
    const endpointCount = WILL_BREAK.length + LIKELY_AFFECTED.length + MAY_NEED_TESTING.length;
    const processCount = affectedProcesses.length;
    const moduleCount = affectedModules.length;
    let risk = 'LOW';
    if (endpointCount >= 30 || processCount >= 5 || moduleCount >= 5 || expandedSymbols.length >= 200) {
      risk = 'CRITICAL';
    } else if (endpointCount >= 15 || processCount >= 3 || moduleCount >= 3 || expandedSymbols.length >= 100) {
      risk = 'HIGH';
    } else if (endpointCount >= 5 || expandedSymbols.length >= 30) {
      risk = 'MEDIUM';
    }

    // ── 8. Return shape ─────────────────────────────────────────────
    return {
      // (#28, #49) per-repo Record<string, number> for ALL count fields,
      // matching the multi-repo aggregator shape. Consumers no longer need
      // to type-check whether `changed_files` is a number or an object —
      // it is always an object keyed by repoId.
      summary: {
        changed_files: { [repo.id]: changedFiles.length },
        changed_symbols: { [repo.id]: changedSymbols.length },
        impacted_endpoints: { [repo.id]: endpointCount },
        risk_level: risk,
      },
      impacted_endpoints: {
        WILL_BREAK,
        LIKELY_AFFECTED,
        MAY_NEED_TESTING,
      },
      changed_symbols: changedSymbols,
      affected_processes: affectedProcesses,
      affected_modules: affectedModules,
      _meta: {
        version: '1.0',
        generated_at: new Date().toISOString(),
        ...(!traversalComplete && { partial: true }),
      },
      ...(_diagnostics && { _diagnostics }),
    };
  }

  /**
   * API Impact tool — analyze an HTTP route's response shape, consumers, and mismatches.
   *
   * Queries Route nodes and their FETCHES consumer edges to determine:
   * - Which consumers (fetch() callers) depend on this route
   * - Whether consumer code accesses fields not present in the handler's response shape
   * - Risk level based on consumer count and mismatch severity
   */
  private async apiImpact(repo: RepoHandle, params: {
    route?: string;
    file?: string;
  }): Promise<any> {
    await this.ensureInitialized(repo.id);

    if (!params.route && !params.file) {
      return { error: 'Either "route" or "file" parameter is required.' };
    }

    // Build the route lookup query
    let routeWhere = '';
    const routeParams: Record<string, any> = {};

    if (params.route) {
      routeWhere = 'WHERE r.name = $route';
      routeParams.route = params.route;
    } else if (params.file) {
      routeWhere = 'WHERE r.filePath = $file';
      routeParams.file = params.file;
    }

    // Find the route(s) — may return multiple if same file has multiple methods
    const routeRows = await executeParameterized(repo.id, `
      MATCH (r:Route)
      ${routeWhere}
      RETURN r.id AS routeId, r.name AS route, r.filePath AS handlerFile,
             r.responseKeys AS responseKeys, r.errorKeys AS errorKeys,
             r.middleware AS middleware
    `, routeParams);

    if (!routeRows || routeRows.length === 0) {
      return { error: 'No routes found matching the given route or file.' };
    }

    // Build results — one entry per matched route
    const routes: any[] = [];
    let allMismatches: any[] = [];
    let totalConsumers = 0;

    for (const row of routeRows) {
      const routeId = row.routeId || row[0];
      const routeName = row.route || row[1];
      const handlerFile = row.handlerFile || row[2];
      const responseKeys: string[] = row.responseKeys || row[3] || [];
      const errorKeys: string[] = row.errorKeys || row[4] || [];
      const middleware: string[] = row.middleware || row[5] || [];

      // Find consumers: functions that FETCHES this route (via CodeRelation edges)
      const consumerRows = await executeParameterized(repo.id, `
        MATCH (c:Function)-[r:CodeRelation {type: 'FETCHES'}]->(rout:Route)
        WHERE rout.id = $routeId
        RETURN c.id AS consumerId, c.name AS consumerName,
               c.filePath AS consumerFile, r.reason AS fetchReason
      `, { routeId });

      const consumers: any[] = [];
      const routeConsumerSet = new Set<string>();

      for (const cres of consumerRows) {
        const consumerId = cres.consumerId || cres[0];
        const consumerName = cres.consumerName || cres[1];
        const consumerFile = cres.consumerFile || cres[2];
        const fetchReason: string = cres.fetchReason || cres[3] || '';

        // Skip duplicate consumers from same file (multiple methods in same file)
        if (routeConsumerSet.has(consumerFile)) continue;
        routeConsumerSet.add(consumerFile);

        // Determine if this is a multi-fetch consumer (fetches multiple routes)
        const multiMatch = fetchReason.match(/fetches:(\d+)/);
        const attributionNote = multiMatch && parseInt(multiMatch[1]) > 1
          ? `fetches ${multiMatch[1]} routes`
          : undefined;

        // Determine confidence based on multi-fetch
        const confidence = multiMatch && parseInt(multiMatch[1]) > 1 ? 'low' : 'high';

        consumers.push({
          name: consumerName,
          file: consumerFile,
          attributionNote,
          confidence,
        });

        // Check for mismatches: consumer accesses fields not in response shape
        const keyMatch = fetchReason.match(/keys:([^|]+)/);
        if (keyMatch) {
          const accessedKeys = keyMatch[1].split(',').map((k: string) => k.trim());
          const successSet = new Set(responseKeys);
          const errorSet = new Set(errorKeys);

          for (const key of accessedKeys) {
            // Skip if key is a nested property access (e.g., "data.items")
            const topLevelKey = key.split('.')[0];
            const isSuccess = successSet.has(topLevelKey);
            const isError = errorSet.has(topLevelKey);

            if (!isSuccess && !isError) {
              allMismatches.push({
                consumer: consumerFile,
                field: topLevelKey,
                reason: `${topLevelKey} not in response shape`,
                confidence,
              });
            }
          }
        }
      }

      totalConsumers += consumers.length;

      routes.push({
        route: routeName,
        handler: handlerFile,
        responseShape: {
          success: responseKeys,
          error: errorKeys,
        },
        middleware,
        consumers,
      });
    }

    // Calculate impact summary
    const directConsumers = totalConsumers;
    let riskLevel = 'LOW';
    if (allMismatches.length > 0) {
      // Mismatches always bump risk to at least MEDIUM
      riskLevel = directConsumers >= 10 ? 'HIGH' : 'MEDIUM';
    } else if (directConsumers >= 10) {
      riskLevel = 'HIGH';
    } else if (directConsumers >= 3) {
      riskLevel = 'MEDIUM';
    }

    const impactSummary = {
      directConsumers,
      riskLevel,
    };

    // If multiple routes matched, return array format
    if (routes.length > 1) {
      return {
        routes,
        total: routes.length,
        mismatches: allMismatches,
        impactSummary,
      };
    }

    // Single route — return flat structure
    const single = routes[0];
    return {
      route: single.route,
      handler: single.handler,
      responseShape: single.responseShape,
      middleware: single.middleware,
      consumers: single.consumers,
      mismatches: allMismatches,
      impactSummary,
    };
  }

  /**
   * route_map tool — list routes with their consumers and middleware.
   * Simpler than api_impact: just returns route metadata without mismatch analysis.
   */
  private async routeMap(repo: RepoHandle, params: { route?: string; file?: string }): Promise<any> {
    await this.ensureInitialized(repo.id);

    if (!params.route && !params.file) {
      return { error: 'Either "route" or "file" parameter is required.' };
    }

    const routeWhere = params.route
      ? 'WHERE r.name = $route'
      : 'WHERE r.filePath = $file';
    const routeParams = { route: params.route, file: params.file };
    const queryParam = params.route ? 'route' : 'file';

    const routeRows = await executeParameterized(repo.id, `
      MATCH (r:Route)
      ${routeWhere}
      RETURN r.id AS routeId, r.name AS route, r.filePath AS handlerFile,
             r.responseKeys AS responseKeys, r.errorKeys AS errorKeys,
             r.middleware AS middleware
    `, { [queryParam]: params.route ?? params.file });

    if (!routeRows || routeRows.length === 0) {
      return { error: 'No routes found matching the given route or file.' };
    }

    const routes: any[] = [];

    for (const row of routeRows) {
      const routeId = row.routeId || row[0];
      const routeName = row.route || row[1];
      const handlerFile = row.handlerFile || row[2];
      const middleware: string[] = row.middleware || row[5] || [];

      const consumerRows = await executeParameterized(repo.id, `
        MATCH (c:Function)-[r:CodeRelation {type: 'FETCHES'}]->(rout:Route)
        WHERE rout.id = $routeId
        RETURN c.filePath AS consumerFile
      `, { routeId });

      const consumers = [...new Set(consumerRows.map((r: any) => r.consumerFile || r[0]))];

      routes.push({
        route: routeName,
        handler: handlerFile,
        middleware,
        consumers: consumers.map(f => ({ file: f })),
      });
    }

    return { routes };
  }

  /**
   * shape_check tool — list routes with their response shapes.
   * Analyzes consumer key access and identifies mismatches between
   * consumer-accessed keys and route response/error keys.
   */
  private async shapeCheck(repo: RepoHandle, params: { route?: string; file?: string }): Promise<any> {
    await this.ensureInitialized(repo.id);

    if (!params.route && !params.file) {
      return { error: 'Either "route" or "file" parameter is required.' };
    }

    const routeWhere = params.route
      ? 'WHERE r.name = $route'
      : 'WHERE r.filePath = $file';
    const queryParam = params.route ? 'route' : 'file';

    const routeRows = await executeParameterized(repo.id, `
      MATCH (r:Route)
      ${routeWhere}
      RETURN r.id AS routeId, r.name AS route, r.filePath AS handlerFile,
             r.responseKeys AS responseKeys, r.errorKeys AS errorKeys
    `, { [queryParam]: params.route ?? params.file });

    if (!routeRows || routeRows.length === 0) {
      return { error: 'No routes found matching the given route or file.' };
    }

    const routes: any[] = [];

    for (const row of routeRows) {
      const routeId = row.routeId || row[0];
      const routeName = row.route || row[1];
      const handlerFile = row.handlerFile || row[2];
      const responseKeys: string[] = row.responseKeys || row[3] || [];
      const errorKeys: string[] = row.errorKeys || row[4] || [];

      // Query FETCHES edges with reason field to extract accessed keys
      const consumerRows = await executeParameterized(repo.id, `
        MATCH (c:Function)-[rel:CodeRelation {type: 'FETCHES'}]->(r:Route)
        WHERE r.id = $routeId
        RETURN c.filePath AS consumerFile, rel.reason AS reason
      `, { routeId });

      // Build consumer info with key analysis
      const consumers: any[] = [];
      for (const consumerRow of consumerRows) {
        const filePath = consumerRow.consumerFile || consumerRow[0];
        const reason = consumerRow.reason || consumerRow[1] || '';

        // Parse accessed keys from reason field (format: "fetch-url-match|keys:key1,key2,...")
        const keysMatch = reason.match(/keys:([^|]+)/);
        const accessedKeys: string[] = keysMatch
          ? keysMatch[1].split(',').map(k => k.trim()).filter(k => k.length > 0)
          : [];

        // Classify keys: errorPathKeys (in errorKeys), mismatched (not in responseKeys or errorKeys)
        const responseKeySet = new Set(responseKeys);
        const errorKeySet = new Set(errorKeys);

        const errorPathKeys: string[] = accessedKeys.filter(k => errorKeySet.has(k));
        const mismatched: string[] = accessedKeys.filter(
          k => !responseKeySet.has(k) && !errorKeySet.has(k)
        );

        consumers.push({
          filePath,
          accessedKeys,
          ...(errorPathKeys.length > 0 && { errorPathKeys }),
          ...(mismatched.length > 0 && { mismatched }),
        });
      }

      // Determine route status: MISMATCH if any consumer has mismatched keys
      const hasMismatches = consumers.some(c => c.mismatched && c.mismatched.length > 0);

      routes.push({
        route: routeName,
        handler: handlerFile,
        responseKeys,
        errorKeys,
        consumers,
        ...(hasMismatches && { status: 'MISMATCH' }),
      });
    }

    return { routes };
  }

  /**
   * Rename tool — multi-file coordinated rename using graph + text search.
   * Graph refs are tagged "graph" (high confidence).
   * Additional refs found via text search are tagged "text_search" (lower confidence).
   */
  private async rename(repo: RepoHandle, params: {
    symbol_name?: string;
    symbol_uid?: string;
    new_name: string;
    file_path?: string;
    dry_run?: boolean;
  }): Promise<any> {
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
    
    const addEdit = (filePath: string, line: number, oldText: string, newText: string, confidence: string) => {
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
          const defRegex = new RegExp(`\\b${oldName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'g');
          // (#60) Verify the regex actually finds a match. The
          // previous String.includes() check is a substring match
          // (e.g. "getAllBond" is included in "getAllBondCategory")
          // and the subsequent String.replace() with a word-bounded
          // regex then produces a no-op edit (old === new),
          // polluting the edit list. Gate on regex.test() so only
          // true symbol-accurate matches contribute.
          defRegex.lastIndex = 0;
          if (defRegex.test(lines[lineIdx])) {
            defRegex.lastIndex = 0;
            addEdit(sym.filePath, sym.startLine, lines[lineIdx].trim(), lines[lineIdx].replace(defRegex, new_name).trim(), 'graph');
          }
        }
      } catch (e) { logQueryError('rename:read-definition', e); }
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
            // (#60) Same gate as the definition edit: substring
            // match is too loose, so verify the word-bounded
            // regex finds a real match before producing an
            // edit. The reproduction in #60 was renaming
            // `getAllBond` on BondService — the IMPLEMENTS edge
            // from AssetDetailServiceImpl pulled its file into
            // the rename, and lines like
            // `protected ... getAllBondCategory() {` matched
            // String.includes('getAllBond') but the regex found
            // nothing — producing a no-op edit.
            const refRegex = new RegExp(`\\b${oldName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'g');
            refRegex.lastIndex = 0;
            if (refRegex.test(lines[i])) {
              refRegex.lastIndex = 0;
              addEdit(ref.filePath, i + 1, lines[i].trim(), lines[i].replace(refRegex, new_name).trim(), 'graph');
            }
            graphEdits++;
            break; // one edit per file from graph refs
          }
        }
      } catch (e) { logQueryError('rename:read-ref', e); }
    }

    // Step 3: Text search for refs the graph might have missed
    let astSearchEdits = 0;
    const graphFiles = new Set([sym.filePath, ...allIncoming.map(r => r.filePath)].filter(Boolean));
    
    // Simple text search across the repo for the old name (in files not already covered by graph)
    try {
      const { execFileSync } = await import('child_process');
      const rgArgs = [
        '-l',
        '--type-add', 'code:*.{ts,tsx,js,jsx,py,go,rs,java,c,h,cpp,cc,cxx,hpp,hxx,hh,cs,php,swift}',
        '-t', 'code',
        `\\b${oldName}\\b`,
        '.',
      ];
      const output = execFileSync('rg', rgArgs, { cwd: repo.repoPath, encoding: 'utf-8', timeout: 5000 });
      const files = output.trim().split('\n').filter(f => f.length > 0);
      
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
              addEdit(normalizedFile, i + 1, lines[i].trim(), lines[i].replace(regex, new_name).trim(), 'text_search');
              astSearchEdits++;
            }
          }
        } catch (e) { logQueryError('rename:text-search-read', e); }
      }
    } catch (e) { logQueryError('rename:ripgrep', e); }
    
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
        } catch (e) { logQueryError('rename:apply-edit', e); }
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

  private async impact(repo: RepoHandle, params: {
    target: string;
    direction: 'upstream' | 'downstream';
    maxDepth?: number;
    relationTypes?: string[];
    includeTests?: boolean;
    minConfidence?: number;
  }): Promise<any> {
    // Validate minConfidence range (#66). Reject out-of-range values explicitly
    // so callers learn about the 0-1 contract instead of silently getting
    // an empty result set (minConfidence=1.5 reads as "no result above 150%").
    if (params.minConfidence !== undefined &&
        (params.minConfidence < 0 || params.minConfidence > 1)) {
      throw new Error(
        `minConfidence must be between 0 and 1 (got ${params.minConfidence})`
      );
    }
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

  private async _impactImpl(repo: RepoHandle, params: {
    target: string;
    direction: 'upstream' | 'downstream';
    maxDepth?: number;
    relationTypes?: string[];
    includeTests?: boolean;
    minConfidence?: number;
    // (#53) Disambiguate overloaded methods (interface vs impl) by file path,
    // matching the `context` tool's `file_path` parameter contract. Forwarded
    // to the name-resolution sub-queries so the candidate whose filePath
    // contains the suffix is preferred.
    file_path?: string;
  }): Promise<any> {
    await this.ensureInitialized(repo.id);

    const { target, direction } = params;
    const isQualified = target.includes(':') || target.includes('/');
    // For uid-format targets (e.g. "Class:UserController"), extract the name
    // part for name-based fallback lookups.
    const targetName = isQualified ? (target.split(/[:/]/).pop() ?? target) : target;
    const maxDepth = params.maxDepth || 3;
    const rawRelTypes = params.relationTypes && params.relationTypes.length > 0
      ? params.relationTypes.filter(t => VALID_RELATION_TYPES.has(t))
      : ['CALLS', 'IMPORTS', 'EXTENDS', 'IMPLEMENTS'];
    const relationTypes = rawRelTypes.length > 0 ? rawRelTypes : ['CALLS', 'IMPORTS', 'EXTENDS', 'IMPLEMENTS'];
    const includeTests = params.includeTests ?? false;
    const minConfidence = params.minConfidence ?? 0;

    const relTypeFilter = relationTypes.map(t => `'${t}'`).join(', ');
    const confidenceFilter = minConfidence > 0 ? ` AND r.confidence >= ${minConfidence}` : '';

    // Resolve target by name, preferring Class/Interface over Constructor
    // (fix #480: Java class and constructor share the same name).
    // labels(n)[0] returns empty string in LadybugDB, so we use explicit
    // label-typed sub-queries in a single UNION ordered by priority to avoid
    // up to 6 serial round-trips for non-Class targets.
    let sym: any = null;
    let symType = '';

    // If target looks like a uid (Type:Name or path/Name), try exact id match first
    if (isQualified) {
      const uidRows = await executeParameterized(repo.id, `
        MATCH (n) WHERE n.id = $targetName
        RETURN n.id AS id, n.name AS name, labels(n)[0] AS type, n.filePath AS filePath
        LIMIT 1
      `, { targetName: target }).catch((e) => { logQueryError('impact:uid-resolution', e); return []; });
      if (uidRows.length > 0) {
        sym = uidRows[0];
        symType = sym.type || '';
      }
    }

    if (!sym) {
      try {
        // (#10) Collect ALL matches across types, not just the first per type.
        // When a name like "GetOrder" exists in multiple files (e.g., a
        // service method and a handler method), silently picking the first
        // candidate gives a misleading blast radius. Mirror the `context`
        // tool's `status: 'ambiguous'` contract so callers can disambiguate
        // with `file_path` rather than receive silently-wrong results.
        const rows = await executeParameterized(repo.id, `
          MATCH (n:\`Class\`) WHERE n.name = $targetName
          RETURN n.id AS id, n.name AS name, n.filePath AS filePath, 0 AS priority
          UNION ALL
          MATCH (n:\`Interface\`) WHERE n.name = $targetName
          RETURN n.id AS id, n.name AS name, n.filePath AS filePath, 1 AS priority
          UNION ALL
          MATCH (n:\`Function\`) WHERE n.name = $targetName
          RETURN n.id AS id, n.name AS name, n.filePath AS filePath, 2 AS priority
          UNION ALL
          MATCH (n:\`Method\`) WHERE n.name = $targetName
          RETURN n.id AS id, n.name AS name, n.filePath AS filePath, 3 AS priority
          UNION ALL
          MATCH (n:\`Constructor\`) WHERE n.name = $targetName
          RETURN n.id AS id, n.name AS name, n.filePath AS filePath, 4 AS priority
        `, { targetName }).catch(() => []);

        if (rows.length > 0) {
          const filePathFilter = params.file_path;
          const fpLower = filePathFilter?.toLowerCase();
          // Build a deduplicated, priority-sorted list of candidates. Two
          // rows with the same id are a single candidate.
          const uniqueById = new Map<string, any>();
          for (const r of rows) {
            const id = r.id || r[0];
            if (id && !uniqueById.has(id)) uniqueById.set(id, r);
          }
          const candidates = Array.from(uniqueById.values()).sort(
            (a, b) => (a.priority ?? a[3] ?? 99) - (b.priority ?? b[3] ?? 99),
          );

          // (#53) If `file_path` is supplied, prefer the row whose filePath
          // contains it as a suffix. This disambiguates interface-vs-impl
          // overloading (e.g., `unholdMoney` defined in both
          // CashService.java and CashServiceV2Impl.java).
          if (fpLower) {
            const matched = candidates.find((r: any) => {
              const fp = (r.filePath ?? r[2] ?? '') as string;
              return fp && fp.toLowerCase().endsWith(fpLower);
            });
            if (matched) {
              sym = matched;
            }
          }
          if (!sym) {
            // (#10) When a name matches multiple distinct files (e.g.,
            // GetOrder in handlers/ vs services/), the result is genuinely
            // ambiguous — picking one candidate silently mis-states the
            // blast radius. Surface the ambiguity in a structured shape
            // the caller can act on (re-run with file_path, or inspect
            // candidates). Same-file matches (e.g., a Class and its
            // Constructor with the same name) silently prefer Class via
            // the priority sort, mirroring #480.
            const distinctFiles = new Set(
              candidates.map((r: any) => (r.filePath ?? r[2] ?? '') as string),
            );
            if (candidates.length > 1 && distinctFiles.size > 1) {
              return {
                status: 'ambiguous',
                target: targetName,
                candidates: candidates.map((r: any) => ({
                  uid: r.id || r[0],
                  name: r.name || r[1],
                  kind: ['Class', 'Interface', 'Function', 'Method', 'Constructor'][
                    r.priority ?? r[3]
                  ] ?? '',
                  filePath: r.filePath || r[2],
                })),
                suggestion:
                  'Re-run with file_path parameter to scope impact analysis to a single candidate (matches the context tool contract).',
              };
            }
            sym = candidates[0];
          }
          const priorityToLabel = ['Class', 'Interface', 'Function', 'Method', 'Constructor'];
          symType = priorityToLabel[sym.priority ?? sym[3]] ?? '';
        }
      } catch { /* fall through to unlabeled match */ }

      // Fall back to unlabeled match for any other node type
      if (!sym) {
        const rows = await executeParameterized(repo.id, `
          MATCH (n)
          WHERE n.name = $targetName
          RETURN n.id AS id, n.name AS name, labels(n)[0] AS type, n.filePath AS filePath
          LIMIT 1
        `, { targetName });
        if (rows.length > 0) {
          // (#53) Honor `file_path` for disambiguation if a filePath matches
          // the supplied suffix; otherwise pick the first row as before.
          const fpLower = params.file_path?.toLowerCase();
          const matched = fpLower
            ? rows.find((r: any) => {
                const fp = (r.filePath ?? r[3] ?? '') as string;
                return fp && fp.toLowerCase().endsWith(fpLower);
              })
            : undefined;
          sym = matched ?? rows[0];
          symType = sym.type || sym[2] || '';
        }
      }
    }

    if (!sym) return { error: `Target '${target}' not found` };

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
        // Run all seed queries in parallel — they are independent.
        //
        // (#75) Class nodes have HAS_METHOD edges to BOTH Constructor and
        // Method nodes. The original seed only collected Constructor (which
        // is enough for typical Java bean patterns but misses real service
        // methods like `pricingIConnect` that hold the actual downstream
        // CALLS edges). Pull both node types so the BFS reaches method-level
        // edges at depth 2+, making `maxDepth` actually meaningful for
        // class-level impact analysis.
        //
        // Note: Method nodes are added to the BFS frontier but NOT to
        // `visited` — they must be discoverable as HAS_METHOD results at
        // depth 1 (the legitimate "direct callers" of the class). Adding
        // them to `visited` would dedupe those legitimate results away.
        const [ctorRows, methodRows, fileRows] = await Promise.all([
          executeParameterized(repo.id, `
            MATCH (n)-[hm:CodeRelation]->(c:Constructor)
            WHERE n.id = $symId AND hm.type = 'HAS_METHOD'
            RETURN c.id AS id, c.name AS name, labels(c)[0] AS type, c.filePath AS filePath
          `, { symId }),
          executeParameterized(repo.id, `
            MATCH (n)-[hm:CodeRelation]->(m:Method)
            WHERE n.id = $symId AND hm.type = 'HAS_METHOD'
            RETURN m.id AS id, m.name AS name, labels(m)[0] AS type, m.filePath AS filePath
          `, { symId }),
          // Restrict to DEFINES edges only — other File->Class edge types (if
          // any) should not be treated as the owning file relationship.
          executeParameterized(repo.id, `
            MATCH (f:File)-[rel:CodeRelation]->(n)
            WHERE n.id = $symId AND rel.type = 'DEFINES'
            RETURN f.id AS id, f.name AS name, labels(f)[0] AS type, f.filePath AS filePath
          `, { symId }),
        ]);

        // Constructors: add to both visited and frontier (Java class↔ctor
        // name collision; they have no incoming HAS_METHOD from the class).
        for (const r of ctorRows) {
          const rid = r.id || r[0];
          if (rid && !visited.has(rid)) { visited.add(rid); frontier.push(rid); }
        }
        // Methods: add to frontier ONLY (not visited) so the depth-1
        // HAS_METHOD edges from the Class are still discoverable. The
        // Methods are already the targets of those edges, so we want to
        // traverse FROM them at depth 2+ (their outgoing CALLS, etc.).
        for (const r of methodRows) {
          const rid = r.id || r[0];
          if (rid && !frontier.includes(rid)) { frontier.push(rid); }
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
      const idList = frontier.map(id => `'${id.replace(/'/g, "''")}'`).join(', ');
      const query = direction === 'upstream'
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
            impacted.push({
              depth,
              id: relId,
              name: rel.name || rel[2],
              type: rel.type || rel[3],
              filePath,
              relationType: rel.relType || rel[5],
              confidence: rel.confidence || rel[6] || 1.0,
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
      const allIdsArr = impacted.map(i => i.id);
      const d1IdsArr = (grouped[1] || []).map((i: any) => i.id);

      // Chunk IDs into batches of 100 for parameterized queries
      const CHUNK_SIZE = 100;
      const chunkIds = (ids: string[]): string[][] => {
        const chunks: string[][] = [];
        for (let i = 0; i < ids.length; i += CHUNK_SIZE) {
          chunks.push(ids.slice(i, i + CHUNK_SIZE));
        }
        return chunks;
      };

      // Affected processes: which execution flows are broken and at which step
      const maxChunks = parseInt(process.env.IMPACT_MAX_CHUNKS || '999999', 10);
      const processChunks = chunkIds(allIdsArr);
      const processRows: any[] = [];
      const processedIds: string[] = [];
      let chunksProcessed = 0;
      for (const chunk of processChunks) {
        if (chunksProcessed >= maxChunks) {
          traversalComplete = false;
          break;
        }
        processedIds.push(...chunk);
        const result = await executeParameterized(repo.id, `
          MATCH (s)-[r:CodeRelation {type: 'STEP_IN_PROCESS'}]->(p:Process)
          WHERE s.id IN $ids
          RETURN p.heuristicLabel AS name, COUNT(DISTINCT s.id) AS hits, MIN(r.step) AS minStep, p.stepCount AS stepCount
          ORDER BY hits DESC
          LIMIT 20
        `, { ids: chunk }).catch(() => []);
        processRows.push(...result);
        chunksProcessed++;
      }

      // Re-aggregate and limit to top 20 after merging all chunks
      const aggregatedProcesses = new Map<string, any>();
      for (const row of processRows) {
        const key = row.name;
        if (aggregatedProcesses.has(key)) {
          const existing = aggregatedProcesses.get(key);
          existing.hits += row.hits;
          if (row.minStep < existing.minStep) existing.minStep = row.minStep;
        } else {
          aggregatedProcesses.set(key, { ...row });
        }
      }
      const topProcesses = Array.from(aggregatedProcesses.values())
        .sort((a, b) => b.hits - a.hits)
        .slice(0, 20);

      const [moduleRows, directModuleRows] = await Promise.all([
        executeQuery(repo.id, `
          MATCH (s)-[:CodeRelation {type: 'MEMBER_OF'}]->(c:Community)
          WHERE s.id IN [${processedIds.map(id => `'${id.replace(/'/g, "''")}'`).join(', ')}]
          RETURN c.heuristicLabel AS name, COUNT(DISTINCT s.id) AS hits
          ORDER BY hits DESC
          LIMIT 20
        `).catch(() => []),
        d1IdsArr.length > 0 ? executeQuery(repo.id, `
          MATCH (s)-[:CodeRelation {type: 'MEMBER_OF'}]->(c:Community)
          WHERE s.id IN [${d1IdsArr.filter(id => processedIds.includes(id)).map(id => `'${id.replace(/'/g, "''")}'`).join(', ')}]
          RETURN DISTINCT c.heuristicLabel AS name
        `).catch(() => []) : Promise.resolve([]),
      ]);

      affectedProcesses = topProcesses.map((r: any) => ({
        name: r.name || r[0],
        total_hits: r.hits || r[1],
        broken_at_step: r.minStep ?? r[2],
        step_count: r.stepCount ?? r[3],
      }));

      const directModuleSet = new Set(directModuleRows.map((r: any) => r.name || r[0]));
      affectedModules = moduleRows.map((r: any) => {
        const name = r.name || r[0];
        return {
          name,
          hits: r.hits || r[1],
          impact: directModuleSet.has(name) ? 'direct' : 'indirect',
        };
      });
    }

    // Risk scoring
    const processCount = affectedProcesses.length;
    const moduleCount = affectedModules.length;
    let risk = 'LOW';
    if (directCount >= 30 || processCount >= 5 || moduleCount >= 5 || impacted.length >= 200) {
      risk = 'CRITICAL';
    } else if (directCount >= 15 || processCount >= 3 || moduleCount >= 3 || impacted.length >= 100) {
      risk = 'HIGH';
    } else if (directCount >= 5 || impacted.length >= 30) {
      risk = 'MEDIUM';
    }

    return {
      target: {
        id: symId,
        name: sym.name || sym[1],
        type: sym.type || sym[2],
        filePath: sym.filePath || sym[3],
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
      const clusters = await executeQuery(repo.id, `
        MATCH (c:Community)
        RETURN c.id AS id, c.label AS label, c.heuristicLabel AS heuristicLabel, c.cohesion AS cohesion, c.symbolCount AS symbolCount
        ORDER BY c.symbolCount DESC
        LIMIT ${rawLimit}
      `);
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
      const processes = await executeQuery(repo.id, `
        MATCH (p:Process)
        RETURN p.id AS id, p.label AS label, p.heuristicLabel AS heuristicLabel, p.processType AS processType, p.stepCount AS stepCount
        ORDER BY p.stepCount DESC
        LIMIT ${limit}
      `);
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

    const clusters = await executeParameterized(repo.id, `
      MATCH (c:Community)
      WHERE c.label = $clusterName OR c.heuristicLabel = $clusterName
      RETURN c.id AS id, c.label AS label, c.heuristicLabel AS heuristicLabel, c.cohesion AS cohesion, c.symbolCount AS symbolCount
    `, { clusterName: name });
    if (clusters.length === 0) return { error: `Cluster '${name}' not found` };

    const rawClusters = clusters.map((c: any) => ({
      id: c.id || c[0], label: c.label || c[1], heuristicLabel: c.heuristicLabel || c[2],
      cohesion: c.cohesion || c[3], symbolCount: c.symbolCount || c[4],
    }));

    let totalSymbols = 0, weightedCohesion = 0;
    for (const c of rawClusters) {
      const s = c.symbolCount || 0;
      totalSymbols += s;
      weightedCohesion += (c.cohesion || 0) * s;
    }

    const members = await executeParameterized(repo.id, `
      MATCH (n)-[:CodeRelation {type: 'MEMBER_OF'}]->(c:Community)
      WHERE c.label = $clusterName OR c.heuristicLabel = $clusterName
      RETURN DISTINCT n.name AS name, labels(n)[0] AS type, n.filePath AS filePath
      LIMIT 30
    `, { clusterName: name });

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
        name: m.name || m[0], type: m.type || m[1], filePath: m.filePath || m[2],
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

    const processes = await executeParameterized(repo.id, `
      MATCH (p:Process)
      WHERE p.label = $processName OR p.heuristicLabel = $processName
      RETURN p.id AS id, p.label AS label, p.heuristicLabel AS heuristicLabel, p.processType AS processType, p.stepCount AS stepCount
      LIMIT 1
    `, { processName: name });
    if (processes.length === 0) return { error: `Process '${name}' not found` };

    const proc = processes[0];
    const procId = proc.id || proc[0];
    const steps = await executeParameterized(repo.id, `
      MATCH (n)-[r:CodeRelation {type: 'STEP_IN_PROCESS'}]->(p {id: $procId})
      RETURN n.name AS name, labels(n)[0] AS type, n.filePath AS filePath, r.step AS step
      ORDER BY r.step
    `, { procId });

    return {
      process: {
        id: procId, label: proc.label || proc[1], heuristicLabel: proc.heuristicLabel || proc[2],
        processType: proc.processType || proc[3], stepCount: proc.stepCount || proc[4],
      },
      steps: steps.map((s: any) => ({
        step: s.step || s[3], name: s.name || s[0], type: s.type || s[1], filePath: s.filePath || s[2],
      })),
    };
  }

  /**
   * Document Endpoint tool — Generate API documentation JSON.
   */
  private async documentEndpoint(repo: RepoHandle, params: any): Promise<{ result?: DocumentEndpointResult; error?: string } | OpenApiModeResult> {
    await this.ensureInitialized(repo.id);
    
    // Ensure cross-registry is initialized (lazy init on first access)
    if (!this.crossRepoRegistry) {
      if (!this.crossRepoInitPromise) {
        this.crossRepoInitPromise = this.initCrossRepoRegistry();
      }
      await this.crossRepoInitPromise;
    }
    
    // Create cross-repo context
    const crossRepo: CrossRepoContext = {
      findDepRepo: (prefix) => this.findDepRepo(prefix),
      queryMultipleRepos: (ids, query, p) => this.queryMultipleRepos(ids, query, p),
      listDepRepos: async () => {
        const repos = this.crossRepoRegistry!.listRepos();
        return repos.map(r => r.repoId).filter(id => id !== repo.id);
      }
    };

    // Backward-compat bridge: map legacy include_context to mode
    let mode: 'openapi' | 'ai_context' = 'openapi';
    if (params.mode === 'ai_context' || params.mode === 'openapi') {
      mode = params.mode;
    } else if (params.include_context === true) {
      mode = 'ai_context';
      console.warn('[DEPRECATED] include_context is deprecated. Use mode: "ai_context" instead.');
    }
    // Note: params.openapi is now the default (mode: 'openapi'), no-op mapping

    const options: DocumentEndpointOptions = {
      method: params.method,
      path: params.path,
      depth: params.depth ?? 10,
      mode,
      repo: params.repo,
      crossRepo,
    };
    return documentEndpoint(repo, options);
  }

  /**
   * Endpoints tool — query Route nodes for HTTP endpoints.
   */
  private async endpoints(
    repo: RepoHandle,
    params?: { method?: string; path?: string }
  ): Promise<{ endpoints: EndpointInfo[] }> {
    await this.ensureInitialized(repo.id);
    return queryEndpoints(repo, params);
  }

  // ─── Cross-Repo Methods ─────────────────────────────────────────────

  /**
   * Execute the same Cypher query on multiple repos in parallel.
   * Each result is attributed with its source repoId.
   * Failed repos return empty results instead of throwing.
   *
   * @param repoIds - List of repo identifiers
   * @param cypher - Cypher query to execute
   * @param params - Optional query parameters
   * @returns Array of { repoId, results } for each repo
   */
  async queryMultipleRepos(
    repoIds: string[],
    cypher: string,
    params?: Record<string, unknown>
  ): Promise<Array<{ repoId: string; results: unknown[] }>> {
    if (repoIds.length === 0) return [];

    const DEBUG = process.env.GITNEXUS_DEBUG === 'true';

    const queryPromises = repoIds.map(async (repoId) => {
      try {
        // First try direct lookup
        let handle = this.repos.get(repoId);

        // Debug logging
        if (DEBUG) {
          console.error(`[GitNexus DEBUG] queryMultipleRepos: repoId=${repoId}, handleFound=${!!handle}`);
          if (!handle) {
            console.error(`[GitNexus DEBUG] Available repos: ${[...this.repos.keys()].join(', ')}`);
          }
        }

        // If not found, try resolving by name
        if (!handle) {
          try {
            handle = await this.resolveRepo(repoId);
            if (DEBUG && handle) {
              console.error(`[GitNexus DEBUG] Resolved repoId=${repoId} to handle.id=${handle.id}`);
            }
          } catch {
            // Resolution failed
          }
        }

        if (!handle) {
          return { repoId, results: [] as unknown[], _error: 'repo_not_found' };
        }

        await this.ensureInitialized(handle.id);

        if (!isLbugReady(handle.id)) {
          if (DEBUG) {
            console.error(`[GitNexus DEBUG] LadybugDB not ready for repo: ${repoId}`);
          }
          return { repoId, results: [] as unknown[], _error: 'ladybug_not_ready' };
        }

        const results = params
          ? await executeParameterized(handle.id, cypher, params)
          : await executeQuery(handle.id, cypher);

        if (DEBUG) {
          console.error(`[GitNexus DEBUG] queryMultipleRepos: repoId=${repoId}, resultCount=${results?.length || 0}`);
        }

        return { repoId, results: results || [] };
      } catch (err) {
        logQueryError(`queryMultipleRepos:${repoId}`, err);
        return { repoId, results: [] as unknown[], _error: err instanceof Error ? err.message : String(err) };
      }
    });

    return Promise.all(queryPromises);
  }

  /**
   * Auto-expand a single repo to include its consumers via CrossRepoRegistry.
   * Returns the deduplicated repo list [sourceRepoId, ...consumerRepoIds],
   * or null if no consumers found / registry not available (caller falls back to single-repo).
   */
  private async expandToConsumers(sourceRepoId: string): Promise<string[] | null> {
    // Lazy-initialize registry if needed
    if (!this.crossRepoRegistry) {
      if (!this.crossRepoInitPromise) {
        this.crossRepoInitPromise = this.initCrossRepoRegistry();
      }
      await this.crossRepoInitPromise;
    }

    if (!this.crossRepoRegistry?.isInitialized()) {
      return null;
    }

    const consumerRepoIds = this.crossRepoRegistry.findConsumers(sourceRepoId);
    if (consumerRepoIds.length === 0) {
      return null;
    }

    // Deduplicate: source repo always included, consumers filtered to exclude source
    const seen = new Set<string>([sourceRepoId]);
    const allRepoIds = [sourceRepoId];
    for (const id of consumerRepoIds) {
      if (!seen.has(id)) {
        seen.add(id);
        allRepoIds.push(id);
      }
    }
    return allRepoIds;
  }


  /**
   * Get the manifest for a registered repo.
   * Returns null if repo is unknown or manifest doesn't exist.
   *
   * @param repoId - The repo identifier
   * @returns RepoManifest or null
   */
  async getManifest(repoId: string): Promise<RepoManifest | null> {
    try {
      const handle = await this.resolveRepo(repoId);
      // Manifest is stored at <repoPath>/.gitnexus/repo_manifest.json
      // Try repoPath first (standard location)
      let manifest = await readManifest(handle.repoPath);
      if (!manifest && handle.storagePath) {
        // Fallback: some test setups use storagePath as the repo root
        manifest = await readManifest(handle.storagePath);
      }
      return manifest;
    } catch {
      // Unknown repo or failed to read manifest
      return null;
    }
  }

  /**
   * Find which repo provides a dependency.
   * Lazy-initializes the CrossRepoRegistry on first call.
   *
   * @param depName - Dependency name (e.g., "shared-utils" or "com.example:lib")
   * @returns repoId of the providing repo, or null if not found
   */
  async findDepRepo(depName: string): Promise<string | null> {
    if (!depName) return null;

    // Lazy-initialize registry on first access with race condition guard
    if (!this.crossRepoRegistry) {
      if (!this.crossRepoInitPromise) {
        this.crossRepoInitPromise = this.initCrossRepoRegistry();
      }
      await this.crossRepoInitPromise;
    }

    return this.crossRepoRegistry.findDepRepo(depName);
  }

  /**
   * Initialize CrossRepoRegistry (extracted for lazy init).
   */
  private async initCrossRepoRegistry(): Promise<void> {
    const registry = new CrossRepoRegistry();
    const repoInfos = [...this.repos.values()].map((h) => ({
      repoId: h.id,
      repoPath: h.repoPath,
      storagePath: h.storagePath,
    }));
    await registry.initialize(repoInfos);
    this.crossRepoRegistry = registry;
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
    if (this.crossRepoRegistry) {
      this.crossRepoRegistry.clear();
      this.crossRepoRegistry = null;
    }
    this.crossRepoInitPromise = null;
  }
}
