/**
 * Analyze Command
 *
 * Indexes a repository and stores the knowledge graph in .gitnexus/
 */

import path from 'path';
import { execFileSync } from 'child_process';
import v8 from 'v8';
import cliProgress from 'cli-progress';
import { runPipelineFromRepo } from '../core/ingestion/pipeline.js';
import { initLbug, loadGraphToLbug, getLbugStats, executeQuery, executeWithReusedStatement, closeLbug, createFTSIndex, loadCachedEmbeddings } from '../core/lbug/lbug-adapter.js';
// Embedding imports are lazy (dynamic import) so onnxruntime-node is never
// loaded when embeddings are not requested. This avoids crashes on Node
// versions whose ABI is not yet supported by the native binary (#89).
// disposeEmbedder intentionally not called — ONNX Runtime segfaults on cleanup (see #38)
import { getStoragePaths, saveMeta, loadMeta, addToGitignore, registerRepo, getGlobalRegistryPath, cleanupOldKuzuFiles } from '../storage/repo-manager.js';
import { getCurrentCommit, isGitRepo, getGitRoot } from '../storage/git.js';
import { generateAIContextFiles } from './ai-context.js';
import { generateSkillFiles, type GeneratedSkillInfo } from './skill-gen.js';
import fs from 'fs/promises';


const HEAP_MB = 8192;
const HEAP_FLAG = `--max-old-space-size=${HEAP_MB}`;

/** Re-exec the process with an 8GB heap if we're currently below that. */
function ensureHeap(): boolean {
  const nodeOpts = process.env.NODE_OPTIONS || '';
  if (nodeOpts.includes('--max-old-space-size')) return false;

  const v8Heap = v8.getHeapStatistics().heap_size_limit;
  if (v8Heap >= HEAP_MB * 1024 * 1024 * 0.9) return false;

  try {
    execFileSync(process.execPath, [HEAP_FLAG, ...process.argv.slice(1)], {
      stdio: 'inherit',
      env: { ...process.env, NODE_OPTIONS: `${nodeOpts} ${HEAP_FLAG}`.trim() },
    });
  } catch (e: any) {
    process.exitCode = e.status ?? 1;
  }
  return true;
}

export interface AnalyzeOptions {
  force?: boolean;
  embeddings?: boolean;
  skills?: boolean;
  verbose?: boolean;
}

/** Threshold: auto-skip embeddings for repos with more nodes than this */
const EMBEDDING_NODE_LIMIT = 50_000;

