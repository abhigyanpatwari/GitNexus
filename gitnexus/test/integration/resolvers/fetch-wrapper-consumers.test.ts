import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import path from 'path';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { runtimeParseIdentity } from '../../helpers/runtime-parse-identity.js';
import { loadParseCache, saveParseCache } from '../../../src/storage/parse-cache.js';
import {
  getDurableParsedFileDir,
  pruneAndSaveDurableParsedFileStore,
} from '../../../src/storage/parsedfile-store.js';
import {
  FIXTURES,
  getRelationships,
  getNodesByLabel,
  runPipelineFromRepo,
  writeFixtureRepo,
  type PipelineResult,
} from './helpers.js';

const parseIdentity = await runtimeParseIdentity();

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

describe('Mount-prefixed wrapper consumers (#2858)', () => {
  let root: string;
  let cacheDir: string;
  let result: PipelineResult;

  beforeAll(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'consumer-mount-prefix-'));
    writeFixtureRepo(root, {
      'backend/main.py': `from fastapi import FastAPI
app = FastAPI()
@app.get('/api/models')
def models(): return []
@app.get('/api/agents/{id}')
def agent(id: str): return {}
@app.get('/models')
def other_models(): return []
@app.get('/unsupported')
def unsupported(): return []
`,
      'web/config.ts': `declare const VITE_API_BASE_URL: string;
export function getApiUrl(path: string) {
  const base = VITE_API_BASE_URL || '';
  const prefix = '/api';
  const normalized = path.startsWith('/') ? path : '/' + path;
  return \`\${base}\${prefix}\${normalized}\`;
}`,
      'web/request.ts': `import { getApiUrl } from './config';
export function request(path: string) {
  const url = getApiUrl(path);
  return fetch(url);
}
export function direct(path: string) { return fetch('/api' + path); }
export function versioned(path: string) { return fetch(\`/api\${path}\`); }
export function forward(path: string) { return direct(path); }
`,
      'web/clients/models.ts': `import { request } from '../request';
export function models() { return request('/models'); }`,
      'web/clients/direct.ts': `import { direct } from '../request';
export function models() { return direct('/models'); }`,
      'web/clients/agents.ts': `import { versioned } from '../request';
export function agent(id: string) { return versioned(\`/agents/\${id}\`); }`,
      'web/clients/nested.ts': `import { forward } from '../request';
export function models() {
  function request(path: string) { forward(path + ''); return 1; }
  return request('/models');
}`,
      'web/clients/forward.ts': `import { forward } from '../request';
export function models() { return forward('/models'); }`,
      'web/unsupported.ts': `function send(path: string) { return fetch(path.toUpperCase()); }
send('/unsupported');`,
      'web/decoy.ts': `function request(channel: string) { return channel; }
request('/models');
const cache = new Map(); cache.get('/models');`,
    });
    cacheDir = await mkdtemp(path.join(tmpdir(), 'consumer-mount-cache-'));
    const parseCache = await loadParseCache(cacheDir, parseIdentity, cacheDir);
    result = await runPipelineFromRepo(root, () => {}, { parseCache });
    const savedKeys = await saveParseCache(cacheDir, parseCache);
    await pruneAndSaveDurableParsedFileStore(
      getDurableParsedFileDir(cacheDir),
      parseIdentity.base,
      new Set(savedKeys),
    );
  }, 60_000);

  afterAll(async () => {
    if (root) await rm(root, { recursive: true, force: true });
    if (cacheDir) await rm(cacheDir, { recursive: true, force: true });
  });

  it('links the runtime URL through literals, forwarding, and an imported URL builder', () => {
    expect(
      getRelationships(result, 'FETCHES')
        .filter((edge) => edge.sourceFilePath.startsWith('web/clients/'))
        .map((edge) => `${edge.sourceFilePath} -> ${edge.target}`)
        .sort(),
    ).toEqual([
      'web/clients/agents.ts -> /api/agents/{id}',
      'web/clients/direct.ts -> /api/models',
      'web/clients/forward.ts -> /api/models',
      'web/clients/models.ts -> /api/models',
      'web/clients/nested.ts -> /api/models',
    ]);
  });

  it('does not link the caller literal to an unrelated unprefixed route', () => {
    expect(getRelationships(result, 'FETCHES').filter((edge) => edge.target === '/models')).toEqual(
      [],
    );
  });

  it('does not count an unknown transformed destination as the raw route consumer', () => {
    const route = [...result.graph.iterNodes()].find(
      (node) => node.label === 'Route' && node.properties.name === '/unsupported',
    );
    expect(route).toBeDefined();
    expect(route?.properties.unverifiedConsumers).toBeUndefined();
    expect(
      getRelationships(result, 'FETCHES').filter((edge) => edge.target === '/unsupported'),
    ).toEqual([]);
  });

  it('preserves composed consumers when replaying a persisted parse cache', async () => {
    const warm = await runPipelineFromRepo(root, () => {}, {
      parseCache: await loadParseCache(cacheDir, parseIdentity, cacheDir),
    });
    expect(warm.reparsedFileCount).toBe(0);
    expect(warm.parseCacheHitFileCount).toBeGreaterThan(0);
    const consumers = (value: PipelineResult) =>
      getRelationships(value, 'FETCHES')
        .map((edge) => `${edge.sourceFilePath} -> ${edge.target}`)
        .sort();
    expect(consumers(warm)).toEqual(consumers(result));
  }, 60_000);
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
  it('resolves relative, alias, workspace, barrel, export-alias diamond, overload, multi-declarator, HOC, CommonJS and package-fetch targets while rejecting shadowed and ambiguous names', async () => {
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
      'web/cjs-member.js -> /api/cjs-arrow',
      'web/cjs-member.js -> /api/cjs-member',
      'web/cjs.js -> /api/cjs',
      'web/default-paren.ts -> /api/default-paren',
      'web/destructured.ts -> /api/destructured',
      'web/diamond.ts -> /api/diamond',
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
