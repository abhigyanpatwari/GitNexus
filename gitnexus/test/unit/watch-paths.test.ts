import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createWatchIgnorePredicate } from '../../src/config/ignore-service.js';
import { isRelevantWatchPath, resolveWatchOptions } from '../../src/cli/watch.js';
import * as git from '../../src/storage/git.js';

vi.mock('../../src/storage/git.js', () => ({
  getCoreExcludesFilePath: vi.fn(),
  getGitInfoExcludePath: vi.fn(),
}));

let repoPath: string;

beforeEach(async () => {
  repoPath = await fs.mkdtemp(path.join(os.tmpdir(), 'gitnexus-watch-'));
  vi.mocked(git.getCoreExcludesFilePath).mockReturnValue(null);
  vi.mocked(git.getGitInfoExcludePath).mockReturnValue(null);
});

afterEach(async () => {
  await fs.rm(repoPath, { recursive: true, force: true });
});

describe('watch path selection', () => {
  it('accepts every scanner-admitted file instead of maintaining a second allow-list', () => {
    expect(isRelevantWatchPath('src/service.ts')).toBe(true);
    expect(isRelevantWatchPath('server/app.py')).toBe(true);
    expect(isRelevantWatchPath('backend/project.csproj')).toBe(true);
    expect(isRelevantWatchPath('.gitnexusrc')).toBe(true);
    expect(isRelevantWatchPath('README.md')).toBe(true);
    expect(isRelevantWatchPath('docs/guide.mdx')).toBe(true);
    expect(isRelevantWatchPath('config/application-prod.yml')).toBe(true);
    expect(isRelevantWatchPath('src/main/resources/application.properties')).toBe(true);
    expect(isRelevantWatchPath('templates/page.html')).toBe(true);
    expect(isRelevantWatchPath('templates/page.htm')).toBe(true);
    expect(isRelevantWatchPath('views/page.ejs')).toBe(true);
    expect(isRelevantWatchPath('views/page.hbs')).toBe(true);
    expect(isRelevantWatchPath('views/page.blade.php')).toBe(true);
    expect(
      isRelevantWatchPath(
        'src/main/resources/META-INF/spring/org.springframework.boot.autoconfigure.AutoConfiguration.imports',
      ),
    ).toBe(true);
    expect(isRelevantWatchPath('src/main/resources/META-INF/spring.factories')).toBe(true);
    expect(isRelevantWatchPath('tsconfig.base.json')).toBe(true);
    expect(isRelevantWatchPath('packages/api/tsconfig.build.json')).toBe(true);
    expect(isRelevantWatchPath('schema.sql')).toBe(true);
    expect(isRelevantWatchPath('Dockerfile')).toBe(true);
    expect(isRelevantWatchPath('assets/logo.png')).toBe(true);
    expect(isRelevantWatchPath('../outside.ts')).toBe(false);
    expect(isRelevantWatchPath('C:\\outside.ts')).toBe(false);
  });

  it('honors hardcoded, gitignore, and explicit-unignore rules', async () => {
    await fs.writeFile(
      path.join(repoPath, '.gitignore'),
      ['generated/*', '!generated/', '!generated/keep.ts'].join('\n'),
    );
    const ignored = await createWatchIgnorePredicate(repoPath);

    expect(ignored(path.join(repoPath, 'node_modules', 'pkg', 'index.ts'))).toBe(true);
    expect(ignored(path.join(repoPath, 'generated'), true)).toBe(false);
    expect(ignored(path.join(repoPath, 'generated', 'drop.ts'))).toBe(true);
    expect(ignored(path.join(repoPath, 'generated', 'keep.ts'))).toBe(false);
    expect(ignored(path.join(repoPath, 'src', 'keep.ts'))).toBe(false);
    expect(ignored(path.resolve(repoPath, '..', 'outside.ts'))).toBe(true);
  });

  it('does not partially mutate environment state when a reloaded config is invalid', async () => {
    const names = [
      'GITNEXUS_MAX_FILE_SIZE',
      'GITNEXUS_WORKER_SUB_BATCH_TIMEOUT_MS',
      'GITNEXUS_VERBOSE',
    ] as const;
    const original = Object.fromEntries(names.map((name) => [name, process.env[name]]));
    try {
      await fs.writeFile(
        path.join(repoPath, '.gitnexusrc'),
        JSON.stringify({ maxFileSize: '2048', workerTimeout: '90', workers: '2' }),
      );
      const baseline = { maxFileSize: '512', workerTimeout: '30000', verbose: undefined };
      await resolveWatchOptions(repoPath, {}, baseline);
      expect(process.env.GITNEXUS_MAX_FILE_SIZE).toBe('2048');
      expect(process.env.GITNEXUS_WORKER_SUB_BATCH_TIMEOUT_MS).toBe('90000');

      await fs.writeFile(
        path.join(repoPath, '.gitnexusrc'),
        JSON.stringify({ maxFileSize: '4096', workerTimeout: '120', workers: '0' }),
      );
      await expect(resolveWatchOptions(repoPath, {}, baseline)).rejects.toThrow(
        '--workers must be a positive integer',
      );
      expect(process.env.GITNEXUS_MAX_FILE_SIZE).toBe('2048');
      expect(process.env.GITNEXUS_WORKER_SUB_BATCH_TIMEOUT_MS).toBe('90000');
    } finally {
      for (const name of names) {
        const value = original[name];
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
  });

  it('ignores unsupported repository defaults but rejects explicit unsupported CLI flags', async () => {
    await fs.writeFile(path.join(repoPath, '.gitnexusrc'), JSON.stringify({ embeddings: true }));
    const ignored: string[][] = [];
    await expect(
      resolveWatchOptions(
        repoPath,
        {},
        {
          maxFileSize: undefined,
          workerTimeout: undefined,
          verbose: undefined,
        },
        (names) => ignored.push([...names]),
      ),
    ).resolves.toMatchObject({ skipAgentsMd: true, skipSkills: true });
    expect(ignored).toEqual([['embeddings']]);

    await expect(
      resolveWatchOptions(
        repoPath,
        { embeddings: true },
        {
          maxFileSize: undefined,
          workerTimeout: undefined,
          verbose: undefined,
        },
      ),
    ).rejects.toThrow('analyze --watch does not support --embeddings');
  });

  it('rejects a watch file-size threshold above the parser ceiling', async () => {
    await expect(
      resolveWatchOptions(
        repoPath,
        { maxFileSize: '32769' },
        {
          maxFileSize: undefined,
          workerTimeout: undefined,
          verbose: undefined,
        },
      ),
    ).rejects.toThrow('maxFileSize must not exceed 32768');
  });

  it.skipIf(process.platform === 'win32')(
    'rejects repository ignore files that are final-file symlinks',
    async () => {
      const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'gitnexus-watch-outside-'));
      try {
        const target = path.join(outside, 'ignore');
        await fs.writeFile(target, 'secret.ts\n');
        await fs.symlink(target, path.join(repoPath, '.gitignore'), 'file');
        await expect(createWatchIgnorePredicate(repoPath)).rejects.toThrow(/symbolic link/);
      } finally {
        await fs.rm(outside, { recursive: true, force: true });
      }
    },
  );
});
