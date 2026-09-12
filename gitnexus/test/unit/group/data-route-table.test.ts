import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { HttpRouteExtractor } from '../../../src/core/group/extractors/http-route-extractor.js';
import type { RepoHandle } from '../../../src/core/group/types.js';
import { DATA_ROUTE_TABLE_SOURCE } from '../../../src/core/ingestion/route-extractors/data-route-table.js';

describe('data route table group contracts', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gitnexus-route-table-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  const repo = (): RepoHandle => ({
    id: 'route-table-test',
    path: 'test/route-table',
    repoPath: tmpDir,
    storagePath: path.join(tmpDir, '.gitnexus'),
  });

  it('resolves imported handlers and leaves source-only members unattributed', async () => {
    fs.writeFileSync(
      path.join(tmpDir, 'routes.js'),
      `import { listUsers as handleUsers } from './handlers.js';
const routes = [
  { path: '/users', method: 'GET', handler: handleUsers },
  { path: '/auth/me', method: 'GET', handler: auth.getCurrentUser },
];
for (const route of routes) {
  if (route.path === request.path && route.method === request.method) route.handler();
}
`,
    );
    fs.writeFileSync(
      path.join(tmpDir, 'handlers.js'),
      `export function listUsers() { return []; }
export const auth = { getCurrentUser() { return {}; } };
`,
    );

    const queriedNames: string[] = [];
    const db = async (_query: string, params?: Record<string, unknown>) => {
      const name = String(params?.name ?? '');
      queriedNames.push(name);
      if (name !== 'listUsers' && name !== 'getCurrentUser') return [];
      return [
        {
          uid: `symbol:${name}`,
          name,
          filePath: 'handlers.js',
          startLine: 1,
          endLine: 2,
          labels: ['Function'],
        },
      ];
    };

    const contracts = await new HttpRouteExtractor().extract(db, tmpDir, repo());
    const providers = contracts.filter(
      (contract) =>
        contract.role === 'provider' && contract.meta.framework === DATA_ROUTE_TABLE_SOURCE,
    );

    expect(
      providers
        .map((provider) => ({
          contractId: provider.contractId,
          symbolUid: provider.symbolUid,
          symbolName: provider.symbolName,
          extractionStrategy: provider.meta.extractionStrategy,
        }))
        .sort((left, right) => left.contractId.localeCompare(right.contractId)),
    ).toEqual([
      {
        contractId: 'http::GET::/auth/me',
        symbolUid: '',
        symbolName: 'handler',
        extractionStrategy: 'source_scan',
      },
      {
        contractId: 'http::GET::/users',
        symbolUid: 'symbol:listUsers',
        symbolName: 'listUsers',
        extractionStrategy: 'source_scan_resolved',
      },
    ]);
    expect(queriedNames).not.toContain('getCurrentUser');
  });

  it('keeps ambiguous handlers unattributed instead of guessing', async () => {
    fs.writeFileSync(
      path.join(tmpDir, 'routes.js'),
      `const routes = [{ path: '/users', method: 'GET', handler: listUsers }];
for (const route of routes) {
  if (route.path === request.path && route.method === request.method) route.handler();
}`,
    );
    const db = async (_query: string, params?: Record<string, unknown>) =>
      params?.name === 'listUsers'
        ? [
            { uid: 'a', name: 'listUsers', filePath: 'a.js' },
            { uid: 'b', name: 'listUsers', filePath: 'b.js' },
          ]
        : [];

    const contracts = await new HttpRouteExtractor().extract(db, tmpDir, repo());
    const provider = contracts.find((contract) => contract.contractId === 'http::GET::/users');

    expect(provider).toMatchObject({ symbolUid: '', symbolName: 'listUsers' });
  });

  it('keeps duplicate same-file handlers unattributed', async () => {
    fs.writeFileSync(
      path.join(tmpDir, 'routes.js'),
      `const routes = [{ path: '/users', method: 'GET', handler: listUsers }];
for (const route of routes) {
  if (route.path === request.path && route.method === request.method) route.handler();
}`,
    );
    const db = async (query: string) =>
      query.includes('UNION ALL')
        ? [
            { uid: 'a', name: 'listUsers', filePath: 'routes.js', labels: ['Function'] },
            { uid: 'b', name: 'listUsers', filePath: 'routes.js', labels: ['Function'] },
          ]
        : [];

    const contracts = await new HttpRouteExtractor().extract(db, tmpDir, repo());
    const provider = contracts.find((contract) => contract.contractId === 'http::GET::/users');

    expect(provider).toMatchObject({ symbolUid: '', symbolName: 'listUsers' });
  });

  it('does not bind an unimported handler to a unique same-name symbol in another file', async () => {
    fs.writeFileSync(
      path.join(tmpDir, 'routes.js'),
      `const routes = [{ path: '/users', method: 'GET', handler: listUsers }];
for (const route of routes) {
  if (route.path === request.path && route.method === request.method) route.handler();
}`,
    );
    const db = async (query: string, params?: Record<string, unknown>) => {
      if (query.includes('UNION ALL')) return [];
      return params?.name === 'listUsers'
        ? [{ uid: 'decoy', name: 'listUsers', filePath: 'unrelated.js' }]
        : [];
    };

    const contracts = await new HttpRouteExtractor().extract(db, tmpDir, repo());
    const provider = contracts.find((contract) => contract.contractId === 'http::GET::/users');

    expect(provider).toMatchObject({ symbolUid: '', symbolName: 'listUsers' });
  });

  it('does not fall back from an unresolved import to a same-name local symbol', async () => {
    fs.writeFileSync(
      path.join(tmpDir, 'routes.js'),
      `import { listUsers } from 'external-router-package';
const routes = [{ path: '/users', method: 'GET', handler: listUsers }];
for (const route of routes) {
  if (route.path === request.path && route.method === request.method) route.handler();
}`,
    );
    const db = async (_query: string, params?: Record<string, unknown>) =>
      params?.name === 'listUsers'
        ? [{ uid: 'local-decoy', name: 'listUsers', filePath: 'local.js' }]
        : [];

    const contracts = await new HttpRouteExtractor().extract(db, tmpDir, repo());
    const provider = contracts.find((contract) => contract.contractId === 'http::GET::/users');

    expect(provider).toMatchObject({ symbolUid: '', symbolName: 'listUsers' });
  });

  it('does not attribute an unresolved member handler to its registrar function', async () => {
    fs.writeFileSync(
      path.join(tmpDir, 'routes.js'),
      `function setupRoutes(path, method) {
  const routes = [{ path: '/me', method: 'GET', handler: auth.getCurrentUser }];
  for (const route of routes) {
    if (route.path === request.path && route.method === request.method) route.handler();
  }
}
`,
    );
    const db = async (query: string) =>
      query.includes('UNION ALL')
        ? [
            {
              uid: 'function:setupRoutes',
              name: 'setupRoutes',
              filePath: 'routes.js',
              startLine: 0,
              endLine: 5,
              labels: ['Function'],
            },
          ]
        : [];

    const contracts = await new HttpRouteExtractor().extract(db, tmpDir, repo());
    const provider = contracts.find((contract) => contract.contractId === 'http::GET::/me');

    expect(provider).toMatchObject({ symbolUid: '', symbolName: 'handler' });
  });

  it('suppresses duplicate identities when any data-table handler is unresolved', async () => {
    fs.writeFileSync(
      path.join(tmpDir, 'routes.js'),
      `function second() {}
const routes = [
  { path: '/users', method: 'GET', handler: missing },
  { path: '/users', method: 'GET', handler: second },
];
for (const route of routes) {
  if (route.path === request.path && route.method === request.method) route.handler();
}`,
    );
    const db = async (query: string) =>
      query.includes('UNION ALL')
        ? [{ uid: 'second', name: 'second', filePath: 'routes.js', labels: ['Function'] }]
        : [];

    const contracts = await new HttpRouteExtractor().extract(db, tmpDir, repo());

    expect(contracts.some((contract) => contract.contractId === 'http::GET::/users')).toBe(false);
  });

  it('suppresses duplicate identities that resolve to different handlers', async () => {
    fs.writeFileSync(
      path.join(tmpDir, 'routes.js'),
      `function first() {}
function second() {}
const routes = [
  { path: '/users', method: 'GET', handler: first },
  { path: '/users', method: 'GET', handler: second },
];
for (const route of routes) {
  if (route.path === request.path && route.method === request.method) route.handler();
}`,
    );
    const db = async (query: string) =>
      query.includes('UNION ALL')
        ? [
            { uid: 'first', name: 'first', filePath: 'routes.js', labels: ['Function'] },
            { uid: 'second', name: 'second', filePath: 'routes.js', labels: ['Function'] },
          ]
        : [];

    const contracts = await new HttpRouteExtractor().extract(db, tmpDir, repo());

    expect(contracts.some((contract) => contract.contractId === 'http::GET::/users')).toBe(false);
  });
});
