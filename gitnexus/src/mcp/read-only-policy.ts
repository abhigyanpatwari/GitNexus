import { READ_ONLY_TOOL_ANNOTATIONS, type GITNEXUS_TOOLS } from './tools.js';

type GitNexusTool = (typeof GITNEXUS_TOOLS)[number];

export const MCP_READ_ONLY_TOOLS = new Set([
  'list_repos',
  'query',
  'context',
  'read_file',
  'grep',
  'detect_changes',
  'check',
  // Listed with a preview-only schema (see toolForReadOnlyMcp) and gated by
  // assertMcpReadOnlyToolCall, which rejects every dry_run except omitted/true.
  'rename',
  'impact',
  'explain',
  'pdg_query',
  'route_map',
  'tool_map',
  'shape_check',
  'api_impact',
  'trace',
]);

const READ_ONLY_RENAME_SUMMARY =
  'Read-only semantic rename preview (dry_run must be omitted or true; edits cannot be applied)';

const READ_ONLY_RENAME_DESCRIPTION = `Preview a rename using the indexed graph and GitNexus's own semantic layer in the current checkout. Preview-only in MCP read-only mode: dry_run must be omitted or true, and any other value is rejected before dispatch. No file is ever written.
Graph identities and language-provider scope resolution select exact UTF-16 name spans. No compiler, language service, or text-search replacement is used.
Pass symbol_uid from context() to select the declaration. Unsupported syntax, ambiguous bindings, stale declarations, and incomplete occurrence coverage fail closed.
Returns result_version:2 with semantic_edits, exact UTF-16 spans, and coverage describing the indexed source scope and limitations. Ambiguous symbol_name returns context()'s ranked candidates; re-call with symbol_uid.`;

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
  // `rename` is the one tool here that can write. Its read-only listing is
  // preview-only, so the dispatch contract must agree: only an omitted or
  // literal `true` reaches the backend. Anything else - `false`, `"false"`, `0`,
  // `null` - is rejected here rather than left to the planner's own type check.
  if (toolName === 'rename' && args?.dry_run !== undefined && args.dry_run !== true) {
    throw new Error(
      'Parameter "dry_run" must be omitted or true for "rename" in GitNexus MCP read-only mode; applying edits is not available.',
    );
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
        !/^\s*-\s+(?:cypher|group_sync|group_list):/u.test(line) &&
        !/^\|\s*`(?:cypher|group_sync|group_list)`\s*\|/u.test(line) &&
        !line.includes('gitnexus://group/'),
    )
    .map((line) => {
      // rename stays listed, but the generated lines advertise apply; restate
      // them as the preview-only contract this mode actually enforces.
      if (/^\s*-\s+rename:/u.test(line)) return `  - rename: ${READ_ONLY_RENAME_SUMMARY}`;
      if (/^\|\s*`rename`\s*\|/u.test(line)) return `| \`rename\` | ${READ_ONLY_RENAME_SUMMARY} |`;
      return line;
    })
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

  if (tool.name === 'rename') {
    // Preview-only listing: a schema-validating client cannot even form a
    // dry_run:false call, and the annotations stop advertising a destructive tool.
    properties.dry_run = {
      type: 'boolean',
      const: true,
      default: true,
      description:
        'Preview only in MCP read-only mode: omit or pass true. false and non-boolean values are rejected.',
    };
    return {
      ...tool,
      description: `${READ_ONLY_RENAME_DESCRIPTION}\n\nGitNexus MCP read-only mode excludes raw Cypher, mutation, and group routing.`,
      annotations: READ_ONLY_TOOL_ANNOTATIONS,
      inputSchema: { ...tool.inputSchema, properties },
    };
  }

  return {
    ...tool,
    description: `${scrubGroupDescription(tool.description)}\n\nGitNexus MCP read-only mode excludes raw Cypher, mutation, and group routing.`,
    inputSchema: { ...tool.inputSchema, properties },
  };
}
