/**
 * Phase: anchors
 *
 * Adds deterministic semantic metadata to graph nodes. This is intentionally
 * heuristic and local-first: it gives agents useful purpose text immediately,
 * while later LLM enrichment can overwrite or extend these fields by hash.
 *
 * @deps    scopeResolution
 * @reads   graph (nodes and relationships)
 * @writes  graph node properties (summary, purpose, tags, description)
 */

import type { PipelinePhase, PipelineContext, PhaseResult } from './types.js';
import { applySemanticAnchors } from '../semantic-anchor.js';

export interface AnchorsOutput {
  anchoredNodes: number;
  llmEnrichedNodes?: number;
  llmCachedNodes?: number;
  llmFailedNodes?: number;
  llmSkippedReason?: string;
}

const resolveLLMAnchorLimit = (value: number | undefined): number | undefined => {
  if (value !== undefined) return value;
  const raw = process.env.GITNEXUS_LLM_ANCHOR_LIMIT;
  if (!raw) return 50;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) return 50;
  return Math.trunc(parsed);
};

export const anchorsPhase: PipelinePhase<AnchorsOutput> = {
  name: 'anchors',
  deps: ['scopeResolution'],

  async execute(
    ctx: PipelineContext,
    _deps: ReadonlyMap<string, PhaseResult<unknown>>,
  ): Promise<AnchorsOutput> {
    ctx.onProgress({
      phase: 'anchors',
      percent: 82,
      message: 'Generating semantic anchors...',
      stats: { filesProcessed: 0, totalFiles: 0, nodesCreated: ctx.graph.nodeCount },
    });

    const result: AnchorsOutput = applySemanticAnchors(ctx.graph);

    if (ctx.options?.llmAnchors) {
      const cachePath =
        ctx.options.semanticAnchorCachePath ??
        `${ctx.repoPath.replace(/[\\/]$/, '')}/.gitnexus/semantic-anchor-cache.json`;

      try {
        const { resolveLLMConfig, callLLM } = await import('../../wiki/llm-client.js');
        const { callCursorLLM, resolveCursorConfig } = await import('../../wiki/cursor-client.js');
        const { applyLLMSemanticAnchors } = await import('../semantic-anchor-llm.js');
        const config = await resolveLLMConfig({
          maxTokens: Number(process.env.GITNEXUS_LLM_ANCHOR_MAX_TOKENS ?? 700),
          temperature: 0,
        });

        if (!config.apiKey && config.provider !== 'cursor') {
          result.llmSkippedReason =
            'No LLM API key configured; set GITNEXUS_API_KEY or OPENAI_API_KEY.';
        } else {
          const model = config.provider === 'cursor' ? config.model || 'cursor-auto' : config.model;
          const llmResult = await applyLLMSemanticAnchors(ctx.graph, {
            cachePath,
            model,
            maxNodes: resolveLLMAnchorLimit(ctx.options.llmAnchorLimit),
            callLLM:
              config.provider === 'cursor'
                ? async (prompt, systemPrompt) =>
                    (
                      await callCursorLLM(
                        prompt,
                        resolveCursorConfig({ model, workingDirectory: ctx.repoPath }),
                        systemPrompt,
                      )
                    ).content
                : async (prompt, systemPrompt) =>
                    (await callLLM(prompt, config, systemPrompt)).content,
            onProgress: (message) =>
              ctx.onProgress({
                phase: 'anchors',
                percent: 83,
                message,
                stats: {
                  filesProcessed: 0,
                  totalFiles: 0,
                  nodesCreated: ctx.graph.nodeCount,
                },
              }),
          });
          result.llmEnrichedNodes = llmResult.enrichedNodes;
          result.llmCachedNodes = llmResult.cachedNodes;
          result.llmFailedNodes = llmResult.failedNodes;
        }
      } catch (err) {
        result.llmSkippedReason = err instanceof Error ? err.message : String(err);
      }
    }

    ctx.onProgress({
      phase: 'anchors',
      percent: 83,
      message:
        result.llmEnrichedNodes || result.llmCachedNodes
          ? `Generated ${result.anchoredNodes} semantic anchors; LLM enriched ${result.llmEnrichedNodes ?? 0}, cached ${result.llmCachedNodes ?? 0}`
          : result.llmSkippedReason
            ? `Generated ${result.anchoredNodes} semantic anchors; LLM skipped (${result.llmSkippedReason})`
            : `Generated ${result.anchoredNodes} semantic anchors`,
      stats: { filesProcessed: 0, totalFiles: 0, nodesCreated: ctx.graph.nodeCount },
    });

    return result;
  },
};
