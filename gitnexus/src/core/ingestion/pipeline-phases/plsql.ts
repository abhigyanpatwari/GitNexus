/**
 * Phase: plsql
 *
 * Processes Oracle PL/SQL files with the ANTLR4 PlSql grammar (no tree-sitter).
 * Dedicated extensions (.pks, .pkb, …) are always included; `.sql` files only
 * when their content holds an Oracle PL/SQL unit.
 *
 * @deps    structure
 * @reads   scannedFiles (from structure phase)
 * @writes  graph (package Module, subprogram/trigger Function, table Record
 *          nodes; CONTAINS / CALLS / ACCESSES edges)
 */

import type { PipelinePhase, PipelineContext, PhaseResult } from './types.js';
import { getPhaseOutput } from './types.js';
import { processPlSql, isPlSqlSource } from '../plsql-processor.js';
import { hasPlSqlExtension, isSqlFile } from '../plsql/file-types.js';
import { readFileContents } from '../filesystem-walker.js';
import type { StructureOutput } from './structure.js';
import { isDev } from '../utils/env.js';

import { logger } from '../../logger.js';

export interface PlSqlOutput {
  files: number;
  packages: number;
  subprograms: number;
}

export const plsqlPhase: PipelinePhase<PlSqlOutput> = {
  name: 'plsql',
  deps: ['structure'],

  async execute(
    ctx: PipelineContext,
    deps: ReadonlyMap<string, PhaseResult<unknown>>,
  ): Promise<PlSqlOutput> {
    const { scannedFiles, allPathSet } = getPhaseOutput<StructureOutput>(deps, 'structure');

    const candidates = scannedFiles.filter((f) => hasPlSqlExtension(f.path) || isSqlFile(f.path));
    if (candidates.length === 0) return { files: 0, packages: 0, subprograms: 0 };

    const contents = await readFileContents(
      ctx.repoPath,
      candidates.map((f) => f.path),
    );
    const files = candidates
      .filter((f) => contents.has(f.path) && isPlSqlSource(f.path, contents.get(f.path)!))
      .map((f) => ({ path: f.path, content: contents.get(f.path)! }));
    if (files.length === 0) return { files: 0, packages: 0, subprograms: 0 };

    const result = processPlSql(ctx.graph, files, allPathSet);

    if (isDev) {
      logger.info(
        `  PL/SQL: ${result.packages} packages, ${result.subprograms} subprograms, ${result.triggers} triggers, ${result.tables} tables from ${result.files} files`,
      );
      logger.info(
        `  PL/SQL edges: ${result.calls} calls (${result.ambiguousCalls} ambiguous, ${result.unresolvedCalls} unresolved), ${result.accesses} table accesses, ${result.dynamicSqlSites} dynamic SQL sites`,
      );
      if (result.segmentsWithErrors > 0) {
        logger.info(
          `  PL/SQL degraded: ${result.segmentsWithErrors} segments with syntax errors (${result.segmentsTimedOut} at the parse deadline), ${result.fallbackDefinitions} fallback definitions`,
        );
      }
    }

    return { files: result.files, packages: result.packages, subprograms: result.subprograms };
  },
};
