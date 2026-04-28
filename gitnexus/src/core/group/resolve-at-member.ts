/**
 * Map MCP/CLI `@groupName` or `@groupName/memberPath` to a concrete member path in group.yaml.
 */

import { loadGroupConfig } from './config-parser.js';
import { getDefaultGitnexusDir, getGroupDir } from './storage.js';

export async function resolveAtGroupMemberRepoPath(
  groupName: string,
  explicitMemberPath: string | undefined,
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
      return { ok: true, repoPath: explicitMemberPath };
    }
    return { ok: true, repoPath: keys[0]! };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}
