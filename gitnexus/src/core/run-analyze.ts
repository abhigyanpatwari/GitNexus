/**
 * Shared Analysis Orchestrator
 *
 * Extracts the core analysis pipeline from the CLI analyze command into a
 * reusable function that can be called from both the CLI and a server-side
 * worker process.
 *
 * IMPORTANT: This module must NEVER call process.exit(). The caller (CLI
 * wrapper or server worker) is responsible for process lifecycle.
 */

import path from 'path';
import fs from 'fs/promises';
import { runPipelineFromRepo } from './ingestion/pipeline.js';
import {
  initLbug,
  loadGraphToLbug,
  getLbugStats,
  executeQuery,
  executeWithReusedStatement,
  closeLbug,
  createFTSIndex,
  loadCachedEmbeddings,
} from './lbug/lbug-adapter.js';
import {
  getStoragePaths,
  saveMeta,
  loadMeta,
  addToGitignore,
  registerRepo,
  cleanupOldKuzuFiles,
} from '../storage/repo-manager.js';
import { getCurrentCommit, hasGitDir } from '../storage/git.js';
import type { CachedEmbedding } from './embeddings/types.js';
import { generateAIContextFiles } from '../cli/ai-context.js';
import { EMBEDDING_DIMS, EMBEDDING_TABLE_NAME } from './lbug/schema.js';
import { STALE_HASH_SENTINEL } from './lbug/schema.js';
import type { EmbeddingConfigSummary } from './embeddings/http-client.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface AnalyzeCallbacks {
  onProgress: (phase: string, percent: number, message: string) => void;
  onLog?: (message: string) => void;
}

export interface AnalyzeOptions {
  force?: boolean;
  embeddings?: boolean;
  skipGit?: boolean;
  /** Skip AGENTS.md and CLAUDE.md gitnexus block updates. */
  skipAgentsMd?: boolean;
  /** Omit volatile symbol/relationship counts from AGENTS.md and CLAUDE.md. */
  noStats?: boolean;
}

export interface AnalyzeResult {
  repoName: string;
  repoPath: string;
  stats: {
    files?: number;
    nodes?: number;
    edges?: number;
    communities?: number;
    processes?: number;
    embeddings?: number;
  };
  alreadyUpToDate?: boolean;
  /** The raw pipeline result — only populated when needed by callers (e.g. skill generation). */
  pipelineResult?: any;
}

/** Threshold: auto-skip embeddings for repos with more nodes than this */
const EMBEDDING_NODE_LIMIT = 100_000;
const EMBEDDING_BACKEND_SWITCH_ENV = 'GITNEXUS_ALLOW_EMBEDDING_BACKEND_SWITCH';

export const PHASE_LABELS: Record<string, string> = {
  extracting: 'Scanning files',
  structure: 'Building structure',
  parsing: 'Parsing code',
  imports: 'Resolving imports',
  calls: 'Tracing calls',
  heritage: 'Extracting inheritance',
  communities: 'Detecting communities',
  processes: 'Detecting processes',
  complete: 'Pipeline complete',
  lbug: 'Loading into LadybugDB',
  fts: 'Creating search indexes',
  embeddings: 'Generating embeddings',
  done: 'Done',
};

const getCurrentEmbeddingConfig = async (): Promise<EmbeddingConfigSummary> => {
  const { getHttpConfigSummary } = await import('./embeddings/http-client.js');
  const httpConfig = getHttpConfigSummary();
  if (httpConfig) return httpConfig;

  return {
    provider: 'onnx',
    model: 'Snowflake/snowflake-arctic-embed-xs',
    dimensions: EMBEDDING_DIMS,
  };
};

const embeddingConfigsCompatible = (
  a?: EmbeddingConfigSummary,
  b?: EmbeddingConfigSummary,
): boolean => {
  if (!a || !b) return true;
  const sameProvider = a.provider === b.provider;
  const sameBaseUrl = a.provider === 'openai' || a.baseUrl === b.baseUrl;
  return sameProvider && sameBaseUrl && a.model === b.model && a.dimensions === b.dimensions;
};

const formatEmbeddingConfig = (config?: EmbeddingConfigSummary): string => {
  if (!config) return 'unknown';
  const base = config.baseUrl ? ` @ ${config.baseUrl}` : '';
  return `${config.provider}:${config.model}:${config.dimensions}d${base}`;
};

