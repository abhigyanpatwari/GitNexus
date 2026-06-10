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
import { getCurrentCommit, getGitRoot, hasGitDir } from '../storage/git.js';
import { SCHEMA_VERSION } from '../core/lbug/schema.js';
// (#108) generateAIContextFiles is no longer called from analyze. It still
// runs from `gitnexus setup` (always) and from `gitnexus analyze --skills`
// (one-shot convenience for the skills-e2e flow). The plain `analyze` path
// never writes AGENTS.md / CLAUDE.md — see the comment in analyzeCommand below.
import { scaffoldAIContextForIndexedRepos } from './scaffold.js';
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
  /** Index the folder even when no .git directory is present. */
  skipGit?: boolean;
  /**
   * WI-5 (#159 P3 Mode A): when true, run the pipeline with the
   * LSP reconciler enabled (CALLS-only, TS-only, confidence 0.70).
   * The default `analyze` (no flag) is byte-identical — no server
   * is started, no edges are mutated.
   */
  lsp?: boolean;
  /**
   * WI-5 (#159 P3 Mode A): when true, print every
   * `{action, from→to, why}` tuple the reconciler would emit and
   * write nothing. Implies `lsp: true`; the engine sees every
   * decision but never mutates the graph.
   */
  lspDryRun?: boolean;
}

/** Threshold: auto-skip embeddings for repos with more nodes than this */
const EMBEDDING_NODE_LIMIT = 50_000;

/**
 * (#109) Decide whether existing embeddings should be auto-preserved into
 * the rebuilt index. Returns true when:
 *   - an existing index is present
 *   - that index had at least one embedding
 *   - the user did NOT pass --force (which is an explicit data-loss signal)
 *
 * `options.embeddings` does NOT affect this — auto-preserve runs even when
 * the user is not requesting a fresh embedding pass. That is the whole
 * point: silently dropping the slowest, most expensive artifact in the
 * index on every re-index is the bug we are closing.
 */
export function shouldPreserveExistingEmbeddings(
  existingMeta: { stats?: { embeddings?: number } } | null | undefined,
  options: { force?: boolean; embeddings?: boolean } | undefined,
): boolean {
  const count = existingMeta?.stats?.embeddings ?? 0;
  return !!(existingMeta && count > 0 && !options?.force);
}

/**
 * (#109) Total decision: should the cache loader run? Either the user
 * explicitly asked for a fresh embedding pass, OR we are auto-preserving
 * the existing ones.
 */
