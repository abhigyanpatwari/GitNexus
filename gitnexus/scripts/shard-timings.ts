import path from 'node:path';

/** Separate native costs from coverage and from the other operating system. */
export function shardTimingsFile(): string {
  const profile = process.env.GITNEXUS_SHARD_PROFILE ?? 'coverage';
  if (!['coverage', 'windows-latest', 'macos-latest'].includes(profile)) {
    throw new Error(`Unknown shard timing profile: ${profile}`);
  }
  return `.vitest/timings/${profile}.json`;
}

/** Matches vitest-shard-balancer's project-qualified timing identity. */
export function shardTimingKey(root: string, moduleId: string, projectName: string): string {
  const relative = path.relative(root, moduleId).split(path.sep).join('/');
  return projectName ? `${projectName}:${relative}` : relative;
}
