import { describe, expect, it } from 'vitest';
import { buildAnalyzeArgs, shouldIgnoreWatchPath } from '../../src/cli/watch.js';

describe('watch command', () => {
  it('does not force analysis, so manifest checks can skip clean repos', () => {
    const args = buildAnalyzeArgs('/repo', {});

    expect(args).toContain('analyze');
    expect(args).toContain('/repo');
    expect(args).not.toContain('--force');
  });

  it('passes through analyze options', () => {
    const args = buildAnalyzeArgs('/repo', {
      embeddings: true,
      skipGit: true,
      name: 'alias',
      maxFileSize: '512',
      workerTimeout: '2',
    });

    expect(args).toEqual(
      expect.arrayContaining([
        '--embeddings',
        '--skip-git',
        '--name',
        'alias',
        '--max-file-size',
        '512',
        '--worker-timeout',
        '2',
      ]),
    );
  });

  it('ignores index and build output paths', () => {
    expect(shouldIgnoreWatchPath('.gitnexus/meta.json')).toBe(true);
    expect(shouldIgnoreWatchPath('src/index.ts')).toBe(false);
  });
});