const isExplicitBackendSwitchAllowed = (): boolean => {
  const raw = process.env[EMBEDDING_BACKEND_SWITCH_ENV]?.toLowerCase();
  return raw === '1' || raw === 'true' || raw === 'yes';
};

const resolveEmbeddingConfig = async (
  options: AnalyzeOptions,
  existingMeta: Awaited<ReturnType<typeof loadMeta>>,
  log: (msg: string) => void,
): Promise<EmbeddingConfigSummary | undefined> => {
  if (!options.embeddings) return undefined;

  const currentConfig = await getCurrentEmbeddingConfig();
  const existingConfig = existingMeta?.embedding;
  if (!existingConfig || embeddingConfigsCompatible(existingConfig, currentConfig)) {
    return currentConfig;
  }

  const from = formatEmbeddingConfig(existingConfig);
  const to = formatEmbeddingConfig(currentConfig);
  if (!isExplicitBackendSwitchAllowed()) {
    throw new Error(
      `Existing embeddings were created with ${from}, but current configuration resolves to ${to}. ` +
        `Refusing to overwrite embeddings with a different backend/model. Set OPENAI_API_KEY ` +
        `or matching GITNEXUS_EMBEDDING_URL/GITNEXUS_EMBEDDING_MODEL/GITNEXUS_EMBEDDING_DIMS ` +
        `to keep the existing backend. To intentionally rebuild with ${to}, rerun with ` +
        `${EMBEDDING_BACKEND_SWITCH_ENV}=1 and --force.`,
    );
  }

  log(
    `Embedding backend switch explicitly allowed by ${EMBEDDING_BACKEND_SWITCH_ENV}; ` +
      `discarding cache (${from} -> ${to})`,
  );
  return currentConfig;
};

// ---------------------------------------------------------------------------
// Main orchestrator
// ---------------------------------------------------------------------------

/**
 * Run the full GitNexus analysis pipeline.
 *
 * This is the shared core extracted from the CLI `analyze` command. It
 * handles: pipeline execution, LadybugDB loading, FTS indexing, embedding
 * generation, metadata persistence, and AI context file generation.
 *
 * The function communicates progress and log messages exclusively through
 * the {@link AnalyzeCallbacks} interface — it never writes to stdout/stderr
 * directly and never calls `process.exit()`.
 */