const PHASE_LABELS: Record<string, string> = {
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

export const analyzeCommand = async (
  inputPath?: string,
  options?: AnalyzeOptions
) => {
  if (ensureHeap()) return;

  if (options?.verbose) {
    process.env.GITNEXUS_VERBOSE = '1';
  }

  console.log('\n  GitNexus Analyzer\n');

  let repoPath: string;
  if (inputPath) {
    repoPath = path.resolve(inputPath);
  } else {
    const gitRoot = getGitRoot(process.cwd());
    if (!gitRoot) {
      console.log('  Not inside a git repository\n');
      process.exitCode = 1;
      return;
    }
    repoPath = gitRoot;
  }

  if (!isGitRepo(repoPath)) {
    console.log('  Not a git repository\n');
    process.exitCode = 1;
    return;
  }

  const { storagePath, lbugPath } = getStoragePaths(repoPath);

  // Clean up stale KuzuDB files from before the LadybugDB migration.
  // If kuzu existed but lbug doesn't, we're doing a migration re-index — say so.
  const kuzuResult = await cleanupOldKuzuFiles(storagePath);
  if (kuzuResult.found && kuzuResult.needsReindex) {
    console.log('  Migrating from KuzuDB to LadybugDB — rebuilding index...\n');
  }

  const currentCommit = getCurrentCommit(repoPath);
  const existingMeta = await loadMeta(storagePath);

  if (existingMeta && !options?.force && !options?.skills && existingMeta.lastCommit === currentCommit) {
    console.log('  Already up to date\n');
    return;
  }

  if (process.env.GITNEXUS_NO_GITIGNORE) {
    console.log('  GITNEXUS_NO_GITIGNORE is set — skipping .gitignore (still reading .gitnexusignore)\n');
  }

  // Single progress bar for entire pipeline
  const bar = new cliProgress.SingleBar({
    format: '  {bar} {percentage}% | {phase}',
    barCompleteChar: '\u2588',
    barIncompleteChar: '\u2591',
    hideCursor: true,
    barGlue: '',
    autopadding: true,
    clearOnComplete: false,
    stopOnComplete: false,
  }, cliProgress.Presets.shades_grey);

  bar.start(100, 0, { phase: 'Initializing...' });

  // Graceful SIGINT handling — clean up resources and exit
  let aborted = false;
  const sigintHandler = () => {
    if (aborted) process.exit(1); // Second Ctrl-C: force exit
    aborted = true;
    bar.stop();
    console.log('\n  Interrupted — cleaning up...');
    closeLbug().catch(() => {}).finally(() => process.exit(130));
  };
  process.on('SIGINT', sigintHandler);

  // Route all console output through bar.log() so the bar doesn't stamp itself
  // multiple times when other code writes to stdout/stderr mid-render.
  const origLog = console.log.bind(console);
  const origWarn = console.warn.bind(console);
  const origError = console.error.bind(console);
  const barLog = (...args: any[]) => {
    // Clear the bar line, print the message, then let the next bar.update redraw
    process.stdout.write('\x1b[2K\r');
    origLog(args.map(a => (typeof a === 'string' ? a : String(a))).join(' '));
  };
  console.log = barLog;
  console.warn = barLog;
  console.error = barLog;

  // Track elapsed time per phase — both updateBar and the interval use the
  // same format so they don't flicker against each other.
  let lastPhaseLabel = 'Initializing...';
  let phaseStart = Date.now();

  /** Update bar with phase label + elapsed seconds (shown after 3s). */
  const updateBar = (value: number, phaseLabel: string) => {
    if (phaseLabel !== lastPhaseLabel) { lastPhaseLabel = phaseLabel; phaseStart = Date.now(); }
    const elapsed = Math.round((Date.now() - phaseStart) / 1000);
    const display = elapsed >= 3 ? `${phaseLabel} (${elapsed}s)` : phaseLabel;
    bar.update(value, { phase: display });
  };

  // Tick elapsed seconds for phases with infrequent progress callbacks
  // (e.g. CSV streaming, FTS indexing). Uses the same display format as
  // updateBar so there's no flickering.
  const elapsedTimer = setInterval(() => {
    const elapsed = Math.round((Date.now() - phaseStart) / 1000);
    if (elapsed >= 3) {
      bar.update({ phase: `${lastPhaseLabel} (${elapsed}s)` });
    }
  }, 1000);

  const t0Global = Date.now();

  // ── Cache embeddings from existing index before rebuild ────────────
  let cachedEmbeddingNodeIds = new Set<string>();
  let cachedEmbeddings: Array<{ nodeId: string; embedding: number[] }> = [];

  if (options?.embeddings && existingMeta && !options?.force) {
    try {
      updateBar(0, 'Caching embeddings...');
      await initLbug(lbugPath);
      const cached = await loadCachedEmbeddings();
      cachedEmbeddingNodeIds = cached.embeddingNodeIds;
      cachedEmbeddings = cached.embeddings;
      await closeLbug();
    } catch {
      try { await closeLbug(); } catch {}
    }
  }

  // ── Phase 1: Full Pipeline (0–60%) ─────────────────────────────────
  const pipelineResult = await runPipelineFromRepo(repoPath, (progress) => {
    const phaseLabel = PHASE_LABELS[progress.phase] || progress.phase;
    const scaled = Math.round(progress.percent * 0.6);
    updateBar(scaled, phaseLabel);
  });

  // ── Phase 2: LadybugDB (60–85%) ──────────────────────────────────────
  updateBar(60, 'Loading into LadybugDB...');

  await closeLbug();
  const lbugFiles = [lbugPath, `${lbugPath}.wal`, `${lbugPath}.lock`];
  for (const f of lbugFiles) {
    try { await fs.rm(f, { recursive: true, force: true }); } catch {}
  }

  const t0Lbug = Date.now();
  await initLbug(lbugPath);
  let lbugMsgCount = 0;
  const lbugResult = await loadGraphToLbug(pipelineResult.graph, pipelineResult.repoPath, storagePath, (msg) => {
    lbugMsgCount++;
    const progress = Math.min(84, 60 + Math.round((lbugMsgCount / (lbugMsgCount + 10)) * 24));
    updateBar(progress, msg);
  });
  const lbugTime = ((Date.now() - t0Lbug) / 1000).toFixed(1);
  const lbugWarnings = lbugResult.warnings;

  // ── Phase 3: FTS (85–90%) ─────────────────────────────────────────
  updateBar(85, 'Creating search indexes...');

  const t0Fts = Date.now();
  try {
    await createFTSIndex('File', 'file_fts', ['name', 'content']);
    await createFTSIndex('Function', 'function_fts', ['name', 'content']);
    await createFTSIndex('Class', 'class_fts', ['name', 'content']);
    await createFTSIndex('Method', 'method_fts', ['name', 'content']);
    await createFTSIndex('Interface', 'interface_fts', ['name', 'content']);
  } catch (e: any) {
    // Non-fatal — FTS is best-effort
  }
  const ftsTime = ((Date.now() - t0Fts) / 1000).toFixed(1);

  // ── Phase 3.5: Re-insert cached embeddings ────────────────────────
  if (cachedEmbeddings.length > 0) {
    updateBar(88, `Restoring ${cachedEmbeddings.length} cached embeddings...`);
    const EMBED_BATCH = 200;
    for (let i = 0; i < cachedEmbeddings.length; i += EMBED_BATCH) {
      const batch = cachedEmbeddings.slice(i, i + EMBED_BATCH);
      const paramsList = batch.map(e => ({ nodeId: e.nodeId, embedding: e.embedding }));
      try {
        await executeWithReusedStatement(
          `CREATE (e:CodeEmbedding {nodeId: $nodeId, embedding: $embedding})`,
          paramsList,
        );
      } catch { /* some may fail if node was removed, that's fine */ }
    }
  }

  // ── Phase 4: Embeddings (90–98%) ──────────────────────────────────
  const stats = await getLbugStats();
  let embeddingTime = '0.0';
  let embeddingSkipped = true;
  let embeddingSkipReason = 'off (use --embeddings to enable)';

  if (options?.embeddings) {
    if (stats.nodes > EMBEDDING_NODE_LIMIT) {
      embeddingSkipReason = `skipped (${stats.nodes.toLocaleString()} nodes > ${EMBEDDING_NODE_LIMIT.toLocaleString()} limit)`;
    } else {
      embeddingSkipped = false;
    }
  }

  if (!embeddingSkipped) {
    updateBar(90, 'Loading embedding model...');
    const t0Emb = Date.now();
    const { runEmbeddingPipeline } = await import('../core/embeddings/embedding-pipeline.js');
    await runEmbeddingPipeline(
      executeQuery,
      executeWithReusedStatement,
      (progress) => {
        const scaled = 90 + Math.round((progress.percent / 100) * 8);
        const label = progress.phase === 'loading-model' ? 'Loading embedding model...' : `Embedding ${progress.nodesProcessed || 0}/${progress.totalNodes || '?'}`;
        updateBar(scaled, label);
      },
      {},
      cachedEmbeddingNodeIds.size > 0 ? cachedEmbeddingNodeIds : undefined,
    );
    embeddingTime = ((Date.now() - t0Emb) / 1000).toFixed(1);
  }

  // ── Phase 5: Finalize (98–100%) ───────────────────────────────────
  updateBar(98, 'Saving metadata...');

  // Count embeddings in the index (cached + newly generated)
  let embeddingCount = 0;
  try {
    const embResult = await executeQuery(`MATCH (e:CodeEmbedding) RETURN count(e) AS cnt`);
    embeddingCount = embResult?.[0]?.cnt ?? 0;
  } catch { /* table may not exist if embeddings never ran */ }

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
  };
  await saveMeta(storagePath, meta);
  await registerRepo(repoPath, meta);
  await addToGitignore(repoPath);

  const projectName = path.basename(repoPath);
  let aggregatedClusterCount = 0;
  if (pipelineResult.communityResult?.communities) {
    const groups = new Map<string, number>();
    for (const c of pipelineResult.communityResult.communities) {
      const label = c.heuristicLabel || c.label || 'Unknown';
      groups.set(label, (groups.get(label) || 0) + c.symbolCount);
    }
    aggregatedClusterCount = Array.from(groups.values()).filter(count => count >= 5).length;
  }

  let generatedSkills: GeneratedSkillInfo[] = [];
  if (options?.skills && pipelineResult.communityResult) {
    updateBar(99, 'Generating skill files...');
    const skillResult = await generateSkillFiles(repoPath, projectName, pipelineResult);
    generatedSkills = skillResult.skills;
  }

  const aiContext = await generateAIContextFiles(repoPath, storagePath, projectName, {
    files: pipelineResult.totalFileCount,
    nodes: stats.nodes,
    edges: stats.edges,
    communities: pipelineResult.communityResult?.stats.totalCommunities,
    clusters: aggregatedClusterCount,
    processes: pipelineResult.processResult?.stats.totalProcesses,
  }, generatedSkills);

  await closeLbug();
  // Note: we intentionally do NOT call disposeEmbedder() here.
  // ONNX Runtime's native cleanup segfaults on macOS and some Linux configs.
  // Since the process exits immediately after, Node.js reclaims everything.

  const totalTime = ((Date.now() - t0Global) / 1000).toFixed(1);

  clearInterval(elapsedTimer);
  process.removeListener('SIGINT', sigintHandler);

  console.log = origLog;
  console.warn = origWarn;
  console.error = origError;

  bar.update(100, { phase: 'Done' });
  bar.stop();

  // ── Summary ───────────────────────────────────────────────────────
  const embeddingsCached = cachedEmbeddings.length > 0;
  console.log(`\n  Repository indexed successfully (${totalTime}s)${embeddingsCached ? ` [${cachedEmbeddings.length} embeddings cached]` : ''}\n`);
  console.log(`  ${stats.nodes.toLocaleString()} nodes | ${stats.edges.toLocaleString()} edges | ${pipelineResult.communityResult?.stats.totalCommunities || 0} clusters | ${pipelineResult.processResult?.stats.totalProcesses || 0} flows`);
  console.log(`  LadybugDB ${lbugTime}s | FTS ${ftsTime}s | Embeddings ${embeddingSkipped ? embeddingSkipReason : embeddingTime + 's'}`);
  console.log(`  ${repoPath}`);

  if (aiContext.files.length > 0) {
    console.log(`  Context: ${aiContext.files.join(', ')}`);
  }

  // Show a quiet summary if some edge types needed fallback insertion
  if (lbugWarnings.length > 0) {
    const totalFallback = lbugWarnings.reduce((sum, w) => {
      const m = w.match(/\((\d+) edges\)/);
      return sum + (m ? parseInt(m[1]) : 0);
    }, 0);
    console.log(`  Note: ${totalFallback} edges across ${lbugWarnings.length} types inserted via fallback (schema will be updated in next release)`);
  }

  try {
    await fs.access(getGlobalRegistryPath());
  } catch {
    console.log('\n  Tip: Run `gitnexus setup` to configure MCP for your editor.');
  }

  console.log('');

  // LadybugDB's native module holds open handles that prevent Node from exiting.
  // ONNX Runtime also registers native atexit hooks that segfault on some
  // platforms (#38, #40). Force-exit to ensure clean termination.
  process.exit(0);
};
