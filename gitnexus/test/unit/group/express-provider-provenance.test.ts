import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { HttpRouteExtractor } from '../../../src/core/group/extractors/http-route-extractor.js';
import type { RepoHandle } from '../../../src/core/group/types.js';
import {
  getRelationships,
  runPipelineFromRepo,
  writeFixtureRepo,
} from '../../integration/resolvers/helpers.js';

describe('Express group provider provenance', () => {
  let root: string;
  const extractor = new HttpRouteExtractor();
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'gitnexus-group-express-'));
  });
  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });
  const write = (files: Record<string, string>) => writeFixtureRepo(root, files);
  const repo = (): RepoHandle => ({
    id: 'test',
    path: root,
    repoPath: root,
    storagePath: path.join(root, '.gitnexus'),
  });
  const providers = (contracts: Awaited<ReturnType<HttpRouteExtractor['extract']>>) =>
    contracts
      .filter((contract) => contract.role === 'provider')
      .map((contract) => contract.contractId)
      .sort();

  it('composes imported Express routers instead of publishing their local paths', async () => {
    write({
      'server.ts': `import express from 'express'; import router from './router'; const app = express(); app.use('/api', router);`,
      'router.ts': `import { Router } from 'express'; const router = Router(); router.get('/users', () => {}); export default router;`,
    });
    expect(providers(await extractor.extract(null, root, repo()))).toEqual([
      'http::GET::/api/users',
    ]);
  });

  it('does not admit arbitrary receivers named app or router', async () => {
    write({
      'server.ts': `const router = new Map(); router.get('/not-http', 'fallback'); const app = { post() {} }; app.post('/also-not-http', () => {});`,
    });
    expect(providers(await extractor.extract(null, root, repo()))).toEqual([]);
  });

  it('agrees with ingestion across mixed extensions, aliases and multiple mounts while preserving consumers and other providers', async () => {
    write({
      'tsconfig.json': JSON.stringify({
        compilerOptions: { baseUrl: '.', paths: { '@routes/*': ['src/*'] } },
      }),
      'server.ts': `import express from 'express'; import { middle } from '@routes/middle'; import hidden from './src/hidden'; const app = express(); app.use(['/v1', '/v2'], auth, middle); app.use(runtimePrefix, middle); app.use(runtimePrefix, hidden);`,
      'src/middle.js': `import { Router } from 'express'; import { nested } from './leaf'; export const middle = Router(); middle.use('/admin', nested);`,
      'src/leaf.tsx': `import { Router } from 'express'; import axios from 'axios'; export const nested = Router(); nested.get('/users', () => {}); export async function outbound() { await fetch('/remote'); return axios.post('/outbound'); }`,
      'src/hidden.js': `import { Router } from 'express'; const hidden = Router(); hidden.get('/hidden', () => {}); export default hidden;`,
      'src/other.ts': `import { Hono } from 'hono'; import { Controller, Get } from '@nestjs/common'; const edge = new Hono(); edge.get('/hono', () => {}); @Controller('nest') class ControllerClass { @Get('list') list() {} } const routes = [{ path: '/table', method: 'POST', handler: tableHandler }]; function tableHandler() {} for (const route of routes) { if (route.path === request.path && route.method === request.method) route.handler(); }`,
    });
    const expected = [
      'http::GET::/hono',
      'http::GET::/nest/list',
      'http::GET::/v1/admin/users',
      'http::GET::/v2/admin/users',
      'http::POST::/table',
    ];
    const sourceOnly = await extractor.extract(null, root, repo());
    expect(providers(sourceOnly)).toEqual(expected);
    expect(
      sourceOnly
        .filter((contract) => contract.role === 'consumer')
        .map((contract) => contract.contractId)
        .sort(),
    ).toEqual(['http::GET::/remote', 'http::POST::/outbound']);

    const ingested = await runPipelineFromRepo(root, () => {});
    const rows = getRelationships(ingested, 'HANDLES_ROUTE')
      .filter((edge) => edge.sourceLabel === 'File')
      .map((edge) => {
        const route = ingested.graph.getNode(edge.rel.targetId)!;
        return {
          fileId: edge.rel.sourceId,
          filePath: edge.sourceFilePath,
          routePath: edge.target,
          routeMethod: route.properties.method,
          routeSource: edge.rel.reason,
          handlerSymbolId: route.properties.handlerSymbolId,
        };
      });
    expect(rows.map((row) => `http::${row.routeMethod}::${row.routePath}`).sort()).toEqual(
      expected,
    );
    const db = async (query: string) => (query.includes("type: 'HANDLES_ROUTE'") ? rows : []);
    expect(providers(await extractor.extract(db, root, repo()))).toEqual(expected);

    // A later run rebuilds project relationships even when router files are unchanged.
    write({
      'server.ts': `import express from 'express'; import { middle } from '@routes/middle'; import hidden from './src/hidden'; const app = express(); app.use('/v3', middle); app.use(runtimePrefix, hidden);`,
    });
    expect(providers(await extractor.extract(null, root, repo()))).toEqual([
      'http::GET::/hono',
      'http::GET::/nest/list',
      'http::GET::/v3/admin/users',
      'http::POST::/table',
    ]);
  }, 60000);

  it('enriches composed graph routes from exact same-line registrations and imported handler aliases', async () => {
    write({
      'server.ts': `import express from 'express'; import router from './router'; const app = express(); app.use('/api', router);`,
      'router.ts': `import { Router } from 'express'; import { list as imported } from './handlers'; const router = Router(); function local() {} router.get('/local', local); router.get('/imported', imported); export default router;`,
      'handlers.ts': `export function list() {}`,
    });
    const db = async (
      query: string,
      params?: Record<string, unknown>,
    ): Promise<Record<string, unknown>[]> => {
      if (query.includes("type: 'HANDLES_ROUTE'"))
        return ['/local', '/imported'].map((route) => ({
          fileId: 'router-file',
          filePath: 'router.ts',
          routePath: `/api${route}`,
          routeMethod: 'GET',
          handlerSymbolId: '',
        }));
      if (query.includes('UNION ALL') && params?.filePath === 'router.ts')
        return [
          {
            uid: 'local-uid',
            name: 'local',
            filePath: 'router.ts',
            startLine: 0,
            endLine: 0,
            labels: ['Function'],
          },
        ];
      if (query.includes('STARTS WITH') && params?.name === 'list')
        return [{ uid: 'list-uid', name: 'list', filePath: 'handlers.ts' }];
      return [];
    };
    const contracts = await extractor.extract(db, root, repo());
    expect(providers(contracts)).toEqual(['http::GET::/api/imported', 'http::GET::/api/local']);
    expect(
      contracts.find((contract) => contract.contractId === 'http::GET::/api/imported'),
    ).toMatchObject({
      symbolUid: 'list-uid',
      symbolRef: { filePath: 'handlers.ts' },
      meta: { extractionStrategy: 'graph_assisted' },
    });
    expect(
      contracts.find((contract) => contract.contractId === 'http::GET::/api/local')?.symbolUid,
    ).toBe('local-uid');
  });

  it('does not borrow global handlers or the enclosing registrar for unresolved handler designators', async () => {
    write({
      'router.ts': `import { Router } from 'express';
import { imported } from './handlers';
const router = Router();
function handler() {}
function install(handler, imported, object) {
  router.get('/parameter', handler); router.get('/shadowed-import', imported); router.get('/member', object.handler);
  router.get('/inline', () => {});
}
function unknown() { router.get('/unknown', missing); }
export default router;`,
    });
    const db = async (query: string): Promise<Record<string, unknown>[]> =>
      query.includes('UNION ALL')
        ? [
            {
              uid: 'global-handler',
              name: 'handler',
              filePath: 'router.ts',
              startLine: 3,
              endLine: 3,
              labels: ['Function'],
            },
            {
              uid: 'registrar',
              name: 'install',
              filePath: 'router.ts',
              startLine: 4,
              endLine: 7,
              labels: ['Function'],
            },
            {
              uid: 'unknown-registrar',
              name: 'unknown',
              filePath: 'router.ts',
              startLine: 8,
              endLine: 8,
              labels: ['Function'],
            },
          ]
        : [];
    const contracts = await extractor.extract(db, root, repo());
    expect(providers(contracts)).toEqual([
      'http::GET::/inline',
      'http::GET::/member',
      'http::GET::/parameter',
      'http::GET::/shadowed-import',
      'http::GET::/unknown',
    ]);
    for (const contract of contracts.filter(
      (contract) => contract.contractId !== 'http::GET::/inline',
    ))
      expect(contract.symbolUid).toBe('');
    expect(
      contracts.find((contract) => contract.contractId === 'http::GET::/inline')?.symbolUid,
    ).toBe('registrar');
  });

  it('fails closed when configured internal modules shadow framework package names', async () => {
    write({
      'tsconfig.json': JSON.stringify({
        compilerOptions: { baseUrl: '.', paths: { express: ['./local.ts'], hono: ['./local.ts'] } },
      }),
      'local.ts': `export default function storage() { return new Map(); } export class Hono { get() {} }`,
      'server.ts': `import express from 'express'; import { Hono } from 'hono'; const app = express(); const edge = new Hono(); app.get('/not-http', 'fallback'); edge.get('/also-not-http', () => {});`,
    });
    expect(providers(await extractor.extract(null, root, repo()))).toEqual([]);
  });
});