export function shouldCacheEmbeddings(
  existingMeta: { stats?: { embeddings?: number } } | null | undefined,
  options: { force?: boolean; embeddings?: boolean } | undefined,
): boolean {
  return shouldPreserveExistingEmbeddings(existingMeta, options) || !!options?.embeddings;
}

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
      if (!options?.skipGit) {
        console.log('  Not inside a git repository.\n  Tip: pass --skip-git to index any folder without a .git directory.\n');
        process.exitCode = 1;
        return;
      }
      // --skip-git: fall back to cwd as the root
      repoPath = path.resolve(process.cwd());
    } else {
      repoPath = gitRoot;
    }
  }

  const repoHasGit = hasGitDir(repoPath);
  if (!repoHasGit && !options?.skipGit) {
    console.log('  Not a git repository.\n  Tip: pass --skip-git to index any folder without a .git directory.\n');
    process.exitCode = 1;
    return;
  }
  if (!repoHasGit) {
    console.log('  Warning: no .git directory found \u2014 commit-tracking and incremental updates disabled.\n');
  }

  const { storagePath, lbugPath } = getStoragePaths(repoPath);

  // Clean up stale KuzuDB files from before the LadybugDB migration.
  // If kuzu existed but lbug doesn't, we're doing a migration re-index — say so.
  const kuzuResult = await cleanupOldKuzuFiles(storagePath);
  if (kuzuResult.found && kuzuResult.needsReindex) {
    console.log('  Migrating from KuzuDB to LadybugDB — rebuilding index...\n');
  }

  const currentCommit = repoHasGit ? getCurrentCommit(repoPath) : '';
  const existingMeta = await loadMeta(storagePath);

  if (existingMeta && !options?.force && !options?.skills && existingMeta.lastCommit === currentCommit) {
    // Non-git folders have currentCommit = '' — always rebuild since we can't detect changes
    if (currentCommit !== '') {
      console.log('  Already up to date\n');
      return;
    }
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

  // (#109) Auto-preserve existing embeddings unless --force. Without this,
  // every `gitnexus analyze` (incl. the post-commit hook) silently drops
  // them when --embeddings is omitted, even though they are the slowest
  // and most expensive artifact in the index. With this, "off by default"
  // still means off for *new* embedding generation — we just carry the
  // existing ones over to the rebuilt index.
  const existingEmbeddingCount = existingMeta?.stats?.embeddings ?? 0;
  const preserveExistingEmbeddings = shouldPreserveExistingEmbeddings(existingMeta, options);
  const shouldCache = shouldCacheEmbeddings(existingMeta, options);

  if (options?.force && existingEmbeddingCount > 0) {
    // Loud warning — user explicitly opted into data loss.
    bar.stop();
    console.log(
      `\n  ⚠️  --force will drop ${existingEmbeddingCount.toLocaleString()} existing embedding${existingEmbeddingCount === 1 ? '' : 's'}. ` +
        `Pass --embeddings to regenerate, or omit --force to preserve.\n`,
    );
    bar.start(100, 0, { phase: 'Initializing...' });
  }

  if (shouldCache) {
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
  // WI-5 (#159 P3 Mode A): thread `lsp` + `lspDryRun` through to
  // `PipelineOptions.lsp`. The pipeline runs the reconciler over
  // the heuristic CALLS feed ONLY when `options.lsp.enabled` is
  // true; the default `analyze` (no flag) takes the byte-identical
  // path. The pipeline prints the dry-run report or the summary
  // line itself (single source of truth).
  const pipelineResult = await runPipelineFromRepo(repoPath, (progress) => {
    const phaseLabel = PHASE_LABELS[progress.phase] || progress.phase;
    const scaled = Math.round(progress.percent * 0.6);
    updateBar(scaled, phaseLabel);
  }, {
    lsp: {
      enabled: options?.lsp === true || options?.lspDryRun === true,
      dryRun: options?.lspDryRun === true,
    },
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
    // Check if cached embedding dimensions match current schema
    const cachedDims = cachedEmbeddings[0].embedding.length;
    const { getEmbeddingDims } = await import('../core/lbug/schema.js');
    if (cachedDims !== getEmbeddingDims()) {
      // Dimensions changed (e.g. switched embedding model) — discard cache and re-embed all
      console.error(`⚠️  Embedding dimensions changed (${cachedDims}d → ${getEmbeddingDims()}d), discarding cache`);
      cachedEmbeddings = [];
      cachedEmbeddingNodeIds = new Set();
    } else {
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
  }

  // ── Phase 4: Embeddings (90–98%) ──────────────────────────────────
  const stats = await getLbugStats();
  let embeddingTime = '0.0';
  let embeddingSkipped = true;
  // (#109) If existing embeddings were auto-preserved, the "off" framing is
  // misleading — surface a label that distinguishes "no new generation" from
  // "no embeddings at all". The cached count is reported by the summary line.
  let embeddingSkipReason = preserveExistingEmbeddings
    ? 'off (existing embeddings preserved)'
    : 'off (use --embeddings to enable)';

  if (options?.embeddings) {
    if (stats.nodes > EMBEDDING_NODE_LIMIT) {
      embeddingSkipReason = `skipped (${stats.nodes.toLocaleString()} nodes > ${EMBEDDING_NODE_LIMIT.toLocaleString()} limit)`;
    } else {
      embeddingSkipped = false;
    }
  }

  if (!embeddingSkipped) {
    const { isHttpMode } = await import('../core/embeddings/http-client.js');
    const httpMode = isHttpMode();
    updateBar(90, httpMode ? 'Connecting to embedding endpoint...' : 'Loading embedding model...');
    const t0Emb = Date.now();
    const { runEmbeddingPipeline } = await import('../core/embeddings/embedding-pipeline.js');
    await runEmbeddingPipeline(
      executeQuery,
      executeWithReusedStatement,
      (progress) => {
        const scaled = 90 + Math.round((progress.percent / 100) * 8);
        const label = progress.phase === 'loading-model'
          ? (httpMode ? 'Connecting to embedding endpoint...' : 'Loading embedding model...')
          : `Embedding ${progress.nodesProcessed || 0}/${progress.totalNodes || '?'}`;
        updateBar(scaled, label);
      },
      {},
      cachedEmbeddingNodeIds.size > 0 ? cachedEmbeddingNodeIds : undefined,
    );
    embeddingTime = ((Date.now() - t0Emb) / 1000).toFixed(1);
  }

  // ── Phase 5: Finalize (98–100%) ───────────────────────────────────
  updateBar(98, 'Saving metadata...');

  // Bail before writing the registry if the pipeline produced no files (#48).
  // Otherwise a --skip-git run on an empty dir creates a 0-node entry that
  // pollutes `gitnexus list` and triggers "Multiple repositories indexed"
  // for subsequent calls. Use the same exit-code-via-processExitCode pattern
  // the early-return path uses, so scripts can detect the failure.
  if (pipelineResult.totalFileCount === 0) {
    bar.stop();
    console.log(`\n  No source files found in ${repoPath}. Aborting — nothing to index.\n`);
    console.log('  Tip: pass a path with source files, or remove --skip-git to let GitNexus locate the repo root.\n');
    process.exitCode = 1;
    return;
  }

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
    schemaVersion: SCHEMA_VERSION,
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
  // Only attempt to update .gitignore when a .git directory is present.
  // Use hasGitDir (filesystem check) rather than git CLI subprocess
  // so we skip correctly for --skip-git folders even if git CLI is available.
  // The mutation is idempotent: see addToGitignore in repo-manager.ts (#108).
  if (hasGitDir(repoPath)) {
    await addToGitignore(repoPath);
  }

  // (#108) Do NOT call `generateAIContextFiles` here. Writing CLAUDE.md /
  // AGENTS.md on every analyze mutates tracked files with volatile stats
  // (symbol/edge/process counts) on every commit — the PostToolUse hook fires
  // after every commit, so this would churn `git status` and the
  // ${stats.nodes} symbols, ${stats.edges} relationships header would be
  // a moving target. AI-context generation is initial-scaffolding work and
  // belongs in `gitnexus setup` instead. The current authoritative counts
  // always live in `.gitnexus/meta.json` (gitignored) — point tools there.
  // We keep `aiContext.files` as a stub so the downstream summary printer
  // continues to compile and reports nothing for analyze-driven runs.
  //
  // Exception: `--skills` is a one-shot convenience flag (used by the
  // skills-e2e tests and by users who want analyze to also bootstrap the
  // AGENTS.md / CLAUDE.md / .claude/skills/generated/ tree in a single
  // command). It explicitly opts in to the same scaffolding that setup
  // runs, so the volatile counts land in the meta.json we just wrote.
  const aiContext = { files: [] as string[] };
  if (options?.skills) {
    const projectName = path.basename(repoPath);
    let generatedSkills: GeneratedSkillInfo[] = [];
    if (pipelineResult.communityResult) {
      updateBar(99, 'Generating skill files...');
      try {
        const skillResult = await generateSkillFiles(repoPath, projectName, pipelineResult);
        generatedSkills = skillResult.skills;
      } catch (err: any) {
        console.log(`  Note: --skills generation failed: ${err.message}`);
      }
    }
    const skillsByRepo = new Map<string, GeneratedSkillInfo[]>();
    skillsByRepo.set(repoPath, generatedSkills);
    const summary = await scaffoldAIContextForIndexedRepos(repoPath, skillsByRepo);
    for (const name of summary.configured) {
      aiContext.files.push(`AI context (${name} → AGENTS.md, CLAUDE.md)`);
    }
    if (summary.errors.length > 0) {
      console.log(`  Note: --skills scaffolding reported ${summary.errors.length} error(s):`);
      for (const err of summary.errors) console.log(`    ! ${err}`);
    }
  }

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
  // (#109) Distinguish "auto-preserved from a prior index" from "carried
  // through a --embeddings rebuild" in the user-visible summary.
  const embeddingsCached = cachedEmbeddings.length > 0;
  const cachedLabel = preserveExistingEmbeddings && !options?.embeddings
    ? 'preserved'
    : 'cached';
  console.log(`\n  Repository indexed successfully (${totalTime}s)${embeddingsCached ? ` [${cachedEmbeddings.length} embeddings ${cachedLabel}]` : ''}\n`);
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
