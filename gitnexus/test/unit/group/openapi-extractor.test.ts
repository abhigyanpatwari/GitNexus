import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { OpenApiExtractor } from '../../../src/core/group/extractors/openapi-extractor.js';
import type { RepoHandle } from '../../../src/core/group/types.js';

describe('OpenApiExtractor', () => {
  let tmpDir: string;
  let extractor: OpenApiExtractor;

  beforeEach(() => {
    tmpDir = path.join(os.tmpdir(), `gitnexus-openapi-${Date.now()}-${Math.random()}`);
    fs.mkdirSync(tmpDir, { recursive: true });
    extractor = new OpenApiExtractor();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function writeFile(relPath: string, content: string): void {
    const full = path.join(tmpDir, relPath);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }

  const makeRepo = (repoPath: string): RepoHandle => ({
    id: 'test-repo',
    path: 'test/backend',
    repoPath,
    storagePath: path.join(repoPath, '.gitnexus'),
  });

  it('extracts OpenAPI 3 paths as provider HTTP contracts', async () => {
    writeFile(
      'docs/openapi.yaml',
      `
openapi: 3.0.3
info:
  title: Orders
  version: 1.0.0
servers:
  - url: https://api.example.test/v1
paths:
  /users/{id}:
    get:
      operationId: getUser
      summary: Get user
      tags: [users]
    post:
      operationId: createUser
`,
    );

    const contracts = await extractor.extract(null, tmpDir, makeRepo(tmpDir));
    const providers = contracts.filter((c) => c.role === 'provider');

    const getUser = providers.find((c) => c.contractId === 'http::GET::/v1/users/{param}');
    expect(getUser).toBeDefined();
    expect(getUser?.symbolName).toBe('getUser');
    expect(getUser?.meta.source).toBe('openapi');
    expect(getUser?.meta.specFile).toBe('docs/openapi.yaml');
    expect(getUser?.meta.tags).toEqual(['users']);

    expect(providers.find((c) => c.contractId === 'http::POST::/v1/users/{param}')).toBeDefined();
  });

  it('extracts Swagger 2 basePath routes from JSON specs', async () => {
    writeFile(
      'swagger.json',
      JSON.stringify({
        swagger: '2.0',
        info: { title: 'Legacy API', version: '1.0.0' },
        basePath: '/api/v2',
        paths: {
          '/orders/{orderId}': {
            delete: { operationId: 'deleteOrder' },
          },
        },
      }),
    );

    const contracts = await extractor.extract(null, tmpDir, makeRepo(tmpDir));
    const route = contracts.find((c) => c.contractId === 'http::DELETE::/api/v2/orders/{param}');

    expect(route).toBeDefined();
    expect(route?.symbolName).toBe('deleteOrder');
    expect(route?.meta.specVersion).toBe('2.0');
  });

  it('honors document and operation role overrides for generated client specs', async () => {
    writeFile(
      'client.orders.openapi.yaml',
      `
openapi: 3.1.0
x-gitnexus-role: consumer
paths:
  /orders:
    get:
      operationId: listOrders
    post:
      operationId: createOrder
      x-gitnexus-role: provider
`,
    );

    const contracts = await extractor.extract(null, tmpDir, makeRepo(tmpDir));

    const listOrders = contracts.find((c) => c.contractId === 'http::GET::/orders');
    expect(listOrders?.role).toBe('consumer');
    expect(listOrders?.symbolUid).toContain('openapi::consumer');

    const createOrder = contracts.find((c) => c.contractId === 'http::POST::/orders');
    expect(createOrder?.role).toBe('provider');
    expect(createOrder?.symbolUid).toContain('openapi::provider');
  });

  it('ignores non-OpenAPI YAML files and operations marked ignored', async () => {
    writeFile(
      'docs/openapi.yaml',
      `
name: not an api spec
paths:
  /fake: {}
`,
    );
    writeFile(
      'swagger/ignored.yaml',
      `
openapi: 3.0.0
paths:
  /internal:
    get:
      x-gitnexus-ignore: true
`,
    );

    const contracts = await extractor.extract(null, tmpDir, makeRepo(tmpDir));
    expect(contracts).toHaveLength(0);
  });
});
