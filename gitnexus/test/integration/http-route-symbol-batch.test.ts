/**
 * `HttpRouteExtractor` loads the symbols of the files it expects to look up
 * with one CONTAINING_FILES_QUERY instead of one CONTAINING_QUERY per file. The
 * batch carries no ORDER BY (nor does CONTAINING_QUERY): the extractor groups
 * its rows by file in arrival order, and relies on each file's rows arriving in
 * the order that file's own CONTAINING_QUERY returns them, because the
 * resolvers take the first name match and the first of two equal spans.
 *
 * The unit suite proves the extractor's side with a fake executor. This runs
 * the real pipeline over a small multi-language repository, loads the graph
 * into a real LadybugDB, and checks the engine's side: for every file the
 * batch returns exactly its own query's rows in the same order, and the
 * extractor produces the same contracts with the batch as without it. (The
 * graph is small enough that a file's own query has one row order to match.)
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { runPipelineFromRepo } from '../../src/core/ingestion/pipeline.js';
import {
  CONTAINING_FILES_QUERY,
  CONTAINING_QUERY,
  HttpRouteExtractor,
} from '../../src/core/group/extractors/http-route-extractor.js';
import type { CypherExecutor } from '../../src/core/group/contract-extractor.js';
import type { RepoHandle } from '../../src/core/group/types.js';

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
  'service/main.py': `from fastapi import FastAPI

app = FastAPI()


@app.get("/api/status")
def status():
    return {"ok": True}
`,
};

beforeAll(async () => {
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
  const adapter = await import('../../src/core/lbug/lbug-adapter.js');
  await adapter.initLbug(dbPath);
  await adapter.loadGraphToLbug(result.graph, repoDir, storagePath);
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

const realExecutor = async (): Promise<CypherExecutor> => {
  const adapter = await import('../../src/core/lbug/lbug-adapter.js');
  return (query, params = {}) => adapter.executePrepared(query, params);
};

describe('CONTAINING_FILES_QUERY against a real LadybugDB', () => {
  it('returns each file exactly the rows of its own CONTAINING_QUERY, in the same order', async () => {
    const db = await realExecutor();
    const fileRows = (await db(
      `MATCH (f:File) RETURN f.filePath AS filePath ORDER BY filePath`,
    )) as Array<{ filePath: string }>;
    const files = fileRows.map((r) => r.filePath);
    expect(files).toEqual(expect.arrayContaining(Object.keys(FILES)));

    const batched = new Map<string, Record<string, unknown>[]>();
    for (const row of await db(CONTAINING_FILES_QUERY, { filePaths: files })) {
      const filePath = String(row.filePath);
      batched.set(filePath, [...(batched.get(filePath) ?? []), row]);
    }

    let symbolRows = 0;
    for (const filePath of files) {
      const own = await db(CONTAINING_QUERY, { filePath });
      symbolRows += own.length;
      expect(batched.get(filePath) ?? [], filePath).toEqual(own);
    }
    // The comparison is not vacuous: the source files define symbols.
    expect(symbolRows).toBeGreaterThan(10);
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

    expect(fromBatches).toEqual(fromSingles);
    // Handler symbols resolved from the graph, not a file-level fallback.
    const byId = new Map(fromBatches.map((c) => [`${c.role} ${c.contractId}`, c]));
    expect(byId.get('provider http::GET::/api/orders')?.symbolName).toBe('listOrders');
    expect(byId.get('provider http::DELETE::/api/items/{param}')?.symbolName).toBe('deleteItem');
    expect(byId.get('provider http::GET::/api/health')?.symbolName).toBe('health');
    expect(byId.get('provider http::GET::/api/status')?.symbolName).toBe('status');

    expect(batched.counts.batch).toBeGreaterThan(0);
    expect(batched.counts.batch + batched.counts.single).toBeLessThan(perFile.counts.single);
  });
});
