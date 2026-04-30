import { createHash } from 'crypto';
import fs from 'fs/promises';
import path from 'path';
import type { GraphNode } from 'gitnexus-shared';
import type { KnowledgeGraph } from '../graph/types.js';
import { buildRelationCounts, type AnchorRelationCounts } from './semantic-anchor.js';

export const LLM_SEMANTIC_ANCHOR_VERSION = 2;

export interface LLMAnchorFields {
  summary: string;
  purpose: string;
  tags: string[];
}

interface CachedLLMAnchor extends LLMAnchorFields {
  contentHash: string;
  model: string;
  generatedAt: string;
}

export interface LLMSemanticAnchorCache {
  version: 1;
  entries: Record<string, CachedLLMAnchor>;
}

export interface ApplyLLMSemanticAnchorsOptions {
  cachePath: string;
  model: string;
  maxNodes?: number;
  generatedAt?: string;
  callLLM: (prompt: string, systemPrompt: string) => Promise<string>;
  onProgress?: (message: string) => void;
}

export interface LLMSemanticAnchorResult {
  enrichedNodes: number;
  cachedNodes: number;
  skippedNodes: number;
  failedNodes: number;
  cachePath: string;
}

const sha256 = (value: string): string => createHash('sha256').update(value).digest('hex');

const readCache = async (cachePath: string): Promise<LLMSemanticAnchorCache> => {
  try {
    const raw = await fs.readFile(cachePath, 'utf-8');
    const parsed = JSON.parse(raw) as LLMSemanticAnchorCache;
    if (parsed.version === 1 && parsed.entries && typeof parsed.entries === 'object') {
      return parsed;
    }
  } catch {
    /* empty cache */
  }
  return { version: 1, entries: {} };
};

const writeCache = async (cachePath: string, cache: LLMSemanticAnchorCache): Promise<void> => {
  await fs.mkdir(path.dirname(cachePath), { recursive: true });
  await fs.writeFile(cachePath, JSON.stringify(cache, null, 2), 'utf-8');
};

const contentHashForNode = (node: GraphNode, counts: AnchorRelationCounts): string =>
  sha256(
    JSON.stringify({
      id: node.id,
      label: node.label,
      name: node.properties.name,
      filePath: node.properties.filePath,
      startLine: node.properties.startLine,
      endLine: node.properties.endLine,
      content: node.properties.content ?? '',
      heuristicSummary: node.properties.summary ?? '',
      heuristicPurpose: node.properties.purpose ?? '',
      heuristicTags: node.properties.tags ?? [],
      counts,
      version: LLM_SEMANTIC_ANCHOR_VERSION,
    }),
  );

const compactContent = (value: unknown, maxChars = 2400): string => {
  if (typeof value !== 'string' || value.length === 0) return '';
  const normalized = value.replace(/\s+/g, ' ').trim();
  return normalized.length > maxChars ? `${normalized.slice(0, maxChars)}...` : normalized;
};

const parseJSONAnchor = (raw: string): LLMAnchorFields => {
  const trimmed = raw.trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const jsonText = fenced?.[1]?.trim() ?? trimmed;
  const parsed = JSON.parse(jsonText) as Partial<LLMAnchorFields>;
  const summary = typeof parsed.summary === 'string' ? parsed.summary.trim() : '';
  const purpose = typeof parsed.purpose === 'string' ? parsed.purpose.trim() : '';
  const tags = Array.isArray(parsed.tags)
    ? parsed.tags.filter((tag): tag is string => typeof tag === 'string')
    : [];

  if (!summary || !purpose) {
    throw new Error('LLM anchor JSON must contain summary and purpose strings');
  }

  return {
    summary: summary.slice(0, 500),
    purpose: purpose.slice(0, 500),
    tags: normalizeTags(tags).slice(0, 8),
  };
};

const normalizeTags = (tags: string[]): string[] =>
  Array.from(
    new Set(
      tags
        .map((tag) =>
          tag
            .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
            .replace(/[^a-zA-Z0-9]+/g, '-')
            .replace(/^-+|-+$/g, '')
            .toLowerCase(),
        )
        .filter((tag) => tag.length > 0),
    ),
  ).sort();

