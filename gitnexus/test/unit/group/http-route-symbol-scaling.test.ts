import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  CONTAINING_FILES_QUERY,
  CONTAINING_QUERY,
  HANDLES_ROUTE_QUERY,
  HttpRouteExtractor,
} from '../../../src/core/group/extractors/http-route-extractor.js';

const directories: string[] = [];
afterEach(() => {
  for (const dir of directories.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function fixture(count: number, failBatch = false) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'http-symbol-scaling-'));
  directories.push(dir);
  const symbols = Array.from({ length: count }, (_, i) => ({
    uid: `Function:${i}`,
    name: `handler${i}`,
    filePath: `r${i}.opaque`,
    startLine: 0,
    endLine: 10,
    labels: ['Function'],
  }));
  const routes: Record<string, unknown>[] = symbols.map((symbol, i) => ({
    fileId: `File:${i}`,
    filePath: symbol.filePath,
    routePath: `/r${i}`,
    routeId: `Route:${i}`,
    routeMethod: 'GET',
    handlerSymbolId: symbol.uid,
  }));
  const db = vi.fn(async (query: string, params: Record<string, unknown> = {}) => {
    if (query === HANDLES_ROUTE_QUERY) return routes;
    if (query === CONTAINING_FILES_QUERY) {
      if (failBatch) throw new Error('batch unavailable');
      const files = new Set(params.filePaths as string[]);
      return symbols.filter((s) => files.has(s.filePath));
    }
    if (query === CONTAINING_QUERY) return symbols.filter((s) => s.filePath === params.filePath);
    return [];
  });
  const run = () =>
    new HttpRouteExtractor().extract(db, dir, {
      id: 'test',
      path: 'repo',
      repoPath: dir,
      storagePath: dir,
    });
  return { dir, symbols, routes, db, run };
}

const queries = (f: ReturnType<typeof fixture>, query: string) =>
  f.db.mock.calls.filter(([q]) => q === query);

describe('HTTP symbol loading bounds repeated work', () => {
  it('loads any number of handler files with one query and preserves every handler', async () => {
    const f = fixture(501);
    const contracts = await f.run();
    expect(contracts.map((c) => [c.contractId, c.symbolUid, c.symbolName]).sort()).toEqual(
      f.symbols.map((s, i) => [`http::GET::/r${i}`, s.uid, s.name]).sort(),
    );
    expect(queries(f, CONTAINING_FILES_QUERY)).toHaveLength(1);
    expect(queries(f, CONTAINING_FILES_QUERY)[0][1]).toEqual({
      filePaths: f.symbols.map((s) => s.filePath).sort(),
    });
    expect(queries(f, CONTAINING_QUERY)).toEqual([]);
  });

  it('asks only for the requested file when other files have many symbols', async () => {
    const f = fixture(501);
    f.routes.splice(1);
    expect(await f.run()).toHaveLength(1);
    expect(queries(f, CONTAINING_FILES_QUERY).map(([, params]) => params)).toEqual([
      { filePaths: ['r0.opaque'] },
    ]);
    expect(queries(f, CONTAINING_QUERY)).toEqual([]);
  });

  it('falls back to one query per file after a failed batch without losing any contract', async () => {
    const f = fixture(501, true);
    const contracts = await f.run();
    expect(contracts.map((c) => c.symbolName).sort()).toEqual(f.symbols.map((s) => s.name).sort());
    expect(queries(f, CONTAINING_FILES_QUERY)).toHaveLength(1);
    expect(queries(f, CONTAINING_QUERY)).toHaveLength(501);
  });

  it('names routes without a handler id up front and remembers absent files', async () => {
    const f = fixture(500);
    fs.writeFileSync(
      path.join(f.dir, 'late.py'),
      'from fastapi import FastAPI\napp = FastAPI()\n@app.get("/late")\ndef late():\n    return {}\n',
    );
    fs.writeFileSync(
      path.join(f.dir, 'missing.py'),
      'from fastapi import FastAPI\napp = FastAPI()\n@app.get("/missing")\ndef missing():\n    return {}\n',
    );
    f.symbols.push({
      uid: 'Function:late',
      name: 'late',
      filePath: 'late.py',
      startLine: 3,
      endLine: 4,
      labels: ['Function'],
    });
    for (const name of ['late', 'missing'])
      f.routes.push({
        fileId: `File:${name}`,
        filePath: `${name}.py`,
        routePath: `/${name}`,
        routeMethod: 'GET',
        handlerSymbolId: '',
      });
    const contracts = await f.run();
    expect(contracts.find((c) => c.contractId === 'http::GET::/late')?.symbolUid).toBe(
      'Function:late',
    );
    expect(contracts.find((c) => c.contractId === 'http::GET::/missing')?.symbolUid).toBe('');
    // One query for the 502 route files; the two scanned files are already cached.
    expect(queries(f, CONTAINING_FILES_QUERY)).toHaveLength(1);
    expect((queries(f, CONTAINING_FILES_QUERY)[0][1].filePaths as string[]).slice(0, 2)).toEqual([
      'late.py',
      'missing.py',
    ]);
    expect(queries(f, CONTAINING_QUERY)).toEqual([]);
  });

  it('loads scanned files with detections in one more query, whatever their number', async () => {
    const f = fixture(3);
    const consumers = Array.from({ length: 40 }, (_, i) => `web/c${i}.ts`);
    fs.mkdirSync(path.join(f.dir, 'web'));
    for (const [i, rel] of consumers.entries()) {
      fs.writeFileSync(
        path.join(f.dir, rel),
        `export async function load${i}() {\n  return fetch('/api/c${i}');\n}\n`,
      );
      f.symbols.push({
        uid: `Function:${rel}:load${i}`,
        name: `load${i}`,
        filePath: rel,
        startLine: 0,
        endLine: 2,
        labels: ['Function'],
      });
    }
    const contracts = await f.run();
    // The source scan visits files in glob order, so compare as sorted lists.
    expect(
      contracts
        .filter((c) => c.role === 'consumer')
        .map((c) => `${c.contractId} ${c.symbolUid}`)
        .sort(),
    ).toEqual(consumers.map((rel, i) => `http::GET::/api/c${i} Function:${rel}:load${i}`).sort());
    const batches = queries(f, CONTAINING_FILES_QUERY).map(
      ([, params]) => params.filePaths as string[],
    );
    expect(batches).toHaveLength(2);
    expect([...batches[1]].sort()).toEqual([...consumers].sort());
    expect(queries(f, CONTAINING_QUERY)).toEqual([]);
  });

  it('retains the first row when symbol IDs collide and scopes ID maps to a file', async () => {
    const f = fixture(2);
    f.symbols[1].uid = f.symbols[0].uid;
    f.routes[1].handlerSymbolId = f.symbols[0].uid;
    f.symbols.push({ ...f.symbols[0], name: 'laterDuplicate' });
    expect((await f.run()).map((c) => c.symbolName)).toEqual(['handler0', 'handler1']);
  });
});
