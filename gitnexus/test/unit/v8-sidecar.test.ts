import { describe, it, expect } from 'vitest';
import { mkdtemp, rm, writeFile, readFile } from 'fs/promises';
import { tmpdir } from 'os';
import path from 'path';
import {
  internGraphStrings,
  tryLoadV8Sidecar,
  v8SidecarPath,
  writeV8SidecarBestEffort,
} from '../../src/storage/v8-sidecar.js';

describe('v8-sidecar', () => {
  it('interns duplicate strings in place and keeps Map identity', () => {
    const pool = new Map<string, string>();
    const m = new Map([['k', 'dup']]);
    const graph = { a: 'dup', b: 'dup', m };
    internGraphStrings(graph, pool);
    expect(graph.a).toBe(graph.b);
    expect(graph.m).toBe(m);
    expect(graph.m.get('k')).toBe(graph.a);
  });

  it('round-trips a live graph when JSON size matches', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'v8sc-'));
    try {
      const jsonPath = path.join(dir, 'shard.json');
      const graph = { n: 1, nested: { s: 'x' }, map: new Map([['a', 1]]) };
      const json = JSON.stringify({ n: 1 });
      await writeFile(jsonPath, json, 'utf-8');
      await writeV8SidecarBestEffort(jsonPath, graph, Buffer.byteLength(json, 'utf8'));
      const hit = await tryLoadV8Sidecar(jsonPath);
      expect(hit).toBeDefined();
      if (!hit) return;
      const value = hit.value as typeof graph;
      expect(value.n).toBe(1);
      expect(value.map).toBeInstanceOf(Map);
      expect(value.map.get('a')).toBe(1);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('misses when JSON byte length changes under the same sidecar', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'v8sc-stale-'));
    try {
      const jsonPath = path.join(dir, 'shard.json');
      const json = '{"a":1}';
      await writeFile(jsonPath, json, 'utf-8');
      await writeV8SidecarBestEffort(jsonPath, { a: 1 }, Buffer.byteLength(json, 'utf8'));
      await writeFile(jsonPath, '{"a":1,"b":2}', 'utf-8');
      expect(await tryLoadV8Sidecar(jsonPath)).toBeUndefined();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  const seedSidecar = async (dir: string): Promise<string> => {
    const jsonPath = path.join(dir, 'shard.json');
    const json = '{}';
    await writeFile(jsonPath, json, 'utf-8');
    await writeV8SidecarBestEffort(jsonPath, { ok: true }, Buffer.byteLength(json, 'utf8'));
    return jsonPath;
  };

  it('does not gate reads on recorded Node major or V8 version stamps', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'v8sc-diag-'));
    try {
      const jsonPath = await seedSidecar(dir);
      const sidecar = v8SidecarPath(jsonPath);
      const buf = await readFile(sidecar);
      buf.writeUInt16LE(1, 12); // nodeMajor — diagnostic only
      const v8len = buf.readUInt16LE(14);
      buf.fill(0x39, 16, 16 + v8len); // restamp recorded V8 version as all-'9'
      await writeFile(sidecar, buf);
      const hit = await tryLoadV8Sidecar(jsonPath);
      expect(hit).toBeDefined();
      expect((hit?.value as { ok: boolean } | undefined)?.ok).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('misses when v8.deserialize rejects a well-formed envelope', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'v8sc-payload-'));
    try {
      const jsonPath = await seedSidecar(dir);
      const sidecar = v8SidecarPath(jsonPath);
      const buf = await readFile(sidecar);
      const v8len = buf.readUInt16LE(14);
      const payloadOff = 16 + v8len + 8 + 4; // v8ver + jsonBytes + payloadBytes
      expect(payloadOff).toBeLessThan(buf.byteLength);
      buf.fill(0x7f, payloadOff);
      await writeFile(sidecar, buf);
      expect(await tryLoadV8Sidecar(jsonPath)).toBeUndefined();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('misses a garbage magic without throwing', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'v8sc-magic-'));
    try {
      const jsonPath = await seedSidecar(dir);
      await writeFile(v8SidecarPath(jsonPath), Buffer.alloc(64, 7));
      expect(await tryLoadV8Sidecar(jsonPath)).toBeUndefined();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
