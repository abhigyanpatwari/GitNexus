import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { VectorStore, type LegacyVectorGroup } from '../../src/core/lbug/vector-store.js';

const source = 'a'.repeat(64);
const roots: string[] = [];
const handles: VectorStore[] = [];
async function fixture() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'gn-legacy-index-'));
  roots.push(directory);
  const options = {
    directory,
    identity: 'b'.repeat(64),
    dimensions: 4,
    // Match the production vector pool; LadybugDB 0.22 needs more than 8 MiB
    // for the receipt tables and bounded insert batches.
    bufferPoolBytes: 64 * 1024 * 1024,
    threads: 1,
    batchBytes: 1024 * 1024,
  };
  const store = await VectorStore.open({ ...options, mode: 'create' });
  handles.push(store);
  return { store, options };
}
const group = (n: number): LegacyVectorGroup => ({
  nodeId: `Function:a.ts:n${n}`,
  contentHash: `hash-${n}`,
  chunks: 2,
  sourceStartLine: n * 3,
  sourceEndLine: n * 3 + 2,
});
async function* groups(n: number) {
  for (let i = 0; i < n; i++) yield group(i);
}
afterEach(async () => {
  for (const handle of handles.splice(0)) await handle.close();
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

describe('bounded native legacy receipt index', () => {
  it('streams receipt batches, excludes unsafe groups, and resumes without rescanning', async () => {
    const { store, options } = await fixture();
    const scan = vi.fn(() => groups(1000));
    const excluded = vi.fn(() => [group(2).nodeId, group(999).nodeId]);
    await store.prepareLegacyReuseIndex(source, scan, excluded);
    expect(await store.legacyReuseGroup(source, group(998).nodeId)).toEqual(group(998));
    expect(await store.legacyReuseGroup(source, group(2).nodeId)).toBeNull();
    expect(await store.legacyReuseGroup('c'.repeat(64), group(998).nodeId)).toBeNull();
    expect(await store.completedNodes([group(998).nodeId])).toEqual(new Map());
    await store.close();
    const reopened = await VectorStore.open({ ...options, mode: 'resume' });
    handles.push(reopened);
    await reopened.prepareLegacyReuseIndex(source, scan, excluded);
    expect(scan).toHaveBeenCalledOnce();
    expect(excluded).toHaveBeenCalledOnce();
    expect(await reopened.legacyReuseGroup(source, group(998).nodeId)).toEqual(group(998));
  });
  it('rebuilds an interrupted receipt pass without deleting completed paid vectors', async () => {
    const { store } = await fixture();
    const id = 'Function:a.ts:paid';
    await store.beginNode(id, 'paid-hash');
    await store.append(id, 'paid-hash', [
      { chunkIndex: 0, startLine: 1, endLine: 2, embedding: [1, 0, 0, 0] },
    ]);
    await store.finishNode(id, 'paid-hash', 1);
    await expect(
      store.prepareLegacyReuseIndex(
        source,
        async function* () {
          yield* groups(65);
          throw new Error('interrupted');
        },
        () => [],
      ),
    ).rejects.toThrow('interrupted');
    expect(await store.legacyReuseGroup(source, group(0).nodeId)).toBeNull();
    await store.prepareLegacyReuseIndex(
      source,
      () => groups(3),
      () => [],
    );
    expect(await store.legacyReuseGroup(source, group(2).nodeId)).toEqual(group(2));
    expect(await store.legacyReuseGroup(source, group(64).nodeId)).toBeNull();
    expect((await store.completedNodes([id])).size).toBe(1);
  });
  it('rejects duplicate or oversized receipts before marking the source complete', async () => {
    const { store } = await fixture();
    await expect(
      store.prepareLegacyReuseIndex(
        source,
        async function* () {
          yield group(0);
          yield group(0);
        },
        () => [],
      ),
    ).rejects.toThrow();
    expect(await store.legacyReuseGroup(source, group(0).nodeId)).toBeNull();
    await expect(
      store.prepareLegacyReuseIndex(
        source,
        async function* () {
          yield { ...group(1), contentHash: 'x'.repeat(1024 * 1024) };
        },
        () => [],
      ),
    ).rejects.toThrow('oversized');
    expect(await store.legacyReuseGroup(source, group(1).nodeId)).toBeNull();
  });
  it('keeps cancellation incomplete and refuses writes to a published artifact', async () => {
    const { store } = await fixture();
    const controller = new AbortController();
    await expect(
      store.prepareLegacyReuseIndex(
        source,
        async function* () {
          yield* groups(65);
          controller.abort();
          yield group(66);
        },
        () => [],
        controller.signal,
      ),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(await store.legacyReuseGroup(source, group(0).nodeId)).toBeNull();
    await store.seal(0, 0);
    await expect(
      store.prepareLegacyReuseIndex(
        source,
        () => groups(1),
        () => [],
      ),
    ).rejects.toThrow();
  });
});
