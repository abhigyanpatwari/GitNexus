import { describe, it, expect, beforeAll } from 'vitest';
import path from 'path';
import {
  FIXTURES,
  getRelationships,
  getNodesByLabel,
  runPipelineFromRepo,
  type PipelineResult,
} from './helpers.js';

describe('Fetch wrapper consumer FETCHES edge extraction', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(path.join(FIXTURES, 'fetch-wrapper-consumers'), () => {});
  }, 60000);

  it('creates Route nodes for API endpoints', () => {
    const routes = getNodesByLabel(result, 'Route');
    expect(routes).toContain('/api/grants');
    expect(routes).toContain('/api/users');
  });

  it('creates FETCHES edge from GrantsList via apiFetch wrapper', () => {
    const edges = getRelationships(result, 'FETCHES');
    const grantsEdge = edges.find(
      (e) => e.sourceFilePath.includes('GrantsList') && e.target === '/api/grants',
    );
    expect(grantsEdge).toBeDefined();
  });

  it('creates FETCHES edge from UserList via apiFetch wrapper', () => {
    const edges = getRelationships(result, 'FETCHES');
    const usersEdge = edges.find(
      (e) => e.sourceFilePath.includes('UserList') && e.target === '/api/users',
    );
    expect(usersEdge).toBeDefined();
  });

  it('produces the correct total number of FETCHES edges', () => {
    const edges = getRelationships(result, 'FETCHES');
    expect(edges.length).toBe(2);
  });
});

// GitNexus's own web client (#3488): `fetchWithTimeout(`${_backendUrl}/api/repos`)`
// reaches fetch through `resilientFetch` and a local `fetchImpl` alias, and the
// URL starts with a base-URL binding.
describe('Base-URL wrapper consumer FETCHES edge extraction', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(path.join(FIXTURES, 'fetch-base-url-wrapper'), () => {});
  }, 60000);

  it('links base-URL calls through a forwarding wrapper chain, and nothing else', () => {
    const edges = getRelationships(result, 'FETCHES')
      .map((e) => `${e.sourceFilePath} -> ${e.rel.targetId.replace(/^Route:/, '')}`)
      .sort();
    expect(edges).toEqual([
      'web/backend-client.ts -> GET /api/analyze/:jobId',
      'web/backend-client.ts -> GET /api/file',
      'web/backend-client.ts -> GET /api/processes',
      'web/backend-client.ts -> GET /api/repos',
      'web/backend-client.ts -> POST /api/query',
      'web/client-request.ts -> GET /api/repos',
      'web/direct.ts -> GET /api/direct',
    ]);
  });
});

describe('Fetch wrapper lexical and project target identity', () => {
  it('resolves relative, alias, workspace, barrel, overload, multi-declarator, HOC, CommonJS and package-fetch targets while rejecting shadowed and ambiguous names', async () => {
    const result = await runPipelineFromRepo(
      path.join(FIXTURES, 'fetch-wrapper-target-identity'),
      () => {},
      { skipGraphPhases: true },
    );
    const edges = getRelationships(result, 'FETCHES')
      .map((edge) => `${edge.sourceFilePath} -> ${edge.target}`)
      .sort();
    expect(edges).toEqual([
      'lib/keys.ts -> /api/key',
      'lib/overloaded.ts -> /api/overload-local',
      'web/alias.ts -> /api/alias',
      'web/alias.ts -> /api/forwarded',
      'web/barrel.ts -> /api/barrel',
      'web/barrel.ts -> /api/barrel-imported',
      'web/barrel.ts -> /api/barrel-star',
      'web/cjs.js -> /api/cjs',
      'web/hoc.ts -> /api/hoc',
      'web/multi.ts -> /api/multi',
      'web/nested.ts -> /api/nested',
      'web/node.ts -> /api/node',
      'web/overloaded.ts -> /api/overload-import',
      'web/relative.ts -> /api/relative',
      'web/unresolved.ts -> /api/unique',
      'web/workspace.ts -> /api/workspace',
    ]);
  }, 60000);

  it('honors explicit wrapper names through local parameter bindings', async () => {
    const result = await runPipelineFromRepo(
      path.join(FIXTURES, 'fetch-wrapper-target-identity'),
      () => {},
      { skipGraphPhases: true, fetchWrappers: ['request'] },
    );
    const edges = getRelationships(result, 'FETCHES');
    expect(
      edges.some(
        (edge) => edge.sourceFilePath === 'web/shadow.ts' && edge.target === '/api/parameter',
      ),
    ).toBe(true);
  }, 60000);
});
