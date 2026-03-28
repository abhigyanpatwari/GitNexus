/**
 * Skill File Generator
 *
 * Generates repo-specific SKILL.md files from detected Leiden communities.
 * Each significant community becomes a skill that describes a functional area
 * of the codebase, including key files, entry points, execution flows, and
 * cross-community connections.
 */

import fs from 'fs/promises';
import path from 'path';
import { PipelineResult } from '../types/pipeline.js';
import { CommunityNode, CommunityMembership } from '../core/ingestion/community-processor.js';
import { ProcessNode } from '../core/ingestion/process-processor.js';
import { KnowledgeGraph } from '../core/graph/types.js';

// ============================================================================
// TYPES
// ============================================================================

export interface GeneratedSkillInfo {
  name: string;
  label: string;
  symbolCount: number;
  fileCount: number;
}

interface AggregatedCommunity {
  label: string;
  rawIds: string[];
  symbolCount: number;
  cohesion: number;
}

interface MemberSymbol {
  id: string;
  name: string;
  label: string;
  filePath: string;
  startLine: number;
  isExported: boolean;
}

interface FileInfo {
  relativePath: string;
  symbols: string[];
}

interface CrossConnection {
  targetLabel: string;
  count: number;
}

// ============================================================================
// MAIN EXPORT
// ============================================================================

/**
 * @brief Generate repo-specific skill files from detected communities
 * @param {string} repoPath - Absolute path to the repository root
 * @param {string} projectName - Human-readable project name
 * @param {PipelineResult} pipelineResult - In-memory pipeline data with communities, processes, graph
 * @returns {Promise<{ skills: GeneratedSkillInfo[], outputPath: string }>} Generated skill metadata
 */
export const generateSkillFiles = async (
  repoPath: string,
  projectName: string,
  pipelineResult: PipelineResult,
): Promise<{ skills: GeneratedSkillInfo[]; outputPath: string }> => {
  const { communityResult, processResult, graph } = pipelineResult;
  const outputDir = path.join(repoPath, '.claude', 'skills', 'generated');

  if (!communityResult || !communityResult.memberships.length) {
    console.log('\n  Skills: no communities detected, skipping skill generation');
    return { skills: [], outputPath: outputDir };
  }

  console.log('\n  Generating repo-specific skills...');

  // Step 1: Build communities from memberships (not the filtered communities array).
  // The community processor skips singletons from its communities array but memberships
  // include ALL assignments. For repos with sparse CALLS edges, the communities array
  // can be empty while memberships still has useful groupings.
  const communities =
    communityResult.communities.length > 0
      ? communityResult.communities
      : buildCommunitiesFromMemberships(communityResult.memberships, graph, repoPath);

  const aggregated = aggregateCommunities(communities);

  // Step 2: Filter to significant communities
  // Keep communities with >= 3 symbols after aggregation.
  const significant = aggregated
    .filter((c) => c.symbolCount >= 3)
    .sort((a, b) => b.symbolCount - a.symbolCount)
    .slice(0, 20);

  if (significant.length === 0) {
    console.log('\n  Skills: no significant communities found (all below 3-symbol threshold)');
    return { skills: [], outputPath: outputDir };
  }

  // Step 3: Build lookup maps
  const membershipsByComm = buildMembershipMap(communityResult.memberships);
  const nodeIdToCommunityLabel = buildNodeCommunityLabelMap(
    communityResult.memberships,
    communities,
  );

  // Step 4: Clear and recreate output directory
  try {
    await fs.rm(outputDir, { recursive: true, force: true });
  } catch {
    /* may not exist */
  }
  await fs.mkdir(outputDir, { recursive: true });

  // Step 5: Generate skill files
  const skills: GeneratedSkillInfo[] = [];
  const usedNames = new Set<string>();

  for (const community of significant) {
    // Gather member symbols
    const members = gatherMembers(community.rawIds, membershipsByComm, graph);
    if (members.length === 0) continue;

    // Gather file info
    const files = gatherFiles(members, repoPath);

    // Gather entry points
    const entryPoints = gatherEntryPoints(members);

    // Gather execution flows
    const flows = gatherFlows(community.rawIds, processResult?.processes || []);

    // Gather cross-community connections
    const connections = gatherCrossConnections(
      community.rawIds,
      community.label,
      membershipsByComm,
      nodeIdToCommunityLabel,
      graph,
    );

    // Generate kebab name
    const kebabName = toKebabName(community.label, usedNames);
    usedNames.add(kebabName);

    // Generate SKILL.md content
    const content = renderSkillMarkdown(
      community,
      projectName,
      members,
      files,
      entryPoints,
      flows,
      connections,
      kebabName,
    );

    // Write file
    const skillDir = path.join(outputDir, kebabName);
    await fs.mkdir(skillDir, { recursive: true });
    await fs.writeFile(path.join(skillDir, 'SKILL.md'), content, 'utf-8');

    const info: GeneratedSkillInfo = {
      name: kebabName,
      label: community.label,
      symbolCount: community.symbolCount,
      fileCount: files.length,
    };
    skills.push(info);

    console.log(
      `    \u2713 ${community.label} (${community.symbolCount} symbols, ${files.length} files)`,
    );
  }

  console.log(`\n  ${skills.length} skills generated \u2192 .claude/skills/generated/`);

  return { skills, outputPath: outputDir };
};

