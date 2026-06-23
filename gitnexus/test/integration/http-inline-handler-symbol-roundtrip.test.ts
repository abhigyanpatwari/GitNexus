/**
 * End-to-end validation of the INLINE provider source-scan containment path
 * (#2276).
 *
 * The unit suite (`test/unit/group/http-route-extractor.test.ts`) proves the
 * resolver logic by MOCKING `CONTAINING_QUERY` with hand-picked spans. That
 * leaves one assumption unverified: that the REAL ingestion pipeline records a
 * Go enclosing function with a 0-based span that actually contains the emitted
 * call-site line. This test closes that gap.
 *
 * It runs the real pipeline over a Go file whose `http.HandleFunc` handler is an
 * inline `func(){…}` (the issue's headline Go example), persists the resulting
 * graph into a real LadybugDB, and runs the production `HttpRouteExtractor`
 * against the real executor. The provider must resolve to the containing
 * `main()` symbol via line-span containment (`source_scan_resolved`) — not the
 * file-level fallback. Go does not index anonymous func literals as symbols
 * (only `function_declaration`/`method_declaration`), so the innermost
 * containing symbol is `main` itself.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { runPipelineFromRepo } from '../../src/core/ingestion/pipeline.js';
import { HttpRouteExtractor } from '../../src/core/group/extractors/http-route-extractor.js';
import type { CypherExecutor } from '../../src/core/group/contract-extractor.js';
import type { RepoHandle } from '../../src/core/group/types.js';

let tmpBase: string;
let repoDir: string;
let storagePath: string;
let dbPath: string;

beforeAll(async () => {
  // Atomic, unique temp dir (fs.mkdtemp) — avoids the predictable
  // os.tmpdir()+name pattern CodeQL flags as an insecure temporary file.
  tmpBase = await fs.mkdtemp(path.join(os.tmpdir(), 'gitnexus-http-inline-e2e-'));
  repoDir = path.join(tmpBase, 'repo');
  storagePath = path.join(tmpBase, '.gitnexus');
  dbPath = path.join(storagePath, 'lbug');
  await fs.mkdir(path.join(repoDir, 'cmd'), { recursive: true });
  await fs.mkdir(dbPath, { recursive: true });

  // net/http inline handler INSIDE main() — the #2276 Go example. Before this
  // change the func literal was not even captured; now it emits name:null + the
  // call-site line so it resolves to main() by containment.
  await fs.writeFile(
    path.join(repoDir, 'cmd', 'server.go'),
    `package main

import "net/http"

func main() {
\thttp.HandleFunc("/api/health", func(w http.ResponseWriter, r *http.Request) {
\t\tw.Write([]byte("ok"))
\t})
\thttp.ListenAndServe(":8080", nil)
}
`,
  );

  const result = await runPipelineFromRepo(repoDir, () => {}, {});
  const adapter = await import('../../src/core/lbug/lbug-adapter.js');
  await adapter.initLbug(dbPath);
  await adapter.loadGraphToLbug(result.graph, tmpBase, storagePath);
}, 120_000);

afterAll(async () => {
  try {
    const adapter = await import('../../src/core/lbug/lbug-adapter.js');
    await adapter.closeLbug();
  } catch {
    /* may not have opened */
  }
  if (tmpBase) {
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

describe('inline Go provider handler resolves via real source-scan containment (#2276)', () => {
  it('resolves an inline http.HandleFunc closure to the containing main() with a real symbolUid', async () => {
    const adapter = await import('../../src/core/lbug/lbug-adapter.js');
    // Param-aware executor (CONTAINING_QUERY binds $filePath) — the same shape
    // production passes to ContractExtractors.
    const dbExecutor: CypherExecutor = (query, params = {}) =>
      adapter.executePrepared(query, params);
    const repo: RepoHandle = {
      id: 'test-repo',
      path: 'repo',
      repoPath: repoDir,
      storagePath,
    };

    const contracts = await new HttpRouteExtractor().extract(dbExecutor, repoDir, repo);
    const provider = contracts.find(
      (c) => c.role === 'provider' && c.contractId === 'http::GET::/api/health',
    );

    expect(provider).toBeDefined();
    // The real pipeline indexed main() with its true 0-based span; the emitted
    // call-site line lands inside it, so containment yields a real symbolUid
    // rather than the empty file-level fallback.
    expect(provider?.symbolUid).toBeTruthy();
    expect(provider?.symbolName).toBe('main');
    expect(provider?.meta.extractionStrategy).toBe('source_scan_resolved');
  });
});
