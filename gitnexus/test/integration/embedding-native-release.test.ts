import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import lbug from '@ladybugdb/core';
import { VectorStore } from '../../src/core/lbug/vector-store.js';
import { EmbeddingGraphSource } from '../../src/core/lbug/embedding-source.js';
import {
  closeLbugConnection,
  drainLbugResourceReleases,
  openLbugConnection,
} from '../../src/core/lbug/lbug-config.js';

describe('embedding native handle ownership', () => {
  let root: string;
  const opened: Array<{ close(): Promise<void> }> = [];
  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'gn-native-release-'));
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    for (const handle of opened.splice(0)) await handle.close();
    await drainLbugResourceReleases();
    await fs.rm(root, { recursive: true, force: true });
  });

  async function open(kind: 'graph' | 'vector') {
    if (kind === 'vector') {
      const store = await VectorStore.open({
        directory: root,
        identity: 'a'.repeat(64),
        dimensions: 2,
        bufferPoolBytes: 16 * 1024 * 1024,
        threads: 1,
        batchBytes: 1024,
        mode: 'create',
      });
      opened.push(store);
      return store;
    }
    const graphPath = path.join(root, 'graph');
    const writer = await openLbugConnection(lbug, graphPath, {
      bufferPoolBytes: 16 * 1024 * 1024,
      threads: 1,
    });
    try {
      for (const sql of [
        'CREATE NODE TABLE File (id STRING, name STRING, filePath STRING, content STRING, PRIMARY KEY(id))',
        "CREATE (:File {id:'File:one.ts',name:'one.ts',filePath:'one.ts',content:'export const one = 1;'})",
        'CHECKPOINT',
      ]) {
        const result = await writer.conn.query(sql);
        for (const part of Array.isArray(result) ? result : [result]) part.close();
      }
    } finally {
      await closeLbugConnection(writer);
    }
    const source = await EmbeddingGraphSource.open(graphPath, 16 * 1024 * 1024, 1);
    opened.push(source);
    let count = 0;
    for await (const _ of source.scan('File')) count++;
    expect(count).toBe(1);
    return source;
  }

  it.each(['scan', 'fetch'] as const)(
    'allows graph teardown after a %s result fails to close',
    async (operation) => {
      const source = (await open('graph')) as EmbeddingGraphSource;
      const original = lbug.QueryResult.prototype.close;
      vi.spyOn(lbug.QueryResult.prototype, 'close').mockImplementationOnce(function (
        this: lbug.QueryResult,
      ) {
        original.call(this);
        throw new Error('result release failed');
      });
      const read =
        operation === 'fetch'
          ? source.fetch('File', ['File:one.ts'])
          : (async () => {
              for await (const _ of source.scan('File')) {
                /* drain */
              }
            })();
      await expect(read).rejects.toThrow('result release failed');
      await expect(source.close()).resolves.toBeUndefined();
    },
  );

  it.each([
    ['graph', 'connection'],
    ['graph', 'database'],
    ['vector', 'connection'],
    ['vector', 'database'],
  ] as const)('retries a failed %s %s close before claiming release', async (kind, part) => {
    const handle = await open(kind);
    const prototype = part === 'connection' ? lbug.Connection.prototype : lbug.Database.prototype;
    const close = vi
      .spyOn(prototype, 'close')
      .mockRejectedValueOnce(new Error('native release failed'));
    await expect(handle.close()).rejects.toThrow('native release failed');
    await handle.close();
    expect(close).toHaveBeenCalledTimes(2);
    await handle.close();
    expect(close).toHaveBeenCalledTimes(2);
  });

  it.each(['graph', 'vector'] as const)(
    'keeps concurrent %s close callers pending until native exit',
    async (kind) => {
      const handle = await open(kind);
      const original = lbug.Connection.prototype.close;
      let release!: () => void;
      const wait = new Promise<void>((resolve) => {
        release = resolve;
      });
      const close = vi
        .spyOn(lbug.Connection.prototype, 'close')
        .mockImplementationOnce(async function (this: lbug.Connection) {
          await wait;
          await original.call(this);
        });
      const first = handle.close();
      let finished = false;
      const second = handle.close().then(() => {
        finished = true;
      });
      try {
        await Promise.resolve();
        expect(finished).toBe(false);
        expect(close).toHaveBeenCalledTimes(1);
      } finally {
        release();
        await Promise.all([first, second]);
      }
      expect(finished).toBe(true);
    },
  );
});
