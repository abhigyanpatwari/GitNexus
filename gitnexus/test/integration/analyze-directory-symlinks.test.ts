import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { expect, it } from 'vitest';
import lbug from '@ladybugdb/core';
import { walkRepositoryPaths } from '../../src/core/ingestion/filesystem-walker.js';
import { IncludeExtractor } from '../../src/core/group/extractors/include-extractor.js';
import { CLI_SPAWN_PREFIX } from '../helpers/cli-entry.js';

it.skipIf(process.platform === 'win32')(
  'repeated real analyze/status calls converge with directory symlinks (#3608)',
  async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'gn-directory-symlinks-'));
    const repo = path.join(root, 'repo');
    const env = {
      ...process.env,
      GITNEXUS_HOME: path.join(root, 'home'),
      GITNEXUS_SHARED_STORE: 'off',
      GITNEXUS_MEMORY: 'off',
      GITNEXUS_WORKER_READY_TIMEOUT_MS: '60000',
    };
    const command = (args: string[]) =>
      execFileSync(process.execPath, [...CLI_SPAWN_PREFIX, ...args], {
        cwd: repo,
        env,
        encoding: 'utf8',
        timeout: 90_000,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    try {
      await fs.mkdir(path.join(repo, 'app'), { recursive: true });
      await fs.mkdir(path.join(repo, 'shared'));
      await fs.mkdir(path.join(root, 'outside'));
      await fs.writeFile(path.join(root, 'outside/external.h'), '#pragma once\n');
      await fs.writeFile(path.join(repo, 'shared/shared.c'), 'int shared(void){return 1;}\n');
      await fs.writeFile(path.join(repo, 'app/main.c'), 'int main(void){return 0;}\n');
      await fs.symlink('../shared', path.join(repo, 'app/shared'), 'dir');
      await fs.symlink('..', path.join(repo, 'app/parent'), 'dir');
      await fs.symlink('main.c', path.join(repo, 'app/alias.c'), 'file');
      await fs.symlink('missing.c', path.join(repo, 'app/dangling.c'), 'file');
      await fs.symlink('../../outside', path.join(repo, 'app/external.h'), 'dir');
      execFileSync('git', ['init', '-q'], { cwd: repo });
      execFileSync('git', ['add', '.'], { cwd: repo });
      execFileSync(
        'git',
        [
          '-c',
          'user.name=Test',
          '-c',
          'user.email=test@example.invalid',
          'commit',
          '-qm',
          'symlink fixture',
        ],
        { cwd: repo },
      );

      for (let pass = 0; pass < 3; pass++) {
        // Force every pass to scan again, including the unchanged-commit case.
        const output = command(['analyze', repo, '--index-only', '--no-share', '--force']);
        expect(output).toContain('directory symlinks and special files are not indexed');
        const status = JSON.parse(command(['status', '--json']));
        expect(status.current.commit).toBe(status.index.commit);
        expect(status.contentDrift).toMatchObject({ status: 'current' });
        expect(status.status).toBe('up-to-date');
      }
      const paths = (await walkRepositoryPaths(repo)).map((entry) => entry.path);
      expect(paths).toContain('app/alias.c');
      expect(paths).not.toContain('app/shared');
      expect(paths).not.toContain('app/parent');
      expect(paths).not.toContain('app/dangling.c');
      expect(paths).not.toContain('app/external.h');
      const contracts = await new IncludeExtractor().extract(null, repo, {
        id: 'fixture',
        path: 'fixture',
        repoPath: repo,
        storagePath: path.join(repo, '.gitnexus'),
      });
      expect(contracts.some((contract) => contract.symbolUid === 'File:app/external.h')).toBe(
        false,
      );
      // Cold read of the actual persisted graph: excluding directories must not
      // remove the ordinary source files or the existing file-symlink behavior.
      const db = new lbug.Database(
        path.join(repo, '.gitnexus/lbug'),
        256 * 1024 * 1024,
        false,
        true,
      );
      const conn = new lbug.Connection(db);
      try {
        const result = await conn.query('MATCH (f:Function) RETURN f.filePath AS filePath');
        const cursor = Array.isArray(result) ? result[0] : result;
        const rows = (await cursor.getAll()) as unknown as Array<{ filePath: string }>;
        expect(new Set(rows.map((row) => row.filePath))).toEqual(
          new Set(['app/main.c', 'app/alias.c', 'shared/shared.c']),
        );
        cursor.close();
      } finally {
        await conn.close();
        await db.close();
      }
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  },
  240_000,
);
