import { afterEach, describe, expect, it } from 'vitest';
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