// ============================================================================
// FALLBACK COMMUNITY BUILDER
// ============================================================================

/**
 * @brief Build CommunityNode-like objects from raw memberships when the community
 *        processor's communities array is empty (all singletons were filtered out)
 * @param {CommunityMembership[]} memberships - All node-to-community assignments
 * @param {KnowledgeGraph} graph - The knowledge graph for resolving node metadata
 * @param {string} repoPath - Repository root for path normalization
 * @returns {CommunityNode[]} Synthetic community nodes built from membership data
 */
const buildCommunitiesFromMemberships = (
  memberships: CommunityMembership[],
  graph: KnowledgeGraph,
  repoPath: string,
): CommunityNode[] => {
  // Group memberships by communityId
  const groups = new Map<string, string[]>();
  for (const m of memberships) {
    const arr = groups.get(m.communityId);
    if (arr) {
      arr.push(m.nodeId);
    } else {
      groups.set(m.communityId, [m.nodeId]);
    }
  }

  const communities: CommunityNode[] = [];

  for (const [commId, nodeIds] of groups) {
    // Derive a heuristic label from the most common parent directory
    const folderCounts = new Map<string, number>();
    for (const nodeId of nodeIds) {
      const node = graph.getNode(nodeId);
      if (!node?.properties.filePath) continue;
      const normalized = node.properties.filePath.replace(/\\/g, '/');
      const parts = normalized.split('/').filter(Boolean);
      if (parts.length >= 2) {
        const folder = parts[parts.length - 2];
        if (
          !['src', 'lib', 'core', 'utils', 'common', 'shared', 'helpers'].includes(
            folder.toLowerCase(),
          )
        ) {
          folderCounts.set(folder, (folderCounts.get(folder) || 0) + 1);
        }
      }
    }

    let bestFolder = '';
    let bestCount = 0;
    for (const [folder, count] of folderCounts) {
      if (count > bestCount) {
        bestCount = count;
        bestFolder = folder;
      }
    }

    const label = bestFolder
      ? bestFolder.charAt(0).toUpperCase() + bestFolder.slice(1)
      : `Cluster_${commId.replace('comm_', '')}`;

    // Compute cohesion as internal-edge ratio (matches backend calculateCohesion).
    // For each member node, count edges that stay inside the community vs total.
    const nodeSet = new Set(nodeIds);
    let internalEdges = 0;
    let totalEdges = 0;
    graph.forEachRelationship((rel) => {
      if (nodeSet.has(rel.sourceId)) {
        totalEdges++;
        if (nodeSet.has(rel.targetId)) internalEdges++;
      }
    });
    const cohesion = totalEdges > 0 ? Math.min(1.0, internalEdges / totalEdges) : 1.0;

    communities.push({
      id: commId,
      label,
      heuristicLabel: label,
      cohesion,
      symbolCount: nodeIds.length,
    });
  }

  return communities.sort((a, b) => b.symbolCount - a.symbolCount);
};

