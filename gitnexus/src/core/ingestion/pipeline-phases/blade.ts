/**
 * Phase: blade
 *
 * Links Laravel Blade views to the views they extend, include, or render as
 * components. Blade stays template-only: files are read as text and never
 * enter PHP provider paths (see #1790).
 *
 * @deps    structure
 * @reads   scannedFiles, allPathSet (from structure phase)
 * @writes  graph (IMPORTS edges between Blade File nodes)
 */

import { isBladeTemplateFilename } from 'gitnexus-shared';
import type { PipelinePhase, PipelineContext, PhaseResult } from './types.js';
import { getPhaseOutput } from './types.js';
import { processBlade } from '../blade-processor.js';
import { readFileContents } from '../filesystem-walker.js';
import type { StructureOutput } from './structure.js';
import { isDev } from '../utils/env.js';

import { logger } from '../../logger.js';
export interface BladeOutput {
  /** Number of view-to-view links created. */
  links: number;
}

export const bladePhase: PipelinePhase<BladeOutput> = {
  name: 'blade',
  deps: ['structure'],

  async execute(
    ctx: PipelineContext,
    deps: ReadonlyMap<string, PhaseResult<unknown>>,
  ): Promise<BladeOutput> {
    const { scannedFiles, allPathSet } = getPhaseOutput<StructureOutput>(deps, 'structure');

    const bladePaths = scannedFiles.map((f) => f.path).filter((p) => isBladeTemplateFilename(p));
    if (bladePaths.length === 0) return { links: 0 };

    const contents = await readFileContents(ctx.repoPath, bladePaths);
    const files = [...contents].map(([path, content]) => ({ path, content }));
    const result = processBlade(ctx.graph, files, allPathSet);

    if (isDev) {
      logger.info(`  Blade: ${result.links} view links from ${files.length} templates`);
    }

    return result;
  },
};
