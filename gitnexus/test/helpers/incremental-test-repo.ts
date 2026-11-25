import { fixtureGitExecutable } from './git-executable.js';
import { execFileSync } from 'node:child_process';
import { getStoragePaths, type RepoMeta } from '../../src/storage/repo-manager.js';

export function withoutAnalysisFeature(meta: RepoMeta, featureId: string): RepoMeta {
  return {
    ...meta,
    analysisFeatures: Object.fromEntries(
      Object.entries(meta.analysisFeatures ?? {}).filter(([id]) => id !== featureId),
    ),
  };
}

export async function readWildcardServiceAnnotations(repoPath: string): Promise<string[]> {
  const adapter = await import('../../src/core/lbug/lbug-adapter.js');
  const { lbugPath } = getStoragePaths(repoPath);
  await adapter.initLbug(lbugPath);
  try {
    const rows = (await adapter.executeQuery(
      "MATCH (c:Class) WHERE c.name = 'WildcardService' " +
        'RETURN c.frameworkAnnotations AS frameworkAnnotations LIMIT 1',
    )) as Array<{ frameworkAnnotations?: unknown }>;
    const value = rows[0]?.frameworkAnnotations;
    return Array.isArray(value)
      ? value.filter((item): item is string => typeof item === 'string')
      : [];
  } finally {
    await adapter.closeLbug();
  }
}

export function gitCommitAll(cwd: string, message: string): void {
  const overrides = ['-c', 'user.name=test', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false'];
  const git = fixtureGitExecutable();
  execFileSync(git, [...overrides, 'add', '-A'], { cwd, stdio: 'pipe' });
  execFileSync(git, [...overrides, 'commit', '-q', '-m', message], { cwd, stdio: 'pipe' });
}