// ============================================================================
// AGGREGATION
// ============================================================================

/**
 * @brief Aggregate raw Leiden communities by heuristicLabel
 * @param {CommunityNode[]} communities - Raw community nodes from Leiden detection
 * @returns {AggregatedCommunity[]} Aggregated communities grouped by label
 */
const aggregateCommunities = (communities: CommunityNode[]): AggregatedCommunity[] => {
  const groups = new Map<
    string,
    {
      rawIds: string[];
      totalSymbols: number;
      weightedCohesion: number;
    }
  >();

  for (const c of communities) {
    const label = c.heuristicLabel || c.label || 'Unknown';
    const symbols = c.symbolCount || 0;
    const cohesion = c.cohesion || 0;
    const existing = groups.get(label);

    if (!existing) {
      groups.set(label, {
        rawIds: [c.id],
        totalSymbols: symbols,
        weightedCohesion: cohesion * symbols,
      });
    } else {
      existing.rawIds.push(c.id);
      existing.totalSymbols += symbols;
      existing.weightedCohesion += cohesion * symbols;
    }
  }

  return Array.from(groups.entries()).map(([label, g]) => ({
    label,
    rawIds: g.rawIds,
    symbolCount: g.totalSymbols,
    cohesion: g.totalSymbols > 0 ? g.weightedCohesion / g.totalSymbols : 0,
  }));
};

// ============================================================================
// LOOKUP MAP BUILDERS
// ============================================================================

/**
 * @brief Build a map from communityId to member nodeIds
 * @param {CommunityMembership[]} memberships - All membership records
 * @returns {Map<string, string[]>} Map of communityId -> nodeId[]
 */
const buildMembershipMap = (memberships: CommunityMembership[]): Map<string, string[]> => {
  const map = new Map<string, string[]>();
  for (const m of memberships) {
    const arr = map.get(m.communityId);
    if (arr) {
      arr.push(m.nodeId);
    } else {
      map.set(m.communityId, [m.nodeId]);
    }
  }
  return map;
};

/**
 * @brief Build a map from nodeId to aggregated community label
 * @param {CommunityMembership[]} memberships - All membership records
 * @param {CommunityNode[]} communities - Community nodes with labels
 * @returns {Map<string, string>} Map of nodeId -> community label
 */
const buildNodeCommunityLabelMap = (
  memberships: CommunityMembership[],
  communities: CommunityNode[],
): Map<string, string> => {
  const commIdToLabel = new Map<string, string>();
  for (const c of communities) {
    commIdToLabel.set(c.id, c.heuristicLabel || c.label || 'Unknown');
  }

  const map = new Map<string, string>();
  for (const m of memberships) {
    const label = commIdToLabel.get(m.communityId);
    if (label) {
      map.set(m.nodeId, label);
    }
  }
  return map;
};

// ============================================================================
// DATA GATHERING
// ============================================================================

/**
 * @brief Gather member symbols for an aggregated community
 * @param {string[]} rawIds - Raw community IDs belonging to this aggregated community
 * @param {Map<string, string[]>} membershipsByComm - communityId -> nodeIds
 * @param {KnowledgeGraph} graph - The knowledge graph
 * @returns {MemberSymbol[]} Array of member symbol information
 */