const applyAnchorToNode = (
  node: GraphNode,
  anchor: LLMAnchorFields,
  model: string,
  contentHash: string,
  generatedAt: string,
): void => {
  const existingTags = Array.isArray(node.properties.tags)
    ? node.properties.tags.filter((tag): tag is string => typeof tag === 'string')
    : [];
  node.properties.summary = anchor.summary;
  node.properties.purpose = anchor.purpose;
  node.properties.tags = normalizeTags([...existingTags, ...anchor.tags]);
  node.properties.description = anchor.summary;
  node.properties.anchorModel = `llm:${model}`;
  node.properties.anchorHash = contentHash;
  node.properties.anchorVersion = LLM_SEMANTIC_ANCHOR_VERSION;
  node.properties.anchorGeneratedAt = generatedAt;
};

const buildPrompt = (node: GraphNode, counts: AnchorRelationCounts): string =>
  JSON.stringify(
    {
      node: {
        id: node.id,
        label: node.label,
        name: node.properties.name,
        filePath: node.properties.filePath,
        startLine: node.properties.startLine,
        endLine: node.properties.endLine,
        heuristicSummary: node.properties.summary,
        heuristicPurpose: node.properties.purpose,
        heuristicTags: node.properties.tags,
        contentExcerpt: compactContent(node.properties.content),
      },
      graphSignals: counts,
      output: {
        summary: 'one concise sentence about what this node does',
        purpose: 'one concise sentence explaining when an agent should inspect it',
        tags: ['3-8 stable kebab-case tags'],
      },
    },
    null,
    2,
  );

const SYSTEM_PROMPT =
  'You enrich static code graph anchors. Return only JSON with keys summary, purpose, tags. Keep summaries factual and grounded in the provided node data.';

export const applyLLMSemanticAnchors = async (
  graph: KnowledgeGraph,
  options: ApplyLLMSemanticAnchorsOptions,
): Promise<LLMSemanticAnchorResult> => {
  const generatedAt = options.generatedAt ?? new Date().toISOString();
  const maxNodes = options.maxNodes ?? Number.POSITIVE_INFINITY;
  const cache = await readCache(options.cachePath);
  const counts = buildRelationCounts(graph);
  const candidates = [...graph.iterNodes()]
    .filter((node) => typeof node.properties.summary === 'string')
    .sort((a, b) => {
      const ca = counts.get(a.id) ?? { incoming: 0, outgoing: 0, byType: {} };
      const cb = counts.get(b.id) ?? { incoming: 0, outgoing: 0, byType: {} };
      return cb.incoming + cb.outgoing - (ca.incoming + ca.outgoing);
    })
    .slice(0, maxNodes);

  let enrichedNodes = 0;
  let cachedNodes = 0;
  let failedNodes = 0;

  for (const node of candidates) {
    const nodeCounts = counts.get(node.id) ?? { incoming: 0, outgoing: 0, byType: {} };
    const contentHash = contentHashForNode(node, nodeCounts);
    const cached = cache.entries[node.id];
    if (cached?.contentHash === contentHash && cached.model === options.model) {
      applyAnchorToNode(node, cached, options.model, contentHash, cached.generatedAt);
      cachedNodes += 1;
      continue;
    }

    try {
      options.onProgress?.(`Enriching semantic anchor ${enrichedNodes + 1}/${candidates.length}`);
      const raw = await options.callLLM(buildPrompt(node, nodeCounts), SYSTEM_PROMPT);
      const anchor = parseJSONAnchor(raw);
      applyAnchorToNode(node, anchor, options.model, contentHash, generatedAt);
      cache.entries[node.id] = { ...anchor, contentHash, model: options.model, generatedAt };
      enrichedNodes += 1;
    } catch {
      failedNodes += 1;
    }
  }

  await writeCache(options.cachePath, cache);

  return {
    enrichedNodes,
    cachedNodes,
    failedNodes,
    skippedNodes: Math.max(0, graph.nodeCount - candidates.length),
    cachePath: options.cachePath,
  };
};
