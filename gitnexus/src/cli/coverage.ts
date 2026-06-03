import type { Command } from 'commander';
import path from 'path';
import fs from 'fs/promises';
import { cliError } from './cli-message.js';
import { createKnowledgeGraph } from '../core/graph/graph.js';
import type { KnowledgeGraph } from '../core/graph/types.js';

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

function detectFormat(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.lcov' || ext === '.info') return 'lcov';
  if (ext === '.cov' || ext === '.coverprofile') return 'go';
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
    .description('Import a coverage file (lcov, go coverprofile, or generic JSON)')
    .option('--format <format>', 'Coverage format: lcov, go, or generic (auto-detected if omitted)')
    .option('--label <label>', 'Human-readable label for the run')
    .option('--command <command>', 'Test command that produced this coverage')
    .action(async (fileArg: string | undefined, opts: Record<string, string>) => {
      try {
        const repoPath = await getRepoPath();
        const { openCoverageStore, ingestCoverage, parseLcov, parseGoCover, parseGenericCoverage } =
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
          // Create an empty in-memory graph for symbol mapping.
          // Full graph sync to LadybugDB is a TODO — for now, only the
          // SQLite store receives coverage data.  Symbol-level coverage
          // mapping depends on a loaded graph and will be addressed when
          // graph persistence is wired.
          const graph: KnowledgeGraph = createKnowledgeGraph();

          // TODO: graph persistence — load the graph from LadybugDB before
          // ingesting so that symbol-coverage, edge-traversal, and
          // graph-bridge writes actually reach the knowledge graph.
          // Currently the graph starts empty, so line-to-symbol mapping
          // produces no results, but line hits and run metadata are still
          // written to the SQLite store.

          const ingestedId = ingestCoverage(canonical, { store, graph });
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
            const label = run.label || run.id;
            const ratio = formatPercent(run.coverageRatio);
            const ts = run.timestamp
              ? new Date(run.timestamp).toLocaleString()
              : 'unknown date';
            console.log(
              `  ${label.padEnd(30)} ${ratio.padEnd(8)} ${run.coveredLines}/${run.totalLines} lines  ${ts}`,
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

          // TODO: graph persistence — mergeRuns calls ingestCoverage which
          // needs a loaded KnowledgeGraph for symbol mapping.  Currently a
          // fresh empty graph is used, so only line hits are merged.
          const graph: KnowledgeGraph = createKnowledgeGraph();
          const resultId = mergeRuns(runIds, store, { store, graph }, mergedMeta);

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

        const store = openCoverageStore(repoPath);
        try {
          if (opts.all) {
            const runs = store.listRuns();
            if (runs.length === 0) {
              console.log('No coverage runs to remove.');
              return;
            }
            store.deleteAllRuns();
            console.log(`Removed ${runs.length} coverage run(s).`);
            // TODO: graph persistence — remove all CoverageRun nodes and
            // COVERED_BY edges from the LadybugDB knowledge graph.
          } else {
            const run = store.getRun(runId);
            if (!run) {
              cliError(`Run not found: ${runId}`);
              process.exitCode = 1;
              return;
            }
            store.deleteRun(runId);
            console.log(`Removed coverage run: ${run.label || runId}`);
            // TODO: graph persistence — remove the CoverageRun node and
            // its COVERED_BY edges from the LadybugDB knowledge graph.
            // Use removeCoverageFromGraph(runId, graph) after loading the
            // graph from LadybugDB.
          }
        } finally {
          store.close();
        }
      } catch (err: unknown) {
        cliError((err as Error).message);
        process.exitCode = 1;
      }
    });
}
