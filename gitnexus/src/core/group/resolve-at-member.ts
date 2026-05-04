/**
 * Map MCP/CLI `@groupName` or `@groupName/memberPath` to a concrete member path in group.yaml.
 */

import { loadGroupConfig } from './config-parser.js';
import { getDefaultGitnexusDir, getGroupDir } from './storage.js';

function memberRegistryNameAllowed(
  registryName: string,
  mcpRepoAllowlist: ReadonlySet<string> | null | undefined,
): boolean {
  if (mcpRepoAllowlist == null || mcpRepoAllowlist.size === 0) return true;
  return mcpRepoAllowlist.has(registryName.trim().toLowerCase());
}

export async function resolveAtGroupMemberRepoPath(
  groupName: string,
  explicitMemberPath: string | undefined,
  mcpRepoAllowlist?: ReadonlySet<string> | null,
): Promise<{ ok: true; repoPath: string } | { ok: false; error: string }> {
  const trimmed = groupName.trim();
  if (!trimmed) return { ok: false, error: 'Group name is empty.' };
  try {
    const groupDir = getGroupDir(getDefaultGitnexusDir(), trimmed);
    const config = await loadGroupConfig(groupDir);
    const keys = Object.keys(config.repos).sort((a, b) => a.localeCompare(b));
    if (keys.length === 0) {
      return { ok: false, error: `Group "${trimmed}" has no repos in group.yaml.` };
    }
    if (explicitMemberPath !== undefined && explicitMemberPath !== '') {
      if (!(explicitMemberPath in config.repos)) {
        return {
          ok: false,
          error: `Unknown member path "${explicitMemberPath}" in group "${trimmed}". Known paths: ${keys.join(', ')}`,
        };
      }
      const reg = config.repos[explicitMemberPath];
      if (!memberRegistryNameAllowed(reg, mcpRepoAllowlist)) {
        return {
          ok: false,
          error: `Group member "${explicitMemberPath}" is not exposed by this MCP server (repo allowlist).`,
        };
      }
      return { ok: true, repoPath: explicitMemberPath };
    }
    if (mcpRepoAllowlist == null || mcpRepoAllowlist.size === 0) {
      return { ok: true, repoPath: keys[0]! };
    }
    for (const k of keys) {
      const reg = config.repos[k];
      if (reg && memberRegistryNameAllowed(reg, mcpRepoAllowlist)) {
        return { ok: true, repoPath: k };
      }
    }
    return {
      ok: false,
      error: `No members of group "${trimmed}" are exposed by this MCP server (repo allowlist).`,
    };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}
