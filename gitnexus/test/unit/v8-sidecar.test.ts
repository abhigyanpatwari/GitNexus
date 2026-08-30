import { describe, it, expect } from 'vitest';
import { mkdtemp, rm, writeFile, readFile } from 'fs/promises';
import { tmpdir } from 'os';
import path from 'path';
import {
  inspectV8Cache,
  internGraphStrings,
  parseCachePathListing,
  tryLoadV8Cache,
  writeV8CacheFile,
  V8_CACHE_FORMAT,
} from '../../src/storage/v8-sidecar.js';

describe('v8 cache envelope', () => {
  it('interns duplicate strings in place and keeps Map identity', () => {
    const pool = new Map<string, string>();
    const m = new Map([['k', 'dup']]);
    const graph = { a: 'dup', b: 'dup', m };
    internGraphStrings(graph, pool);
    expect(graph.a).toBe(graph.b);
    expect(graph.m).toBe(m);
    expect(graph.m.get('k')).toBe(graph.a);
    expect([...pool.keys()].sort()).toEqual(['dup', 'k']);
    expect(pool.get('dup')).toBe('dup');
  });

  it('round-trips a live graph including Maps', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'v8cf-'));
    try {
      const filePath = path.join(dir, 'shard.v8');
      const graph = { n: 1, nested: { s: 'x' }, map: new Map([['a', 1]]) };
      expect(await writeV8CacheFile(filePath, graph)).toBe(true);
      const hit = await tryLoadV8Cache(filePath);
      expect(hit?.kind).toBe('hit');
      if (hit?.kind !== 'hit') return;
      const value = hit.value as typeof graph;
      expect(value.n).toBe(1);
      expect(value.map).toBeInstanceOf(Map);
      expect(value.map.get('a')).toBe(1);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('skips deserialize when a valid path listing misses wantPaths', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'v8cf-skip-'));
    try {
      const filePath = path.join(dir, 'shard.v8');
      await writeV8CacheFile(filePath, [{ filePath: 'a.c' }], ['a.c']);
      const skip = await tryLoadV8Cache(filePath, undefined, new Set(['other.c']));
      expect(skip?.kind).toBe('skip');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('deserializes when path listing is invalid instead of skipping', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'v8cf-failclosed-'));
    try {
      const filePath = path.join(dir, 'shard.v8');
      await writeV8CacheFile(filePath, [{ filePath: 'a.c' }], ['a.c']);
      const buf = await readFile(filePath);
      const v8len = buf.readUInt16LE(14);
      const pathBytesOff = 16 + v8len + 4;
      const pathBytes = buf.readUInt32LE(pathBytesOff);
      const pathsOff = 16 + v8len + 12;
      buf.fill(0x00, pathsOff, pathsOff + Math.min(pathBytes, 1));
      await writeFile(filePath, buf);
      const hit = await tryLoadV8Cache(filePath, undefined, new Set(['other.c']));
      expect(hit?.kind).toBe('hit');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('treats invalid UTF-8 path listing bytes as untrusted', () => {
    expect(parseCachePathListing(Buffer.from([0x31, 0x0a, 0xff, 0x0a]))).toBeNull();
  });

  it('deserializes when the path listing is invalid UTF-8 instead of skipping', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'v8cf-utf8-'));
    try {
      const filePath = path.join(dir, 'shard.v8');
      await writeV8CacheFile(filePath, [{ filePath: 'a.c' }], ['a.c']);
      const buf = await readFile(filePath);
      const v8len = buf.readUInt16LE(14);
      const pathBytes = buf.readUInt32LE(16 + v8len + 4);
      const pathsOff = 16 + v8len + 12;
      buf.fill(0xff, pathsOff, pathsOff + Math.min(pathBytes, 1));
      await writeFile(filePath, buf);
      const hit = await tryLoadV8Cache(filePath, undefined, new Set(['other.c']));
      expect(hit?.kind).toBe('hit');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('deserializes when the envelope path count disagrees with the listing', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'v8cf-count-'));
    try {
      const filePath = path.join(dir, 'shard.v8');
      await writeV8CacheFile(filePath, [{ filePath: 'a.c' }], ['a.c']);
      const buf = await readFile(filePath);
      const v8len = buf.readUInt16LE(14);
      buf.writeUInt32LE(2, 16 + v8len);
      await writeFile(filePath, buf);
      expect(await inspectV8Cache(filePath)).toBeUndefined();
      const hit = await tryLoadV8Cache(filePath, undefined, new Set(['other.c']));
      expect(hit?.kind).toBe('hit');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('misses when internGraphStrings throws during materialization', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'v8cf-intern-'));
    try {
      const filePath = path.join(dir, 'shard.v8');
      await writeV8CacheFile(filePath, { s: 'x' });
      const pool = new Map<string, string>();
      pool.set = () => {
        throw new Error('intern boom');
      };
      expect(await tryLoadV8Cache(filePath, pool)).toBeUndefined();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('misses when the recorded Node major does not match this runtime', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'v8cf-compat-'));
    try {
      const filePath = path.join(dir, 'shard.v8');
      await writeV8CacheFile(filePath, { ok: true });
      const buf = await readFile(filePath);
      buf.writeUInt16LE(1, 12);
      await writeFile(filePath, buf);
      expect(await tryLoadV8Cache(filePath)).toBeUndefined();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('misses when the recorded V8 version does not match this runtime', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'v8cf-v8-compat-'));
    try {
      const filePath = path.join(dir, 'shard.v8');
      await writeV8CacheFile(filePath, { ok: true });
      const buf = await readFile(filePath);
      buf[16] ^= 1;
      await writeFile(filePath, buf);
      expect(await tryLoadV8Cache(filePath)).toBeUndefined();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('misses when the payload checksum rejects same-size corruption', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'v8cf-payload-'));
    try {
      const filePath = path.join(dir, 'shard.v8');
      await writeV8CacheFile(filePath, { ok: true });
      const buf = await readFile(filePath);
      expect(buf.readUInt32LE(8)).toBe(V8_CACHE_FORMAT);
      const v8len = buf.readUInt16LE(14);
      const pathBytes = buf.readUInt32LE(16 + v8len + 4);
      const payloadOff = 16 + v8len + 12 + pathBytes;
      buf[payloadOff] ^= 0xff;
      await writeFile(filePath, buf);
      expect(await tryLoadV8Cache(filePath)).toBeUndefined();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('misses a garbage magic without throwing', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'v8cf-magic-'));
    try {
      const filePath = path.join(dir, 'shard.v8');
      await writeFile(filePath, Buffer.alloc(64, 7));
      expect(await tryLoadV8Cache(filePath)).toBeUndefined();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
