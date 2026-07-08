/**
 * Integration Tests: Non-ASCII path handling (#1811)
 *
 * Verifies that LadybugDB can open a database and run COPY commands when
 * the storage path contains CJK (or other non-ASCII) characters.
 *
 * The primary failure mode is on Windows, where KuzuDB's native layer
 * uses ANSI file APIs and the Active Code Page mangles UTF-8 bytes.
 * The fix converts paths to 8.3 short-name form on Windows. On
 * Linux/macOS the conversion is a no-op since POSIX APIs handle UTF-8
 * natively — but locale misconfiguration or filesystem encoding
 * mismatches could still surface, so the test runs on all platforms.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { createMinimalTestGraph } from '../helpers/test-graph.js';

let tmpBase: string;
let storagePath: string;
let dbPath: string;

beforeAll(async () => {
  // Create a temp directory with CJK characters in the name.
  // This reproduces the user's scenario: repo at C:\Project\中文\code
  tmpBase = path.join(os.tmpdir(), `gitnexus-lbug-非ASCII路径-${Date.now()}-${process.pid}`);
  storagePath = path.join(tmpBase, '.gitnexus');
  dbPath = path.join(storagePath, 'lbug');
  await fs.mkdir(dbPath, { recursive: true });
});

afterAll(async () => {
  // Close the adapter before cleanup to release native file handles.
  try {
    const adapter = await import('../../src/core/lbug/lbug-adapter.js');
    await adapter.closeLbug();
  } catch {
    // May not have been opened
  }

  if (tmpBase) {
    // Retry cleanup — LadybugDB on Windows holds handles briefly after close.
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        await fs.rm(tmpBase, { recursive: true, force: true });
        return;
      } catch {
        if (attempt < 4) await new Promise((r) => setTimeout(r, 200 * (attempt + 1)));
      }
    }
  }
});

describe('LadybugDB with non-ASCII storage path (#1811)', () => {
  it('initLbug succeeds with CJK characters in the database path', async () => {
    const adapter = await import('../../src/core/lbug/lbug-adapter.js');
    await expect(adapter.initLbug(dbPath)).resolves.not.toThrow();
  });

  it('loadGraphToLbug COPY succeeds with CJK characters in CSV paths', async () => {
    const adapter = await import('../../src/core/lbug/lbug-adapter.js');
    const graph = createMinimalTestGraph();

    await expect(adapter.loadGraphToLbug(graph, tmpBase, storagePath)).resolves.not.toThrow();
  });

  it('data is queryable after loading through non-ASCII paths', async () => {
    const adapter = await import('../../src/core/lbug/lbug-adapter.js');

    const files = await adapter.executeQuery('MATCH (n:File) RETURN n.id AS id');
    expect(files).toHaveLength(2);

    const functions = await adapter.executeQuery('MATCH (n:Function) RETURN n.id AS id');
    expect(functions).toHaveLength(2);

    const rels = await adapter.executeQuery('MATCH ()-[r:CodeRelation]->() RETURN count(r) AS cnt');
    expect(rels[0].cnt).toBe(4);
  });
});
