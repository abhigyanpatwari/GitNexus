import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  recordLegacyEmbeddingSource,
  readLegacyEmbeddingSource,
} from '../../src/storage/legacy-embedding-source.js';
import {
  adoptEmbeddingArtifact,
  readEmbeddingArtifactSpace,
} from '../../src/storage/embedding-artifact.js';

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});
async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'gn-legacy-receipt-'));
  roots.push(root);
  const sourceFile = 'lbug.generation.' + 'a'.repeat(32);
  await fs.writeFile(path.join(root, sourceFile), 'retired database');
  const input = {
    sourceFile,
    schemaFingerprint: 'schema',
    recordedIdentity: { provider: 'local', model: 'old', dimensions: 4 },
  };
  return { root, input, source: path.join(root, sourceFile) };
}
const collect = async (ids: AsyncIterable<string>) => {
  const result: string[] = [];
  for await (const id of ids) result.push(id);
  return result;
};

describe('retained legacy source receipts', () => {
  it('retains the sole legacy fallback through rebases and drops it only after sealing', async () => {
    const f = await fixture();
    const legacy = await recordLegacyEmbeddingSource(f.root, f.input, []);
    const space = {
      vectorIdentity: 'a'.repeat(64),
      inputIdentity: 'b'.repeat(64),
      dimensions: 4,
      schema: 'vectors',
    };
    const owner = {
      artifactIdentity: 'c'.repeat(64),
      jobIdentity: 'c'.repeat(64),
      sourceIdentity: 'd'.repeat(64),
      graphGeneration: 'e'.repeat(32),
      manifestDigest: 'f'.repeat(64),
      phase: 'pending' as const,
      revalidateInputs: false,
      fallbackLegacy: legacy,
    };
    const validate = async () => {};
    const first = await adoptEmbeddingArtifact(f.root, space, null, owner, validate);
    const rebased = {
      ...owner,
      jobIdentity: '1'.repeat(64),
      graphGeneration: '2'.repeat(32),
      revalidateInputs: true,
    };
    await expect(
      adoptEmbeddingArtifact(
        f.root,
        space,
        first,
        { ...rebased, fallbackLegacy: undefined },
        validate,
      ),
    ).rejects.toThrow('retained fallback');
    await expect(
      adoptEmbeddingArtifact(
        f.root,
        space,
        first,
        { ...owner, fallbackArtifact: '3'.repeat(64) },
        validate,
      ),
    ).rejects.toThrow('ownership');
    const next = await adoptEmbeddingArtifact(f.root, space, first, rebased, validate);
    expect((await readEmbeddingArtifactSpace(f.root, space, validate))?.owner.fallbackLegacy).toBe(
      legacy,
    );
    await expect(
      adoptEmbeddingArtifact(
        f.root,
        space,
        next,
        { ...rebased, fallbackLegacy: undefined },
        validate,
      ),
    ).rejects.toThrow('changed');
    const sealed = await adoptEmbeddingArtifact(
      f.root,
      space,
      next,
      { ...rebased, phase: 'sealed', fallbackLegacy: undefined },
      validate,
    );
    expect(sealed.owner.fallbackLegacy).toBeUndefined();
  });
  it('streams a large exclusion list and is idempotent without copying the native source', async () => {
    const f = await fixture();
    const before = await fs.stat(f.source);
    let yielded = 0;
    const ids = async function* () {
      for (let i = 0; i < 12000; i++) {
        yielded++;
        yield `Const:a.ts:n${i}`;
      }
    };
    const identity = await recordLegacyEmbeddingSource(f.root, f.input, ids());
    expect(yielded).toBe(12000);
    const retained = await readLegacyEmbeddingSource(f.root, identity);
    expect(retained.recordedIdentity).toEqual(f.input.recordedIdentity);
    expect(retained.recordedInputIdentity).toBeUndefined();
    expect((await collect(retained.excludedIds())).length).toBe(12000);
    expect(await recordLegacyEmbeddingSource(f.root, f.input, ids())).toBe(identity);
    expect((await fs.stat(f.source)).ino).toBe(before.ino);
    expect((await fs.stat(f.source)).mtimeMs).toBe(before.mtimeMs);
    expect(
      (await fs.stat(path.join(f.root, 'embeddings', 'legacy', identity, 'legacy.json'))).size,
    ).toBeLessThan(2048);
  });
  it('preserves unknown fields and refuses paths outside a retired graph', async () => {
    const f = await fixture();
    const identity = await recordLegacyEmbeddingSource(
      f.root,
      { ...f.input, recordedIdentity: { dimensions: 4 } },
      [],
    );
    expect((await readLegacyEmbeddingSource(f.root, identity)).recordedIdentity).toEqual({
      dimensions: 4,
    });
    await expect(
      recordLegacyEmbeddingSource(f.root, { ...f.input, sourceFile: '../lbug' }, []),
    ).rejects.toThrow('retired');
    await expect(
      recordLegacyEmbeddingSource(f.root, { ...f.input, sourceFile: 'lbug' }, []),
    ).rejects.toThrow('retired');
  });
  it('rejects replaced sources, source symlinks, and unrecovered WALs', async () => {
    const f = await fixture();
    const identity = await recordLegacyEmbeddingSource(f.root, f.input, []);
    await fs.rename(f.source, f.source + '.old');
    await fs.writeFile(f.source, 'retired database');
    await expect(readLegacyEmbeddingSource(f.root, identity)).rejects.toThrow(
      'changed after retirement',
    );
    await fs.unlink(f.source);
    await fs.symlink(f.source + '.old', f.source);
    await expect(readLegacyEmbeddingSource(f.root, identity)).rejects.toThrow('regular file');
    await fs.unlink(f.source);
    await fs.rename(f.source + '.old', f.source);
    const restoredIdentity = await recordLegacyEmbeddingSource(f.root, f.input, []);
    await fs.writeFile(f.source + '.wal', 'not checkpointed');
    await expect(readLegacyEmbeddingSource(f.root, restoredIdentity)).rejects.toThrow(
      'native recovery',
    );
  });
  it('rejects in-place source changes even when size and mtime are restored', async () => {
    const f = await fixture();
    const timestamp = new Date('2020-01-01T00:00:00Z');
    await fs.utimes(f.source, timestamp, timestamp);
    const identity = await recordLegacyEmbeddingSource(f.root, f.input, []);
    const before = await fs.stat(f.source, { bigint: true });
    await fs.writeFile(f.source, 'changed database');
    await fs.utimes(f.source, timestamp, timestamp);
    const after = await fs.stat(f.source, { bigint: true });
    expect({ ino: after.ino, size: after.size, mtime: after.mtimeNs }).toEqual({
      ino: before.ino,
      size: before.size,
      mtime: before.mtimeNs,
    });
    await expect(readLegacyEmbeddingSource(f.root, identity)).rejects.toThrow(
      'changed after retirement',
    );
    expect(await fs.readFile(f.source, 'utf8')).toBe('changed database');
  });
  it('validates the complete exclusion checksum before a native index may become complete', async () => {
    const f = await fixture();
    const identity = await recordLegacyEmbeddingSource(f.root, f.input, ['Const:a.ts:x']);
    const file = path.join(f.root, 'embeddings', 'legacy', identity, 'excluded.jsonl');
    await fs.writeFile(file, '"Const:a.ts:y"\n');
    const retained = await readLegacyEmbeddingSource(f.root, identity);
    await expect(collect(retained.excludedIds())).rejects.toThrow('checksum mismatch');
    await expect(recordLegacyEmbeddingSource(f.root, f.input, ['Const:a.ts:x'])).rejects.toThrow(
      'checksum mismatch',
    );
  });
  it('rejects a corrupt bounded receipt instead of selecting another source', async () => {
    const f = await fixture();
    const identity = await recordLegacyEmbeddingSource(f.root, f.input, []);
    await fs.writeFile(path.join(f.root, 'embeddings', 'legacy', identity, 'legacy.json'), '{}');
    await expect(readLegacyEmbeddingSource(f.root, identity)).rejects.toThrow('Malformed');
  });
  it('cleans only its unpublished spool on cancellation and retains source data', async () => {
    const f = await fixture();
    const signal = AbortSignal.abort();
    await expect(
      recordLegacyEmbeddingSource(f.root, f.input, ['Const:a.ts:x'], signal),
    ).rejects.toThrow();
    expect(await fs.readFile(f.source, 'utf8')).toBe('retired database');
    expect(await fs.readdir(path.join(f.root, 'embeddings', 'legacy'))).toEqual([]);
  });
  it('bounds corrupt exclusion framing and rejects directory symlinks', async () => {
    const f = await fixture();
    const identity = await recordLegacyEmbeddingSource(f.root, f.input, []);
    const directory = path.join(f.root, 'embeddings', 'legacy', identity);
    await fs.rename(directory, directory + '.original');
    await fs.symlink(directory + '.original', directory);
    await expect(readLegacyEmbeddingSource(f.root, identity)).rejects.toThrow('owned directory');
    await expect(
      recordLegacyEmbeddingSource(f.root, f.input, ['Const:a.ts:' + 'x'.repeat(1024 * 1024)]),
    ).rejects.toThrow('bounded size');
  });
});
