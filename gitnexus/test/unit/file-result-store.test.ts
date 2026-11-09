import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import v8 from 'node:v8';
import { mkdtemp, rm, readFile, writeFile, readdir, appendFile, mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import {
  encodeFileResultSection,
  decodeFileResultSection,
  inspectFileResultSection,
  MAX_FILE_RESULT_SECTION_BYTES,
} from '../../src/storage/file-result-codec.js';
import {
  emptyFileResultStore,
  appendFileResults,
  writeFileResultIndex,
  loadFileResultStore,
  readFileResults,
  pinFileResults,
  loadPackedFileScopes,
} from '../../src/storage/file-result-store.js';
import {
  encodeV8CacheBuffer,
  decodeV8CacheBuffer,
  inspectV8CacheBuffer,
} from '../../src/storage/v8-sidecar.js';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
const temporary = async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'gn-file-results-'));
  roots.push(root);
  return root;
};
const key = (s: string) => createHash('sha256').update(s).digest('hex');
const record = (name: string) => ({
  key: key(name),
  path: name,
  cacheable: true,
  facts: encodeFileResultSection(key(name), name, 'facts', { nodes: [name] })!,
  scopes: encodeFileResultSection(key(name), name, 'scopes', [
    { filePath: name, scopes: new Map() },
  ])!,
});

describe('file-result codec', () => {
  it.each(['we\nird.ts', 'we\rird.ts', 'we\0ird.ts'])(
    'leaves an unlistable path %j to the raw worker fallback',
    (name) => {
      expect(encodeFileResultSection(key(name), name, 'facts', { nodes: [] })).toBeUndefined();
      expect(encodeFileResultSection(key(name), name, 'scopes', [])).toBeUndefined();
    },
  );
  it.each(['gzip', 'zstd'] as const)(
    'decodes large %s sections while enforcing the output limit',
    (codec) => {
      const value = { data: Uint8Array.from({ length: 128 * 1024 }, (_, i) => i % 251) };
      const encoded = encodeFileResultSection(key('large'), 'large.ts', 'scopes', value, codec)!;
      expect(decodeFileResultSection(encoded, key('large'), 'large.ts', 'scopes')?.value).toEqual(
        value,
      );
      const shortened = Buffer.from(encoded);
      shortened.writeUInt32LE(encoded.readUInt32LE(1) - 1, 1);
      expect(
        decodeFileResultSection(shortened, key('large'), 'large.ts', 'scopes'),
      ).toBeUndefined();
    },
  );

  it('rejects a different file, key or section before deserializing', () => {
    const encoded = record('a.ts').facts;
    const deserialize = vi.spyOn(v8, 'deserialize');
    try {
      expect(decodeFileResultSection(encoded, key('b.ts'), 'a.ts', 'facts')).toBeUndefined();
      expect(decodeFileResultSection(encoded, key('a.ts'), 'b.ts', 'facts')).toBeUndefined();
      expect(decodeFileResultSection(encoded, key('a.ts'), 'a.ts', 'scopes')).toBeUndefined();
      expect(deserialize).not.toHaveBeenCalled();
      expect(decodeFileResultSection(encoded, key('a.ts'), 'a.ts', 'facts')?.value).toEqual({
        nodes: ['a.ts'],
      });
      expect(deserialize).toHaveBeenCalledTimes(1);
    } finally {
      deserialize.mockRestore();
    }
  });
  it.each(['gzip', 'zstd'] as const)(
    'preserves Maps, Sets and shared references with %s',
    (codec) => {
      const shared = { name: 'definition' };
      const value = { list: [shared], bindings: new Map([['x', shared]]), set: new Set([shared]) };
      const encoded = encodeFileResultSection(key('a'), 'a.ts', 'scopes', value, codec)!;
      const decoded = decodeFileResultSection(encoded, key('a'), 'a.ts', 'scopes')!
        .value as typeof value;
      expect(decoded).toEqual(value);
      expect(decoded.list[0]).toBe(decoded.bindings.get('x'));
      expect(decoded.set.has(decoded.list[0])).toBe(true);
      expect(inspectFileResultSection(encoded, key('b'), 'a.ts', 'scopes')).toBe(false);
      expect(inspectFileResultSection(encoded, key('a'), 'b.ts', 'scopes')).toBe(false);
      expect(inspectFileResultSection(encoded, key('a'), 'a.ts', 'facts')).toBe(false);
    },
  );
  it('rejects corruption, invalid codec, excessive lengths and truncated input', () => {
    const good = record('a.ts').facts;
    for (const mutate of [
      (b: Buffer) => {
        b[0] = 9;
      },
      (b: Buffer) => {
        b.writeUInt32LE(MAX_FILE_RESULT_SECTION_BYTES + 1, 1);
      },
      (b: Buffer) => {
        b[b.length - 3] ^= 255;
      },
    ]) {
      const bad = Buffer.from(good);
      mutate(bad);
      expect(decodeFileResultSection(bad, key('a.ts'), 'a.ts', 'facts')).toBeUndefined();
    }
    expect(
      decodeFileResultSection(good.subarray(0, 3), key('a.ts'), 'a.ts', 'facts'),
    ).toBeUndefined();
  });
  it('retains V8 runtime and authenticated-listing checks', () => {
    const encoded = encodeV8CacheBuffer(new Map([['x', 1]]), ['a.ts'])!;
    expect(decodeV8CacheBuffer(encoded)?.value).toEqual(new Map([['x', 1]]));
    for (const offset of [8, 12, 16, encoded.length - 1]) {
      const changed = Buffer.from(encoded);
      changed[offset] ^= 1;
      expect(inspectV8CacheBuffer(changed)).toBeUndefined();
    }
    expect(decodeV8CacheBuffer(encoded.subarray(0, encoded.length - 1))).toBeUndefined();
    expect(encodeV8CacheBuffer({ callback: () => {} }, [])).toBeUndefined();
  });
});

