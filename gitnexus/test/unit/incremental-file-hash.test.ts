import { describe, it, expect } from 'vitest';
import { mkdtemp, writeFile, rm } from 'fs/promises';
import { tmpdir } from 'os';
import path from 'path';
import { computeFileHash, computeFileHashes, diffFileHashes } from '../../src/storage/file-hash.js';

describe('diffFileHashes', () => {
  it('classifies files into changed / added / deleted / toWrite', () => {
    const stored = { a: 'h-a', b: 'h-b', c: 'h-c' };
    const current = new Map<string, string>([
      ['a', 'h-a'], // unchanged
      ['b', 'h-b-NEW'], // changed
      ['d', 'h-d'], // added
      // 'c' is gone → deleted
    ]);
    const diff = diffFileHashes(current, stored);
    expect(diff.changed).toEqual(['b']);
    expect(diff.added).toEqual(['d']);
    expect(diff.deleted).toEqual(['c']);
    // toWrite is the union of changed ∪ added (rows to be (re)written)
    expect(diff.toWrite.sort()).toEqual(['b', 'd']);
  });

  it('treats no stored map as "everything is added"', () => {
    const current = new Map<string, string>([
      ['x', 'h1'],
      ['y', 'h2'],
    ]);
    const diff = diffFileHashes(current, undefined);
    expect(diff.added.sort()).toEqual(['x', 'y']);
    expect(diff.changed).toEqual([]);
    expect(diff.deleted).toEqual([]);
    expect(diff.toWrite.sort()).toEqual(['x', 'y']);
  });

  it('returns sorted arrays for stable cross-platform comparison', () => {
    const stored = { z: 'h', a: 'h', m: 'h' };
    const current = new Map<string, string>([
      ['z', 'h2'],
      ['a', 'h2'],
      ['m', 'h2'],
    ]);
    const diff = diffFileHashes(current, stored);
    expect(diff.changed).toEqual(['a', 'm', 'z']);
    expect(diff.toWrite).toEqual(['a', 'm', 'z']);
  });

  it('handles empty current map (all stored files become deleted)', () => {
    const stored = { a: 'h1', b: 'h2' };
    const diff = diffFileHashes(new Map(), stored);
    expect(diff.deleted).toEqual(['a', 'b']);
    expect(diff.changed).toEqual([]);
    expect(diff.added).toEqual([]);
  });
});

describe('computeFileHash', () => {
  it('produces a stable SHA-256 hex digest', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'gnx-fh-'));
    try {
      const f = path.join(dir, 'a.txt');
      await writeFile(f, 'hello world\n', 'utf-8');
      const h1 = await computeFileHash(f);
      const h2 = await computeFileHash(f);
      expect(h1).toBe(h2);
      expect(h1).toMatch(/^[a-f0-9]{64}$/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('returns null on missing file (caller treats as "no signature")', async () => {
    const h = await computeFileHash('/definitely/does/not/exist/here.xyz');
    expect(h).toBeNull();
  });

  it('different content → different hash', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'gnx-fh-'));
    try {
      const a = path.join(dir, 'a.txt');
      const b = path.join(dir, 'b.txt');
      await writeFile(a, 'hello', 'utf-8');
      await writeFile(b, 'goodbye', 'utf-8');
      const ha = await computeFileHash(a);
      const hb = await computeFileHash(b);
      expect(ha).not.toBeNull();
      expect(hb).not.toBeNull();
      expect(ha).not.toBe(hb);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('computeFileHashes', () => {
  it('hashes a small batch of files in parallel', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'gnx-fh-'));
    try {
      await writeFile(path.join(dir, 'one.txt'), 'A', 'utf-8');
      await writeFile(path.join(dir, 'two.txt'), 'B', 'utf-8');
      await writeFile(path.join(dir, 'three.txt'), 'C', 'utf-8');
      const map = await computeFileHashes(dir, ['one.txt', 'two.txt', 'three.txt']);
      expect(map.size).toBe(3);
      expect(map.get('one.txt')).toMatch(/^[a-f0-9]{64}$/);
      // All distinct since contents differ
      const hashes = [...map.values()];
      expect(new Set(hashes).size).toBe(3);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('omits files that fail to read (no entry in result)', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'gnx-fh-'));
    try {
      await writeFile(path.join(dir, 'real.txt'), 'X', 'utf-8');
      const map = await computeFileHashes(dir, ['real.txt', 'phantom.txt']);
      expect(map.has('real.txt')).toBe(true);
      expect(map.has('phantom.txt')).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
