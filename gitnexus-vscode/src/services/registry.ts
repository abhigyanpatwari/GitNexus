import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import type { RepoRegistryEntry } from '../types';

interface RegistryPayload {
  repos?: RepoRegistryEntry[];
}

export function getRegistryPath(): string {
  return path.join(os.homedir(), '.gitnexus', 'registry.json');
}

export async function readRegistryRepos(): Promise<RepoRegistryEntry[]> {
  const registryPath = getRegistryPath();

  try {
    const content = await fs.readFile(registryPath, 'utf8');
    const parsed = JSON.parse(content) as RegistryPayload;
    if (!Array.isArray(parsed.repos)) {
      return [];
    }

    return parsed.repos.filter((repo) => typeof repo?.name === 'string' && typeof repo?.path === 'string');
  } catch {
    return [];
  }
}

export function findRepoForWorkspace(workspaceRoot: string, repos: RepoRegistryEntry[]): RepoRegistryEntry | undefined {
  const workspace = path.resolve(workspaceRoot);
  const exact = repos.find((repo) => path.resolve(repo.path) === workspace);
  if (exact) {
    return exact;
  }

  const parentMatches = repos
    .filter((repo) => workspace.startsWith(path.resolve(repo.path) + path.sep))
    .sort((a, b) => b.path.length - a.path.length);

  if (parentMatches.length > 0) {
    return parentMatches[0];
  }

  const childMatches = repos
    .filter((repo) => path.resolve(repo.path).startsWith(workspace + path.sep))
    .sort((a, b) => a.path.length - b.path.length);

  return childMatches[0];
}

export function pickDefaultRepo(
  repos: RepoRegistryEntry[],
  configuredRepo: string | undefined,
  workspaceRoot: string | undefined,
): RepoRegistryEntry | undefined {
  if (repos.length === 0) {
    return undefined;
  }

  if (configuredRepo) {
    const match = repos.find((repo) => repo.name.toLowerCase() === configuredRepo.toLowerCase());
    if (match) {
      return match;
    }
  }

  if (workspaceRoot) {
    const workspaceMatch = findRepoForWorkspace(workspaceRoot, repos);
    if (workspaceMatch) {
      return workspaceMatch;
    }
  }

  return repos[0];
}
