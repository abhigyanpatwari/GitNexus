import { describe, it, expect } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile, readFile } from 'fs/promises';
import { tmpdir } from 'os';
import path from 'path';
import {
  bindV8GenerationBestEffort,
  dropV8Sidecar,
  internGraphStrings,
  newV8Generation,
  tryLoadV8Sidecar,
  v8GenerationPath,
  v8SidecarPath,
  writeV8SidecarBestEffort,
} from '../../src/storage/v8-sidecar.js';

const publishSidecar = async (jsonPath: string, json: string, graph: unknown): Promise<Buffer> => {
  const jsonBytes = Buffer.byteLength(json, 'utf8');
  const generation = newV8Generation();
  await bindV8GenerationBestEffort(jsonPath, generation, jsonBytes);
  await writeFile(jsonPath, json, 'utf-8');
  await writeV8SidecarBestEffort(jsonPath, graph, jsonBytes, generation);
  return generation;
};

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

  it('round-trips a live graph when generation and JSON size match', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'v8sc-'));
    try {
      const jsonPath = path.join(dir, 'shard.json');
      const graph = { n: 1, nested: { s: 'x' }, map: new Map([['a', 1]]) };
      const json = JSON.stringify({ n: 1 });
      await publishSidecar(jsonPath, json, graph);
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
      await publishSidecar(jsonPath, json, { a: 1 });
      await writeFile(jsonPath, '{"a":1,"b":2}', 'utf-8');
      expect(await tryLoadV8Sidecar(jsonPath)).toBeUndefined();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('misses a leftover sidecar after a same-size JSON rewrite when generation rotates and replacement V8 is not published', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'v8sc-samesize-'));
    try {
      const jsonPath = path.join(dir, 'shard.json');
      const jsonA = '{"id":"aaa"}';
      const jsonB = '{"id":"bbb"}';
      expect(Buffer.byteLength(jsonA, 'utf8')).toBe(Buffer.byteLength(jsonB, 'utf8'));
      await publishSidecar(jsonPath, jsonA, { id: 'aaa' });
      const jsonBytes = Buffer.byteLength(jsonB, 'utf8');
      const nextGen = newV8Generation();
      await bindV8GenerationBestEffort(jsonPath, nextGen, jsonBytes);
      await writeFile(jsonPath, jsonB, 'utf-8');
      expect(await tryLoadV8Sidecar(jsonPath)).toBeUndefined();
      expect(JSON.parse(await readFile(jsonPath, 'utf-8'))).toEqual({ id: 'bbb' });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  // The double-failure signal persist paths gate on: when NEITHER generation
  // rotation nor removal of the old sidecar can succeed, a same-length rewrite
  // would leave the stale `.v8` indistinguishable from the new JSON, so both
  // helpers must report failure rather than swallow it.
  it('reports failure from both invalidation mechanisms when neither can succeed', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'v8sc-both-fail-'));
    try {
      const jsonPath = path.join(dir, 'shard.json');
      const json = '{"id":"aaa"}';
      await publishSidecar(jsonPath, json, { id: 'aaa' });
      // Non-empty directories at both paths: `unlink` cannot remove a
      // directory and `rename` cannot replace a non-empty one, on any platform
      // and regardless of privileges.
      await rm(v8SidecarPath(jsonPath), { force: true });
      await rm(v8GenerationPath(jsonPath), { force: true });
      for (const blocked of [v8SidecarPath(jsonPath), v8GenerationPath(jsonPath)]) {
        await mkdir(blocked);
        await writeFile(path.join(blocked, 'occupied'), 'x', 'utf-8');
      }
      const jsonBytes = Buffer.byteLength(json, 'utf8');
      expect(await bindV8GenerationBestEffort(jsonPath, newV8Generation(), jsonBytes)).toBe(false);
      expect(await dropV8Sidecar(jsonPath)).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('reports success from drop when the sidecar is already absent', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'v8sc-drop-absent-'));
    try {
      expect(await dropV8Sidecar(path.join(dir, 'missing.json'))).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('falls back when internGraphStrings throws during materialization', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'v8sc-intern-'));
    try {
      const jsonPath = path.join(dir, 'shard.json');
      await publishSidecar(jsonPath, '{"s":"x"}', { s: 'x' });
      const pool = new Map<string, string>();
      pool.set = () => {
        throw new Error('intern boom');
      };
      expect(await tryLoadV8Sidecar(jsonPath, pool)).toBeUndefined();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  const seedSidecar = async (dir: string): Promise<string> => {
    const jsonPath = path.join(dir, 'shard.json');
    await publishSidecar(jsonPath, '{}', { ok: true });
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
      const payloadOff = 16 + v8len + 8 + 16 + 4; // v8ver + jsonBytes + gen + payloadBytes
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
