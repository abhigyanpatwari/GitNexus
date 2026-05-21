/**
 * U14 (F7 architectural from PR #1693 review) — Function-scope env reads
 * in parse-impl.
 *
 * Pre-U14, `CHUNK_BYTE_BUDGET` was a module-load IIFE constant that
 * captured `GITNEXUS_CHUNK_BYTE_BUDGET` once and froze the value for
 * the module's lifetime. That defeated `PipelineOptions.chunkByteBudget`
 * (silently no-op'd because the body read the frozen constant) AND
 * forced tests to use `vi.resetModules` to vary the chunk layout (see
 * the U7 deferred-extraction test and the U6 multi-chunk integration
 * test for examples of the workaround).
 *
 * After U14:
 *   - Option present  -> option wins (per-call, no env / no vi.resetModules)
 *   - Option absent   -> env wins (back-compat)
 *   - Both absent     -> built-in 2 MB default
 *
 * This file pins all three resolution branches, plus the behavioral
 * invariant the workaround was masking: two back-to-back runs in the
 * same vitest worker process can use DIFFERENT `chunkByteBudget` values
 * and observe DIFFERENT chunking on the same fixture WITHOUT needing
 * `vi.resetModules` between them.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { runChunkedParseAndResolve } from '../../src/core/ingestion/pipeline-phases/parse-impl.js';
import { createKnowledgeGraph } from '../../src/core/graph/graph.js';

const ORIGINAL_BUDGET = process.env.GITNEXUS_CHUNK_BYTE_BUDGET;

type Fixture = Record<string, string>;

function makeRepo(fixture: Fixture): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'parse-impl-env-reads-'));
  for (const [name, content] of Object.entries(fixture)) {
    fs.writeFileSync(path.join(dir, name), content);
  }
  return dir;
}

function scanned(repo: string, files: string[]) {
  return files.map((rel) => ({
    path: rel,
    size: fs.statSync(path.join(repo, rel)).size,
  }));
}

/**
 * Capture every per-chunk progress message emitted during a run.
 * parse-impl emits one per chunk in the "Parsing chunk X/Y" form, so
 * counting unique chunk indices in the captured stream is a stable
 * proxy for the number of chunks the loop actually produced. Avoids
 * exposing internal counter state from parse-impl.
 */
async function countChunksFromProgress(
  repoPath: string,
  files: string[],
  options?: { chunkByteBudget?: number },
): Promise<number> {
  const scan = scanned(repoPath, files);
  const graph = createKnowledgeGraph();
  const chunkIndices = new Set<string>();
  await runChunkedParseAndResolve(
    graph,
    scan,
    files,
    files.length,
    repoPath,
    Date.now(),
    (p) => {
      if (typeof p.message !== 'string') return;
      const m = /Parsing chunk (\d+)\/(\d+)/.exec(p.message);
      if (m !== null) chunkIndices.add(`${m[1]}/${m[2]}`);
    },
    { skipWorkers: true, ...options },
  );
  return chunkIndices.size;
}

describe('parse-impl chunkByteBudget resolution (U14 / F7)', () => {
  let repoPath = '';

  beforeEach(() => {
    repoPath = makeRepo({
      'a.ts': 'export const A = 1;\n',
      'b.ts': 'export const B = 2;\n',
      'c.ts': 'export const C = 3;\n',
    });
  });

  afterEach(() => {
    if (repoPath && fs.existsSync(repoPath)) {
      fs.rmSync(repoPath, { recursive: true, force: true });
    }
    if (ORIGINAL_BUDGET === undefined) {
      delete process.env.GITNEXUS_CHUNK_BYTE_BUDGET;
    } else {
      process.env.GITNEXUS_CHUNK_BYTE_BUDGET = ORIGINAL_BUDGET;
    }
  });

  it('option-first: PipelineOptions.chunkByteBudget overrides the env var', async () => {
    // Force the env to a HUGE value that would normally collapse the
    // fixture to a single chunk; pass a SMALL option that produces 3
    // chunks. If the option wins, we observe 3 chunks; if env wins, 1.
    process.env.GITNEXUS_CHUNK_BYTE_BUDGET = String(10 * 1024 * 1024);
    const chunks = await countChunksFromProgress(repoPath, ['a.ts', 'b.ts', 'c.ts'], {
      chunkByteBudget: 8,
    });
    expect(chunks).toBe(3);
  });

  it('env-fallback: GITNEXUS_CHUNK_BYTE_BUDGET is honored when the option is absent', async () => {
    process.env.GITNEXUS_CHUNK_BYTE_BUDGET = '8';
    const chunks = await countChunksFromProgress(repoPath, ['a.ts', 'b.ts', 'c.ts']);
    expect(chunks).toBe(3);
  });

  it('default-fallback: large built-in budget keeps the fixture in a single chunk', async () => {
    // Both option and env unset → falls through to DEFAULT_CHUNK_BYTE_BUDGET
    // (2 MB). The fixture totals well under that, so exactly one chunk.
    delete process.env.GITNEXUS_CHUNK_BYTE_BUDGET;
    const chunks = await countChunksFromProgress(repoPath, ['a.ts', 'b.ts', 'c.ts']);
    expect(chunks).toBe(1);
  });

  it('per-call: two back-to-back runs with different option values observe their own values, not the previous call', async () => {
    // The behavioral invariant U14 restores: a long-running host
    // (eval-server, MCP daemon) calling runChunkedParseAndResolve twice
    // with different chunkByteBudget values gets the value it passed,
    // not whatever the first call set (pre-U14, the module-load IIFE
    // froze the value at import — the option was a silent no-op).
    const files = ['a.ts', 'b.ts', 'c.ts'];
    delete process.env.GITNEXUS_CHUNK_BYTE_BUDGET;
    const small = await countChunksFromProgress(repoPath, files, {
      chunkByteBudget: 8,
    });
    const large = await countChunksFromProgress(repoPath, files, {
      chunkByteBudget: 10 * 1024 * 1024,
    });
    expect(small).toBe(3);
    expect(large).toBe(1);
  });
});
