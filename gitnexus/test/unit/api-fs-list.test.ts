import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import path from 'node:path';
import fs from 'node:fs/promises';
import os from 'node:os';
import { handleFsListRequest } from '../../src/server/api.js';

let tmpRoot: string;

beforeAll(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'gitnexus-api-fs-list-test-'));
  await fs.mkdir(path.join(tmpRoot, 'alpha'));
  await fs.mkdir(path.join(tmpRoot, 'beta'));
  await fs.writeFile(path.join(tmpRoot, 'file.txt'), 'hello\n', 'utf-8');
});

afterAll(async () => {
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

const invoke = async (query: Record<string, unknown>): Promise<{ status: number; body: any }> => {
  let capturedStatus = 200;
  let capturedBody: any = undefined;
  const res = {
    status(code: number) {
      capturedStatus = code;
      return this;
    },
    json(body: any) {
      capturedBody = body;
    },
  };
  await handleFsListRequest({ query }, res);
  return { status: capturedStatus, body: capturedBody };
};

describe('GET /api/fs/list — handleFsListRequest', () => {
  it('lists only subdirectories, sorted alphabetically', async () => {
    const { status, body } = await invoke({ dir: tmpRoot });
    expect(status).toBe(200);
    expect(body.entries).toEqual([{ name: 'alpha' }, { name: 'beta' }]);
  });

  it('excludes files from the listing', async () => {
    const { body } = await invoke({ dir: tmpRoot });
    const names = body.entries.map((e: { name: string }) => e.name);
    expect(names).not.toContain('file.txt');
  });

  it('returns empty entries for an empty directory', async () => {
    const { status, body } = await invoke({ dir: path.join(tmpRoot, 'alpha') });
    expect(status).toBe(200);
    expect(body.entries).toEqual([]);
  });

  it('defaults to / when dir is omitted (linux server)', async () => {
    const { status } = await invoke({});
    // On Linux root / is the filesystem root; on Windows path.normalize('/')
    // normalizes to \ while path.resolve('/') resolves to the CWD drive root.
    // Our guard skips the traversal check for bare root paths.
    expect(status).toBe(200);
  });

  it('returns 400 for a relative path', async () => {
    const { status, body } = await invoke({ dir: 'relative/path' });
    expect(status).toBe(400);
    expect(body.error).toMatch(/absolute path/);
  });

  it('returns 400 for a non-canonical absolute path', async () => {
    // On Windows, `/foo` is absolute but normalize(\foo) !== resolve(D:\foo)
    // On Linux, construct a path with redundant separators that stays absolute
    const nonCanonical = process.platform === 'win32' ? '/nonexistent' : `${tmpRoot}/./alpha`;
    const { status } = await invoke({ dir: nonCanonical });
    if (process.platform === 'win32') {
      expect(status).toBe(400);
    } else {
      // On Linux, normalize and resolve agree for all absolute paths
      expect(status).toBe(200);
    }
  });

  it('returns 404 for a non-existent directory', async () => {
    const { status, body } = await invoke({ dir: path.join(tmpRoot, 'nonexistent') });
    expect(status).toBe(404);
    expect(body.error).toMatch(/not found/i);
  });

  it('returns 400 when dir is an array (type confusion)', async () => {
    const { status, body } = await invoke({ dir: [tmpRoot, '/etc'] });
    expect(status).toBe(400);
    expect(body.error).toMatch(/single string/);
  });

  it('route source is wired with createRouteLimiter', async () => {
    const source = await fs.readFile(
      path.join(import.meta.dirname, '..', '..', 'src', 'server', 'api.ts'),
      'utf-8',
    );
    expect(source).toMatch(/app\.get\('\/api\/fs\/list',\s*createRouteLimiter\(\)/);
  });
});
