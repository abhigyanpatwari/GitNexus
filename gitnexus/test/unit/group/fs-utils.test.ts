import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { readSafe, readSafeBounded } from '../../../src/core/group/extractors/fs-utils.js';
import { cleanupTempDir } from '../../helpers/test-db.js';

const tempDirs: string[] = [];

describe('group extractor readSafe', () => {
  afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((dir) => cleanupTempDir(dir)));
  });

  it('rejects a path whose canonical target escapes through a directory symlink', async () => {
    const repo = await fs.mkdtemp(path.join(os.tmpdir(), 'gitnexus-readsafe-repo-'));
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'gitnexus-readsafe-outside-'));
    tempDirs.push(repo, outside);
    await fs.writeFile(path.join(outside, 'secret.graphql'), 'query Secret { secret }', 'utf8');
    await fs.symlink(
      outside,
      path.join(repo, 'linked'),
      process.platform === 'win32' ? 'junction' : 'dir',
    );

    await expect(readSafeBounded(repo, 'linked/secret.graphql', 1024)).resolves.toBeNull();
  });

  it('reads a regular file within the canonical repository root', async () => {
    const repo = await fs.mkdtemp(path.join(os.tmpdir(), 'gitnexus-readsafe-repo-'));
    tempDirs.push(repo);
    await fs.writeFile(path.join(repo, 'schema.graphql'), 'query Health { health }', 'utf8');

    expect(readSafe(repo, 'schema.graphql')).toBe('query Health { health }');
    await expect(readSafeBounded(repo, 'schema.graphql', 1024)).resolves.toBe(
      'query Health { health }',
    );
  });

  it('rejects an oversized sparse file before reading its contents', async () => {
    const repo = await fs.mkdtemp(path.join(os.tmpdir(), 'gitnexus-readsafe-repo-'));
    tempDirs.push(repo);
    const file = await fs.open(path.join(repo, 'oversized.graphql'), 'w');
    try {
      await file.truncate(16 * 1024 * 1024);
    } finally {
      await file.close();
    }

    await expect(readSafeBounded(repo, 'oversized.graphql', 1024)).resolves.toBeNull();
  });

  it('accepts a regular file whose size is exactly maxBytes', async () => {
    const repo = await fs.mkdtemp(path.join(os.tmpdir(), 'gitnexus-readsafe-repo-'));
    tempDirs.push(repo);
    await fs.writeFile(path.join(repo, 'exact.graphql'), '12345678', 'utf8');

    await expect(readSafeBounded(repo, 'exact.graphql', 8)).resolves.toBe('12345678');
    await expect(readSafeBounded(repo, 'exact.graphql', 7)).resolves.toBeNull();
  });

  it.skipIf(process.platform === 'win32')(
    'reads a final-file symlink whose canonical target stays inside the repository',
    async () => {
      const repo = await fs.mkdtemp(path.join(os.tmpdir(), 'gitnexus-readsafe-repo-'));
      tempDirs.push(repo);
      await fs.writeFile(path.join(repo, 'schema.graphql'), 'query Health { health }', 'utf8');
      await fs.symlink('schema.graphql', path.join(repo, 'schema-link.graphql'), 'file');

      await expect(readSafeBounded(repo, 'schema-link.graphql', 1024)).resolves.toBe(
        'query Health { health }',
      );
    },
  );

  it.skipIf(process.platform === 'win32')(
    'rejects a final-file symlink whose canonical target escapes the repository',
    async () => {
      const repo = await fs.mkdtemp(path.join(os.tmpdir(), 'gitnexus-readsafe-repo-'));
      const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'gitnexus-readsafe-outside-'));
      tempDirs.push(repo, outside);
      const secret = path.join(outside, 'secret.graphql');
      await fs.writeFile(secret, 'query Secret { secret }', 'utf8');
      await fs.symlink(secret, path.join(repo, 'secret-link.graphql'), 'file');

      await expect(readSafeBounded(repo, 'secret-link.graphql', 1024)).resolves.toBeNull();
    },
  );
});