export async function runFullAnalysis(
  repoPath: string,
  options: AnalyzeOptions,
  callbacks: AnalyzeCallbacks,
): Promise<AnalyzeResult> {
  const log = (msg: string) => callbacks.onLog?.(msg);
  const progress = (phase: string, percent: number, message: string) =>
    callbacks.onProgress(phase, percent, message);

  const { storagePath, lbugPath } = getStoragePaths(repoPath);

  // Clean up stale KuzuDB files from before the LadybugDB migration.
  const kuzuResult = await cleanupOldKuzuFiles(storagePath);
  if (kuzuResult.found && kuzuResult.needsReindex) {
    log('Migrating from KuzuDB to LadybugDB — rebuilding index...');
  }

  const repoHasGit = hasGitDir(repoPath);
  const currentCommit = repoHasGit ? getCurrentCommit(repoPath) : '';
  const existingMeta = await loadMeta(storagePath);

  // ── Early-return: already up to date ──────────────────────────────
  if (existingMeta && !options.force && existingMeta.lastCommit === currentCommit) {
    const missingRequestedEmbeddings =
      Boolean(options.embeddings) && ((existingMeta.stats?.embeddings ?? 0) === 0);
    // Non-git folders have currentCommit = '' — always rebuild since we can't detect changes
    if (currentCommit !== '' && !missingRequestedEmbeddings) {
      return {
        repoName: path.basename(repoPath),
        repoPath,
        stats: existingMeta.stats ?? {},
        alreadyUpToDate: true,
      };
    }
  }

  const currentEmbeddingConfig = await resolveEmbeddingConfig(options, existingMeta, log);

  // ── Cache embeddings from existing index before rebuild ────────────
  let cachedEmbeddingNodeIds = new Set<string>();
  let cachedEmbeddings: CachedEmbedding[] = [];

  if (options.embeddings && existingMeta && !options.force) {
    if (
      existingMeta.embedding &&
      currentEmbeddingConfig &&
      !embeddingConfigsCompatible(existingMeta.embedding, currentEmbeddingConfig)
    ) {
      log(
        `Embedding backend changed (${formatEmbeddingConfig(existingMeta.embedding)} -> ${formatEmbeddingConfig(currentEmbeddingConfig)}), discarding cache`,
      );
    } else {
      try {
        progress('embeddings', 0, 'Caching embeddings...');
        await initLbug(lbugPath);
        const cached = await loadCachedEmbeddings();
        cachedEmbeddingNodeIds = cached.embeddingNodeIds;
        cachedEmbeddings = cached.embeddings;
        await closeLbug();
      } catch {
        try {
          await closeLbug();
        } catch {
          /* swallow */
        }
      }
    }
  }

  // ── Phase 1: Full Pipeline (0–60%) ────────────────────────────────
  const pipelineResult = await runPipelineFromRepo(repoPath, (p) => {
    const phaseLabel = PHASE_LABELS[p.phase] || p.phase;
    const scaled = Math.round(p.percent * 0.6);
    progress(p.phase, scaled, phaseLabel);
  });

  // ── Phase 2: LadybugDB (60–85%) ──────────────────────────────────
  progress('lbug', 60, 'Loading into LadybugDB...');

  await closeLbug();
  const lbugFiles = [lbugPath, `${lbugPath}.wal`, `${lbugPath}.lock`];
  for (const f of lbugFiles) {
    try {
      await fs.rm(f, { recursive: true, force: true });
    } catch {
      /* swallow */
    }
  }

  await initLbug(lbugPath);
  try {
    // All work after initLbug is wrapped in try/finally to ensure closeLbug()
    // is called even if an error occurs — the module-level singleton DB handle
    // must be released to avoid blocking subsequent invocations.

    let lbugMsgCount = 0;
    await loadGraphToLbug(pipelineResult.graph, pipelineResult.repoPath, storagePath, (msg) => {
      lbugMsgCount++;
      const pct = Math.min(84, 60 + Math.round((lbugMsgCount / (lbugMsgCount + 10)) * 24));
      progress('lbug', pct, msg);
    });

    // ── Phase 3: FTS (85–90%) ─────────────────────────────────────────
    progress('fts', 85, 'Creating search indexes...');

    try {
      await createFTSIndex('File', 'file_fts', ['name', 'content']);
      await createFTSIndex('Function', 'function_fts', ['name', 'content']);
      await createFTSIndex('Class', 'class_fts', ['name', 'content']);
      await createFTSIndex('Method', 'method_fts', ['name', 'content']);
      await createFTSIndex('Interface', 'interface_fts', ['name', 'content']);
    } catch {
      // Non-fatal — FTS is best-effort
    }

    // ── Phase 3.5: Re-insert cached embeddings ────────────────────────
    if (cachedEmbeddings.length > 0) {
      const cachedDims = cachedEmbeddings[0].embedding.length;
      const { EMBEDDING_DIMS } = await import('./lbug/schema.js');
      if (cachedDims !== EMBEDDING_DIMS) {
        // Dimensions changed (e.g. switched embedding model) — discard cache and re-embed all
        log(
          `Embedding dimensions changed (${cachedDims}d -> ${EMBEDDING_DIMS}d), discarding cache`,
        );
        cachedEmbeddings = [];
        cachedEmbeddingNodeIds = new Set();
      } else {
        progress('embeddings', 88, `Restoring ${cachedEmbeddings.length} cached embeddings...`);
        const { batchInsertEmbeddings: batchInsert } =
          await import('./embeddings/embedding-pipeline.js');
        const EMBED_BATCH = 200;
        for (let i = 0; i < cachedEmbeddings.length; i += EMBED_BATCH) {
          const batch = cachedEmbeddings.slice(i, i + EMBED_BATCH);

          try {
            await batchInsert(executeWithReusedStatement, batch);
          } catch {
            /* some may fail if node was removed, that's fine */
          }
        }
      }
    }

    // ── Phase 4: Embeddings (90–98%) ──────────────────────────────────
    const stats = await getLbugStats();
    let embeddingSkipped = true;
    let embeddingConfig: EmbeddingConfigSummary | undefined;

    if (options.embeddings) {
      if (stats.nodes <= EMBEDDING_NODE_LIMIT) {
        embeddingSkipped = false;
      }
    }

    if (!embeddingSkipped) {
      const { isHttpMode } = await import('./embeddings/http-client.js');
      const httpMode = isHttpMode();
      embeddingConfig = currentEmbeddingConfig ?? (await getCurrentEmbeddingConfig());
      progress(
        'embeddings',
        90,
        httpMode ? 'Connecting to embedding endpoint...' : 'Loading embedding model...',
      );
      const { runEmbeddingPipeline } = await import('./embeddings/embedding-pipeline.js');
      // Build a Map<nodeId, contentHash> from cached embeddings for incremental mode
      let existingEmbeddings: Map<string, string> | undefined;
      if (cachedEmbeddingNodeIds.size > 0) {
        existingEmbeddings = new Map<string, string>();
        for (const e of cachedEmbeddings) {
          existingEmbeddings.set(e.nodeId, e.contentHash ?? STALE_HASH_SENTINEL);
        }
      }

      const { readServerMapping } = await import('./embeddings/server-mapping.js');
      const projectName = path.basename(repoPath);
      const serverName = await readServerMapping(projectName);
      await runEmbeddingPipeline(
        executeQuery,
        executeWithReusedStatement,
        (p) => {
          const scaled = 90 + Math.round((p.percent / 100) * 8);
          const label =
            p.phase === 'loading-model'
              ? httpMode
                ? 'Connecting to embedding endpoint...'
                : 'Loading embedding model...'
              : `Embedding ${p.nodesProcessed || 0}/${p.totalNodes || '?'}`;
          progress('embeddings', scaled, label);
        },
        {},
        cachedEmbeddingNodeIds.size > 0 ? cachedEmbeddingNodeIds : undefined,
        { repoName: projectName, serverName },
        existingEmbeddings,
      );
    }

    // ── Phase 5: Finalize (98–100%) ───────────────────────────────────
    progress('done', 98, 'Saving metadata...');

    // Count embeddings in the index (cached + newly generated)
    let embeddingCount = 0;
    try {
      const embResult = await executeQuery(
        `MATCH (e:${EMBEDDING_TABLE_NAME}) RETURN count(e) AS cnt`,
      );
      embeddingCount = embResult?.[0]?.cnt ?? 0;
    } catch {
      /* table may not exist if embeddings never ran */
    }

    const meta = {
      repoPath,
      lastCommit: currentCommit,
      indexedAt: new Date().toISOString(),
      stats: {
        files: pipelineResult.totalFileCount,
        nodes: stats.nodes,
        edges: stats.edges,
        communities: pipelineResult.communityResult?.stats.totalCommunities,
        processes: pipelineResult.processResult?.stats.totalProcesses,
        embeddings: embeddingCount,
      },
      ...(embeddingConfig && embeddingCount > 0 ? { embedding: embeddingConfig } : {}),
    };
    await saveMeta(storagePath, meta);
    await registerRepo(repoPath, meta);

    // Only attempt to update .gitignore when a .git directory is present.
    if (hasGitDir(repoPath)) {
      await addToGitignore(repoPath);
    }

    const projectName = path.basename(repoPath);

    // ── Generate AI context files (best-effort) ───────────────────────
    let aggregatedClusterCount = 0;
    if (pipelineResult.communityResult?.communities) {
      const groups = new Map<string, number>();
      for (const c of pipelineResult.communityResult.communities) {
        const label = c.heuristicLabel || c.label || 'Unknown';
        groups.set(label, (groups.get(label) || 0) + c.symbolCount);
      }
      aggregatedClusterCount = Array.from(groups.values()).filter((count) => count >= 5).length;
    }

    try {
      await generateAIContextFiles(
        repoPath,
        storagePath,
        projectName,
        {
          files: pipelineResult.totalFileCount,
          nodes: stats.nodes,
          edges: stats.edges,
          communities: pipelineResult.communityResult?.stats.totalCommunities,
          clusters: aggregatedClusterCount,
          processes: pipelineResult.processResult?.stats.totalProcesses,
        },
        undefined,
        { skipAgentsMd: options.skipAgentsMd, noStats: options.noStats },
      );
    } catch {
      // Best-effort — don't fail the entire analysis for context file issues
    }

    // ── Close LadybugDB ──────────────────────────────────────────────
    await closeLbug();

    progress('done', 100, 'Done');

    return {
      repoName: projectName,
      repoPath,
      stats: meta.stats,
      pipelineResult,
    };
  } catch (err) {
    // Ensure LadybugDB is closed even on error
    try {
      await closeLbug();
    } catch {
      /* swallow */
    }
    throw err;
  }
}
