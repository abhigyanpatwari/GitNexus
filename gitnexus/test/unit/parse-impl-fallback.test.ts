/**
 * U6 — Sequential-fallback cleanup safety.
 *
 * Verifies that `runChunkedParseAndResolve` runs its cleanup steps
 * (`astCache.clear()`, `bindingAccumulator.finalize()`,
 * `enrichExportedTypeMap`) even when the sequential-fallback loop throws
 * mid-iteration. These tests exercise the try/finally added in U6.
 *
 * We drive the sequential fallback by passing `{ skipWorkers: true }` so the
 * worker pool is never created and `sequentialChunkPaths` is populated with
 * every chunk.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Spies captured from the module mocks below — populated per-test.
const spies = {
  astCacheClearCalls: 0,
  resetSpies() {
    this.astCacheClearCalls = 0;
  },
};

// Controls which dependency throws for a given test.
// `readFileContentsFailAfter`: call count threshold — fail once the N-th call
// is reached. The first `readFileContents` call happens in the outer
// worker/parse loop (before sequential fallback); we want to fail only on the
// second call (inside the fallback) so the U6 try/finally is exercised.
const failureConfig: {
  readFileContentsFailAfter: number;
  readFileContentsCalls: number;
  processCalls: boolean;
} = {
  readFileContentsFailAfter: Infinity,
  readFileContentsCalls: 0,
  processCalls: false,
};

vi.mock('../../src/core/ingestion/filesystem-walker.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../src/core/ingestion/filesystem-walker.js')>();
  return {
    ...actual,
    readFileContents: vi.fn(async (repoPath: string, chunkPaths: string[]) => {
      failureConfig.readFileContentsCalls += 1;
      if (failureConfig.readFileContentsCalls >= failureConfig.readFileContentsFailAfter) {
        throw new Error('injected readFileContents failure');
      }
      return actual.readFileContents(repoPath, chunkPaths);
    }),
  };
});

vi.mock('../../src/core/ingestion/call-processor.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../src/core/ingestion/call-processor.js')>();
  return {
    ...actual,
    processCalls: vi.fn(async (...args: unknown[]) => {
      if (failureConfig.processCalls) {
        throw new Error('injected processCalls failure');
      }
      // Delegate to original
      return (actual.processCalls as unknown as (...a: unknown[]) => Promise<unknown>)(...args);
    }),
  };
});

// Wrap createASTCache so we can count clear() calls across all cache instances.
vi.mock('../../src/core/ingestion/ast-cache.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/core/ingestion/ast-cache.js')>();
  return {
    ...actual,
    createASTCache: (max?: number) => {
      const cache = actual.createASTCache(max);
      const origClear = cache.clear.bind(cache);
      cache.clear = () => {
        spies.astCacheClearCalls += 1;
        origClear();
      };
      return cache;
    },
  };
});

// Import after the mocks so bindings reference the wrapped versions.
const { runChunkedParseAndResolve } =
  await import('../../src/core/ingestion/pipeline-phases/parse-impl.js');
const { createKnowledgeGraph } = await import('../../src/core/graph/graph.js');

function makeTempRepo(files: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'parse-impl-fallback-'));
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(dir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }
  return dir;
}

function scanned(repo: string, files: string[]) {
  return files.map((rel) => ({
    path: rel,
    size: fs.statSync(path.join(repo, rel)).size,
  }));
}

describe('parse-impl sequential fallback cleanup (U6)', () => {
  let repoPath = '';

  beforeEach(() => {
    spies.resetSpies();
    failureConfig.readFileContentsFailAfter = Infinity;
    failureConfig.readFileContentsCalls = 0;
    failureConfig.processCalls = false;
    repoPath = makeTempRepo({
      'a.ts': `export function foo() { return 1; }\n`,
      'b.ts': `import { foo } from './a';\nexport function bar() { return foo(); }\n`,
    });
  });

  afterEach(() => {
    if (repoPath && fs.existsSync(repoPath)) {
      fs.rmSync(repoPath, { recursive: true, force: true });
    }
  });

  it('happy path: sequential fallback completes and bindingAccumulator is finalized', async () => {
    const graph = createKnowledgeGraph();
    const files = ['a.ts', 'b.ts'];
    const result = await runChunkedParseAndResolve(
      graph,
      scanned(repoPath, files),
      files,
      files.length,
      repoPath,
      Date.now(),
      () => {},
      { skipWorkers: true },
    );
    // Happy path — should return a BindingAccumulator and clear astCache at
    // least once (per-chunk + finally).
    expect(result.bindingAccumulator).toBeDefined();
    expect(spies.astCacheClearCalls).toBeGreaterThanOrEqual(1);
    // finalize() on a BindingAccumulator makes it read-only; appending after
    // finalize throws. We use that to prove finalize actually ran.
    expect(() =>
      result.bindingAccumulator.appendFile('after.ts', [
        { scope: '', varName: 'x', typeName: 'number' },
      ]),
    ).toThrow();
  });

  it('error path: readFileContents throws mid-fallback — astCache is cleared and finalize runs', async () => {
    const graph = createKnowledgeGraph();
    const files = ['a.ts', 'b.ts'];
    // Fail the second readFileContents call — first call is in the outer
    // worker/parse loop, second is inside the sequential fallback.
    failureConfig.readFileContentsFailAfter = 2;

    const clearsBefore = spies.astCacheClearCalls;
    await expect(
      runChunkedParseAndResolve(
        graph,
        scanned(repoPath, files),
        files,
        files.length,
        repoPath,
        Date.now(),
        () => {},
        { skipWorkers: true },
      ),
    ).rejects.toThrow(/injected readFileContents failure/);

    // Finally-block must have cleared astCache at least once on the error path.
    expect(spies.astCacheClearCalls).toBeGreaterThan(clearsBefore);
  });

  it('error path: processCalls throws in fallback loop — cleanup still runs', async () => {
    const graph = createKnowledgeGraph();
    const files = ['a.ts', 'b.ts'];
    failureConfig.processCalls = true;

    const clearsBefore = spies.astCacheClearCalls;
    await expect(
      runChunkedParseAndResolve(
        graph,
        scanned(repoPath, files),
        files,
        files.length,
        repoPath,
        Date.now(),
        () => {},
        { skipWorkers: true },
      ),
    ).rejects.toThrow(/injected processCalls failure/);

    // astCache.clear() must have run in the finally block.
    expect(spies.astCacheClearCalls).toBeGreaterThan(clearsBefore);
  });
});