const gatherMembers = (
  rawIds: string[],
  membershipsByComm: Map<string, string[]>,
  graph: KnowledgeGraph,
): MemberSymbol[] => {
  const seen = new Set<string>();
  const members: MemberSymbol[] = [];

  for (const commId of rawIds) {
    const nodeIds = membershipsByComm.get(commId) || [];
    for (const nodeId of nodeIds) {
      if (seen.has(nodeId)) continue;
      seen.add(nodeId);

      const node = graph.getNode(nodeId);
      if (!node) continue;

      members.push({
        id: node.id,
        name: node.properties.name,
        label: node.label,
        filePath: node.properties.filePath || '',
        startLine: node.properties.startLine || 0,
        isExported: node.properties.isExported === true,
      });
    }
  }

  return members;
};

/**
 * @brief Gather deduplicated file info with per-file symbol names
 * @param {MemberSymbol[]} members - Member symbols
 * @param {string} repoPath - Repository root for relative path computation
 * @returns {FileInfo[]} Sorted by symbol count descending
 */
const gatherFiles = (members: MemberSymbol[], repoPath: string): FileInfo[] => {
  const fileMap = new Map<string, string[]>();

  for (const m of members) {
    if (!m.filePath) continue;
    const rel = toRelativePath(m.filePath, repoPath);
    const arr = fileMap.get(rel);
    if (arr) {
      arr.push(m.name);
    } else {
      fileMap.set(rel, [m.name]);
    }
  }

  return Array.from(fileMap.entries())
    .map(([relativePath, symbols]) => ({ relativePath, symbols }))
    .sort((a, b) => b.symbols.length - a.symbols.length);
};

/**
 * @brief Gather exported entry points prioritized by type
 * @param {MemberSymbol[]} members - Member symbols
 * @returns {MemberSymbol[]} Exported symbols sorted by type priority
 */
const gatherEntryPoints = (members: MemberSymbol[]): MemberSymbol[] => {
  const typePriority: Record<string, number> = {
    Function: 0,
    Class: 1,
    Method: 2,
    Interface: 3,
  };

  return members
    .filter((m) => m.isExported)
    .sort((a, b) => {
      const pa = typePriority[a.label] ?? 99;
      const pb = typePriority[b.label] ?? 99;
      return pa - pb;
    });
};

/**
 * @brief Gather execution flows touching this community
 * @param {string[]} rawIds - Raw community IDs for this aggregated community
 * @param {ProcessNode[]} processes - All detected processes
 * @returns {ProcessNode[]} Processes whose communities intersect rawIds, sorted by stepCount
 */
const gatherFlows = (rawIds: string[], processes: ProcessNode[]): ProcessNode[] => {
  const rawIdSet = new Set(rawIds);

  return processes
    .filter((proc) => proc.communities.some((cid) => rawIdSet.has(cid)))
    .sort((a, b) => b.stepCount - a.stepCount);
};

/**
 * @brief Gather cross-community call connections
 * @param {string[]} rawIds - Raw community IDs for this aggregated community
 * @param {string} ownLabel - This community's aggregated label
 * @param {Map<string, string[]>} membershipsByComm - communityId -> nodeIds
 * @param {Map<string, string>} nodeIdToCommunityLabel - nodeId -> community label
 * @param {KnowledgeGraph} graph - The knowledge graph
 * @returns {CrossConnection[]} Aggregated cross-community connections sorted by count
 */
const gatherCrossConnections = (
  rawIds: string[],
  ownLabel: string,
  membershipsByComm: Map<string, string[]>,
  nodeIdToCommunityLabel: Map<string, string>,
  graph: KnowledgeGraph,
): CrossConnection[] => {
  // Collect all node IDs in this aggregated community
  const ownNodeIds = new Set<string>();
  for (const commId of rawIds) {
    const nodeIds = membershipsByComm.get(commId) || [];
    for (const nid of nodeIds) {
      ownNodeIds.add(nid);
    }
  }

  // Count outgoing CALLS to nodes in different communities
  const targetCounts = new Map<string, number>();

  graph.forEachRelationship((rel) => {
    if (rel.type !== 'CALLS') return;
    if (!ownNodeIds.has(rel.sourceId)) return;
    if (ownNodeIds.has(rel.targetId)) return; // same community

    const targetLabel = nodeIdToCommunityLabel.get(rel.targetId);
    if (!targetLabel || targetLabel === ownLabel) return;

    targetCounts.set(targetLabel, (targetCounts.get(targetLabel) || 0) + 1);
  });

  return Array.from(targetCounts.entries())
    .map(([targetLabel, count]) => ({ targetLabel, count }))
    .sort((a, b) => b.count - a.count);
};

