import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import * as gitStaleness from '../../src/core/git-staleness.js';
import { LocalBackend } from '../../src/mcp/local/local-backend.js';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

it('reuses metadata across concurrent pages and observes replacements without a registry write', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'gitnexus-discovery-'));
  vi.stubEnv('GITNEXUS_HOME', root);
  const backend = new LocalBackend();
  try {
    const entries = await Promise.all(
      ['alpha', 'bravo', 'charlie', 'delta'].map(async (name) => {
        const repo = path.join(root, name);
        const storagePath = path.join(repo, '.gitnexus');
        const entry = { name, path: repo, storagePath, lastCommit: 'abc123', indexedAt: 'today' };
        await fs.mkdir(path.join(storagePath, 'lbug'), { recursive: true });
        await fs.writeFile(
          path.join(storagePath, 'gitnexus.json'),
          JSON.stringify({ repoPath: repo, storagePath, contentRetention: 'full', fixture: name }),
        );
        return entry;
      }),
    );
    await fs.writeFile(path.join(root, 'registry.json'), JSON.stringify(entries));

    // Count matching input bytes regardless of whether the caller read a path
    // or an open descriptor, synchronously or asynchronously.
    const parse = JSON.parse;
    const parsed: string[] = [];
    vi.spyOn(JSON, 'parse').mockImplementation((input, reviver) => {
      if (typeof input === 'string' && input.includes('"fixture":')) parsed.push(input);
      return parse(input, reviver);
    });
    const freshness = vi.spyOn(gitStaleness, 'checkStalenessAsync').mockResolvedValue({
      isStale: false,
      commitsBehind: 0,
      status: 'current',
    });

    const list = (offset: number) => backend.callTool('list_repos', { limit: 1, offset });
    const [first, last] = await Promise.all([list(0), list(3)]);
    expect(first.pagination.total).toBe(4);
    expect(first.repositories[0]).toMatchObject({ name: 'alpha', sourceAvailable: true });
    expect(last.repositories[0]).toMatchObject({ name: 'delta', staleness: { status: 'unknown' } });
    expect(freshness).not.toHaveBeenCalled();
    expect(parsed).toHaveLength(4);

    await list(1);
    expect(parsed).toHaveLength(4);

    const alpha = entries[0]!;
    const metadata = path.join(alpha.storagePath, 'gitnexus.json');
    await fs.writeFile(
      metadata + '.tmp',
      JSON.stringify({
        repoPath: alpha.path,
        storagePath: alpha.storagePath,
        contentRetention: 'none',
        fixture: 'replacement',
      }),
    );
    await fs.rename(metadata + '.tmp', metadata);
    const replaced = await list(0);
    expect(replaced.repositories[0]).toMatchObject({
      name: 'alpha',
      contentRetention: 'none',
      sourceAvailable: false,
    });
    expect(parsed).toHaveLength(5);
    expect(freshness).not.toHaveBeenCalled();
  } finally {
    await backend.disconnect();
    await fs.rm(root, { recursive: true, force: true });
  }
});
