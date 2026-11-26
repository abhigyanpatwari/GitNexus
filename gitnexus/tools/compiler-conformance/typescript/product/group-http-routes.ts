import {
  type SymbolRow,
  recordingGraph,
  ORDERS,
  USERS,
  ITEMS,
  handlerSymbols,
  handlerRoutes,
} from '../../../../test/helpers/http-route-handler-graph.js';
import { describe, it, beforeEach, afterEach } from 'node:test';
import { expect } from 'expect';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { HttpRouteExtractor } from '../../../../src/core/group/extractors/http-route-extractor.js';
import type { RepoHandle } from '../../../../src/core/group/types.js';

describe('HttpRouteExtractor', () => {
  let tmpDir: string;

  let extractor: HttpRouteExtractor;

  beforeEach(() => {
    extractor = new HttpRouteExtractor();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gitnexus-http-extract-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  const makeRepo = (repoPath: string): RepoHandle => ({
    id: 'test-repo',
    path: 'test/backend',
    repoPath,
    storagePath: path.join(repoPath, '.gitnexus'),
  });

  /**
   * The files a symbol query asks for: one `$filePath` (CONTAINING_QUERY) or a
   * `$filePaths` list (CONTAINING_FILES_QUERY, which the extractor issues for the
   * files it expects to look up: route files and scanned files with detections).
   */
  const askedSymbolFiles = (params?: Record<string, unknown>): string[] =>
    Array.isArray(params?.filePaths)
      ? (params.filePaths as unknown[]).map(String)
      : [String(params?.filePath ?? '')];

  describe('symbolUid resolution via containment', () => {
    it('resolves a source-scan consumer to the function CONTAINING the fetch', async () => {
      const dir = path.join(tmpDir, 'consumer-containment');
      fs.mkdirSync(path.join(dir, 'src/api'), { recursive: true });
      fs.writeFileSync(
        path.join(dir, 'src/api/users.ts'),
        `export async function fetchUsers() {
  const r = await fetch('/api/users');
  return r.json();
}
`,
      );
      // The DEFINES query (CONTAINING_QUERY) returns the function span; every
      // other query (HANDLES_ROUTE / FETCHES / CONTAINS) is empty, so only the
      // source-scan + line-span containment path resolves the symbol.
      const mockDbExecutor = async (
        query: string,
        params?: Record<string, unknown>,
      ): Promise<Record<string, unknown>[]> => {
        if (
          query.includes('UNION ALL') &&
          askedSymbolFiles(params).some((f) => f.includes('users.ts'))
        ) {
          return [
            {
              uid: 'fn-fetchUsers',
              name: 'fetchUsers',
              filePath: 'src/api/users.ts',
              startLine: 1,
              endLine: 4,
              labels: ['Function'],
            },
          ];
        }
        return [];
      };

      const contracts = await extractor.extract(mockDbExecutor, dir, makeRepo(dir));
      const consumer = contracts.find((c) => c.role === 'consumer');
      expect(consumer).toMatchObject({
        symbolUid: 'fn-fetchUsers',
        symbolName: 'fetchUsers',
        meta: { extractionStrategy: 'source_scan_resolved' },
      });
    });

    it('does NOT resolve an anonymous express handler to a sibling fn named "handler"', async () => {
      const dir = path.join(tmpDir, 'anon-handler-no-false-name');
      fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
      // An unrelated function literally named `handler`, plus an ANONYMOUS route
      // handler. The anonymous handler must not be mis-attached to `handler`.
      fs.writeFileSync(
        path.join(dir, 'src/routes.ts'),
        `import { Router } from 'express';
const router = Router();
function handler() { return 1; }
router.get('/api/x', (req, res) => { res.json([]); });
export default router;
`,
      );
      const mockDbExecutor = async (
        query: string,
        params?: Record<string, unknown>,
      ): Promise<Record<string, unknown>[]> => {
        if (
          query.includes('UNION ALL') &&
          askedSymbolFiles(params).some((f) => f.includes('routes.ts'))
        ) {
          // `function handler` is on source line 3 → 0-based span [2,2]. The
          // anonymous route handler is on line 4, so it is NOT inside this span.
          return [
            {
              uid: 'uid-unrelated-handler',
              name: 'handler',
              filePath: 'src/routes.ts',
              startLine: 2,
              endLine: 2,
              labels: ['Function'],
            },
          ];
        }
        return [];
      };

      const contracts = await extractor.extract(mockDbExecutor, dir, makeRepo(dir));
      const provider = contracts.find(
        (c) => c.role === 'provider' && c.contractId === 'http::GET::/api/x',
      );
      expect(provider).toBeDefined();
      // The arrow on line 4 falls outside the named handler's zero-based span [2,2].
      expect(provider?.symbolUid).not.toBe('uid-unrelated-handler');
    });

    it('resolves an express provider to its named handler symbol', async () => {
      const dir = path.join(tmpDir, 'provider-named-handler');
      fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
      fs.writeFileSync(
        path.join(dir, 'src/routes.ts'),
        `import { Router } from 'express';
const router = Router();
export function listUsers(req, res) { res.json([]); }
router.get('/api/users', listUsers);
export default router;
`,
      );
      const mockDbExecutor = async (
        query: string,
        params?: Record<string, unknown>,
      ): Promise<Record<string, unknown>[]> => {
        if (
          query.includes('UNION ALL') &&
          askedSymbolFiles(params).some((f) => f.includes('routes.ts'))
        ) {
          return [
            {
              uid: 'fn-listUsers',
              name: 'listUsers',
              filePath: 'src/routes.ts',
              startLine: 3,
              endLine: 3,
              labels: ['Function'],
            },
          ];
        }
        return [];
      };

      const contracts = await extractor.extract(mockDbExecutor, dir, makeRepo(dir));
      const provider = contracts.find(
        (c) => c.role === 'provider' && c.contractId === 'http::GET::/api/users',
      );
      expect(provider).toMatchObject({
        symbolUid: 'fn-listUsers',
        symbolName: 'listUsers',
      });
    });

    // A handler defined in a different file than its route registration: the
    // registration file's symbols do not contain it, so resolution falls through
    // to the unique repo-wide name lookup (#2275).
    const crossFileRoutes = `import { Router } from 'express';
import { listUsers } from './handlers/users';
const router = Router();
router.get('/api/users', listUsers);
export default router;
`;

    const routesFileSyms = [
      {
        uid: 'const-router',
        name: 'router',
        filePath: 'src/routes.ts',
        startLine: 3,
        endLine: 3,
        labels: ['Const'],
      },
    ];

    const writeCrossFile = (sub: string) => {
      const dir = path.join(tmpDir, sub);
      fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
      fs.writeFileSync(path.join(dir, 'src/routes.ts'), crossFileRoutes);
      return dir;
    };

    const providerOf = (contracts: Awaited<ReturnType<typeof extractor.extract>>) =>
      contracts.find((c) => c.role === 'provider' && c.contractId === 'http::GET::/api/users');

    it('resolves a cross-file named handler via the unique repo-wide lookup', async () => {
      const dir = writeCrossFile('xfile-unique');
      const mockDbExecutor = async (
        query: string,
        params?: Record<string, unknown>,
      ): Promise<Record<string, unknown>[]> => {
        if (query.includes('UNION ALL'))
          return askedSymbolFiles(params).some((f) => f.includes('routes.ts'))
            ? routesFileSyms
            : [];
        if (query.includes('filePath IN $filePaths')) return [];
        if (query.includes('n.name = $name'))
          return params?.name === 'listUsers'
            ? [{ uid: 'fn-listUsers-xfile', name: 'listUsers', filePath: 'src/handlers/users.ts' }]
            : [];
        return [];
      };
      const provider = providerOf(await extractor.extract(mockDbExecutor, dir, makeRepo(dir)));
      expect(provider).toMatchObject({ symbolUid: 'fn-listUsers-xfile', symbolName: 'listUsers' });
    });

    it('leaves symbolUid empty when the repo-wide name is AMBIGUOUS (multiple matches)', async () => {
      const dir = writeCrossFile('xfile-ambiguous');
      const mockDbExecutor = async (
        query: string,
        params?: Record<string, unknown>,
      ): Promise<Record<string, unknown>[]> => {
        if (query.includes('UNION ALL'))
          return askedSymbolFiles(params).some((f) => f.includes('routes.ts'))
            ? routesFileSyms
            : [];
        if (query.includes('n.name = $name'))
          return [
            { uid: 'fn-a', name: 'listUsers', filePath: 'src/a.ts' },
            { uid: 'fn-b', name: 'listUsers', filePath: 'src/b.ts' },
          ];
        return [];
      };
      const provider = providerOf(await extractor.extract(mockDbExecutor, dir, makeRepo(dir)));
      expect(provider?.symbolUid).toBe('');
    });

    it('leaves symbolUid empty when no repo-wide name matches', async () => {
      const dir = writeCrossFile('xfile-zero');
      const mockDbExecutor = async (
        query: string,
        params?: Record<string, unknown>,
      ): Promise<Record<string, unknown>[]> => {
        if (query.includes('UNION ALL'))
          return askedSymbolFiles(params).some((f) => f.includes('routes.ts'))
            ? routesFileSyms
            : [];
        return [];
      };
      const provider = providerOf(await extractor.extract(mockDbExecutor, dir, makeRepo(dir)));
      expect(provider?.symbolUid).toBe('');
    });

    it('prefers a LOCALLY-DEFINED handler and never consults the repo-wide lookup', async () => {
      // Handler defined in the registration file itself (not imported) → no
      // handlerImport → file-scoped resolution wins; the global / module lookups
      // are never consulted.
      const dir = path.join(tmpDir, 'local-handler-wins');
      fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
      fs.writeFileSync(
        path.join(dir, 'src/routes.ts'),
        `import { Router } from 'express';
const router = Router();
function listUsers(req, res) {
  res.json([]);
}
router.get('/api/users', listUsers);
export default router;
`,
      );
      let globalQueries = 0;
      const mockDbExecutor = async (
        query: string,
        params?: Record<string, unknown>,
      ): Promise<Record<string, unknown>[]> => {
        if (query.includes('UNION ALL'))
          return askedSymbolFiles(params).some((f) => f.includes('routes.ts'))
            ? [
                {
                  uid: 'fn-samefile',
                  name: 'listUsers',
                  filePath: 'src/routes.ts',
                  startLine: 3,
                  endLine: 5,
                  labels: ['Function'],
                },
              ]
            : [];
        if (query.includes('n.name = $name')) {
          globalQueries += 1;
          return [{ uid: 'fn-global', name: 'listUsers', filePath: 'src/elsewhere.ts' }];
        }
        return [];
      };
      const provider = providerOf(await extractor.extract(mockDbExecutor, dir, makeRepo(dir)));
      expect(provider?.symbolUid).toBe('fn-samefile');
      expect(globalQueries).toBe(0);
    });

    it('leaves symbolUid empty (no exception) when the repo-wide query throws', async () => {
      const dir = writeCrossFile('xfile-throws');
      const mockDbExecutor = async (
        query: string,
        params?: Record<string, unknown>,
      ): Promise<Record<string, unknown>[]> => {
        if (query.includes('UNION ALL'))
          return askedSymbolFiles(params).some((f) => f.includes('routes.ts'))
            ? routesFileSyms
            : [];
        if (query.includes('n.name = $name')) throw new Error('DB locked');
        return [];
      };
      const provider = providerOf(await extractor.extract(mockDbExecutor, dir, makeRepo(dir)));
      expect(provider?.symbolUid).toBe('');
    });

    it('caches the repo-wide lookup by name across detections in one extract()', async () => {
      // Two routes in the same file referencing the SAME cross-file handler must
      // issue the by-name query at most once (memoized by name).
      const dir = path.join(tmpDir, 'xfile-cache');
      fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
      fs.writeFileSync(
        path.join(dir, 'src/routes.ts'),
        `import { Router } from 'express';
import { listUsers } from './handlers/users';
const router = Router();
router.get('/api/users', listUsers);
router.post('/api/users', listUsers);
export default router;
`,
      );
      let globalQueries = 0;
      const mockDbExecutor = async (
        query: string,
        params?: Record<string, unknown>,
      ): Promise<Record<string, unknown>[]> => {
        if (query.includes('UNION ALL'))
          return askedSymbolFiles(params).some((f) => f.includes('routes.ts'))
            ? routesFileSyms
            : [];
        if (query.includes('n.name = $name')) {
          globalQueries += 1;
          return [{ uid: 'fn-listUsers-x', name: 'listUsers', filePath: 'src/handlers/users.ts' }];
        }
        return [];
      };
      await extractor.extract(mockDbExecutor, dir, makeRepo(dir));
      expect(globalQueries).toBe(1);
    });

    it('does NOT consult the repo-wide lookup for consumers', async () => {
      // A consumer (the function making a fetch) resolves by containment in its
      // own file; the provider-only repo-wide lookup must never fire for it.
      const dir = path.join(tmpDir, 'xfile-consumer-gate');
      fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
      fs.writeFileSync(
        path.join(dir, 'src/api.ts'),
        `export async function fetchUsers() {
  const r = await fetch('/api/users');
  return r.json();
}
`,
      );
      let globalQueries = 0;
      const mockDbExecutor = async (
        query: string,
        params?: Record<string, unknown>,
      ): Promise<Record<string, unknown>[]> => {
        if (query.includes('UNION ALL'))
          return askedSymbolFiles(params).some((f) => f.includes('api.ts'))
            ? [
                {
                  uid: 'fn-fetchUsers',
                  name: 'fetchUsers',
                  filePath: 'src/api.ts',
                  startLine: 1,
                  endLine: 4,
                  labels: ['Function'],
                },
              ]
            : [];
        if (query.includes('n.name = $name')) {
          globalQueries += 1;
          return [{ uid: 'should-not-be-used', name: 'fetchUsers', filePath: 'src/x.ts' }];
        }
        return [];
      };
      const contracts = await extractor.extract(mockDbExecutor, dir, makeRepo(dir));
      const consumer = contracts.find((c) => c.role === 'consumer');
      expect(consumer?.symbolName).toBe('fetchUsers');
      expect(globalQueries).toBe(0);
    });

    it('does NOT attach a named provider to its registrar when the name is unresolvable', async () => {
      // router.get(...) is registered INSIDE setupRoutes(); the handler
      // `listUsers` is ambiguous repo-wide (2 matches) so name resolution fails.
      // The route must NOT fall through to line-span containment and attach to
      // the enclosing `setupRoutes` wrapper — it stays empty (file fallback).
      const dir = path.join(tmpDir, 'xfile-wrapper-no-attach');
      fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
      fs.writeFileSync(
        path.join(dir, 'src/routes.ts'),
        `import { Router } from 'express';
import { listUsers } from './handlers/users';
const router = Router();
export function setupRoutes() {
  router.get('/api/users', listUsers);
}
export default router;
`,
      );
      const mockDbExecutor = async (
        query: string,
        params?: Record<string, unknown>,
      ): Promise<Record<string, unknown>[]> => {
        if (query.includes('UNION ALL'))
          return askedSymbolFiles(params).some((f) => f.includes('routes.ts'))
            ? [
                {
                  uid: 'fn-setupRoutes',
                  name: 'setupRoutes',
                  filePath: 'src/routes.ts',
                  startLine: 1,
                  endLine: 99,
                  labels: ['Function'],
                },
              ]
            : [];
        if (query.includes('n.name = $name'))
          return [
            { uid: 'fn-a', name: 'listUsers', filePath: 'src/a.ts' },
            { uid: 'fn-b', name: 'listUsers', filePath: 'src/b.ts' },
          ];
        return [];
      };
      const provider = providerOf(await extractor.extract(mockDbExecutor, dir, makeRepo(dir)));
      expect(provider?.symbolUid).toBe('');
    });

    it('rejects a unique repo-wide match that carries no real file (synthetic node)', async () => {
      // A handler name colliding with an ORM model node (orm.ts emits
      // filePath: '') yields a single match with no file. It must be rejected,
      // not attached as an edge-less cross-trace anchor.
      const dir = writeCrossFile('xfile-empty-filepath');
      const mockDbExecutor = async (
        query: string,
        params?: Record<string, unknown>,
      ): Promise<Record<string, unknown>[]> => {
        if (query.includes('UNION ALL'))
          return askedSymbolFiles(params).some((f) => f.includes('routes.ts'))
            ? routesFileSyms
            : [];
        if (query.includes('n.name = $name'))
          return [{ uid: 'orm-listUsers', name: 'listUsers', filePath: '' }];
        return [];
      };
      const provider = providerOf(await extractor.extract(mockDbExecutor, dir, makeRepo(dir)));
      expect(provider?.symbolUid).toBe('');
    });

    it('resolves via the repo-wide lookup when the registration file has NO indexed symbols', async () => {
      // Pins the reordered early-return: CONTAINING_QUERY returns [] for the
      // registration file (no in-file symbols at all), yet the unique repo-wide
      // match still resolves the cross-file handler. Before the reorder, the
      // `syms.length === 0` guard short-circuited above the provider name branch.
      const dir = writeCrossFile('xfile-empty-regfile');
      const mockDbExecutor = async (
        query: string,
        params?: Record<string, unknown>,
      ): Promise<Record<string, unknown>[]> => {
        if (query.includes('UNION ALL')) return [];
        if (query.includes('n.name = $name'))
          return params?.name === 'listUsers'
            ? [{ uid: 'fn-listUsers-xfile', name: 'listUsers', filePath: 'src/handlers/users.ts' }]
            : [];
        return [];
      };
      const provider = providerOf(await extractor.extract(mockDbExecutor, dir, makeRepo(dir)));
      expect(provider).toMatchObject({ symbolUid: 'fn-listUsers-xfile', symbolName: 'listUsers' });
    });

    it('resolves an ALIASED import to its declared name in the target module (not the alias)', async () => {
      // import { listUsers as handleUsers } from './handlers/users';
      // router.get('/api/users', handleUsers);  + an UNRELATED function handleUsers
      // elsewhere. The route must resolve to the imported `listUsers`, and the
      // local alias `handleUsers` must NEVER be looked up.
      const dir = path.join(tmpDir, 'xfile-alias');
      fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
      fs.writeFileSync(
        path.join(dir, 'src/routes.ts'),
        `import { Router } from 'express';
import { listUsers as handleUsers } from './handlers/users';
const router = Router();
router.get('/api/users', handleUsers);
export default router;
`,
      );
      const queriedNames: string[] = [];
      const mockDbExecutor = async (
        query: string,
        params?: Record<string, unknown>,
      ): Promise<Record<string, unknown>[]> => {
        if (query.includes('STARTS WITH')) {
          queriedNames.push(`module:${String(params?.name)}`);
          return params?.name === 'listUsers' &&
            String(params?.fileDot ?? '').startsWith('src/handlers/users')
            ? [{ uid: 'fn-listUsers', name: 'listUsers', filePath: 'src/handlers/users.ts' }]
            : [];
        }
        if (query.includes('n.name = $name')) {
          queriedNames.push(`global:${String(params?.name)}`);
          return params?.name === 'handleUsers'
            ? [{ uid: 'fn-unrelated', name: 'handleUsers', filePath: 'src/other.ts' }]
            : [];
        }
        return [];
      };
      const provider = providerOf(await extractor.extract(mockDbExecutor, dir, makeRepo(dir)));
      expect(provider).toMatchObject({ symbolUid: 'fn-listUsers', symbolName: 'listUsers' });
      expect(queriedNames).not.toContain('module:handleUsers');
      expect(queriedNames).not.toContain('global:handleUsers');
    });

    it('pins an imported handler to its module, resolving a name that is ambiguous repo-wide', async () => {
      // `listUsers` exists in two files; the import pins to ./handlers/users, so
      // the module-scoped query returns exactly one even though a repo-wide
      // name lookup would be ambiguous (and would decline).
      const dir = writeCrossFile('xfile-module-pin');
      const mockDbExecutor = async (
        query: string,
        params?: Record<string, unknown>,
      ): Promise<Record<string, unknown>[]> => {
        if (query.includes('STARTS WITH'))
          return String(params?.fileDot ?? '').startsWith('src/handlers/users')
            ? [{ uid: 'fn-the-right-one', name: 'listUsers', filePath: 'src/handlers/users.ts' }]
            : [];
        if (query.includes('n.name = $name'))
          return [
            { uid: 'fn-a', name: 'listUsers', filePath: 'src/handlers/users.ts' },
            { uid: 'fn-b', name: 'listUsers', filePath: 'src/admin/users.ts' },
          ];
        return [];
      };
      const provider = providerOf(await extractor.extract(mockDbExecutor, dir, makeRepo(dir)));
      expect(provider?.symbolUid).toBe('fn-the-right-one');
    });
  });

  describe('provider extraction — source-scan fallback (Strategy B)', () => {
    it('extracts Express router.get patterns', async () => {
      const dir = path.join(tmpDir, 'express');
      fs.mkdirSync(path.join(dir, 'src/routes'), { recursive: true });
      fs.writeFileSync(
        path.join(dir, 'src/routes/users.ts'),
        `
import { Router } from 'express';
const router = Router();

router.get('/api/users', async (req, res) => { res.json([]); });
router.post('/api/users', async (req, res) => { res.json({}); });
router.delete('/api/users/:id', async (req, res) => { res.sendStatus(204); });

export default router;
`,
      );

      const contracts = await extractor.extract(null, dir, makeRepo(dir));
      const providers = contracts.filter((c) => c.role === 'provider');

      expect(providers.length).toBeGreaterThanOrEqual(3);
      expect(providers.find((c) => c.contractId === 'http::GET::/api/users')).toBeDefined();
      expect(providers.find((c) => c.contractId === 'http::POST::/api/users')).toBeDefined();
      expect(
        providers.find((c) => c.contractId === 'http::DELETE::/api/users/{param}'),
      ).toBeDefined();
    });

    it('dedupes source-only providers by contract id', async () => {
      const dir = path.join(tmpDir, 'source-only-same-contract-id');
      fs.mkdirSync(path.join(dir, 'src/routes'), { recursive: true });
      fs.writeFileSync(
        path.join(dir, 'src/routes/health-a.ts'),
        `
import { Router } from 'express'; const router = Router();
router.get('/api/health', healthA);
`,
      );
      fs.writeFileSync(
        path.join(dir, 'src/routes/health-b.ts'),
        `
import { Router } from 'express'; const router = Router();
router.get('/api/health', healthB);
`,
      );

      const contracts = await extractor.extract(null, dir, makeRepo(dir));
      const providers = contracts.filter((c) => c.contractId === 'http::GET::/api/health');

      expect(providers).toHaveLength(1);
      expect(providers[0].role).toBe('provider');
      expect(providers[0].meta.extractionStrategy).toBe('source_scan');
    });

    it('extracts NestJS controller decorators', async () => {
      const dir = path.join(tmpDir, 'nestjs');
      fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
      fs.writeFileSync(
        path.join(dir, 'src', 'orders.controller.ts'),
        `
import { Controller, Patch } from '@nestjs/common';

@Controller('orders')
export class OrdersController {
  @Patch(':id')
  updateOrder() {
    return {};
  }
}
`,
      );

      const contracts = await extractor.extract(null, dir, makeRepo(dir));
      const providers = contracts.filter((c) => c.role === 'provider');

      const patchRoute = providers.find((c) => c.contractId === 'http::PATCH::/orders/{param}');
      expect(patchRoute).toBeDefined();
      expect(patchRoute?.symbolName).toBe('updateOrder');
    });
  });

  describe('consumer extraction — fetch patterns', () => {
    it('extracts fetch() calls', async () => {
      const dir = path.join(tmpDir, 'frontend');
      fs.mkdirSync(path.join(dir, 'src/api'), { recursive: true });
      fs.writeFileSync(
        path.join(dir, 'src/api/users.ts'),
        `
export async function fetchUsers() {
  const res = await fetch('/api/users');
  return res.json();
}

export async function createUser(data: any) {
  const res = await fetch('/api/users', { method: 'POST', body: JSON.stringify(data) });
  return res.json();
}
`,
      );

      const contracts = await extractor.extract(null, dir, makeRepo(dir));
      const consumers = contracts.filter((c) => c.role === 'consumer');

      expect(consumers.length).toBeGreaterThanOrEqual(2);
      expect(consumers.find((c) => c.contractId === 'http::GET::/api/users')).toBeDefined();
      expect(consumers.find((c) => c.contractId === 'http::POST::/api/users')).toBeDefined();
    });

    it('extracts axios calls', async () => {
      const dir = path.join(tmpDir, 'axios-fe');
      fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
      fs.writeFileSync(
        path.join(dir, 'src/api.ts'),
        `
import axios from 'axios';
export const getUsers = () => axios.get('/api/users');
export const deleteUser = (id: string) => axios.delete(\`/api/users/\${id}\`);
`,
      );

      const contracts = await extractor.extract(null, dir, makeRepo(dir));
      const consumers = contracts.filter((c) => c.role === 'consumer');

      expect(consumers.find((c) => c.contractId === 'http::GET::/api/users')).toBeDefined();
      expect(
        consumers.find((c) => c.contractId === 'http::DELETE::/api/users/{param}'),
      ).toBeDefined();
    });

    it('extracts axios({ method, url }) object form regardless of key order', async () => {
      const dir = path.join(tmpDir, 'axios-object');
      fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
      fs.writeFileSync(
        path.join(dir, 'src/orders.ts'),
        `
import axios from 'axios';

export function createOrder(data: unknown) {
  return axios({ method: 'POST', url: '/api/orders', data });
}

export function updateUser(id: string, data: unknown) {
  return axios({ url: \`/api/users/\${id}\`, method: 'PUT', data });
}

export function listDefaults() {
  return axios({ url: '/api/defaults' });
}
export function ignoreJqueryTypeKey() {
  return axios({ url: '/api/typed', type: 'POST' });
}
export function quotedAxiosMethod() {
  return axios({ url: '/api/quoted-ax', "method": 'DELETE' });
}
`,
      );

      const contracts = await extractor.extract(null, dir, makeRepo(dir));
      const consumers = contracts.filter((c) => c.role === 'consumer');

      expect(consumers.find((c) => c.contractId === 'http::POST::/api/orders')).toBeDefined();
      expect(consumers.find((c) => c.contractId === 'http::PUT::/api/users/{param}')).toBeDefined();
      expect(consumers.find((c) => c.contractId === 'http::GET::/api/defaults')).toBeDefined();
      expect(consumers.find((c) => c.contractId === 'http::POST::/api/typed')).toBeUndefined();
      expect(consumers.find((c) => c.contractId === 'http::GET::/api/typed')).toBeDefined();
      expect(consumers.find((c) => c.contractId === 'http::DELETE::/api/quoted-ax')).toBeDefined();
    });

    it('extracts wrapped X.request({ url, method }) with shared prefix-strip and * verbs', async () => {
      const dir = path.join(tmpDir, 'wrapped-request');
      fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
      fs.writeFileSync(
        path.join(dir, 'src/client.ts'),
        `
import axios from 'axios';

export function listOrders(httpClient, serviceClient, tenant, verb) {
  return httpClient.request({ url: \`\${serviceClient}/api/v1/orders\`, method: 'post' });
}
export function getTenantOrder(httpClient, client, tenant) {
  return httpClient.request({ url: \`\${client}/api/\${tenant}/orders\`, method: 'GET' });
}
export function rootPing(httpClient, client) {
  return httpClient.request({ url: \`\${client}/\`, method: 'GET' });
}
export function dynamicVerb(httpClient) {
  return httpClient.request({ url: '/api/orders', method: verb });
}
export function missingMethod(httpClient) {
  return httpClient.request({ url: '/api/defaults' });
}
export function dropHostTemplate(httpClient, scheme, host) {
  return httpClient.request({ url: \`\${scheme}://\${host}/api/x\`, method: 'GET' });
}
export function absTemplateParam(httpClient, id) {
  return httpClient.request({ url: \`https://host/api/\${id}\`, method: 'GET' });
}
export function quotedMethod(httpClient) {
  return httpClient.request({ url: '/api/quoted', "method": 'PATCH' });
}
export function spreadMethod(httpClient, config) {
  return httpClient.request({ url: '/api/spread', ...config });
}
export function staticAbsolute(httpClient) {
  return httpClient.request({ url: 'https://host/api/static', method: 'GET' });
}
export function protocolRelative(httpClient, proto) {
  return httpClient.request({ url: \`\${proto}//host/api/proto\`, method: 'GET' });
}
export async function fetchGateway(gateway) {
  return fetch(\`\${gateway}/api/users\`);
}
export function axiosGateway(gateway) {
  return axios.get(\`\${gateway}/api/users\`);
}
export async function encodedBraceLiteral() {
  return fetch('https://host/api/%7Bfoo%7D');
}
export async function literalSentinelSegment() {
  return fetch('https://host/api/__gitnexus_http_param__');
}
`,
      );

      const contracts = await extractor.extract(null, dir, makeRepo(dir));
      const consumers = contracts.filter((c) => c.role === 'consumer');

      expect(consumers.find((c) => c.contractId === 'http::POST::/api/v1/orders')).toBeDefined();
      expect(
        consumers.find((c) => c.contractId === 'http::GET::/api/{param}/orders'),
      ).toBeDefined();
      expect(consumers.find((c) => c.contractId === 'http::GET::/')).toBeDefined();
      expect(consumers.find((c) => c.contractId === 'http::*::/api/orders')).toBeDefined();
      expect(consumers.find((c) => c.contractId === 'http::GET::/api/defaults')).toBeDefined();
      expect(consumers.find((c) => c.contractId === 'http::GET::/api/x')).toBeUndefined();
      expect(consumers.find((c) => c.contractId === 'http::GET::/orders')).toBeUndefined();
      expect(consumers.find((c) => c.contractId === 'http::GET::/api/{param}')).toBeDefined();
      expect(consumers.find((c) => c.contractId === 'http::PATCH::/api/quoted')).toBeDefined();
      expect(consumers.find((c) => c.contractId === 'http::*::/api/spread')).toBeDefined();
      expect(consumers.find((c) => c.contractId === 'http::GET::/api/static')).toBeDefined();
      expect(consumers.find((c) => c.contractId === 'http::GET::/api/proto')).toBeUndefined();
      expect(consumers.find((c) => c.contractId === 'http::GET::/host/api/proto')).toBeUndefined();
      expect(consumers.find((c) => c.contractId === 'http::GET::/api/users')).toBeDefined();
      expect(consumers.find((c) => c.contractId === 'http::GET::/api/%7bfoo%7d')).toBeDefined();
      expect(
        consumers.find((c) => c.contractId === 'http::GET::/api/__gitnexus_http_param__'),
      ).toBeDefined();
    });

    it('does not mint HTTP consumers for ungated .request({ url }) helpers', async () => {
      const dir = path.join(tmpDir, 'wrapped-request-negative');
      fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
      fs.writeFileSync(
        path.join(dir, 'src/misc.ts'),
        `
export function e2e(cy) {
  return cy.request({ url: '/api/v1/orders', method: 'GET' });
}
export function enqueue(queue) {
  return queue.request({ url: '/admin', method: 'DELETE' });
}
`,
      );

      const contracts = await extractor.extract(null, dir, makeRepo(dir));
      const consumers = contracts.filter((c) => c.role === 'consumer');
      expect(consumers.find((c) => c.contractId === 'http::GET::/api/v1/orders')).toBeUndefined();
      expect(consumers.find((c) => c.contractId === 'http::DELETE::/admin')).toBeUndefined();
    });
  });

  describe('consumer extraction — graph-first (Strategy A)', () => {
    it('extracts consumers from FETCHES graph edges, resolved to the containing fn', async () => {
      const dir = path.join(tmpDir, 'graph-consumers');
      fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
      // A real fetch so the plugin produces a consumer detection with a line;
      // the graph path then resolves it to the CONTAINING function by line-span.
      fs.writeFileSync(
        path.join(dir, 'src/api.ts'),
        `export async function fetchUsers() {
  const r = await fetch('/api/users');
  return r.json();
}
`,
      );

      const mockDbExecutor = async (query: string) => {
        if (query.includes('HANDLES_ROUTE')) return [];
        if (query.includes('FETCHES')) {
          return [
            {
              fileId: 'file-uid-api',
              filePath: 'src/api.ts',
              routePath: '/api/users',
              routeId: 'route-uid-users',
              fetchReason: 'fetch-url-match',
            },
          ];
        }
        if (query.includes('UNION ALL') && String(query).includes('filePath')) {
          return [
            {
              uid: 'uid-fn-fetch',
              name: 'fetchUsers',
              filePath: 'src/api.ts',
              startLine: 1,
              endLine: 4,
              labels: ['Function'],
            },
          ];
        }
        return [];
      };

      const contracts = await extractor.extract(mockDbExecutor, dir, makeRepo(dir));
      const consumers = contracts.filter((c) => c.role === 'consumer');

      expect(consumers.length).toBeGreaterThanOrEqual(1);
      expect(consumers[0].confidence).toBe(0.9);
      expect(consumers[0].symbolName).toBe('fetchUsers');
      expect(consumers[0].symbolUid).toBe('uid-fn-fetch');
    });

    it('supplements graph consumers with source-scan consumers from other files', async () => {
      const dir = path.join(tmpDir, 'graph-source-consumer-union');
      fs.mkdirSync(path.join(dir, 'src/api'), { recursive: true });
      fs.writeFileSync(
        path.join(dir, 'src/api/graph.ts'),
        `export async function fetchUsers() {
  const r = await fetch('/api/users');
  return r.json();
}
`,
      );
      fs.writeFileSync(
        path.join(dir, 'src/api/health.ts'),
        `
export async function fetchHealth() {
  const res = await fetch('/api/health');
  return res.json();
}
`,
      );

      const mockDbExecutor = async (query: string, params?: Record<string, unknown>) => {
        if (query.includes('HANDLES_ROUTE')) return [];
        if (query.includes('FETCHES')) {
          return [
            {
              fileId: 'file-uid-api',
              filePath: 'src/api/graph.ts',
              routePath: '/api/users',
              routeId: 'route-uid-users',
              fetchReason: 'fetch-url-match',
            },
          ];
        }
        if (query.includes('UNION ALL')) {
          const rows = [
            { uid: 'uid-fn-fetch', name: 'fetchUsers', filePath: 'src/api/graph.ts' },
            { uid: 'uid-fn-health', name: 'fetchHealth', filePath: 'src/api/health.ts' },
          ];
          return rows
            .filter((row) => askedSymbolFiles(params).includes(row.filePath))
            .map((row) => ({ ...row, startLine: 1, endLine: 4, labels: ['Function'] }));
        }
        return [];
      };

      const contracts = await extractor.extract(mockDbExecutor, dir, makeRepo(dir));
      const consumers = contracts.filter((c) => c.role === 'consumer');

      const graphConsumer = consumers.find((c) => c.contractId === 'http::GET::/api/users');
      expect(graphConsumer).toBeDefined();
      expect(graphConsumer?.symbolUid).toBe('uid-fn-fetch');
      expect(graphConsumer?.meta.extractionStrategy).toBe('graph_assisted');

      const sourceConsumer = consumers.find((c) => c.contractId === 'http::GET::/api/health');
      expect(sourceConsumer).toBeDefined();
      expect(sourceConsumer?.meta.extractionStrategy).toBe('source_scan_resolved');
    });
  });

  describe('edge cases', () => {
    it('handles graph queries that throw gracefully', async () => {
      const dir = path.join(tmpDir, 'graph-error');
      fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
      fs.writeFileSync(
        path.join(dir, 'src/routes.ts'),
        `import { Router } from 'express'; const router = Router();
router.get('/api/health', handler);`,
      );

      const throwingExecutor = async () => {
        throw new Error('DB unavailable');
      };

      const contracts = await extractor.extract(throwingExecutor, dir, makeRepo(dir));
      // Should fall back to source scan
      const providers = contracts.filter((c) => c.role === 'provider');
      expect(providers.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe('path normalization', () => {
    it('strips trailing slash', async () => {
      const dir = path.join(tmpDir, 'trailing');
      fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
      fs.writeFileSync(
        path.join(dir, 'src/router.ts'),
        `
import { Router } from 'express'; const router = Router();
router.get('/api/users/', handler);
`,
      );

      const contracts = await extractor.extract(null, dir, makeRepo(dir));
      const provider = contracts.find((c) => c.role === 'provider');
      expect(provider?.meta.path).toBe('/api/users');
    });

    it('normalizes path params from multiple syntaxes', async () => {
      const dir = path.join(tmpDir, 'params');
      fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
      fs.writeFileSync(
        path.join(dir, 'src/router.ts'),
        `
import { Router } from 'express'; const router = Router();
router.get('/api/users/:id', handler1);
router.get('/api/posts/{postId}', handler2);
`,
      );

      const contracts = await extractor.extract(null, dir, makeRepo(dir));
      contracts.forEach((c) => {
        expect(c.meta.path).not.toContain(':id');
        expect(c.meta.path).not.toContain('{postId}');
        if (typeof c.meta.path === 'string' && c.meta.path.includes('users/')) {
          expect(c.meta.path).toContain('{param}');
        }
      });
    });
  });

  // ─── #1185: contract extractors must honour .gitnexusignore ─────────
  //
  // Pre-#1185 the source-scan path used a hardcoded
  // `[node_modules, .git, dist, build, vendor]` glob ignore array, so a
  // user's `.gitnexusignore` pattern (e.g. a Python venv `mentor_env/`,
  // a generated stubs dir, a noisy fixture tree) was silently scanned
  // anyway. Since #1185 the source-scan path consumes the shared
  // `IgnoreService` (mirrors `filesystem-walker.ts`), so any pattern in
  // `.gitnexusignore` (or `.gitignore`) prunes the glob.
  describe('respects .gitnexusignore (#1185)', () => {
    it('source-scan glob skips files matched by .gitnexusignore', async () => {
      const dir = path.join(tmpDir, 'gitnexusignore-honoured');
      fs.mkdirSync(path.join(dir, 'src/routes'), { recursive: true });
      fs.mkdirSync(path.join(dir, 'mentor_env/lib'), { recursive: true });
      // Control: a normal route file that SHOULD be discovered.
      fs.writeFileSync(
        path.join(dir, 'src/routes/users.ts'),
        `import { Router } from 'express';
const router = Router();
router.get('/api/users', (req, res) => res.json([]));
export default router;
`,
      );
      // Vendored source under a venv-style dir: the same Express
      // pattern, but inside a directory the user wants excluded.
      fs.writeFileSync(
        path.join(dir, 'mentor_env/lib/leaked.ts'),
        `import { Router } from 'express';
const r = Router();
r.get('/api/leaked', (req, res) => res.json([]));
export default r;
`,
      );
      fs.writeFileSync(path.join(dir, '.gitnexusignore'), 'mentor_env/\n');

      const contracts = await extractor.extract(null, dir, makeRepo(dir));
      const providers = contracts.filter((c) => c.role === 'provider');
      // Control survives.
      expect(providers.find((c) => c.contractId === 'http::GET::/api/users')).toBeDefined();
      // Excluded path is pruned at the glob level — nothing emitted.
      expect(providers.find((c) => c.contractId === 'http::GET::/api/leaked')).toBeUndefined();
      // Defence-in-depth: no contract whose symbolRef is under mentor_env/.
      expect(contracts.some((c) => c.symbolRef?.filePath?.startsWith('mentor_env/'))).toBe(false);
    });

    // Pinned by the @claude review on PR #1247: above, only `.gitnexusignore`
    // is exercised. `createIgnoreFilter` reads `.gitignore` too via
    // `loadIgnoreRules`, but that integration is only proven at the
    // `IgnoreService` level — no extractor-level test for the
    // `.gitignore`-only code path. Adding one minimal extractor-level
    // assertion here closes the gap (one shared test is sufficient
    // because all three extractors consume the same filter object).
    it('source-scan glob also skips files matched by `.gitignore` (no `.gitnexusignore`)', async () => {
      const dir = path.join(tmpDir, 'gitignore-honoured');
      fs.mkdirSync(path.join(dir, 'src/routes'), { recursive: true });
      fs.mkdirSync(path.join(dir, 'mentor_env/lib'), { recursive: true });
      // Same Express pattern as above so detection logic is identical.
      fs.writeFileSync(
        path.join(dir, 'src/routes/users.ts'),
        `import { Router } from 'express';
const router = Router();
router.get('/api/users', (req, res) => res.json([]));
export default router;
`,
      );
      fs.writeFileSync(
        path.join(dir, 'mentor_env/lib/leaked.ts'),
        `import { Router } from 'express';
const r = Router();
r.get('/api/leaked', (req, res) => res.json([]));
export default r;
`,
      );
      // Note: NO .gitnexusignore — only `.gitignore`. This proves the
      // `.gitignore` code path inside `createIgnoreFilter` is wired to
      // the extractors' globs.
      fs.writeFileSync(path.join(dir, '.gitignore'), 'mentor_env/\n');

      const contracts = await extractor.extract(null, dir, makeRepo(dir));
      const providers = contracts.filter((c) => c.role === 'provider');
      expect(providers.find((c) => c.contractId === 'http::GET::/api/users')).toBeDefined();
      expect(providers.find((c) => c.contractId === 'http::GET::/api/leaked')).toBeUndefined();
      expect(contracts.some((c) => c.symbolRef?.filePath?.startsWith('mentor_env/'))).toBe(false);
    });
  });

  describe('handler symbols load in one query per batch of files', () => {
    it('resolves the same symbols from a batch as from one query per file', async () => {
      const dir = fs.mkdtempSync(path.join(tmpDir, 'batch-parity-'));
      fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
      // Express routes found by the project scan, so their files are expected
      // before the source-scan passes resolve them.
      fs.writeFileSync(
        path.join(dir, 'src/routes.ts'),
        `import { Router } from 'express';
const router = Router();
router.get('/api/ping', (req, res) => {
  res.json({ ok: true });
});
export default router;
`,
      );
      fs.writeFileSync(
        path.join(dir, 'src/admin.ts'),
        `import { Router } from 'express';
const admin = Router();
export function resetCache(req, res) { res.sendStatus(204); }
admin.post('/api/admin/reset', resetCache);
export default admin;
`,
      );
      const symbols: SymbolRow[] = [
        // Three symbols with the same span around the inline /api/ping handler
        // (0-based rows 2-4). Containment keeps the first of equal spans, in
        // the extractor's fixed order: Function before CodeElement, and the
        // earlier-stored of two Functions, whatever order the rows arrive in.
        {
          uid: 'z-ping-function',
          name: 'pingFunction',
          filePath: 'src/routes.ts',
          startLine: 2,
          endLine: 4,
          labels: ['Function'],
        },
        handlerSymbols[0],
        {
          uid: 'a-ping-twin',
          name: 'pingTwin',
          filePath: 'src/routes.ts',
          startLine: 2,
          endLine: 4,
          labels: ['Function'],
        },
        {
          uid: 'a-ping-element',
          name: 'pingElement',
          filePath: 'src/routes.ts',
          startLine: 2,
          endLine: 4,
          labels: ['CodeElement'],
        },
        {
          uid: 'Function:src/admin.ts:resetCache',
          name: 'resetCache',
          filePath: 'src/admin.ts',
          startLine: 2,
          endLine: 2,
          labels: ['Function'],
        },
        ...handlerSymbols.slice(1),
      ];
      const batched = recordingGraph({ routes: handlerRoutes, symbols });
      const perFile = recordingGraph({ routes: handlerRoutes, symbols, failBatch: true });
      const reversed = recordingGraph({ routes: handlerRoutes, symbols, reversed: true });
      const reversedPerFile = recordingGraph({
        routes: handlerRoutes,
        symbols,
        reversed: true,
        failBatch: true,
      });

      const fromBatches = await extractor.extract(batched.db, dir, makeRepo(dir));
      const fromSingles = await new HttpRouteExtractor().extract(perFile.db, dir, makeRepo(dir));
      const fromReversed = await new HttpRouteExtractor().extract(reversed.db, dir, makeRepo(dir));
      const fromReversedSingles = await new HttpRouteExtractor().extract(
        reversedPerFile.db,
        dir,
        makeRepo(dir),
      );

      // The handler files in one query, then the files with Express detections in one more.
      expect(batched.batches()).toHaveLength(2);
      expect(batched.batches()[0]).toEqual([ITEMS, ORDERS, USERS]);
      expect([...batched.batches()[1]].sort()).toEqual(['src/admin.ts', 'src/routes.ts']);
      expect(batched.singles()).toEqual([]);
      expect([...perFile.singles()].sort()).toEqual(
        [ORDERS, USERS, ITEMS, 'src/admin.ts', 'src/routes.ts'].sort(),
      );
      expect(fromBatches).toEqual(fromSingles);
      expect(fromReversed).toEqual(fromBatches);
      expect(fromReversedSingles).toEqual(fromBatches);
      expect(fromBatches.find((c) => c.contractId === 'http::GET::/api/ping')).toMatchObject({
        symbolUid: 'z-ping-function',
        symbolName: 'pingFunction',
      });
      expect(
        fromBatches.find((c) => c.contractId === 'http::POST::/api/admin/reset'),
      ).toMatchObject({ symbolUid: 'Function:src/admin.ts:resetCache', symbolName: 'resetCache' });
    });
  });
});