// ============================================================================
// MARKDOWN RENDERING
// ============================================================================

/**
 * @brief Render SKILL.md content for a single community
 * @param {AggregatedCommunity} community - The aggregated community data
 * @param {string} projectName - Project name for the description
 * @param {MemberSymbol[]} members - All member symbols
 * @param {FileInfo[]} files - File info with symbol names
 * @param {MemberSymbol[]} entryPoints - Exported entry point symbols
 * @param {ProcessNode[]} flows - Execution flows touching this community
 * @param {CrossConnection[]} connections - Cross-community connections
 * @param {string} kebabName - Kebab-case name for the skill
 * @returns {string} Full SKILL.md content
 */
const renderSkillMarkdown = (
  community: AggregatedCommunity,
  projectName: string,
  members: MemberSymbol[],
  files: FileInfo[],
  entryPoints: MemberSymbol[],
  flows: ProcessNode[],
  connections: CrossConnection[],
  kebabName: string,
): string => {
  const cohesionPct = Math.round(community.cohesion * 100);

  // Dominant directory: most common top-level directory
  const dominantDir = getDominantDirectory(files);

  // Top symbol names for "When to Use"
  const topNames = entryPoints.slice(0, 3).map((e) => e.name);
  if (topNames.length === 0) {
    // Fallback to any members
    topNames.push(...members.slice(0, 3).map((m) => m.name));
  }

  const lines: string[] = [];

  // Frontmatter
  lines.push('---');
  lines.push(`name: ${kebabName}`);
  lines.push(
    `description: "Skill for the ${community.label} area of ${projectName}. ${community.symbolCount} symbols across ${files.length} files."`,
  );
  lines.push('---');
  lines.push('');

  // Title
  lines.push(`# ${community.label}`);
  lines.push('');
  lines.push(
    `${community.symbolCount} symbols | ${files.length} files | Cohesion: ${cohesionPct}%`,
  );
  lines.push('');

  // When to Use
  lines.push('## When to Use');
  lines.push('');
  if (dominantDir) {
    lines.push(`- Working with code in \`${dominantDir}/\``);
  }
  if (topNames.length > 0) {
    lines.push(`- Understanding how ${topNames.join(', ')} work`);
  }
  lines.push(`- Modifying ${community.label.toLowerCase()}-related functionality`);
  lines.push('');

  // Key Files (top 10)
  lines.push('## Key Files');
  lines.push('');
  lines.push('| File | Symbols |');
  lines.push('|------|---------|');
  for (const f of files.slice(0, 10)) {
    const symbolList = f.symbols.slice(0, 5).join(', ');
    const suffix = f.symbols.length > 5 ? ` (+${f.symbols.length - 5})` : '';
    lines.push(`| \`${f.relativePath}\` | ${symbolList}${suffix} |`);
  }
  lines.push('');

  // Entry Points (top 5)
  if (entryPoints.length > 0) {
    lines.push('## Entry Points');
    lines.push('');
    lines.push('Start here when exploring this area:');
    lines.push('');
    for (const ep of entryPoints.slice(0, 5)) {
      lines.push(`- **\`${ep.name}\`** (${ep.label}) \u2014 \`${ep.filePath}:${ep.startLine}\``);
    }
    lines.push('');
  }

  // Key Symbols (top 20, exported first, then by type)
  lines.push('## Key Symbols');
  lines.push('');
  lines.push('| Symbol | Type | File | Line |');
  lines.push('|--------|------|------|------|');
  const sortedMembers = [...members].sort((a, b) => {
    if (a.isExported !== b.isExported) return a.isExported ? -1 : 1;
    return a.label.localeCompare(b.label);
  });
  for (const m of sortedMembers.slice(0, 20)) {
    lines.push(`| \`${m.name}\` | ${m.label} | \`${m.filePath}\` | ${m.startLine} |`);
  }
  lines.push('');

  // Execution Flows
  if (flows.length > 0) {
    lines.push('## Execution Flows');
    lines.push('');
    lines.push('| Flow | Type | Steps |');
    lines.push('|------|------|-------|');
    for (const f of flows.slice(0, 10)) {
      lines.push(`| \`${f.heuristicLabel}\` | ${f.processType} | ${f.stepCount} |`);
    }
    lines.push('');
  }

  // Connected Areas
  if (connections.length > 0) {
    lines.push('## Connected Areas');
    lines.push('');
    lines.push('| Area | Connections |');
    lines.push('|------|-------------|');
    for (const c of connections.slice(0, 8)) {
      lines.push(`| ${c.targetLabel} | ${c.count} calls |`);
    }
    lines.push('');
  }

  // How to Explore
  const firstEntry =
    entryPoints.length > 0
      ? entryPoints[0].name
      : members.length > 0
        ? members[0].name
        : community.label;
  lines.push('## How to Explore');
  lines.push('');
  lines.push(`1. \`gitnexus_context({name: "${firstEntry}"})\` \u2014 see callers and callees`);
  lines.push(
    `2. \`gitnexus_query({query: "${community.label.toLowerCase()}"})\` \u2014 find related execution flows`,
  );
  lines.push('3. Read key files listed above for implementation details');
  lines.push('');

  return lines.join('\n');
};

