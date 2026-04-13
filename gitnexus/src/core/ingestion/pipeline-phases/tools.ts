/**
 * Phase: tools
 *
 * Detects MCP/RPC tool definitions and creates Tool graph nodes.
 *
 * @deps    parse
 * @reads   allToolDefs (from parse), allPaths
 * @writes  graph (Tool nodes, HANDLES_TOOL edges)
 * @output  toolDefs array
 */

import type { PipelinePhase, PipelineContext, PhaseResult } from './types.js';
import { getPhaseOutput } from './types.js';
import type { ParseOutput } from './parse.js';
import { generateId } from '../../../lib/utils.js';
import { readFileContents } from '../filesystem-walker.js';
import { isDev } from '../utils/env.js';

export interface ToolDef {
  name: string;
  filePath: string;
  description: string;
}

export interface ToolsOutput {
  toolDefs: ToolDef[];
}

export const toolsPhase: PipelinePhase<ToolsOutput> = {
  name: 'tools',
  deps: ['parse'],

  async execute(
    ctx: PipelineContext,
    deps: ReadonlyMap<string, PhaseResult<unknown>>,
  ): Promise<ToolsOutput> {
    const { allToolDefs, allPaths } = getPhaseOutput<ParseOutput>(deps, 'parse');

    const toolDefs: ToolDef[] = [];
    const seenToolNames = new Set<string>();

    for (const td of allToolDefs) {
      if (seenToolNames.has(td.toolName)) continue;
      seenToolNames.add(td.toolName);
      toolDefs.push({ name: td.toolName, filePath: td.filePath, description: td.description });
    }

    // TS tool definition arrays — require inputSchema nearby
    const toolCandidatePaths = allPaths.filter(
      (p) =>
        (p.endsWith('.ts') || p.endsWith('.js')) &&
        p.toLowerCase().includes('tool') &&
        !p.includes('node_modules') &&
        !p.includes('test') &&
        !p.includes('__'),
    );
    if (toolCandidatePaths.length > 0) {
      const toolContents = await readFileContents(ctx.repoPath, toolCandidatePaths);
      for (const [filePath, content] of toolContents) {
        if (!content.includes('inputSchema')) continue;
        const toolPattern =
          /name:\s*['"](\w+)['"]\s*,\s*\n?\s*description:\s*[`'"]([\s\S]*?)[`'"]/g;
        let match;
        while ((match = toolPattern.exec(content)) !== null) {
          const name = match[1];
          if (seenToolNames.has(name)) continue;
          seenToolNames.add(name);
          toolDefs.push({
            name,
            filePath,
            description: match[2].slice(0, 200).replace(/\n/g, ' ').trim(),
          });
        }
      }
    }

    // Create Tool nodes and HANDLES_TOOL edges
    if (toolDefs.length > 0) {
      for (const td of toolDefs) {
        const toolNodeId = generateId('Tool', td.name);
        ctx.graph.addNode({
          id: toolNodeId,
          label: 'Tool',
          properties: { name: td.name, filePath: td.filePath, description: td.description },
        });

        const handlerFileId = generateId('File', td.filePath);
        ctx.graph.addRelationship({
          id: generateId('HANDLES_TOOL', `${handlerFileId}->${toolNodeId}`),
          sourceId: handlerFileId,
          targetId: toolNodeId,
          type: 'HANDLES_TOOL',
          confidence: 1.0,
          reason: 'tool-definition',
        });
      }

      if (isDev) {
        console.log(`🔧 Tool registry: ${toolDefs.length} tools detected`);
      }
    }

    return { toolDefs };
  },
};
