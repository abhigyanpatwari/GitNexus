/**
 * `HttpRouteExtractor` loads the symbols of the files it expects to look up
 * with one CONTAINING_FILES_QUERY instead of one CONTAINING_QUERY per file.
 * Neither query has an ORDER BY, and on a connection with several execution
 * threads the engine returns a file's rows in an order that changes between
 * calls. The extractor therefore sorts each file's rows on the scan offset the
 * queries return (`ord`) before the first-match resolvers read them.
 *
 * The unit suite proves the extractor's side with a fake executor. This runs
 * the real pipeline over a small multi-language repository, loads the graph
 * into a real LadybugDB, and checks the engine's side: for every file the
 * batch returns exactly its own query's rows, and the extractor produces the
 * same contracts with the batch as without it, including a contract whose
 * symbol only row order decides.
 */
import assert from 'node:assert/strict';
import { describe, it, before, after } from 'node:test';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { runPipelineFromRepo } from '../../../../src/core/ingestion/pipeline.js';
import {
  CONTAINING_FILES_QUERY,
  CONTAINING_QUERY,
  HttpRouteExtractor,
} from '../../../../src/core/group/extractors/http-route-extractor.js';
import type { CypherExecutor } from '../../../../src/core/group/contract-extractor.js';
import type { RepoHandle } from '../../../../src/core/group/types.js';

let tmpBase: string;
let repoDir: string;
let storagePath: string;

const FILES: Record<string, string> = {
  'src/server.ts': `import express from 'express';
import { usersRouter } from './users';

const app = express();

export function health(req, res) {
  res.json({ ok: true });
}

app.get('/api/health', health);
app.post('/api/echo', (req, res) => {
  res.json(req.body);
});
app.use('/api/users', usersRouter);
`,
  'src/users.ts': `import { Router } from 'express';

export const usersRouter = Router();

export function listUsers(req, res) {
  res.json([]);
}

export function getUser(req, res) {
  res.json({ id: req.params.id });
}

usersRouter.get('/', listUsers);
usersRouter.get('/:id', getUser);
`,
  'web/client.ts': `export async function loadUsers() {
  const res = await fetch('/api/users');
  return res.json();
}

export async function loadHealth() {
  const res = await fetch('/api/health');
  return res.json();
}
`,
  'src/main/java/shop/OrderController.java': `package shop;

import org.springframework.web.bind.annotation.*;

@RestController
@RequestMapping("/api/orders")
public class OrderController {
    @GetMapping
    public String listOrders() {
        return "[]";
    }

    @PostMapping
    public String createOrder(@RequestBody String body) {
        return body;
    }

    @GetMapping("/{id}")
    public String getOrder(@PathVariable String id) {
        return id;
    }
}
`,
  'src/main/java/shop/ItemController.java': `package shop;

import org.springframework.web.bind.annotation.*;

@RestController
public class ItemController {
    @GetMapping("/api/items")
    public String listItems() {
        return "[]";
    }

    @DeleteMapping("/api/items/{id}")
    public void deleteItem(@PathVariable String id) {
    }
}
`,
  // One line, so the Function `boot` and the Method `Api.load` have the same
  // span around the fetch, and the file has rows in two node tables.
  'web/min.ts': `export function boot() { class Api { load() { return fetch('/api/min'); } } return new Api(); }
`,
  'service/main.py': `from fastapi import FastAPI

app = FastAPI()


@app.get("/api/status")
def status():
    return {"ok": True}
`,
};

before(
  async () => {
    tmpBase = await fs.mkdtemp(path.join(os.tmpdir(), 'gitnexus-http-symbol-batch-'));
    repoDir = path.join(tmpBase, 'repo');
    storagePath = path.join(tmpBase, '.gitnexus');
    const dbPath = path.join(storagePath, 'lbug');
    for (const [rel, content] of Object.entries(FILES)) {
      await fs.mkdir(path.dirname(path.join(repoDir, rel)), { recursive: true });
      await fs.writeFile(path.join(repoDir, rel), content);
    }
    await fs.mkdir(dbPath, { recursive: true });

    const result = await runPipelineFromRepo(repoDir, () => {}, {});
    const adapter = await import('../../../../src/core/lbug/lbug-adapter.js');
    await adapter.initLbug(dbPath);
    await adapter.loadGraphToLbug(result.graph, repoDir, storagePath);
  },
  { timeout: 120_000 },
);

