import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  CONTAINING_ALL_QUERY,
  CONTAINING_FILES_QUERY,
  CONTAINING_QUERY,
  HANDLES_ROUTE_QUERY,
  HttpRouteExtractor,
} from '../../../src/core/group/extractors/http-route-extractor.js';

const directories: string[] = [];
afterEach(() => {
  for (const dir of directories.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function fixture(count: number, failFullScan = false) {
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
    if (query === CONTAINING_ALL_QUERY) {
      if (failFullScan) throw new Error('full scan unavailable');
      return symbols;
    }
    if (query === CONTAINING_FILES_QUERY) {
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

describe('HTTP symbol loading bounds repeated work', () => {
  it('uses one complete scan beyond the file limit and preserves every handler', async () => {
    const f = fixture(501);
    const contracts = await f.run();
    expect(contracts.map((c) => [c.contractId, c.symbolUid, c.symbolName])).toEqual(
      f.symbols.map((s, i) => [`http::GET::/r${i}`, s.uid, s.name]),
    );
    expect(f.db.mock.calls.filter(([q]) => q === CONTAINING_ALL_QUERY)).toHaveLength(1);
    expect(
      f.db.mock.calls.filter(([q]) => q === CONTAINING_FILES_QUERY || q === CONTAINING_QUERY),
    ).toEqual([]);
  });

  it('keeps sparse lookups selective even when other files have many symbols', async () => {
    const f = fixture(501);
    f.routes.splice(1);
    expect(await f.run()).toHaveLength(1);
    expect(f.db.mock.calls.filter(([q]) => q === CONTAINING_ALL_QUERY)).toEqual([]);
    expect(f.db.mock.calls.find(([q]) => q === CONTAINING_FILES_QUERY)?.[1]).toEqual({
      filePaths: ['r0.opaque'],
    });
  });

  it('falls back after a failed complete scan without losing any contract', async () => {
    const f = fixture(501, true);
    const contracts = await f.run();
    expect(contracts.map((c) => c.symbolName)).toEqual(f.symbols.map((s) => s.name));
    expect(f.db.mock.calls.filter(([q]) => q === CONTAINING_ALL_QUERY)).toHaveLength(1);
    expect(f.db.mock.calls.filter(([q]) => q === CONTAINING_QUERY)).toHaveLength(501);
  });

  it('bounds misses discovered after the initial batch and remembers absent files', async () => {
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
    expect(f.db.mock.calls.filter(([q]) => q === CONTAINING_FILES_QUERY)).toHaveLength(1);
    expect(f.db.mock.calls.filter(([q]) => q === CONTAINING_ALL_QUERY)).toHaveLength(1);
    expect(f.db.mock.calls.filter(([q]) => q === CONTAINING_QUERY)).toEqual([]);
  });

  it('retains the first row when symbol IDs collide and scopes ID maps to a file', async () => {
    const f = fixture(2);
    f.symbols[1].uid = f.symbols[0].uid;
    f.routes[1].handlerSymbolId = f.symbols[0].uid;
    f.symbols.push({ ...f.symbols[0], name: 'laterDuplicate' });
    expect((await f.run()).map((c) => c.symbolName)).toEqual(['handler0', 'handler1']);
  });
});