describe('packed file-result store', () => {
  it.each(['missing', 'unreadable'])('treats a %s scope manifest as a miss', async (kind) => {
    const root = await temporary();
    if (kind === 'unreadable')
      await mkdir(path.join(root, 'parsedfile-store', 'file-results', 'scopes.ndjson'), {
        recursive: true,
      });
    const loaded = [];
    for await (const hit of loadPackedFileScopes(root, new Set(['a.ts']), new Map()))
      loaded.push(hit);
    expect(loaded).toEqual([]);
  });

  it('rotates a pack after an append writes bytes and then fails', async () => {
    const root = await temporary();
    const store = emptyFileResultStore(root, 'identity');
    const a = record('a.ts'),
      b = record('b.ts'),
      c = record('c.ts');
    await appendFileResults(store, [a]);
    const append = fs.appendFile;
    const failure = vi.spyOn(fs, 'appendFile').mockImplementationOnce(async (file, data) => {
      await append(file, (data as Buffer).subarray(0, 5));
      throw new Error('short append');
    });
    try {
      await expect(appendFileResults(store, [b])).rejects.toThrow('short append');
    } finally {
      failure.mockRestore();
    }
    await appendFileResults(store, [c]);
    expect(store.records.has(b.key)).toBe(false);
    expect(store.records.get(c.key)?.pack).not.toBe(store.records.get(a.key)?.pack);
    expect([...(await readFileResults(store, [a.key, c.key])).keys()]).toEqual([a.key, c.key]);
  });
  it('does not prefetch gaps between sparse selections during publication', async () => {
    const root = await temporary();
    const store = emptyFileResultStore(root, 'identity');
    const records = Array.from({ length: 512 }, (_, i) => record(`file${i}.ts`));
    await appendFileResults(store, records);
    const wanted = [records[0], records[511]];
    const open = fs.open;
    const reads: ReturnType<typeof vi.spyOn>[] = [];
    const opening = vi.spyOn(fs, 'open').mockImplementation(async (...args) => {
      const handle = await open(...args);
      reads.push(vi.spyOn(handle, 'read'));
      return handle;
    });
    try {
      expect([
        ...(
          await readFileResults(
            store,
            wanted.map((r) => r.key),
          )
        ).keys(),
      ]).toEqual(wanted.map((r) => r.key));
      expect(
        reads.flatMap((read) => read.mock.calls).map(([buffer]) => (buffer as Buffer).length),
      ).toEqual(wanted.map((r) => r.facts.length + r.scopes.length));
      for (const read of reads) read.mockClear();
      await pinFileResults(
        store,
        wanted.map((r) => r.key),
        root,
      );
      const scopes = [];
      for await (const hit of loadPackedFileScopes(
        root,
        new Set(wanted.map((r) => r.path)),
        new Map(),
      ))
        scopes.push(hit.paths?.[0]);
      expect(scopes).toEqual(wanted.map((r) => r.path));
      expect(
        reads.flatMap((read) => read.mock.calls).map(([buffer]) => (buffer as Buffer).length),
      ).toEqual(wanted.map((r) => r.scopes.length));
    } finally {
      opening.mockRestore();
      for (const read of reads) read.mockRestore();
    }
  });

  it('retains an intact record when a read-ahead window is truncated after stat', async () => {
    const root = await temporary();
    const store = emptyFileResultStore(root, 'identity');
    const a = record('a.ts'),
      b = record('b.ts');
    await appendFileResults(store, [a, b]);
    const open = fs.open;
    vi.spyOn(fs, 'open').mockImplementation(async (...args) => {
      const handle = await open(...args);
      const stat = handle.stat.bind(handle);
      vi.spyOn(handle, 'stat').mockImplementation(async () => {
        const size = await stat();
        await fs.truncate(args[0], a.facts.length + a.scopes.length + 5);
        return size;
      });
      return handle;
    });
    try {
      expect([...(await readFileResults(store, [a.key, b.key])).keys()]).toEqual([a.key]);
    } finally {
      vi.restoreAllMocks();
    }
  });

  it('amortizes adjacent reads in bounded windows for facts and scopes', async () => {
    const root = await temporary();
    const store = emptyFileResultStore(path.join(root, 'packs'), 'identity');
    const records = Array.from({ length: 512 }, (_, i) => record(`file${i}.ts`));
    await appendFileResults(store, records);
    await pinFileResults(
      store,
      records.map((r) => r.key),
      root,
    );
    const open = fs.open;
    const reads: ReturnType<typeof vi.spyOn>[] = [];
    const opening = vi.spyOn(fs, 'open').mockImplementation(async (...args) => {
      const handle = await open(...args);
      reads.push(vi.spyOn(handle, 'read'));
      return handle;
    });
    try {
      const selected = await readFileResults(
        store,
        records.map((r) => r.key),
      );
      expect([...selected.keys()]).toEqual(records.map((r) => r.key));
      const scopes = [];
      for await (const hit of loadPackedFileScopes(
        root,
        new Set(records.map((r) => r.path)),
        new Map(),
      ))
        scopes.push(hit.paths?.[0]);
      expect(scopes).toEqual(records.map((r) => r.path));
      const calls = reads.flatMap((read) => read.mock.calls);
      expect(calls.length).toBeLessThan(32);
      for (const [buffer] of calls) {
        expect(Buffer.isBuffer(buffer)).toBe(true);
        expect((buffer as Buffer).length).toBeLessThanOrEqual(64 * 1024);
      }
    } finally {
      opening.mockRestore();
      for (const read of reads) read.mockRestore();
    }
  });

  it('reads oversized records and backward selections without losing neighbouring bytes', async () => {
    const root = await temporary();
    const store = emptyFileResultStore(root, 'identity');
    const a = record('a.ts'),
      b = record('b.ts'),
      c = record('c.ts');
    // Store bytes are opaque here: exceed the read-ahead window without relying
    // on a particular compression ratio.
    b.facts = Buffer.alloc(96 * 1024, 7);
    b.scopes = Buffer.alloc(96 * 1024, 9);
    await appendFileResults(store, [a, b, c]);
    const selected = await readFileResults(store, [c.key, b.key, a.key]);
    expect([...selected.values()].map((r) => [r.facts, r.scopes])).toEqual(
      [c, b, a].map((r) => [r.facts, r.scopes]),
    );
  });

  it('keeps a later snapshot readable after an interrupted manifest append', async () => {
    const root = await temporary();
    const store = emptyFileResultStore(path.join(root, 'packs'), 'identity');
    const b = record('b.ts');
    await appendFileResults(store, [b]);
    const snapshot = path.join(root, 'parsedfile-store', 'file-results');
    await mkdir(snapshot, { recursive: true });
    // A failed append may leave bytes before returning its I/O error.
    await writeFile(path.join(snapshot, 'scopes.ndjson'), '{"key":"interrupted');
    await pinFileResults(store, [b.key], root);
    const loaded = [];
    for await (const hit of loadPackedFileScopes(root, new Set(['b.ts']), new Map()))
      loaded.push(hit.value);
    expect(loaded).toEqual([[{ filePath: 'b.ts', scopes: new Map() }]]);
  });

  it('packs many files, reloads lazily and pins scopes across live-store rotation', async () => {
    const root = await temporary();
    const live = path.join(root, 'live');
    const store = emptyFileResultStore(live, 'identity');
    const records = Array.from({ length: 100 }, (_, i) => record(`file${i}.ts`));
    await appendFileResults(store, records);
    await writeFileResultIndex(store);
    expect((await readdir(live)).filter((f) => f.endsWith('.pack'))).toHaveLength(1);
    const loaded = await loadFileResultStore(live, 'identity');
    expect((await loadFileResultStore(live, 'other')).records.size).toBe(0);
    const selected = await readFileResults(loaded, [records[0].key, records[99].key]);
    expect([...selected.keys()]).toEqual([records[0].key, records[99].key]);
    const snapshot = path.join(root, 'snapshot');
    await pinFileResults(loaded, [records[0].key], snapshot);
    await rm(live, { recursive: true });
    const scopes = [];
    for await (const hit of loadPackedFileScopes(snapshot, new Set(['file0.ts']), new Map()))
      scopes.push(hit.value);
    expect(scopes).toEqual([[{ filePath: 'file0.ts', scopes: new Map() }]]);
  });
  it('validates offsets and checksums without losing healthy neighbours', async () => {
    const root = await temporary();
    const store = emptyFileResultStore(root, 'identity');
    const a = record('a.ts'),
      b = record('b.ts');
    await appendFileResults(store, [a, b]);
    const ref = store.records.get(a.key)!;
    const pack = path.join(root, ref.pack);
    const bytes = await readFile(pack);
    bytes[ref.offset + 8] ^= 255;
    await writeFile(pack, bytes);
    expect([...(await readFileResults(store, [a.key, b.key])).keys()]).toEqual([b.key]);
    store.records.set(b.key, { ...store.records.get(b.key)!, offset: Number.MAX_SAFE_INTEGER });
    expect((await readFileResults(store, [b.key])).size).toBe(0);
  });
  it('rejects malformed manifests and truncated packs', async () => {
    const root = await temporary();
    const store = emptyFileResultStore(root, 'identity');
    const a = record('a.ts');
    await appendFileResults(store, [a]);
    await writeFileResultIndex(store);
    const ref = store.records.get(a.key)!;
    await writeFile(path.join(root, ref.pack), 'truncated');
    expect((await readFileResults(store, [a.key])).size).toBe(0);
    await appendFile(path.join(root, 'index.json'), '!');
    expect((await loadFileResultStore(root, 'identity')).records.size).toBe(0);
  });
  it('excludes incomplete records and reports failed writes without admitting offsets', async () => {
    const root = await temporary();
    const store = emptyFileResultStore(root, 'identity');
    await appendFileResults(store, [{ ...record('a.ts'), cacheable: false }]);
    expect(store.records.size).toBe(0);
    const bad = path.join(root, 'not-a-directory');
    await writeFile(bad, 'file');
    const failed = emptyFileResultStore(bad, 'identity');
    await expect(appendFileResults(failed, [record('b.ts')])).rejects.toThrow();
    expect(failed.records.size).toBe(0);
  });
});
