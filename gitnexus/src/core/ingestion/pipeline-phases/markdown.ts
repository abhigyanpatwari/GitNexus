/**
 * Phase: markdown
 *
 * Processes Markdown/MDX files to extract headings and cross-links.
 *
 * @deps    structure
 * @reads   scannedFiles, allPaths (from structure phase)
 * @writes  graph (Markdown section nodes + cross-link edges)
 */

import type { PipelinePhase, PipelineContext, PhaseResult } from './types.js';
import { getPhaseOutput } from './types.js';
import { processMarkdown } from '../markdown-processor.js';
import { readFileContents } from '../filesystem-walker.js';
import type { StructureOutput } from './structure.js';
import { isDev } from '../utils/env.js';

export interface MarkdownOutput {
  /** Number of markdown sections extracted. */
  sections: number;
  /** Number of cross-links created. */
  links: number;
}

export const markdownPhase: PipelinePhase<MarkdownOutput> = {
  name: 'markdown',
  deps: ['structure'],

  async execute(
    ctx: PipelineContext,
    deps: ReadonlyMap<string, PhaseResult<unknown>>,
  ): Promise<MarkdownOutput> {
    const { scannedFiles, allPathSet } = getPhaseOutput<StructureOutput>(deps, 'structure');

    const mdScanned = scannedFiles.filter((f) => f.path.endsWith('.md') || f.path.endsWith('.mdx'));

    if (mdScanned.length === 0) {
      return { sections: 0, links: 0 };
    }

    const mdContents = await readFileContents(
      ctx.repoPath,
      mdScanned.map((f) => f.path),
    );
    const mdFiles = mdScanned
      .filter((f) => mdContents.has(f.path))
      .map((f) => ({ path: f.path, content: mdContents.get(f.path)! }));
    const mdResult = processMarkdown(ctx.graph, mdFiles, allPathSet);

    if (isDev) {
      console.log(
        `  Markdown: ${mdResult.sections} sections, ${mdResult.links} cross-links from ${mdFiles.length} files`,
      );
    }

    return { sections: mdResult.sections, links: mdResult.links };
  },
};
