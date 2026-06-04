/**
 * U1 — Bounded chunk concurrency (B1 from PR #1693 review).
 *
 * Verifies that the new `parseChunkConcurrency` PipelineOption (and the
 * paired `GITNEXUS_PARSE_CHUNK_CONCURRENCY` env-var fallback) flow through
 * `runChunkedParseAndResolve` without changing graph output. Pre-fetching
 * chunk file contents up to N chunks ahead of the worker-dispatch cursor
 * is a wall-clock optimization (file I/O overlaps with worker compute),
 * not a graph-semantics change — the deferred-state aggregation still
 * runs in `chunkIdx` order so cross-chunk processors see deterministic
 * input regardless of file-read completion order.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { runChunkedParseAndResolve } from '../../src/core/ingestion/pipeline-phases/parse-impl.js';
import { createKnowledgeGraph } from '../../src/core/graph/graph.js';

function scanned(repo: string, files: string[]) {
  return files.map((rel) => ({
    path: rel,
    size: fs.statSync(path.join(repo, rel)).size,
  }));
}

describe('parse-impl chunk concurrency (U1)', () => {
  let repoPath = '';

  beforeEach(() => {
    repoPath = fs.mkdtempSync(path.join(os.tmpdir(), 'parse-impl-chunk-concurrency-'));
    fs.writeFileSync(path.join(repoPath, 'a.ts'), 'export function foo() { return 1; }\n');
    fs.writeFileSync(
      path.join(repoPath, 'b.ts'),
      'import { foo } from "./a";\nexport function bar() { return foo(); }\n',
    );
    fs.writeFileSync(
      path.join(repoPath, 'c.ts'),
      'import { bar } from "./b";\nexport class Baz { run() { return bar(); } }\n',
    );
  });

  afterEach(() => {
    if (repoPath && fs.existsSync(repoPath)) {
      fs.rmSync(repoPath, { recursive: true, force: true });
    }
  });

  it('produces identical graph output across parseChunkConcurrency values', async () => {
    const files = ['a.ts', 'b.ts', 'c.ts'];
    const scan = scanned(repoPath, files);

    const g1 = createKnowledgeGraph();
    await runChunkedParseAndResolve(g1, scan, files, files.length, repoPath, Date.now(), () => {}, {
      skipWorkers: true,
      parseChunkConcurrency: 1,
    });

    const g2 = createKnowledgeGraph();
    await runChunkedParseAndResolve(g2, scan, files, files.length, repoPath, Date.now(), () => {}, {
      skipWorkers: true,
      parseChunkConcurrency: 2,
    });

    // Same fixture under different concurrency values must produce the
    // same graph — per-chunk results merge in chunkIdx order regardless of
    // file-read completion order, so cross-chunk processors see deterministic
    // input.
    expect(g2.nodeCount).toBe(g1.nodeCount);
    expect(g2.relationshipCount).toBe(g1.relationshipCount);
  });

  it('accepts parseChunkConcurrency=1 (serial-equivalent) and produces the expected fixture symbols', async () => {
    const files = ['a.ts', 'b.ts', 'c.ts'];
    const graph = createKnowledgeGraph();
    await runChunkedParseAndResolve(
      graph,
      scanned(repoPath, files),
      files,
      files.length,
      repoPath,
      Date.now(),
      () => {},
      { skipWorkers: true, parseChunkConcurrency: 1 },
    );
    // Exact assertions per DoD §2.7: pin specific symbols from the fixture
    // so a regression in either the chunk loop or the resolver surfaces
    // here instead of being masked by a bounds-only nodeCount check.
    const symbolNames = Array.from(graph.nodes.values()).map(
      (n) => (n.properties as { name?: string } | undefined)?.name,
    );
    expect(symbolNames.includes('foo')).toBe(true);
    expect(symbolNames.includes('bar')).toBe(true);
    expect(symbolNames.includes('Baz')).toBe(true);
  });

  it('falls back to GITNEXUS_PARSE_CHUNK_CONCURRENCY env when option is undefined', async () => {
    const original = process.env.GITNEXUS_PARSE_CHUNK_CONCURRENCY;
    process.env.GITNEXUS_PARSE_CHUNK_CONCURRENCY = '3';
    try {
      const files = ['a.ts', 'b.ts', 'c.ts'];
      const graph = createKnowledgeGraph();
      await runChunkedParseAndResolve(
        graph,
        scanned(repoPath, files),
        files,
        files.length,
        repoPath,
        Date.now(),
        () => {},
        { skipWorkers: true },
      );
      // Resolver reads the env when options.parseChunkConcurrency is
      // undefined. The env value (3) must produce the same fixture
      // symbols on this fixture as the other concurrency values do.
      const symbolNames = Array.from(graph.nodes.values()).map(
        (n) => (n.properties as { name?: string } | undefined)?.name,
      );
      expect(symbolNames.includes('foo')).toBe(true);
      expect(symbolNames.includes('bar')).toBe(true);
      expect(symbolNames.includes('Baz')).toBe(true);
    } finally {
      if (original === undefined) {
        delete process.env.GITNEXUS_PARSE_CHUNK_CONCURRENCY;
      } else {
        process.env.GITNEXUS_PARSE_CHUNK_CONCURRENCY = original;
      }
    }
  });
});
