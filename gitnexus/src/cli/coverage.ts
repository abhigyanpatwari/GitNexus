import type { Command } from 'commander';
import path from 'path';
import fs from 'fs/promises';
import { cliError, cliInfoKey } from './cli-message.js';
import { createKnowledgeGraph } from '../core/graph/graph.js';
import type { KnowledgeGraph } from '../core/graph/types.js';
import { loadKnowledgeGraph, saveKnowledgeGraph, removeCoverageFromLbug } from '../core/lbug/lbug-adapter.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function getRepoPath(): Promise<string> {
  const { isGitRepo, getGitRoot } = await import('../storage/git.js');
  const cwd = process.cwd();
  const isGit = await isGitRepo(cwd);
  if (!isGit) {
    throw new Error(
      'Not in a git repository. Run "gitnexus coverage" from an indexed repo.',
    );
  }
  const root = await getGitRoot(cwd);
  if (!root) {
    throw new Error('Unable to determine git repository root.');
  }
  return root;
}

function getLbugPath(repoPath: string): string {
  return path.join(repoPath, '.gitnexus', 'lbug');
}

/**
 * Load the KnowledgeGraph from LadybugDB, falling back to an empty graph
 * when the index is not available (e.g. `gitnexus analyze` has not been run).
 */
async function tryLoadGraph(lbugPath: string): Promise<KnowledgeGraph> {
  try {
    return await loadKnowledgeGraph(lbugPath);
  } catch {
    console.warn(
      'Warning: knowledge graph not available. Run "gitnexus analyze" first for symbol-level coverage.',
    );
    return createKnowledgeGraph();
  }
}

/**
 * Persist coverage changes to LadybugDB, swallowing errors so coverage
 * data in SQLite is still usable even when graph sync fails.
 */
async function trySaveGraph(graph: KnowledgeGraph, lbugPath: string): Promise<void> {
  try {
    await saveKnowledgeGraph(graph, lbugPath);
  } catch (err) {
    console.warn(
      `Warning: could not save coverage to knowledge graph: ${(err as Error).message}`,
    );
  }
}

function detectFormat(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  const base = path.basename(filePath).toLowerCase();
  if (ext === '.lcov' || ext === '.info') return 'lcov';
  if (ext === '.cov' || ext === '.coverprofile') return 'go';
  if (ext === '.xml' || base.includes('cobertura') || base.includes('jacoco')) return 'cobertura';
  return 'generic';
}

function formatPercent(ratio: number): string {
  return `${(ratio * 100).toFixed(1)}%`;
}

// ---------------------------------------------------------------------------
// Command registration
// ---------------------------------------------------------------------------

