/**
 * Handler tests for MCP read_file and grep.
 *
 * Registry tests only count tool names. These call LocalBackend.callTool
 * against a temp checkout and a mocked File-node query, with the real grep
 * worker, so retention, containment, the 1-based/0-based handoff, and the
 * checkout-vs-pin contract are actually executed.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const { lbugMocks } = vi.hoisted(() => ({
  lbugMocks: {
    initLbug: vi.fn().mockResolvedValue(undefined),
    executeQuery: vi.fn().mockResolvedValue([]),
    executeParameterized: vi.fn().mockResolvedValue([]),
    ensureVectorExtension: vi.fn().mockResolvedValue(true),
    closeLbug: vi.fn().mockResolvedValue(undefined),
    isLbugReady: vi.fn().mockReturnValue(true),
  },
}));

vi.mock('../../src/core/lbug/pool-adapter.js', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, ...lbugMocks };
});

vi.mock('../../src/mcp/core/lbug-adapter.js', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, ...lbugMocks };
});

vi.mock('../../src/storage/repo-manager.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/storage/repo-manager.js')>();
  return {
    ...actual,
    listRegisteredRepos: vi.fn().mockResolvedValue([]),
  };
});

vi.mock('../../src/core/git-staleness.js', () => ({
  checkStaleness: vi.fn().mockReturnValue({ isStale: false, commitsBehind: 0 }),
  checkStalenessAsync: vi.fn().mockResolvedValue({ isStale: false, commitsBehind: 0 }),
  checkCwdMatch: vi.fn().mockResolvedValue({ match: 'none' }),
}));

import { LocalBackend } from '../../src/mcp/local/local-backend.js';
import { executeQuery } from '../../src/mcp/core/lbug-adapter.js';
import { listRegisteredRepos } from '../../src/storage/repo-manager.js';

const NAME = 'checkout-src';
const INDEXED_AT = '2024-06-01T12:00:00Z';

const dirs: string[] = [];

const writeMeta = async (storage: string, contentRetention: 'full' | 'symbol' | 'none') => {
  await fs.writeFile(
    path.join(storage, 'gitnexus.json'),
    JSON.stringify({ contentRetention, indexedAt: INDEXED_AT }),
    'utf-8',
  );
};

describe('LocalBackend read_file and grep', () => {
  let root: string;
  let storage: string;
  let backend: LocalBackend;
  let symlinks = false;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'gnx-mcp-src-'));
    dirs.push(root);
    storage = path.join(root, '.gitnexus');
    await fs.mkdir(path.join(storage, 'lbug'), { recursive: true });
    await writeMeta(storage, 'full');
    await fs.mkdir(path.join(root, 'src'), { recursive: true });
    await fs.writeFile(path.join(root, 'src', 'auth.ts'), 'signOrder()\nnoop\n', 'utf-8');
    await fs.writeFile(path.join(root, 'literals.txt'), 'a.b\naxb\n', 'utf-8');
    await fs.writeFile(path.join(root, 'case.txt'), 'Token\ntoken\n', 'utf-8');
    await fs.writeFile(path.join(root, '..config'), 'dotfile\n', 'utf-8');
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'gnx-mcp-out-'));
    dirs.push(outside);
    await fs.writeFile(path.join(outside, 'secret.txt'), 'top secret\n', 'utf-8');
    try {
      await fs.symlink(path.join(outside, 'secret.txt'), path.join(root, 'escape.txt'));
      symlinks = true;
    } catch {
      symlinks = false;
    }

    vi.mocked(listRegisteredRepos).mockResolvedValue([
      {
        name: NAME,
        path: root,
        storagePath: storage,
        indexedAt: INDEXED_AT,
        lastCommit: 'abc123',
      } as Awaited<ReturnType<typeof listRegisteredRepos>>[number],
    ]);
    vi.mocked(executeQuery).mockResolvedValue([
      { filePath: 'src/auth.ts' },
      { filePath: 'literals.txt' },
      { filePath: 'case.txt' },
      { filePath: '..config' },
    ]);
    backend = new LocalBackend();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  const read = (params: Record<string, unknown>) =>
    backend.callTool('read_file', { repo: NAME, ...params });
  const grep = (params: Record<string, unknown>) =>
    backend.callTool('grep', { repo: NAME, ...params });

  it('slices 0-based and maps a 1-based grep hit onto that window', async () => {
    const hits = await grep({ pattern: 'signOrder' });
    expect(hits.results).toEqual([
      expect.objectContaining({ filePath: 'src/auth.ts', line: 1, text: 'signOrder()' }),
    ]);
    const hitLine = hits.results[0].line as number;
    const window = await read({
      path: 'src/auth.ts',
      startLine: hitLine - 1,
      endLine: hitLine - 1,
    });
    expect(window.content).toBe('signOrder()');
    const offByOne = await read({ path: 'src/auth.ts', startLine: hitLine, endLine: hitLine });
    expect(offByOne.content).toBe('noop');
  });

  it('rejects endLine without startLine instead of returning the whole file', async () => {
    const out = await read({ path: 'src/auth.ts', endLine: 0 });
    expect(out).toEqual({ error: '"endLine" requires "startLine".' });
  });

  it('caps a whole-file read at maxLines', async () => {
    const out = await read({ path: 'src/auth.ts', maxLines: 1 });
    expect(out.truncated).toBe(true);
    expect(out.content).toBe('signOrder()');
    expect(out.totalLines).toBe(3);
  });

  it('reads a contained absolute path and a file whose name starts with ..', async () => {
    const absolute = await read({ path: path.join(root, 'src', 'auth.ts') });
    expect(absolute.content).toContain('signOrder()');
    const dot = await read({ path: '..config' });
    expect(dot.content).toBe('dotfile\n');
  });

  it('refuses traversal, a symlink out of the repo, and a missing file', async () => {
    expect((await read({ path: '../secret.txt' })).error).toBe('Path traversal denied.');
    expect((await read({ path: '/etc/passwd' })).error).toBe('Path traversal denied.');
    if (symlinks) {
      expect((await read({ path: 'escape.txt' })).error).toBe('Path traversal denied.');
    }
    expect((await read({ path: 'missing.ts' })).error).toBe('File not found: missing.ts');
  });

  it('errors when retention is not full, instead of an empty grep or a file body', async () => {
    await writeMeta(storage, 'symbol');
    vi.mocked(executeQuery).mockClear();
    const file = await read({ path: 'src/auth.ts' });
    const hits = await grep({ pattern: 'signOrder' });
    expect(file).toMatchObject({ code: 'source-unavailable', reason: 'content-retention' });
    expect(file.content).toBeUndefined();
    expect(hits).toMatchObject({ code: 'source-unavailable', reason: 'content-retention' });
    expect(hits.results).toBeUndefined();
    expect(executeQuery).not.toHaveBeenCalled();
  });

  it('errors when the checkout directory is gone, including for grep', async () => {
    const orphanStorage = await fs.mkdtemp(path.join(os.tmpdir(), 'gnx-mcp-meta-'));
    dirs.push(orphanStorage);
    await fs.mkdir(path.join(orphanStorage, 'lbug'), { recursive: true });
    await writeMeta(orphanStorage, 'full');
    const missingCheckout = path.join(orphanStorage, 'gone');
    vi.mocked(listRegisteredRepos).mockResolvedValue([
      {
        name: 'gone',
        path: missingCheckout,
        storagePath: orphanStorage,
        indexedAt: INDEXED_AT,
        lastCommit: 'abc123',
      } as Awaited<ReturnType<typeof listRegisteredRepos>>[number],
    ]);
    const other = new LocalBackend();
    const file = await other.callTool('read_file', { repo: 'gone', path: 'src/auth.ts' });
    const hits = await other.callTool('grep', { repo: 'gone', pattern: 'signOrder' });
    expect(file).toMatchObject({ code: 'source-unavailable', reason: 'checkout-missing' });
    expect(file.error).not.toMatch(/File not found/);
    expect(hits).toMatchObject({ code: 'source-unavailable', reason: 'checkout-missing' });
    expect(hits.results).toBeUndefined();
  });

  it('sees checkout edits after indexing and honors literal plus caseSensitive', async () => {
    await fs.writeFile(path.join(root, 'src', 'auth.ts'), 'TOKEN_MAIN\n', 'utf-8');
    const edited = await grep({ pattern: 'TOKEN_MAIN' });
    expect(edited.results).toEqual([expect.objectContaining({ filePath: 'src/auth.ts', line: 1 })]);
    const stale = await grep({ pattern: 'signOrder' });
    expect(stale.results).toEqual([]);

    const regex = await grep({ pattern: 'a.b', fileFilter: 'literals' });
    expect(regex.results.map((hit: { text: string }) => hit.text).sort()).toEqual(['a.b', 'axb']);
    const literal = await grep({ pattern: 'a.b', literal: true, fileFilter: 'literals' });
    expect(literal.results).toEqual([expect.objectContaining({ text: 'a.b' })]);

    const insensitive = await grep({ pattern: 'Token', fileFilter: 'case.txt' });
    expect(insensitive.results).toHaveLength(2);
    const sensitive = await grep({ pattern: 'Token', caseSensitive: true, fileFilter: 'case.txt' });
    expect(sensitive.results).toEqual([expect.objectContaining({ text: 'Token', line: 1 })]);
  });

  it('rejects branch before resolving a pinned index', async () => {
    const file = await backend.callTool('read_file', {
      path: 'src/auth.ts',
      branch: 'release',
    });
    const hits = await backend.callTool('grep', { pattern: 'signOrder', branch: 'release' });
    expect(file.error).toMatch(/does not accept "branch"/);
    expect(file.content).toBeUndefined();
    expect(hits.error).toMatch(/does not accept "branch"/);
    expect(hits.results).toBeUndefined();
    expect(executeQuery).not.toHaveBeenCalled();
  });
});

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});