// ============================================================================
// UTILITY HELPERS
// ============================================================================

/**
 * @brief Convert a community label to a kebab-case directory name
 * @param {string} label - The community label
 * @param {Set<string>} usedNames - Already-used names for collision detection
 * @returns {string} Unique kebab-case name capped at 50 characters
 */
const toKebabName = (label: string, usedNames: Set<string>): string => {
  let name = label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 50);

  if (!name) name = 'skill';

  let candidate = name;
  let counter = 2;
  while (usedNames.has(candidate)) {
    candidate = `${name}-${counter}`;
    counter++;
  }

  return candidate;
};

/**
 * @brief Convert an absolute or repo-relative file path to a clean relative path
 * @param {string} filePath - The file path from the graph node
 * @param {string} repoPath - Repository root path
 * @returns {string} Relative path using forward slashes
 */
const toRelativePath = (filePath: string, repoPath: string): string => {
  // Normalize to forward slashes for cross-platform consistency
  const normalizedFile = filePath.replace(/\\/g, '/');
  const normalizedRepo = repoPath.replace(/\\/g, '/');

  if (normalizedFile.startsWith(normalizedRepo)) {
    return normalizedFile.slice(normalizedRepo.length).replace(/^\//, '');
  }
  // Already relative or different root
  return normalizedFile.replace(/^\//, '');
};

/**
 * @brief Find the dominant (most common) top-level directory across files
 * @param {FileInfo[]} files - File info entries
 * @returns {string | null} Most common directory or null
 */
const getDominantDirectory = (files: FileInfo[]): string | null => {
  const dirCounts = new Map<string, number>();

  for (const f of files) {
    const parts = f.relativePath.split('/');
    if (parts.length >= 2) {
      const dir = parts[0];
      dirCounts.set(dir, (dirCounts.get(dir) || 0) + f.symbols.length);
    }
  }

  let best: string | null = null;
  let bestCount = 0;
  for (const [dir, count] of dirCounts) {
    if (count > bestCount) {
      bestCount = count;
      best = dir;
    }
  }

  return best;
};
