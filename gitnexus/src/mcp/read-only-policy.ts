import type { GITNEXUS_TOOLS } from './tools.js';

type GitNexusTool = (typeof GITNEXUS_TOOLS)[number];

export const MCP_READ_ONLY_TOOLS = new Set([
  'list_repos',
  'query',
  'context',
  'detect_changes',
  'check',
  'impact',
  'explain',
  'pdg_query',
  'route_map',
  'tool_map',
  'shape_check',
  'api_impact',
  'trace',
]);

const MCP_READ_ONLY_ALIASES = new Set(['search', 'explore', 'overview']);

export function resolveMcpReadOnlyMode(env: NodeJS.ProcessEnv = process.env): boolean {
  const value = env.GITNEXUS_MCP_READ_ONLY?.trim();
  if (value === undefined || value === '' || value === '0') return false;
  if (value === '1') return true;
  throw new Error('GITNEXUS_MCP_READ_ONLY must be 0 or 1.');
}

export function assertMcpReadOnlyToolCall(
  toolName: string,
  args: Record<string, unknown> | undefined,
  readOnly: boolean,
): void {
  if (!readOnly) return;
  if (!MCP_READ_ONLY_TOOLS.has(toolName) && !MCP_READ_ONLY_ALIASES.has(toolName)) {
    throw new Error(`Tool "${toolName}" is not available in GitNexus MCP read-only mode.`);
  }
  if (typeof args?.repo === 'string' && args.repo.trim().startsWith('@')) {
    throw new Error('Group routing is not available in GitNexus MCP read-only mode.');
  }
  // crossDepth/subgroup only do anything on the @group path rejected above,
  // but rejecting them here keeps the advertised schema and the dispatch
  // contract in agreement.
  for (const groupOnlyArg of ['crossDepth', 'subgroup']) {
    if (args?.[groupOnlyArg] !== undefined) {
      throw new Error(
        `Parameter "${groupOnlyArg}" is not available in GitNexus MCP read-only mode.`,
      );
    }
  }
}

export function readOnlyResourceTemplateAllowed(uriTemplate: string, readOnly: boolean): boolean {
  return !readOnly || !/^gitnexus:\/\/group\//iu.test(uriTemplate);
}

export function assertMcpReadOnlyResource(uri: string, readOnly: boolean): void {
  if (!readOnly) return;

  let isGroupResource = false;
  try {
    const parsed = new URL(uri);
    isGroupResource =
      parsed.protocol.toLowerCase() === 'gitnexus:' && parsed.hostname.toLowerCase() === 'group';
  } catch {
    // Invalid resource URIs are rejected by the normal parser. This fallback
    // keeps obviously group-shaped malformed inputs fail-closed as well.
    isGroupResource = /^gitnexus:\/\/group(?:\/|$)/iu.test(uri);
  }

  if (isGroupResource) {
    throw new Error('Group resources are not available in GitNexus MCP read-only mode.');
  }
}

// Cosmetic only: dispatch enforcement above is the actual boundary. If the
// generated resource format drifts and a hidden route slips through here, the
// caller still gets a clean rejection at dispatch.
export function filterMcpReadOnlyResourceContent(content: string, readOnly: boolean): string {
  if (!readOnly) return content;
  return content
    .split('\n')
    .filter(
      (line) =>
        !/^\s*-\s+(?:rename|cypher|group_sync|group_list):/u.test(line) &&
        !/^\|\s*`(?:rename|cypher|group_sync|group_list)`\s*\|/u.test(line) &&
        !line.includes('gitnexus://group/'),
    )
    .join('\n');
}

/** Shared with repository-policy.ts so both policies scrub identically. */
export function scrubGroupDescription(description: string): string {
  return description
    .replace(/\nGROUP MODE:[\s\S]*?(?=\n\n[A-Z][A-Z ()-]*:|$)/gu, '')
    .replace(/\nCROSS-REPO \(experimental\):[\s\S]*?(?=\n\n[A-Z][A-Z ()-]*:|$)/gu, '')
    .replace(/\nDESTINATION TRACE \(cross-repo\):[\s\S]*?(?=\n\n[A-Z][A-Z ()-]*:|$)/gu, '');
}

export function toolForReadOnlyMcp(tool: GitNexusTool, readOnly: boolean): GitNexusTool {
  if (!readOnly) return tool;

  const properties = { ...tool.inputSchema.properties };
  const repo = properties.repo;
  if (repo && typeof repo === 'object') {
    properties.repo = {
      ...repo,
      description:
        'Indexed repository name or path. Group-mode values beginning with @ are unavailable in MCP read-only mode.',
    };
  }
  delete properties.subgroup;
  delete properties.crossDepth;

  return {
    ...tool,
    description: `${scrubGroupDescription(tool.description)}\n\nGitNexus MCP read-only mode excludes raw Cypher, mutation, and group routing.`,
    inputSchema: { ...tool.inputSchema, properties },
  };
}
