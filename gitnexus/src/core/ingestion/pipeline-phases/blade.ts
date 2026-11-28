/**
 * Phase: blade
 *
 * Links Laravel Blade views to the views they extend, include, or render as
 * components. Blade stays template-only: files are read as text and never
 * enter PHP provider paths (see #1790).
 *
 * Also links PHP code to the views it renders (`view('posts.show')`), from
 * the view-render call sites the parse phase recorded.
 *
 * @deps    structure, parse
 * @reads   scannedFiles, allPathSet (structure); allViewRenderCalls (parse)
 * @writes  graph (IMPORTS edges into Blade File nodes)
 */

import { isBladeTemplateFilename } from 'gitnexus-shared';
import type { PipelinePhase, PipelineContext, PhaseResult } from './types.js';
import { getPhaseOutput } from './types.js';
import { processBlade, processBladeViewRenders } from '../blade-processor.js';
import { readFileContents } from '../filesystem-walker.js';
import type { StructureOutput } from './structure.js';
import type { ParseOutput } from './parse.js';
import { isDev } from '../utils/env.js';

import { logger } from '../../logger.js';
export interface BladeOutput {
  /** Number of view-to-view links created. */
  links: number;
  /** Number of code-to-view links created. */
  renderLinks: number;
}

export const bladePhase: PipelinePhase<BladeOutput> = {
  name: 'blade',
  deps: ['structure', 'parse'],

  async execute(
    ctx: PipelineContext,
    deps: ReadonlyMap<string, PhaseResult<unknown>>,
  ): Promise<BladeOutput> {
    const { scannedFiles, allPathSet } = getPhaseOutput<StructureOutput>(deps, 'structure');

    const bladePaths = scannedFiles.map((f) => f.path).filter((p) => isBladeTemplateFilename(p));
    if (bladePaths.length === 0) return { links: 0, renderLinks: 0 };

    const contents = await readFileContents(ctx.repoPath, bladePaths);
    const files = [...contents].map(([path, content]) => ({ path, content }));
    const { links } = processBlade(ctx.graph, files, allPathSet);

    const { allViewRenderCalls } = getPhaseOutput<ParseOutput>(deps, 'parse');
    const { links: renderLinks } = processBladeViewRenders(
      ctx.graph,
      allViewRenderCalls,
      allPathSet,
    );

    if (isDev) {
      logger.info(
        `  Blade: ${links} view links from ${files.length} templates, ${renderLinks} render links`,
      );
    }

    return { links, renderLinks };
  },
};
