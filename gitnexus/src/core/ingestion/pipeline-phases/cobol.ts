/**
 * Phase: cobol
 *
 * Processes COBOL and JCL files via regex extraction (no tree-sitter).
 *
 * @deps    structure
 * @reads   scannedFiles, allPaths (from structure phase)
 * @writes  graph (COBOL program/paragraph/section nodes, JCL job/step nodes)
 */

import type { PipelinePhase, PipelineContext, PhaseResult } from './types.js';
import { getPhaseOutput } from './types.js';
import { processCobol, isCobolFile, isJclFile } from '../cobol-processor.js';
import { readFileContents } from '../filesystem-walker.js';
import type { StructureOutput } from './structure.js';
import { isDev } from '../utils/env.js';

export interface CobolOutput {
  programs: number;
  paragraphs: number;
  sections: number;
}

export const cobolPhase: PipelinePhase<CobolOutput> = {
  name: 'cobol',
  deps: ['structure'],

  async execute(
    ctx: PipelineContext,
    deps: ReadonlyMap<string, PhaseResult<unknown>>,
  ): Promise<CobolOutput> {
    const { scannedFiles, allPathSet } = getPhaseOutput<StructureOutput>(deps, 'structure');

    const cobolScanned = scannedFiles.filter((f) => isCobolFile(f.path) || isJclFile(f.path));

    if (cobolScanned.length === 0) {
      return { programs: 0, paragraphs: 0, sections: 0 };
    }

    const cobolContents = await readFileContents(
      ctx.repoPath,
      cobolScanned.map((f) => f.path),
    );
    const cobolFiles = cobolScanned
      .filter((f) => cobolContents.has(f.path))
      .map((f) => ({ path: f.path, content: cobolContents.get(f.path)! }));
    const cobolResult = processCobol(ctx.graph, cobolFiles, allPathSet);

    if (isDev) {
      console.log(
        `  COBOL: ${cobolResult.programs} programs, ${cobolResult.paragraphs} paragraphs, ${cobolResult.sections} sections from ${cobolFiles.length} files`,
      );
      if (
        cobolResult.execSqlBlocks > 0 ||
        cobolResult.execCicsBlocks > 0 ||
        cobolResult.entryPoints > 0
      ) {
        console.log(
          `  COBOL enriched: ${cobolResult.execSqlBlocks} SQL blocks, ${cobolResult.execCicsBlocks} CICS blocks, ${cobolResult.entryPoints} entry points, ${cobolResult.moves} moves, ${cobolResult.fileDeclarations} file declarations`,
        );
      }
      if (cobolResult.jclJobs > 0) {
        console.log(`  JCL: ${cobolResult.jclJobs} jobs, ${cobolResult.jclSteps} steps`);
      }
    }

    return {
      programs: cobolResult.programs,
      paragraphs: cobolResult.paragraphs,
      sections: cobolResult.sections,
    };
  },
};
