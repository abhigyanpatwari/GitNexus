import path from 'node:path';
import { loadGroupConfig } from './config-parser.js';
import { getDefaultGitnexusDir, getGroupDir, listGroups } from './storage.js';
import { syncGroup, type SyncOptions, type SyncResult } from './sync.js';
import type { GroupConfig } from './types.js';

export interface AutoGroupSyncOptions {
  repoName: string;
  repoPath?: string;
  gitnexusDir?: string;
  allowStale?: boolean;
  exactOnly?: boolean;
  skipEmbeddings?: boolean;
  verbose?: boolean;
  onLog?: (message: string) => void;
  sync?: (config: GroupConfig, opts?: SyncOptions) => Promise<SyncResult>;
}

export interface AutoGroupSyncGroupResult {
  name: string;
  groupDir: string;
  memberPaths: string[];
  result?: SyncResult;
  error?: string;
}

export interface AutoGroupSyncResult {
  scanned: number;
  matched: number;
  synced: number;
  failed: number;
  groups: AutoGroupSyncGroupResult[];
}

function normalizeRegistryName(value: string): string {
  return value.trim().toLowerCase();
}

function repoMappingMatches(registryName: string, repoName: string, repoPath?: string): boolean {
  if (normalizeRegistryName(registryName) === normalizeRegistryName(repoName)) return true;
  if (!repoPath) return false;

  try {
    if (path.isAbsolute(registryName)) {
      return path.resolve(registryName) === path.resolve(repoPath);
    }
  } catch {
    /* registryName is normally an alias, not a filesystem path */
  }

  return false;
}

export async function syncGroupsForAnalyzedRepo(
  options: AutoGroupSyncOptions,
): Promise<AutoGroupSyncResult> {
  const repoName = options.repoName.trim();
  if (!repoName) {
    return { scanned: 0, matched: 0, synced: 0, failed: 0, groups: [] };
  }

  const gitnexusDir = options.gitnexusDir ?? getDefaultGitnexusDir();
  const groupNames = await listGroups(gitnexusDir);
  const groups: AutoGroupSyncGroupResult[] = [];
  const runSync = options.sync ?? syncGroup;

  for (const name of groupNames) {
    const groupDir = getGroupDir(gitnexusDir, name);
    let config: GroupConfig;
    try {
      config = await loadGroupConfig(groupDir);
    } catch (err) {
      groups.push({
        name,
        groupDir,
        memberPaths: [],
        error: err instanceof Error ? err.message : String(err),
      });
      continue;
    }

    const memberPaths = Object.entries(config.repos)
      .filter(([, registryName]) => repoMappingMatches(registryName, repoName, options.repoPath))
      .map(([groupPath]) => groupPath);

    if (memberPaths.length === 0) continue;

    options.onLog?.(
      `  Auto-syncing group "${config.name}" after ${repoName} analysis (${memberPaths.join(', ')})...`,
    );

    try {
      const result = await runSync(config, {
        groupDir,
        allowStale: options.allowStale ?? true,
        exactOnly: options.exactOnly,
        skipEmbeddings: options.skipEmbeddings,
        verbose: options.verbose,
      });
      groups.push({ name: config.name, groupDir, memberPaths, result });
      options.onLog?.(
        `  Group "${config.name}" synced: ${result.contracts.length} contracts, ${result.crossLinks.length} cross-links`,
      );
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      groups.push({ name: config.name, groupDir, memberPaths, error });
      options.onLog?.(`  Group "${config.name}" auto-sync failed: ${error}`);
    }
  }

  const matchedGroups = groups.filter((group) => group.memberPaths.length > 0);
  return {
    scanned: groupNames.length,
    matched: matchedGroups.length,
    synced: matchedGroups.filter((group) => group.result).length,
    failed: groups.filter((group) => group.error).length,
    groups,
  };
}