after(async () => {
  try {
    const adapter = await import('../../../../src/core/lbug/lbug-adapter.js');
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

const realExecutor = async (): Promise<CypherExecutor> => {
  const adapter = await import('../../../../src/core/lbug/lbug-adapter.js');
  return (query, params = {}) => adapter.executePrepared(query, params);
};

const sortedByUid = (rows: Record<string, unknown>[]): Record<string, unknown>[] =>
  [...rows].sort((a, b) => String(a.uid).localeCompare(String(b.uid)));

describe('CONTAINING_FILES_QUERY against a real LadybugDB', () => {
  it('returns each file exactly the rows of its own CONTAINING_QUERY', async () => {
    const db = await realExecutor();
    const fileRows = (await db(
      `MATCH (f:File) RETURN f.filePath AS filePath ORDER BY filePath`,
    )) as Array<{ filePath: string }>;
    const files = fileRows.map((r) => r.filePath);
    assert.ok(Object.keys(FILES).every((expected) => files.includes(expected)));

    const batched = new Map<string, Record<string, unknown>[]>();
    for (const row of await db(CONTAINING_FILES_QUERY, { filePaths: files })) {
      const filePath = String(row.filePath);
      batched.set(filePath, [...(batched.get(filePath) ?? []), row]);
    }

    const labelsPerFile: number[] = [];
    for (const filePath of files) {
      const own = await db(CONTAINING_QUERY, { filePath });
      labelsPerFile.push(new Set(own.map((row) => JSON.stringify(row.labels))).size);
      // Row order is the engine's and differs between calls: compare the sets.
      assert.deepEqual(sortedByUid(batched.get(filePath) ?? []), sortedByUid(own), filePath);
    }
    // The comparison is not vacuous: no file is skipped, the source files
    // define symbols, and one of them has rows in two node tables.
    assert.equal(labelsPerFile.length, files.length);
    assert.ok(labelsPerFile.filter((n) => n > 0).length >= 6);
    assert.equal(Math.max(...labelsPerFile), 2);
  });

  it('gives the extractor the same contracts as one query per file, in fewer queries', async () => {
    const db = await realExecutor();
    const repo: RepoHandle = { id: 'test-repo', path: 'repo', repoPath: repoDir, storagePath };
    // HANDLES_ROUTE / FETCHES carry no ORDER BY either, so two runs could see
    // their rows in different orders. Every query other than the two symbol
    // queries is answered once and replayed to both runs, so only the way
    // symbols load differs between them.
    const replayed = new Map<string, Promise<Record<string, unknown>[]>>();
    const counting = (failBatch: boolean) => {
      const counts = { batch: 0, single: 0 };
      const executor: CypherExecutor = async (query, params) => {
        if (query === CONTAINING_FILES_QUERY) {
          counts.batch += 1;
          if (failBatch) throw new Error('batch disabled');
          return db(query, params);
        }
        if (query === CONTAINING_QUERY) {
          counts.single += 1;
          return db(query, params);
        }
        const key = JSON.stringify([query, params ?? {}]);
        let rows = replayed.get(key);
        if (!rows) replayed.set(key, (rows = db(query, params)));
        return (await rows).map((row) => ({ ...row }));
      };
      return { executor, counts };
    };
    const batched = counting(false);
    const perFile = counting(true);

    const fromBatches = await new HttpRouteExtractor().extract(batched.executor, repoDir, repo);
    const fromSingles = await new HttpRouteExtractor().extract(perFile.executor, repoDir, repo);

    assert.deepEqual(fromBatches, fromSingles);
    // Handler symbols resolved from the graph, not a file-level fallback.
    const byId = new Map(fromBatches.map((c) => [`${c.role} ${c.contractId}`, c]));
    assert.equal(byId.get('provider http::GET::/api/orders')?.symbolName, 'listOrders');
    assert.equal(byId.get('provider http::DELETE::/api/items/{param}')?.symbolName, 'deleteItem');
    assert.equal(byId.get('provider http::GET::/api/health')?.symbolName, 'health');
    assert.equal(byId.get('provider http::GET::/api/status')?.symbolName, 'status');

    // One batch for the route files and one for the scanned files with
    // detections; the failing run reads every source file with its own query.
    assert.deepEqual(batched.counts, { batch: 2, single: 0 });
    assert.deepEqual(perFile.counts, { batch: 2, single: Object.keys(FILES).length });
  });

  it('resolves an equal-span tie the same way on every run', async () => {
    const db = await realExecutor();
    const repo: RepoHandle = { id: 'test-repo', path: 'repo', repoPath: repoDir, storagePath };
    // `boot` (Function) and `Api.load` (Method) both span the fetch in
    // web/min.ts. The engine returns the two rows in either order; the
    // extractor's fixed order puts the Function first.
    const winners = new Set<string>();
    let firstContracts: unknown;
    for (let run = 0; run < 20; run++) {
      const contracts = await new HttpRouteExtractor().extract(db, repoDir, repo);
      if (run === 0) firstContracts = contracts;
      else assert.deepEqual(contracts, firstContracts);
      const tie = contracts.find(
        (c) => c.role === 'consumer' && c.contractId === 'http::GET::/api/min',
      );
      winners.add(`${tie?.symbolName} ${tie?.symbolUid}`);
    }
    assert.deepEqual([...winners], ['boot Function:web/min.ts:boot']);
  });
});
