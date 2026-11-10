import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import v8 from 'node:v8';
import * as storeApi from '../../src/storage/file-result-store.js';
import * as codec from '../../src/storage/file-result-codec.js';
import { tryLoadV8Cache, writeV8CacheFile } from '../../src/storage/v8-sidecar.js';

const reader = new URL('../../bench/v8-sidecar/cache-payloads.mjs', import.meta.url);
const { loadCachePayloads } = await import(reader.href);
const loaders = {
  tryLoadV8Cache,
  loadPackedModules: async () => ({ ...storeApi, ...codec }),
};
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function temporary() {
  const root = await mkdtemp(path.join(tmpdir(), 'intern-corpus-'));
  roots.push(root);
  return root;
}
async function packed() {
  const root = await temporary();
  const shared = { name: 'shared symbol' };
  const values = [
    { nodes: [shared], alias: shared },
    { bindings: new Map([['shared symbol', shared]]), members: new Set([shared]), alias: shared },
  ];
  const store = storeApi.emptyFileResultStore(path.join(root, 'parse-cache/files'), 'test-parser');
  const key = createHash('sha256').update('a.ts').digest('hex');
  await storeApi.appendFileResults(store, [
    {
      key,
      path: 'a.ts',
      cacheable: true,
      facts: codec.encodeFileResultSection(key, 'a.ts', 'facts', values[0])!,
      scopes: codec.encodeFileResultSection(key, 'a.ts', 'scopes', values[1])!,
    },
  ]);
  await storeApi.writeFileResultIndex(store);
  const index = { format: 'file-results-v1', version: store.identity, keys: [key] };
  await writeFile(path.join(root, 'parse-cache/index.json'), JSON.stringify(index));
  return { root, store, key, values, index };
}

describe('cache interning benchmark corpus', () => {
  it('loads both packed sections with Maps, Sets, aliases and deterministic bytes intact', async () => {
    const { root, values } = await packed();
    const result = await loadCachePayloads(root, loaders);
    expect(result.format).toBe('file-results-v1');
    expect(result.payloads).toEqual((await loadCachePayloads(root, loaders)).payloads);
    const [facts, scopes] = result.payloads.map((value: Buffer) => v8.deserialize(value));
    expect([facts, scopes]).toEqual(values);
    expect(facts.nodes[0]).toBe(facts.alias);
    expect(scopes.bindings.get('shared symbol')).toBe(scopes.alias);
    expect(scopes.members.has(scopes.alias)).toBe(true);
  });

  it.each([
    'missing-record',
    'missing-pack',
    'corrupt-pack',
    'wrong-section',
    'duplicate-key',
    'empty',
  ])('rejects %s instead of benchmarking a partial packed corpus', async (damage) => {
    const { root, store, key, index } = await packed();
    const ref = store.records.get(key)!;
    const pack = path.join(store.directory, ref.pack);
    if (damage === 'missing-record') store.records.clear();
    if (damage === 'missing-pack') await rm(pack);
    if (damage === 'corrupt-pack') await writeFile(pack, Buffer.from('broken'));
    if (damage === 'wrong-section') {
      const bytes = await readFile(pack);
      const facts = bytes.subarray(ref.offset, ref.offset + ref.factsLength);
      // Keep the range checksum valid while violating the envelope's section binding.
      await writeFile(pack, Buffer.concat([facts, facts]));
      ref.scopesLength = ref.factsLength;
      ref.scopesHash = ref.factsHash;
    }
    if (damage === 'duplicate-key') index.keys.push(key);
    if (damage === 'empty') {
      index.keys = [];
      store.records.clear();
    }
    await storeApi.writeFileResultIndex(store);
    await writeFile(path.join(root, 'parse-cache/index.json'), JSON.stringify(index));
    await expect(loadCachePayloads(root, loaders)).rejects.toThrow();
  });

  it('reads both legacy cache directories without requiring packed APIs', async () => {
    const root = await temporary();
    for (const [directory, name] of [
      ['parse-cache', 'facts'],
      ['parsedfile-cache/chunk', 'scopes'],
    ]) {
      const full = path.join(root, directory);
      await mkdir(full, { recursive: true });
      await writeV8CacheFile(path.join(full, 'shard.v8'), { name });
    }
    const result = await loadCachePayloads(root, { tryLoadV8Cache });
    expect(result.format).toBe('legacy-v8');
    expect(result.payloads.map((p: Buffer) => v8.deserialize(p))).toEqual([
      { name: 'facts' },
      { name: 'scopes' },
    ]);
  });

  it.each(['empty', 'corrupt'])('rejects an %s legacy corpus', async (kind) => {
    const root = await temporary();
    if (kind === 'corrupt') {
      await mkdir(path.join(root, 'parse-cache'));
      await writeFile(path.join(root, 'parse-cache/bad.v8'), 'broken');
    }
    await expect(loadCachePayloads(root, { tryLoadV8Cache })).rejects.toThrow();
  });
});