export function registerCoverageCommands(program: Command): void {
  const coverage = program
    .command('coverage')
    .description('Manage coverage data for indexed repositories');

  // ── import ───────────────────────────────────────────────────────────
  coverage
    .command('import [file]')
    .description('Import a coverage file (lcov, go coverprofile, cobertura XML, or generic JSON)')
    .option('--format <format>', 'Coverage format: lcov, go, cobertura, or generic (auto-detected if omitted)')
    .option('--label <label>', 'Human-readable label for the run')
    .option('--command <command>', 'Test command that produced this coverage')
    .action(async (fileArg: string | undefined, opts: Record<string, string>) => {
      try {
        const repoPath = await getRepoPath();
        const { openCoverageStore, ingestCoverage, parseLcov, parseGoCover, parseGenericCoverage, parseCobertura } =
          await import('../core/coverage/index.js');

        // Resolve input file
        const inputFile = fileArg
          ? path.resolve(fileArg)
          : path.join(repoPath, 'coverage', 'lcov.info');
        const format = opts.format || detectFormat(inputFile);

        // Read input
        let raw: string;
        try {
          raw = await fs.readFile(inputFile, 'utf-8');
        } catch (err: unknown) {
          const code = (err as NodeJS.ErrnoException)?.code;
          if (code === 'ENOENT') {
            throw new Error(`Coverage file not found: ${inputFile}`);
          }
          throw err;
        }

        // Parse
        const now = new Date().toISOString();
        const runId = `run-${Date.now()}`;

        let canonical: import('../core/coverage/types.js').CanonicalCoverage;
        if (format === 'lcov') {
          canonical = parseLcov(raw, {
            id: runId,
            timestamp: now,
            label: opts.label,
            command: opts.command,
          });
        } else if (format === 'go') {
          canonical = parseGoCover(raw, {
            id: runId,
            timestamp: now,
            label: opts.label,
            command: opts.command,
          });
        } else if (format === 'cobertura') {
          canonical = parseCobertura(raw, {
            id: runId,
            timestamp: now,
            label: opts.label,
            command: opts.command,
          });
        } else {
          canonical = parseGenericCoverage(raw);
          // Override run meta with CLI flags if provided
          canonical.run.id = runId;
          canonical.run.timestamp = now;
          if (opts.label) canonical.run.label = opts.label;
          if (opts.command) canonical.run.command = opts.command;
        }

        // Ingest into CoverageStore (SQLite)
        const store = openCoverageStore(repoPath);
        try {
          // Load the knowledge graph from LadybugDB for symbol-level
          // coverage mapping.  Falls back to an empty graph when the repo
          // has not been indexed yet (line hits are still recorded).
          const lbugPath = getLbugPath(repoPath);
          const graph = await tryLoadGraph(lbugPath);

          const ingestedId = ingestCoverage(canonical, { store, graph });

          // Persist coverage changes back to LadybugDB so MCP tools
          // (coverage_status, coverage_diff) can query symbol coverage.
          await trySaveGraph(graph, lbugPath);

          console.log(`Coverage imported: run "${ingestedId}"`);
          console.log(
            `  ${canonical.run.coveredLines ?? 0} / ${canonical.run.totalLines ?? 0} lines covered ` +
              `(${formatPercent(canonical.run.coveredLines && canonical.run.totalLines ? canonical.run.coveredLines / canonical.run.totalLines : 0)})`,
          );
        } finally {
          store.close();
        }
      } catch (err: unknown) {
        cliError((err as Error).message);
        process.exitCode = 1;
      }
    });

  // ── list ─────────────────────────────────────────────────────────────
  coverage
    .command('list')
    .description('List all imported coverage runs')
    .action(async () => {
      try {
        const repoPath = await getRepoPath();
        const { openCoverageStore } = await import('../core/coverage/index.js');

        const store = openCoverageStore(repoPath);
        try {
          const runs = store.listRuns();
          if (runs.length === 0) {
            console.log('No coverage runs. Import one with: gitnexus coverage import <file>');
            return;
          }

          console.log(`Coverage runs (${runs.length}):\n`);
          for (const run of runs) {
            const ratio = formatPercent(run.coverageRatio);
            const ts = run.timestamp
              ? new Date(run.timestamp).toLocaleString()
              : 'unknown date';
            console.log(
              `  ${run.id.padEnd(28)} ${(run.label || '').padEnd(20)} ${ratio.padEnd(8)} ${run.coveredLines}/${run.totalLines} lines  ${ts}`,
            );
          }
        } finally {
          store.close();
        }
      } catch (err: unknown) {
        cliError((err as Error).message);
        process.exitCode = 1;
      }
    });

  // ── show ─────────────────────────────────────────────────────────────
  coverage
    .command('show <runId>')
    .description('Show details for a specific coverage run')
    .option('--uncovered', 'Show only uncovered symbols')
    .action(async (runId: string, opts: { uncovered?: boolean }) => {
      try {
        const repoPath = await getRepoPath();
        const { openCoverageStore } = await import('../core/coverage/index.js');

        const store = openCoverageStore(repoPath);
        try {
          const run = store.getRun(runId);
          if (!run) {
            cliError(`Run not found: ${runId}`);
            process.exitCode = 1;
            return;
          }

          console.log(`Coverage run: ${run.label || run.id}`);
          console.log(`  ID:         ${run.id}`);
          console.log(`  Timestamp:  ${run.timestamp}`);
          if (run.command) console.log(`  Command:    ${run.command}`);
          console.log(`  Lines:      ${run.coveredLines} / ${run.totalLines} (${formatPercent(run.coverageRatio)})`);
          if (run.totalExecs != null) console.log(`  Executions: ${run.totalExecs}`);
          if (run.durationMs != null) console.log(`  Duration:   ${run.durationMs}ms`);

          if (opts.uncovered) {
            const uncovered = store.getUncoveredSymbols(runId, 20);
            if (uncovered.length === 0) {
              console.log('\n  All symbols fully covered.');
            } else {
              console.log(`\n  Top uncovered symbols (${Math.min(uncovered.length, 20)}):`);
              for (const s of uncovered) {
                const name = s.symbolName || s.nodeId;
                const ratio = formatPercent(s.coverageRatio);
                const loc = s.filePath ? `${s.filePath}:${s.startLine}` : 'unknown location';
                console.log(`    ${ratio.padEnd(8)} ${name.padEnd(40)} ${loc}`);
              }
            }
          }
        } finally {
          store.close();
        }
      } catch (err: unknown) {
        cliError((err as Error).message);
        process.exitCode = 1;
      }
    });

  // ── diff ─────────────────────────────────────────────────────────────
  coverage
    .command('diff <runId1> <runId2>')
    .description('Compare two coverage runs')
    .action(async (runId1: string, runId2: string) => {
      try {
        const repoPath = await getRepoPath();
        const { openCoverageStore } = await import('../core/coverage/index.js');

        const store = openCoverageStore(repoPath);
        try {
          const run1 = store.getRun(runId1);
          const run2 = store.getRun(runId2);

          if (!run1) {
            cliError(`Run not found: ${runId1}`);
            process.exitCode = 1;
            return;
          }
          if (!run2) {
            cliError(`Run not found: ${runId2}`);
            process.exitCode = 1;
            return;
          }

          const ratio1 = run1.coverageRatio;
          const ratio2 = run2.coverageRatio;
          const delta = ratio2 - ratio1;

          console.log(`Coverage diff: ${run1.label || run1.id} -> ${run2.label || run2.id}\n`);
          console.log(`  Before:  ${formatPercent(ratio1)} (${run1.coveredLines}/${run1.totalLines})`);
          console.log(`  After:   ${formatPercent(ratio2)} (${run2.coveredLines}/${run2.totalLines})`);
          console.log(
            `  Delta:   ${delta >= 0 ? '+' : ''}${(delta * 100).toFixed(1)}pp`,
          );

          // Compare symbol coverage (SQLite only)
          const syms1 = new Map<string, number>();
          for (const s of store.getSymbolCoverage(runId1)) {
            syms1.set(s.nodeId, s.coverageRatio);
          }
          const syms2 = new Map<string, number>();
          for (const s of store.getSymbolCoverage(runId2)) {
            syms2.set(s.nodeId, s.coverageRatio);
          }

          let improved = 0;
          let regressed = 0;
          let newSymbols = 0;
          let removedSymbols = 0;

          for (const [nodeId, ratio] of syms2) {
            if (!syms1.has(nodeId)) {
              newSymbols++;
              continue;
            }
            const oldRatio = syms1.get(nodeId)!;
            if (ratio > oldRatio) improved++;
            else if (ratio < oldRatio) regressed++;
          }
          for (const nodeId of syms1.keys()) {
            if (!syms2.has(nodeId)) removedSymbols++;
          }

          if (syms1.size > 0 || syms2.size > 0) {
            console.log(`\n  Symbol coverage changes:`);
            console.log(`    Improved:      ${improved}`);
            console.log(`    Regressed:     ${regressed}`);
            console.log(`    New symbols:   ${newSymbols}`);
            console.log(`    Removed:       ${removedSymbols}`);
          } else {
            console.log(`\n  No symbol-level coverage data available.`);
          }
        } finally {
          store.close();
        }
      } catch (err: unknown) {
        cliError((err as Error).message);
        process.exitCode = 1;
      }
    });

  // ── merge ─────────────────────────────────────────────────────────────
  coverage
    .command('merge <runIds...>')
    .description('Merge multiple coverage runs into one')
    .option('--label <label>', 'Label for the merged run')
    .action(async (runIds: string[], opts: { label?: string }) => {
      try {
        const repoPath = await getRepoPath();
        const { openCoverageStore, mergeRuns } = await import('../core/coverage/index.js');

        if (runIds.length < 2) {
          cliError('Provide at least 2 run IDs to merge.');
          process.exitCode = 1;
          return;
        }

        const store = openCoverageStore(repoPath);
        try {
          // Verify all runs exist
          for (const id of runIds) {
            if (!store.getRun(id)) {
              cliError(`Run not found: ${id}`);
              process.exitCode = 1;
              return;
            }
          }

          const now = new Date().toISOString();
          const mergedId = `merged-${Date.now()}`;
          const mergedMeta = {
            id: mergedId,
            timestamp: now,
            label: opts.label || `merged:${runIds.join(',')}`,
          };

          const lbugPath = getLbugPath(repoPath);
          const graph = await tryLoadGraph(lbugPath);
          const resultId = mergeRuns(runIds, store, { store, graph }, mergedMeta);
          await trySaveGraph(graph, lbugPath);

          console.log(`Merged ${runIds.length} runs into "${resultId}"`);
          const merged = store.getRun(resultId);
          if (merged) {
            console.log(
              `  ${merged.coveredLines} / ${merged.totalLines} lines covered ` +
                `(${formatPercent(merged.coverageRatio)})`,
            );
          }
        } finally {
          store.close();
        }
      } catch (err: unknown) {
        cliError((err as Error).message);
        process.exitCode = 1;
      }
    });

  // ── rm ────────────────────────────────────────────────────────────────
  coverage
    .command('rm <runId>')
    .description('Remove a coverage run')
    .option('--all', 'Remove all coverage runs')
    .action(async (runId: string, opts: { all?: boolean }) => {
      try {
        const repoPath = await getRepoPath();
        const { openCoverageStore } = await import('../core/coverage/index.js');

        const { removeCoverageFromGraph } = await import(
          '../core/coverage/graph-bridge.js'
        );

        const store = openCoverageStore(repoPath);
        try {
          if (opts.all) {
            const runs = store.listRuns();
            if (runs.length === 0) {
              console.log('No coverage runs to remove.');
              return;
            }

            // Load the knowledge graph and collect affected symbol node IDs
            // before removal so we can clear their coverage properties.
            const lbugPath = getLbugPath(repoPath);
            const graph = await tryLoadGraph(lbugPath);
            const affectedNodeIds: string[] = [];
            for (const node of graph.nodes) {
              if (node.properties.coverageRatio !== undefined) {
                affectedNodeIds.push(node.id);
              }
            }
            for (const run of runs) {
              removeCoverageFromGraph(run.id, graph);
            }
            try {
              await removeCoverageFromLbug(
                runs.map((r) => r.id),
                affectedNodeIds,
                lbugPath,
              );
            } catch (err) {
              console.warn(
                `Warning: could not remove coverage from knowledge graph: ${(err as Error).message}`,
              );
            }

            store.deleteAllRuns();
            console.log(`Removed ${runs.length} coverage run(s).`);
          } else {
            const run = store.getRun(runId);
            if (!run) {
              cliError(`Run not found: ${runId}`);
              process.exitCode = 1;
              return;
            }

            // Load the knowledge graph and collect affected symbol node IDs
            // before removal so we can clear their coverage properties.
            const lbugPath = getLbugPath(repoPath);
            const graph = await tryLoadGraph(lbugPath);
            const affectedNodeIds: string[] = [];
            for (const node of graph.nodes) {
              if (node.properties.coverageRatio !== undefined) {
                affectedNodeIds.push(node.id);
              }
            }
            removeCoverageFromGraph(runId, graph);
            try {
              await removeCoverageFromLbug([runId], affectedNodeIds, lbugPath);
            } catch (err) {
              console.warn(
                `Warning: could not remove coverage from knowledge graph: ${(err as Error).message}`,
              );
            }

            store.deleteRun(runId);
            console.log(`Removed coverage run: ${run.label || runId}`);
          }
        } finally {
          store.close();
        }
      } catch (err: unknown) {
        cliError((err as Error).message);
        process.exitCode = 1;
      }
    });

  // ── stream ──────────────────────────────────────────────────────────
  coverage
    .command('stream')
    .description('Stream coverage data from stdin (newline-delimited JSON, one entry per line)')
    .option('--label <label>', 'Human-readable label for the run')
    .option('--command <command>', 'Test command that produced this coverage')
    .option('--batch-size <size>', 'Number of lines to buffer before flushing', '1000')
    .option('--flush-interval <ms>', 'Maximum milliseconds between flushes', '100')
    .action(async (opts: Record<string, string>) => {
      try {
        const repoPath = await getRepoPath();
        const { openCoverageStore, streamIngest } =
          await import('../core/coverage/index.js');

        const lbugPath = getLbugPath(repoPath);
        const graph = await tryLoadGraph(lbugPath);
        const store = openCoverageStore(repoPath);

        try {
          const now = new Date().toISOString();
          const runId = `stream-${Date.now()}`;
          const meta = {
            id: runId,
            timestamp: now,
            label: opts.label,
            command: opts.command,
          };

          const batchSize = parseInt(opts.batchSize, 10) || 1000;
          const flushInterval = parseInt(opts.flushInterval, 10) || 100;

          const resultId = await streamIngest(
            process.stdin,
            { store, graph },
            meta,
            batchSize,
            flushInterval,
          );

          await trySaveGraph(graph, lbugPath);

          const run = store.getRun(resultId);
          const totalLines = run?.totalLines ?? 0;
          const coveredLines = run?.coveredLines ?? 0;
          const ratio = run?.coverageRatio ?? 0;

          console.log(`Stream complete: run "${resultId}"`);
          console.log(
            `  ${coveredLines} / ${totalLines} lines covered ` +
              `(${formatPercent(ratio)})`,
          );
        } finally {
          store.close();
        }
      } catch (err: unknown) {
        cliError((err as Error).message);
        process.exitCode = 1;
      }
    });
}
