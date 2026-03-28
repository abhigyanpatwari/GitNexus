/**
 * Cluster Enricher
 *
 * LLM-based enrichment for community clusters.
 * Generates semantic names, keywords, and descriptions using an LLM.
 */

import { CommunityNode } from './community-processor.js';

// ============================================================================
// TYPES
// ============================================================================

export interface ClusterEnrichment {
  name: string;
  keywords: string[];
  description: string;
}

export interface EnrichmentResult {
  enrichments: Map<string, ClusterEnrichment>;
  tokensUsed: number;
}

export interface LLMClient {
  generate: (prompt: string) => Promise<string>;
}

export interface ClusterMemberInfo {
  name: string;
  filePath: string;
  type: string; // 'Function' | 'Class' | 'Method' | 'Interface'
}

// ============================================================================
// PROMPT TEMPLATE
// ============================================================================

const buildEnrichmentPrompt = (members: ClusterMemberInfo[], heuristicLabel: string): string => {
  // Limit to first 20 members to control token usage
  const limitedMembers = members.slice(0, 20);

  const memberList = limitedMembers.map((m) => `${m.name} (${m.type})`).join(', ');

  return `Analyze this code cluster and provide a semantic name and short description.

Heuristic: "${heuristicLabel}"
Members: ${memberList}${members.length > 20 ? ` (+${members.length - 20} more)` : ''}

Reply with JSON only:
{"name": "2-4 word semantic name", "description": "One sentence describing purpose"}`;
};

// ============================================================================
// PARSE LLM RESPONSE
// ============================================================================

const parseEnrichmentResponse = (response: string, fallbackLabel: string): ClusterEnrichment => {
  try {
    // Extract JSON from response (handles markdown code blocks)
    const jsonMatch = response.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      throw new Error('No JSON found in response');
    }

    const parsed = JSON.parse(jsonMatch[0]);

    return {
      name: parsed.name || fallbackLabel,
      keywords: Array.isArray(parsed.keywords) ? parsed.keywords : [],
      description: parsed.description || '',
    };
  } catch {
    // Fallback if parsing fails
    return {
      name: fallbackLabel,
      keywords: [],
      description: '',
    };
  }
};

// ============================================================================
// MAIN ENRICHMENT FUNCTION
// ============================================================================

/**
 * Enrich clusters with LLM-generated names, keywords, and descriptions
 *
 * @param communities - Community nodes to enrich
 * @param memberMap - Map of communityId -> member info
 * @param llmClient - LLM client for generation
 * @param onProgress - Progress callback
 */
export const enrichClusters = async (
  communities: CommunityNode[],
  memberMap: Map<string, ClusterMemberInfo[]>,
  llmClient: LLMClient,
  onProgress?: (current: number, total: number) => void,
): Promise<EnrichmentResult> => {
  const enrichments = new Map<string, ClusterEnrichment>();
  let tokensUsed = 0;

  for (let i = 0; i < communities.length; i++) {
    const community = communities[i];
    const members = memberMap.get(community.id) || [];

    onProgress?.(i + 1, communities.length);

    if (members.length === 0) {
      // No members, use heuristic
      enrichments.set(community.id, {
        name: community.heuristicLabel,
        keywords: [],
        description: '',
      });
      continue;
    }

    try {
      const prompt = buildEnrichmentPrompt(members, community.heuristicLabel);
      const response = await llmClient.generate(prompt);

      // Rough token estimate
      tokensUsed += prompt.length / 4 + response.length / 4;

      const enrichment = parseEnrichmentResponse(response, community.heuristicLabel);
      enrichments.set(community.id, enrichment);
    } catch (error) {
      // On error, fallback to heuristic
      console.warn(`Failed to enrich cluster ${community.id}:`, error);
      enrichments.set(community.id, {
        name: community.heuristicLabel,
        keywords: [],
        description: '',
      });
    }
  }

  return { enrichments, tokensUsed };
};

// ============================================================================
// BATCH ENRICHMENT (more efficient)
// ============================================================================

/**
 * Enrich multiple clusters in a single LLM call (batch mode)
 * More efficient for token usage but requires larger context window
 */
export const enrichClustersBatch = async (
  communities: CommunityNode[],
  memberMap: Map<string, ClusterMemberInfo[]>,
  llmClient: LLMClient,
  batchSize: number = 5,
  onProgress?: (current: number, total: number) => void,
): Promise<EnrichmentResult> => {
  const enrichments = new Map<string, ClusterEnrichment>();
  let tokensUsed = 0;

  // Process in batches
  for (let i = 0; i < communities.length; i += batchSize) {
    // Report progress
    onProgress?.(Math.min(i + batchSize, communities.length), communities.length);

    const batch = communities.slice(i, i + batchSize);

    const batchPrompt = batch
      .map((community, idx) => {
        const members = memberMap.get(community.id) || [];
        const limitedMembers = members.slice(0, 15);
        const memberList = limitedMembers.map((m) => `${m.name} (${m.type})`).join(', ');

        return `Cluster ${idx + 1} (id: ${community.id}):
Heuristic: "${community.heuristicLabel}"
Members: ${memberList}`;
      })
      .join('\n\n');

    const prompt = `Analyze these code clusters and generate semantic names, keywords, and descriptions.

${batchPrompt}

Output JSON array:
[
  {"id": "comm_X", "name": "...", "keywords": [...], "description": "..."},
  ...
]`;

    try {
      const response = await llmClient.generate(prompt);
      tokensUsed += prompt.length / 4 + response.length / 4;

      // Parse batch response
      const jsonMatch = response.match(/\[[\s\S]*\]/);
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]) as Array<{
          id: string;
          name: string;
          keywords: string[];
          description: string;
        }>;

        for (const item of parsed) {
          enrichments.set(item.id, {
            name: item.name,
            keywords: item.keywords || [],
            description: item.description || '',
          });
        }
      }
    } catch (error) {
      console.warn('Batch enrichment failed, falling back to heuristics:', error);
      // Fallback for this batch
      for (const community of batch) {
        enrichments.set(community.id, {
          name: community.heuristicLabel,
          keywords: [],
          description: '',
        });
      }
    }
  }

  // Fill in any missing communities
  for (const community of communities) {
    if (!enrichments.has(community.id)) {
      enrichments.set(community.id, {
        name: community.heuristicLabel,
        keywords: [],
        description: '',
      });
    }
  }

  return { enrichments, tokensUsed };
};
