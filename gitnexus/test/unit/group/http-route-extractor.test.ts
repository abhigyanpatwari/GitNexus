import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

import {
  HttpRouteExtractor,
  normalizeRepoRelPath,
} from '../../../src/core/group/extractors/http-route-extractor.js';
import { getPluginForFile } from '../../../src/core/group/extractors/http-patterns/index.js';
import type { RepoHandle } from '../../../src/core/group/types.js';

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

  describe('plugin selection', () => {
    it('does not route Blade templates through the PHP source-scan plugin', () => {
      expect(getPluginForFile('resources/views/welcome.blade.php')).toBeUndefined();
      expect(getPluginForFile('routes/web.php')).toBeDefined();
    });
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

  describe('repo-relative path normalization', () => {
    it('normalizes Windows source-scan paths before symbol lookup', () => {
      expect(normalizeRepoRelPath('src\\api\\users.ts')).toBe('src/api/users.ts');
      expect(normalizeRepoRelPath('.\\src\\api\\users.ts')).toBe('src/api/users.ts');
      expect(normalizeRepoRelPath('./src/api/users.ts')).toBe('src/api/users.ts');
    });
  });

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
      // The anonymous arrow (line ~4) is NOT inside `handler`'s span [3,3], so it
      // must not borrow that uid — name resolution is skipped for anonymous.
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

    it('retains unique-name fallback for a Flask handler imported from a bare module', async () => {
      const dir = path.join(tmpDir, 'py-flask-bare-import');
      fs.mkdirSync(path.join(dir, 'app'), { recursive: true });
      fs.writeFileSync(
        path.join(dir, 'app/routes.py'),
        `from flask import Flask
from shared_handlers import list_users
app = Flask(__name__)
app.add_url_rule('/api/users', view_func=list_users)
`,
      );
      const mockDbExecutor = async (
        query: string,
        params?: Record<string, unknown>,
      ): Promise<Record<string, unknown>[]> => {
        if (query.includes('UNION ALL') || query.includes('filePath IN $filePaths')) return [];
        if (query.includes('n.name = $name') && params?.name === 'list_users') {
          return [{ uid: 'fn-list-users', name: 'list_users', filePath: 'shared/handlers.py' }];
        }
        return [];
      };

      const contracts = await extractor.extract(mockDbExecutor, dir, makeRepo(dir));
      const provider = contracts.find(
        (contract) =>
          contract.role === 'provider' && contract.contractId === 'http::GET::/api/users',
      );
      expect(provider).toMatchObject({ symbolUid: 'fn-list-users', symbolName: 'list_users' });
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

    it('resolves a Python Flask add_url_rule ALIASED view through the import (relative module)', async () => {
      // from .handlers.users import list_users as handle_users
      // app.add_url_rule('/api/users', view_func=handle_users)
      // resolves to the declared `list_users` in app/handlers/users.py — the
      // relative dotted module `.handlers.users` is pinned, the alias never used.
      const dir = path.join(tmpDir, 'py-flask-alias');
      fs.mkdirSync(path.join(dir, 'app', 'handlers'), { recursive: true });
      fs.writeFileSync(
        path.join(dir, 'app/routes.py'),
        `from flask import Flask
from .handlers.users import list_users as handle_users
app = Flask(__name__)
app.add_url_rule('/api/users', view_func=handle_users)
`,
      );
      const queriedNames: string[] = [];
      const mockDbExecutor = async (
        query: string,
        params?: Record<string, unknown>,
      ): Promise<Record<string, unknown>[]> => {
        if (query.includes('STARTS WITH')) {
          queriedNames.push(`module:${String(params?.name)}`);
          return params?.name === 'list_users' &&
            String(params?.fileDot ?? '').startsWith('app/handlers/users')
            ? [{ uid: 'fn-list_users', name: 'list_users', filePath: 'app/handlers/users.py' }]
            : [];
        }
        if (query.includes('n.name = $name')) {
          queriedNames.push(`global:${String(params?.name)}`);
          return [];
        }
        return [];
      };
      const contracts = await extractor.extract(mockDbExecutor, dir, makeRepo(dir));
      const provider = contracts.find(
        (c) => c.role === 'provider' && c.contractId === 'http::GET::/api/users',
      );
      expect(provider).toMatchObject({ symbolUid: 'fn-list_users', symbolName: 'list_users' });
      expect(queriedNames).not.toContain('module:handle_users');
    });

    it('retains legacy package-prefix resolution for a Python re-export', async () => {
      const dir = path.join(tmpDir, 'py-flask-reexport');
      fs.mkdirSync(path.join(dir, 'app', 'handlers'), { recursive: true });
      fs.writeFileSync(
        path.join(dir, 'app/routes.py'),
        `from flask import Flask
from .handlers import list_users
app = Flask(__name__)
app.add_url_rule('/api/users', view_func=list_users)
`,
      );
      fs.writeFileSync(
        path.join(dir, 'app', 'handlers', '__init__.py'),
        `from .users import list_users\n`,
      );
      fs.writeFileSync(
        path.join(dir, 'app', 'handlers', 'users.py'),
        `def list_users(): return []\n`,
      );
      const mockDbExecutor = async (
        query: string,
        params?: Record<string, unknown>,
      ): Promise<Record<string, unknown>[]> => {
        if (query.includes('STARTS WITH') && String(params?.fileSlash) === 'app/handlers/') {
          return [
            {
              uid: 'fn-list-users',
              name: 'list_users',
              filePath: 'app/handlers/users.py',
            },
          ];
        }
        return [];
      };

      const contracts = await extractor.extract(mockDbExecutor, dir, makeRepo(dir));
      const provider = contracts.find(
        (contract) =>
          contract.role === 'provider' && contract.contractId === 'http::GET::/api/users',
      );
      expect(provider).toMatchObject({ symbolUid: 'fn-list-users', symbolName: 'list_users' });
    });

    // ── Inline / closure provider handlers (#2276) ──────────────────────
    // An inline provider handler has no name, so it must resolve by line-span
    // containment to the symbol it lives in — exactly like a consumer. Mirrors
    // the Node/Express inline-arrow behavior for the non-Node plugins.

    it('resolves a Go inline http.HandleFunc closure to its containing function (#2276)', async () => {
      const dir = path.join(tmpDir, 'go-inline-handlefunc');
      fs.mkdirSync(path.join(dir, 'cmd'), { recursive: true });
      fs.writeFileSync(
        path.join(dir, 'cmd/server.go'),
        `package main

import "net/http"

func main() {
  http.HandleFunc("/api/inline", func(w http.ResponseWriter, r *http.Request) {
    w.Write([]byte("ok"))
  })
}
`,
      );
      // main() spans source lines 5-9 → 0-based [4,8]; the HandleFunc
      // registration and its anonymous func are on line 6 (row 5), inside span.
      const mockDbExecutor = async (
        query: string,
        params?: Record<string, unknown>,
      ): Promise<Record<string, unknown>[]> => {
        if (
          query.includes('UNION ALL') &&
          askedSymbolFiles(params).some((f) => f.includes('server.go'))
        ) {
          return [
            {
              uid: 'fn-main',
              name: 'main',
              filePath: 'cmd/server.go',
              startLine: 4,
              endLine: 8,
              labels: ['Function'],
            },
          ];
        }
        return [];
      };
      const contracts = await extractor.extract(mockDbExecutor, dir, makeRepo(dir));
      const provider = contracts.find(
        (c) => c.role === 'provider' && c.contractId === 'http::*::/api/inline',
      );
      expect(provider).toMatchObject({
        symbolUid: 'fn-main',
        symbolName: 'main',
        meta: { extractionStrategy: 'source_scan_resolved' },
      });
    });

    it('resolves a Go inline gin framework-route closure to its containing function (#2276)', async () => {
      const dir = path.join(tmpDir, 'go-inline-gin');
      fs.mkdirSync(path.join(dir, 'cmd'), { recursive: true });
      fs.writeFileSync(
        path.join(dir, 'cmd/server.go'),
        `package main

func registerRoutes(r *gin.Engine) {
  r.GET("/api/ping", func(c *gin.Context) {
    c.String(200, "pong")
  })
}
`,
      );
      const mockDbExecutor = async (
        query: string,
        params?: Record<string, unknown>,
      ): Promise<Record<string, unknown>[]> => {
        if (
          query.includes('UNION ALL') &&
          askedSymbolFiles(params).some((f) => f.includes('server.go'))
        ) {
          return [
            {
              uid: 'fn-registerRoutes',
              name: 'registerRoutes',
              filePath: 'cmd/server.go',
              startLine: 2,
              endLine: 6,
              labels: ['Function'],
            },
          ];
        }
        return [];
      };
      const contracts = await extractor.extract(mockDbExecutor, dir, makeRepo(dir));
      const provider = contracts.find(
        (c) => c.role === 'provider' && c.contractId === 'http::GET::/api/ping',
      );
      expect(provider).toMatchObject({
        symbolUid: 'fn-registerRoutes',
        symbolName: 'registerRoutes',
      });
    });

    it('keeps Go NAMED HandleFunc handler resolving by name, not containment (#2276)', async () => {
      const dir = path.join(tmpDir, 'go-named-handlefunc');
      fs.mkdirSync(path.join(dir, 'cmd'), { recursive: true });
      fs.writeFileSync(
        path.join(dir, 'cmd/server.go'),
        `package main

import "net/http"

func healthHandler(w http.ResponseWriter, r *http.Request) {}

func main() {
  http.HandleFunc("/api/health", healthHandler)
}
`,
      );
      // Both the named handler and the registrar main() are indexed. A named
      // provider must resolve to the HANDLER by name, never to main by line.
      const mockDbExecutor = async (
        query: string,
        params?: Record<string, unknown>,
      ): Promise<Record<string, unknown>[]> => {
        if (
          query.includes('UNION ALL') &&
          askedSymbolFiles(params).some((f) => f.includes('server.go'))
        ) {
          return [
            {
              uid: 'fn-healthHandler',
              name: 'healthHandler',
              filePath: 'cmd/server.go',
              startLine: 4,
              endLine: 4,
              labels: ['Function'],
            },
            {
              uid: 'fn-main',
              name: 'main',
              filePath: 'cmd/server.go',
              startLine: 6,
              endLine: 8,
              labels: ['Function'],
            },
          ];
        }
        return [];
      };
      const contracts = await extractor.extract(mockDbExecutor, dir, makeRepo(dir));
      const provider = contracts.find(
        (c) => c.role === 'provider' && c.contractId === 'http::*::/api/health',
      );
      expect(provider).toMatchObject({
        symbolUid: 'fn-healthHandler',
        symbolName: 'healthHandler',
      });
    });

    it('keeps a NAMED gin framework-route handler resolving by name, not its registrar (#2276)', async () => {
      // The framework-route query was also widened to accept func literals; this
      // pins that a NAMED identifier handler still resolves by name even though
      // a `line` is now emitted and the enclosing registrar span covers it.
      const dir = path.join(tmpDir, 'go-named-gin');
      fs.mkdirSync(path.join(dir, 'cmd'), { recursive: true });
      fs.writeFileSync(
        path.join(dir, 'cmd/server.go'),
        `package main

func listOrders(c *gin.Context) {}

func registerRoutes(r *gin.Engine) {
  r.GET("/api/orders", listOrders)
}
`,
      );
      // listOrders spans [2,2]; registerRoutes spans [4,6] and its span CONTAINS
      // the r.GET line (row 5). A named provider must resolve to listOrders by
      // name — never to registerRoutes by line-span containment.
      const mockDbExecutor = async (
        query: string,
        params?: Record<string, unknown>,
      ): Promise<Record<string, unknown>[]> => {
        if (
          query.includes('UNION ALL') &&
          askedSymbolFiles(params).some((f) => f.includes('server.go'))
        ) {
          return [
            {
              uid: 'fn-listOrders',
              name: 'listOrders',
              filePath: 'cmd/server.go',
              startLine: 2,
              endLine: 2,
              labels: ['Function'],
            },
            {
              uid: 'fn-registerRoutes',
              name: 'registerRoutes',
              filePath: 'cmd/server.go',
              startLine: 4,
              endLine: 6,
              labels: ['Function'],
            },
          ];
        }
        return [];
      };
      const contracts = await extractor.extract(mockDbExecutor, dir, makeRepo(dir));
      const provider = contracts.find(
        (c) => c.role === 'provider' && c.contractId === 'http::GET::/api/orders',
      );
      expect(provider).toMatchObject({
        symbolUid: 'fn-listOrders',
        symbolName: 'listOrders',
      });
    });

    it('binds the LAST arg as handler for a middleware + inline route, not the middleware (#2276)', async () => {
      // `r.GET(path, mw, func(){})` — gin/echo variadic middleware before an
      // inline handler. The trailing-anchor on @handler must select the closure
      // (→ containment to the enclosing fn), NOT the middleware identifier. With
      // the prior unanchored capture this emitted a second detection for `mw`
      // that won the contractId merge and mis-attributed the route to it.
      const dir = path.join(tmpDir, 'go-mw-inline-gin');
      fs.mkdirSync(path.join(dir, 'cmd'), { recursive: true });
      fs.writeFileSync(
        path.join(dir, 'cmd/server.go'),
        `package main

func authMiddleware(c *gin.Context) {}

func registerRoutes(r *gin.Engine) {
  r.GET("/api/guarded", authMiddleware, func(c *gin.Context) {
    c.String(200, "ok")
  })
}
`,
      );
      // Both the middleware and the enclosing registrar are indexed. The closure
      // sits at line 6, contained by registerRoutes [5,9]; authMiddleware [3,3]
      // does not contain it. The route must resolve to registerRoutes.
      const mockDbExecutor = async (
        query: string,
        params?: Record<string, unknown>,
      ): Promise<Record<string, unknown>[]> => {
        if (
          query.includes('UNION ALL') &&
          askedSymbolFiles(params).some((f) => f.includes('server.go'))
        ) {
          return [
            {
              uid: 'fn-authMiddleware',
              name: 'authMiddleware',
              filePath: 'cmd/server.go',
              startLine: 3,
              endLine: 3,
              labels: ['Function'],
            },
            {
              uid: 'fn-registerRoutes',
              name: 'registerRoutes',
              filePath: 'cmd/server.go',
              startLine: 5,
              endLine: 9,
              labels: ['Function'],
            },
          ];
        }
        return [];
      };
      const contracts = await extractor.extract(mockDbExecutor, dir, makeRepo(dir));
      const providers = contracts.filter(
        (c) => c.role === 'provider' && c.contractId === 'http::GET::/api/guarded',
      );
      // Exactly one provider (no middleware over-match), resolved by containment.
      expect(providers).toHaveLength(1);
      expect(providers[0]).toMatchObject({
        symbolUid: 'fn-registerRoutes',
        symbolName: 'registerRoutes',
      });
    });

    it('binds the LAST arg as handler for a middleware + NAMED route, not the middleware (#2276)', async () => {
      // `r.GET(path, mw, namedHandler)` — the named handler is the last arg and
      // must resolve by name; the leading middleware identifier must not win.
      const dir = path.join(tmpDir, 'go-mw-named-gin');
      fs.mkdirSync(path.join(dir, 'cmd'), { recursive: true });
      fs.writeFileSync(
        path.join(dir, 'cmd/server.go'),
        `package main

func authMiddleware(c *gin.Context) {}

func listOrders(c *gin.Context) {}

func registerRoutes(r *gin.Engine) {
  r.GET("/api/orders", authMiddleware, listOrders)
}
`,
      );
      const mockDbExecutor = async (
        query: string,
        params?: Record<string, unknown>,
      ): Promise<Record<string, unknown>[]> => {
        if (
          query.includes('UNION ALL') &&
          askedSymbolFiles(params).some((f) => f.includes('server.go'))
        ) {
          return [
            {
              uid: 'fn-authMiddleware',
              name: 'authMiddleware',
              filePath: 'cmd/server.go',
              startLine: 3,
              endLine: 3,
              labels: ['Function'],
            },
            {
              uid: 'fn-listOrders',
              name: 'listOrders',
              filePath: 'cmd/server.go',
              startLine: 5,
              endLine: 5,
              labels: ['Function'],
            },
            {
              uid: 'fn-registerRoutes',
              name: 'registerRoutes',
              filePath: 'cmd/server.go',
              startLine: 7,
              endLine: 9,
              labels: ['Function'],
            },
          ];
        }
        return [];
      };
      const contracts = await extractor.extract(mockDbExecutor, dir, makeRepo(dir));
      const providers = contracts.filter(
        (c) => c.role === 'provider' && c.contractId === 'http::GET::/api/orders',
      );
      expect(providers).toHaveLength(1);
      expect(providers[0]).toMatchObject({
        symbolUid: 'fn-listOrders',
        symbolName: 'listOrders',
      });
    });

    it('resolves a Laravel closure route nested in a method to that method (#2276)', async () => {
      const dir = path.join(tmpDir, 'php-closure-in-method');
      fs.mkdirSync(path.join(dir, 'app'), { recursive: true });
      fs.writeFileSync(
        path.join(dir, 'app/RouteServiceProvider.php'),
        `<?php
class RouteServiceProvider {
    public function boot() {
        Route::get('/api/closure', function () {
            return 1;
        });
    }
}
`,
      );
      // boot() spans source lines 3-7 → 0-based [2,6]; the closure registration
      // is on line 4 (row 3), inside boot's span.
      const mockDbExecutor = async (
        query: string,
        params?: Record<string, unknown>,
      ): Promise<Record<string, unknown>[]> => {
        if (
          query.includes('UNION ALL') &&
          askedSymbolFiles(params).some((f) => f.includes('RouteServiceProvider.php'))
        ) {
          return [
            {
              uid: 'method-boot',
              name: 'boot',
              filePath: 'app/RouteServiceProvider.php',
              startLine: 2,
              endLine: 6,
              labels: ['Method'],
            },
          ];
        }
        return [];
      };
      const contracts = await extractor.extract(mockDbExecutor, dir, makeRepo(dir));
      const provider = contracts.find(
        (c) => c.role === 'provider' && c.contractId === 'http::GET::/api/closure',
      );
      expect(provider).toMatchObject({
        symbolUid: 'method-boot',
        symbolName: 'boot',
        meta: { extractionStrategy: 'source_scan_resolved' },
      });
    });

    it('resolves a Laravel arrow-fn closure route by containment (#2276)', async () => {
      const dir = path.join(tmpDir, 'php-arrow-in-method');
      fs.mkdirSync(path.join(dir, 'app'), { recursive: true });
      fs.writeFileSync(
        path.join(dir, 'app/RouteServiceProvider.php'),
        `<?php
class RouteServiceProvider {
    public function boot() {
        Route::post('/api/arrow', fn() => response());
    }
}
`,
      );
      const mockDbExecutor = async (
        query: string,
        params?: Record<string, unknown>,
      ): Promise<Record<string, unknown>[]> => {
        if (
          query.includes('UNION ALL') &&
          askedSymbolFiles(params).some((f) => f.includes('RouteServiceProvider.php'))
        ) {
          return [
            {
              uid: 'method-boot',
              name: 'boot',
              filePath: 'app/RouteServiceProvider.php',
              startLine: 2,
              endLine: 4,
              labels: ['Method'],
            },
          ];
        }
        return [];
      };
      const contracts = await extractor.extract(mockDbExecutor, dir, makeRepo(dir));
      const provider = contracts.find(
        (c) => c.role === 'provider' && c.contractId === 'http::POST::/api/arrow',
      );
      expect(provider).toMatchObject({ symbolUid: 'method-boot', symbolName: 'boot' });
    });

    it('leaves a Laravel NAMED-controller route at the prior behavior (no closure path) (#2276)', async () => {
      const dir = path.join(tmpDir, 'php-named-controller');
      fs.mkdirSync(path.join(dir, 'routes'), { recursive: true });
      fs.writeFileSync(
        path.join(dir, 'routes/web.php'),
        `<?php
Route::put('/api/named', [UserController::class, 'update']);
`,
      );
      // No closure → name stays 'route' (not null); the 'route' label resolves
      // to no symbol, so symbolUid stays empty (file-level). Behavior unchanged.
      const mockDbExecutor = async (): Promise<Record<string, unknown>[]> => [];
      const contracts = await extractor.extract(mockDbExecutor, dir, makeRepo(dir));
      const provider = contracts.find(
        (c) => c.role === 'provider' && c.contractId === 'http::PUT::/api/named',
      );
      expect(provider).toBeDefined();
      expect(provider?.symbolUid).toBe('');
    });

    it('resolves a FastAPI @app provider to its decorated function (source-scan fallback) (#2276)', async () => {
      const dir = path.join(tmpDir, 'py-fastapi-app');
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(
        path.join(dir, 'main.py'),
        `from fastapi import FastAPI
app = FastAPI()

@app.get("/api/items")
def list_items():
    return []
`,
      );
      // The decorator is on line 4 (row 3); `def list_items` is on line 5
      // (row 4). tree-sitter records the function_definition span from `def`,
      // so list_items spans 0-based [4,5]. The detection line is the decorator
      // row + 1 = 5, and the resolver's direct `line` probe (row 4) lands in
      // the def span. (Graph routes are authoritative; this is the fallback.)
      const mockDbExecutor = async (
        query: string,
        params?: Record<string, unknown>,
      ): Promise<Record<string, unknown>[]> => {
        if (
          query.includes('UNION ALL') &&
          askedSymbolFiles(params).some((f) => f.includes('main.py'))
        ) {
          return [
            {
              uid: 'fn-list_items',
              name: 'list_items',
              filePath: 'main.py',
              startLine: 4,
              endLine: 5,
              labels: ['Function'],
            },
          ];
        }
        return [];
      };
      const contracts = await extractor.extract(mockDbExecutor, dir, makeRepo(dir));
      const provider = contracts.find(
        (c) => c.role === 'provider' && c.contractId === 'http::GET::/api/items',
      );
      expect(provider).toMatchObject({
        symbolUid: 'fn-list_items',
        symbolName: 'list_items',
        meta: { extractionStrategy: 'source_scan_resolved' },
      });
    });

    // Documented limitations pinned by tests (#2276): a closure with no
    // enclosing function symbol, and a multi-decorator FastAPI handler whose
    // detection line falls above the def-span, both degrade to file-level
    // rather than mis-attributing. These lock the comments in php.ts/python.ts.

    it('leaves a FILE-scope Laravel closure at file-level (no enclosing symbol) (#2276)', async () => {
      const dir = path.join(tmpDir, 'php-closure-file-scope');
      fs.mkdirSync(path.join(dir, 'routes'), { recursive: true });
      fs.writeFileSync(
        path.join(dir, 'routes/web.php'),
        `<?php
Route::get('/api/home', function () {
    return view('home');
});
`,
      );
      // No enclosing function/method at file scope, and PHP closures are not
      // indexed as symbols → containment finds nothing → symbolUid stays empty.
      const mockDbExecutor = async (): Promise<Record<string, unknown>[]> => [];
      const contracts = await extractor.extract(mockDbExecutor, dir, makeRepo(dir));
      const provider = contracts.find(
        (c) => c.role === 'provider' && c.contractId === 'http::GET::/api/home',
      );
      expect(provider).toBeDefined();
      expect(provider?.symbolUid).toBe('');
    });

    it('leaves a multi-decorator FastAPI handler at file-level (line above def-span) (#2276)', async () => {
      const dir = path.join(tmpDir, 'py-fastapi-multidecorator');
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(
        path.join(dir, 'main.py'),
        `from fastapi import FastAPI
app = FastAPI()

@app.get("/api/items")
@require_auth
def list_items():
    return []
`,
      );
      // The path literal is on line 4 (row 3) → detection line = row 3 + 1 = 4.
      // With a second decorator the `def` is on line 6 (row 5), so list_items
      // spans 0-based [5,6]. The resolver probes row 3 (line-1) then row 4
      // (line); both fall ABOVE the [5,6] span → no containment → file-level.
      // (Single-decorator resolves because there the def sits at the line probe.)
      const mockDbExecutor = async (
        query: string,
        params?: Record<string, unknown>,
      ): Promise<Record<string, unknown>[]> => {
        if (
          query.includes('UNION ALL') &&
          askedSymbolFiles(params).some((f) => f.includes('main.py'))
        ) {
          return [
            {
              uid: 'fn-list_items',
              name: 'list_items',
              filePath: 'main.py',
              startLine: 5,
              endLine: 6,
              labels: ['Function'],
            },
          ];
        }
        return [];
      };
      const contracts = await extractor.extract(mockDbExecutor, dir, makeRepo(dir));
      const provider = contracts.find(
        (c) => c.role === 'provider' && c.contractId === 'http::GET::/api/items',
      );
      expect(provider).toBeDefined();
      expect(provider?.symbolUid).toBe('');
    });

    // The @router/APIRouter provider emit also carries `line` (#2276), but only
    // @app was covered above. These pin the @router containment path: a
    // single-decorator router handler resolves to its function, and a
    // multi-decorator one degrades to file-level — same as @app.

    it('resolves a FastAPI @router provider to its decorated function (source-scan fallback) (#2276)', async () => {
      const dir = path.join(tmpDir, 'py-fastapi-router');
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(
        path.join(dir, 'main.py'),
        `from fastapi import APIRouter
router = APIRouter()

@router.get("/api/items")
def list_items():
    return []
`,
      );
      // Same shape as the @app case: @router.get is on line 4 (row 3), `def`
      // on line 5 → list_items spans 0-based [4,5]; the `line` probe lands in
      // the def span and resolves via source_scan_resolved. No include_router
      // prefix in scope, so the unprefixed path is emitted.
      const mockDbExecutor = async (
        query: string,
        params?: Record<string, unknown>,
      ): Promise<Record<string, unknown>[]> => {
        if (
          query.includes('UNION ALL') &&
          askedSymbolFiles(params).some((f) => f.includes('main.py'))
        ) {
          return [
            {
              uid: 'fn-list_items',
              name: 'list_items',
              filePath: 'main.py',
              startLine: 4,
              endLine: 5,
              labels: ['Function'],
            },
          ];
        }
        return [];
      };
      const contracts = await extractor.extract(mockDbExecutor, dir, makeRepo(dir));
      const provider = contracts.find(
        (c) => c.role === 'provider' && c.contractId === 'http::GET::/api/items',
      );
      expect(provider).toMatchObject({
        symbolUid: 'fn-list_items',
        symbolName: 'list_items',
        meta: { extractionStrategy: 'source_scan_resolved' },
      });
    });

    it('leaves a module-scope multi-decorator @router handler at file-level (#2276)', async () => {
      const dir = path.join(tmpDir, 'py-fastapi-router-multidecorator');
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(
        path.join(dir, 'main.py'),
        `from fastapi import APIRouter
router = APIRouter()

@router.post("/api/items")
@require_auth
def create_item():
    return {}
`,
      );
      // With a second decorator the `def` is on line 6 → create_item spans
      // 0-based [5,6]; the path-line probe falls ABOVE that span → no
      // containment → file-level (symbolUid stays empty), matching @app.
      const mockDbExecutor = async (
        query: string,
        params?: Record<string, unknown>,
      ): Promise<Record<string, unknown>[]> => {
        if (
          query.includes('UNION ALL') &&
          askedSymbolFiles(params).some((f) => f.includes('main.py'))
        ) {
          return [
            {
              uid: 'fn-create_item',
              name: 'create_item',
              filePath: 'main.py',
              startLine: 5,
              endLine: 6,
              labels: ['Function'],
            },
          ];
        }
        return [];
      };
      const contracts = await extractor.extract(mockDbExecutor, dir, makeRepo(dir));
      const provider = contracts.find(
        (c) => c.role === 'provider' && c.contractId === 'http::POST::/api/items',
      );
      expect(provider).toBeDefined();
      expect(provider?.symbolUid).toBe('');
    });
  });

  describe('provider extraction — source-scan fallback (Strategy B)', () => {
    // ─── #1834 follow-up — Spring on Kotlin ──────────────────────────
    // The same positional / named-argument distinction applies to
    // Kotlin Spring Boot controllers. The Kotlin tree-sitter grammar
    // (fwcd/tree-sitter-kotlin) produces a different AST shape than
    // tree-sitter-java — both forms share `value_argument`, with the
    // optional leading `simple_identifier "="` distinguishing named
    // from positional. The plugin in `http-patterns/kotlin.ts` mirrors
    // the safety bar from java.ts: positional uses `.` to anchor the
    // string_literal as the first named child of `value_argument`,
    // and the named pattern restricts the `simple_identifier` key to
    // `^(path|value)$` to avoid capturing `produces`, `consumes`,
    // `headers`, `name`, `params`, etc.
    //
    // tree-sitter-kotlin is an optionalDependency. If the binding is
    // unavailable in the current test environment, `getPluginForFile`
    // returns undefined for `.kt` files and we skip the suite.
    const kotlinAvailable = getPluginForFile('Probe.kt') !== undefined;
    const itKotlin = kotlinAvailable ? it : it.skip;

    itKotlin('extracts Kotlin @RequestMapping("/api/v1") (positional class prefix)', async () => {
      const dir = path.join(tmpDir, 'kotlin-spring-class-positional');
      fs.mkdirSync(path.join(dir, 'src/controller'), { recursive: true });
      fs.writeFileSync(
        path.join(dir, 'src/controller/UserController.kt'),
        `package com.example
import org.springframework.web.bind.annotation.GetMapping
import org.springframework.web.bind.annotation.RequestMapping
import org.springframework.web.bind.annotation.RestController

@RestController
@RequestMapping("/api/v1")
class UserController {
  @GetMapping("/users") fun list() {}
}
`,
      );

      const contracts = await extractor.extract(null, dir, makeRepo(dir));
      const providers = contracts.filter((c) => c.role === 'provider');

      const route = providers.find((c) => c.contractId === 'http::GET::/api/v1/users');
      expect(route).toBeDefined();
      expect(route!.symbolName).toBe('list');
      expect(route!.meta.framework).toBe('spring');
    });

    itKotlin('extracts Kotlin @RequestMapping(path = "/api/v2") (named class prefix)', async () => {
      const dir = path.join(tmpDir, 'kotlin-spring-class-named-path');
      fs.mkdirSync(path.join(dir, 'src/controller'), { recursive: true });
      fs.writeFileSync(
        path.join(dir, 'src/controller/UserController.kt'),
        `package com.example
import org.springframework.web.bind.annotation.GetMapping
import org.springframework.web.bind.annotation.RequestMapping
import org.springframework.web.bind.annotation.RestController

@RestController
@RequestMapping(path = "/api/v2")
class UserController {
  @GetMapping("/users") fun list() {}
}
`,
      );

      const contracts = await extractor.extract(null, dir, makeRepo(dir));
      const providers = contracts.filter((c) => c.role === 'provider');

      const route = providers.find((c) => c.contractId === 'http::GET::/api/v2/users');
      expect(route).toBeDefined();
    });

    itKotlin(
      'extracts Kotlin @RequestMapping(value = "/orders") (named class prefix)',
      async () => {
        const dir = path.join(tmpDir, 'kotlin-spring-class-named-value');
        fs.mkdirSync(path.join(dir, 'src/controller'), { recursive: true });
        fs.writeFileSync(
          path.join(dir, 'src/controller/OrderController.kt'),
          `package com.example
import org.springframework.web.bind.annotation.GetMapping
import org.springframework.web.bind.annotation.RequestMapping
import org.springframework.web.bind.annotation.RestController

@RestController
@RequestMapping(value = "/orders")
class OrderController {
  @GetMapping("/list") fun list() {}
}
`,
        );

        const contracts = await extractor.extract(null, dir, makeRepo(dir));
        const providers = contracts.filter((c) => c.role === 'provider');

        expect(providers.find((c) => c.contractId === 'http::GET::/orders/list')).toBeDefined();
      },
    );

    itKotlin('extracts Kotlin method-level @GetMapping(value = "/users")', async () => {
      const dir = path.join(tmpDir, 'kotlin-spring-method-named-value');
      fs.mkdirSync(path.join(dir, 'src/controller'), { recursive: true });
      fs.writeFileSync(
        path.join(dir, 'src/controller/UserController.kt'),
        `package com.example
import org.springframework.web.bind.annotation.GetMapping
import org.springframework.web.bind.annotation.RestController

@RestController
class UserController {
  @GetMapping(value = "/users") fun list() {}
}
`,
      );

      const contracts = await extractor.extract(null, dir, makeRepo(dir));
      const providers = contracts.filter((c) => c.role === 'provider');

      const route = providers.find((c) => c.contractId === 'http::GET::/users');
      expect(route).toBeDefined();
      expect(route!.symbolName).toBe('list');
    });

    itKotlin('extracts Kotlin method-level @GetMapping(path = "/users")', async () => {
      const dir = path.join(tmpDir, 'kotlin-spring-method-named-path-get');
      fs.mkdirSync(path.join(dir, 'src/controller'), { recursive: true });
      fs.writeFileSync(
        path.join(dir, 'src/controller/UserController.kt'),
        `package com.example
import org.springframework.web.bind.annotation.GetMapping
import org.springframework.web.bind.annotation.RestController

@RestController
class UserController {
  @GetMapping(path = "/users") fun list() {}
}
`,
      );

      const contracts = await extractor.extract(null, dir, makeRepo(dir));
      const providers = contracts.filter((c) => c.role === 'provider');

      expect(providers.find((c) => c.contractId === 'http::GET::/users')).toBeDefined();
    });

    itKotlin('extracts Kotlin method-level @PostMapping(path = "/users")', async () => {
      const dir = path.join(tmpDir, 'kotlin-spring-method-named-path-post');
      fs.mkdirSync(path.join(dir, 'src/controller'), { recursive: true });
      fs.writeFileSync(
        path.join(dir, 'src/controller/UserController.kt'),
        `package com.example
import org.springframework.web.bind.annotation.PostMapping
import org.springframework.web.bind.annotation.RestController

@RestController
class UserController {
  @PostMapping(path = "/users") fun create() {}
}
`,
      );

      const contracts = await extractor.extract(null, dir, makeRepo(dir));
      const providers = contracts.filter((c) => c.role === 'provider');

      const route = providers.find((c) => c.contractId === 'http::POST::/users');
      expect(route).toBeDefined();
      expect(route!.symbolName).toBe('create');
    });

    itKotlin('combines Kotlin class named-arg prefix with method positional path', async () => {
      const dir = path.join(tmpDir, 'kotlin-spring-mixed-class-named-method-pos');
      fs.mkdirSync(path.join(dir, 'src/controller'), { recursive: true });
      fs.writeFileSync(
        path.join(dir, 'src/controller/UserController.kt'),
        `package com.example
import org.springframework.web.bind.annotation.GetMapping
import org.springframework.web.bind.annotation.RequestMapping
import org.springframework.web.bind.annotation.RestController

@RestController
@RequestMapping(path = "/api")
class UserController {
  @GetMapping("/users") fun list() {}
}
`,
      );

      const contracts = await extractor.extract(null, dir, makeRepo(dir));
      const providers = contracts.filter((c) => c.role === 'provider');

      expect(providers.find((c) => c.contractId === 'http::GET::/api/users')).toBeDefined();
    });

    itKotlin('combines Kotlin class positional prefix with method named-arg path', async () => {
      const dir = path.join(tmpDir, 'kotlin-spring-mixed-class-pos-method-named');
      fs.mkdirSync(path.join(dir, 'src/controller'), { recursive: true });
      fs.writeFileSync(
        path.join(dir, 'src/controller/UserController.kt'),
        `package com.example
import org.springframework.web.bind.annotation.GetMapping
import org.springframework.web.bind.annotation.RequestMapping
import org.springframework.web.bind.annotation.RestController

@RestController
@RequestMapping("/api")
class UserController {
  @GetMapping(value = "/users") fun list() {}
}
`,
      );

      const contracts = await extractor.extract(null, dir, makeRepo(dir));
      const providers = contracts.filter((c) => c.role === 'provider');

      expect(providers.find((c) => c.contractId === 'http::GET::/api/users')).toBeDefined();
    });

    itKotlin(
      'does NOT emit a Kotlin provider for @GetMapping(produces = ...) without path/value',
      async () => {
        // Anti-regression: without the `simple_identifier` key
        // constraint, the named-arg query would capture
        // `produces = "application/json"` and emit a bogus
        // `http::GET::/application/json` contract.
        const dir = path.join(tmpDir, 'kotlin-spring-produces-only');
        fs.mkdirSync(path.join(dir, 'src/controller'), { recursive: true });
        fs.writeFileSync(
          path.join(dir, 'src/controller/MisleadingController.kt'),
          `package com.example
import org.springframework.web.bind.annotation.GetMapping
import org.springframework.web.bind.annotation.RestController

@RestController
class MisleadingController {
  @GetMapping(produces = "application/json") fun list() {}
}
`,
        );

        const contracts = await extractor.extract(null, dir, makeRepo(dir));
        const providers = contracts.filter((c) => c.role === 'provider');

        expect(
          providers.find((c) => c.contractId === 'http::GET::/application/json'),
        ).toBeUndefined();
        const fromThisFile = providers.filter((c) =>
          c.symbolRef.filePath.endsWith('MisleadingController.kt'),
        );
        expect(fromThisFile).toHaveLength(0);
      },
    );

    itKotlin(
      'emits exactly one Kotlin provider for @GetMapping(name = "...", value = "/users")',
      async () => {
        // Anti-regression: without the key constraint, both string
        // literals would be captured as method paths, emitting two
        // contracts (`/listUsers` + `/users`).
        const dir = path.join(tmpDir, 'kotlin-spring-name-and-value');
        fs.mkdirSync(path.join(dir, 'src/controller'), { recursive: true });
        fs.writeFileSync(
          path.join(dir, 'src/controller/UserController.kt'),
          `package com.example
import org.springframework.web.bind.annotation.GetMapping
import org.springframework.web.bind.annotation.RestController

@RestController
class UserController {
  @GetMapping(name = "listUsers", value = "/users") fun list() {}
}
`,
        );

        const contracts = await extractor.extract(null, dir, makeRepo(dir));
        const providers = contracts.filter((c) => c.role === 'provider');

        const usersRoute = providers.find((c) => c.contractId === 'http::GET::/users');
        expect(usersRoute).toBeDefined();
        expect(usersRoute!.symbolName).toBe('list');

        expect(providers.find((c) => c.contractId === 'http::GET::/listUsers')).toBeUndefined();

        const fromThisFile = providers.filter((c) =>
          c.symbolRef.filePath.endsWith('UserController.kt'),
        );
        expect(fromThisFile).toHaveLength(1);
      },
    );

    itKotlin(
      'uses Kotlin `path` (not non-route key) as class prefix when both appear',
      async () => {
        // Anti-regression: without the key constraint, the LAST captured
        // value_argument would win in the prefix map. Here `name = "myApi"`
        // appears after `path = "/api"` — the prefix must remain `/api`.
        const dir = path.join(tmpDir, 'kotlin-spring-class-prefix-key-wins');
        fs.mkdirSync(path.join(dir, 'src/controller'), { recursive: true });
        fs.writeFileSync(
          path.join(dir, 'src/controller/UserController.kt'),
          `package com.example
import org.springframework.web.bind.annotation.GetMapping
import org.springframework.web.bind.annotation.RequestMapping
import org.springframework.web.bind.annotation.RestController

@RestController
@RequestMapping(path = "/api", name = "myApi")
class UserController {
  @GetMapping("/users") fun list() {}
}
`,
        );

        const contracts = await extractor.extract(null, dir, makeRepo(dir));
        const providers = contracts.filter((c) => c.role === 'provider');

        expect(providers.find((c) => c.contractId === 'http::GET::/api/users')).toBeDefined();
        expect(providers.find((c) => c.contractId === 'http::GET::/myApi/users')).toBeUndefined();
      },
    );

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

    it('extracts Express providers whose paths are same-file module constants', async () => {
      const dir = path.join(tmpDir, 'express-constant-paths');
      fs.mkdirSync(path.join(dir, 'src/routes'), { recursive: true });
      fs.writeFileSync(
        path.join(dir, 'src/routes/users.ts'),
        `
import { Router } from 'express';
const router = Router();
const BASE = '/api/v1';
const ROUTES = { USERS: '/api/v1/users' } as const;

router.get(ROUTES.USERS, listUsers);
router.delete(BASE + '/users/:id', removeUser);
function scoped() {
  const BASE = '/shadowed';
  router.get(BASE, handler);
}

export default router;
`,
      );

      const contracts = await extractor.extract(null, dir, makeRepo(dir));
      expect(
        contracts
          .filter((c) => c.role === 'provider')
          .map((c) => c.contractId)
          .sort(),
      ).toEqual(['http::DELETE::/api/v1/users/{param}', 'http::GET::/api/v1/users']);
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

    it('extracts Go Gin and Echo route registrations', async () => {
      const dir = path.join(tmpDir, 'go-frameworks');
      fs.mkdirSync(path.join(dir, 'cmd'), { recursive: true });
      fs.writeFileSync(
        path.join(dir, 'cmd', 'server.go'),
        `
package main

func createOrder(c *gin.Context) {}
func listOrders(c echo.Context) error { return nil }

func main() {
  r := gin.Default()
  r.POST("/api/orders/:id", createOrder)

  e := echo.New()
  e.GET("/api/orders", listOrders)
}
`,
      );

      const contracts = await extractor.extract(null, dir, makeRepo(dir));
      const providers = contracts.filter((c) => c.role === 'provider');

      const ginRoute = providers.find((c) => c.contractId === 'http::POST::/api/orders/{param}');
      expect(ginRoute).toBeDefined();
      expect(ginRoute?.symbolName).toBe('createOrder');

      const echoRoute = providers.find((c) => c.contractId === 'http::GET::/api/orders');
      expect(echoRoute).toBeDefined();
      expect(echoRoute?.symbolName).toBe('listOrders');
    });

    it('extracts stdlib HandleFunc providers', async () => {
      const dir = path.join(tmpDir, 'go-stdlib-provider');
      fs.mkdirSync(path.join(dir, 'cmd'), { recursive: true });
      fs.writeFileSync(
        path.join(dir, 'cmd', 'server.go'),
        `
package main

import "net/http"

func healthHandler(w http.ResponseWriter, r *http.Request) {}

func main() {
  http.HandleFunc("/api/health", healthHandler)
}
`,
      );

      const contracts = await extractor.extract(null, dir, makeRepo(dir));
      const providers = contracts.filter((c) => c.role === 'provider');

      const healthRoute = providers.find((c) => c.contractId === 'http::*::/api/health');
      expect(healthRoute).toBeDefined();
      expect(healthRoute?.symbolName).toBe('healthHandler');
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

    it('extracts jQuery $.get and $.post shorthand', async () => {
      const dir = path.join(tmpDir, 'jquery-shorthand');
      fs.mkdirSync(path.join(dir, 'public/js'), { recursive: true });
      fs.writeFileSync(
        path.join(dir, 'public/js/users.js'),
        `
function loadUsers() {
  $.get('/api/users', function (data) { console.log(data); });
}

function createUser(payload) {
  $.post('/api/users', payload);
}
`,
      );

      const contracts = await extractor.extract(null, dir, makeRepo(dir));
      const consumers = contracts.filter((c) => c.role === 'consumer');

      const getRoute = consumers.find((c) => c.contractId === 'http::GET::/api/users');
      expect(getRoute).toBeDefined();
      expect(getRoute?.meta.framework).toBe('jquery');

      const postRoute = consumers.find((c) => c.contractId === 'http::POST::/api/users');
      expect(postRoute).toBeDefined();
      expect(postRoute?.meta.framework).toBe('jquery');
    });

    it('extracts jQuery $.ajax with method: and type: keys and default GET', async () => {
      const dir = path.join(tmpDir, 'jquery-ajax');
      fs.mkdirSync(path.join(dir, 'public/js'), { recursive: true });
      fs.writeFileSync(
        path.join(dir, 'public/js/orders.js'),
        `
$.ajax({ url: '/api/orders', method: 'PUT', data: {} });
$.ajax({ url: '/api/items',  type:   'DELETE' });
$.ajax({ url: '/api/default' });

function reloadOrder(id) {
  return $.ajax({ url: \`/api/orders/\${id}\`, method: 'GET' });
}
`,
      );

      const contracts = await extractor.extract(null, dir, makeRepo(dir));
      const consumers = contracts.filter((c) => c.role === 'consumer');

      expect(consumers.find((c) => c.contractId === 'http::PUT::/api/orders')).toBeDefined();
      expect(consumers.find((c) => c.contractId === 'http::DELETE::/api/items')).toBeDefined();
      expect(consumers.find((c) => c.contractId === 'http::GET::/api/default')).toBeDefined();
      // Template-literal URL inside $.ajax is normalized to {param} the same
      // way the fetch/axios paths do — confirms readStringProp accepts
      // template_string values for jQuery ajax, not just for axios object form.
      expect(
        consumers.find((c) => c.contractId === 'http::GET::/api/orders/{param}'),
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

    it('does not emit consumers for unrelated object-literal calls (negative control)', async () => {
      const dir = path.join(tmpDir, 'jquery-axios-negative');
      fs.mkdirSync(path.join(dir, 'public/js'), { recursive: true });
      fs.writeFileSync(
        path.join(dir, 'public/js/misc.js'),
        `
// jQuery but not an ajax/get/post call
$.fn.extend({ url: '/nope', method: 'POST' });
$.each([1, 2, 3], function (i, v) { return v; });

// Not axios and not $ — unrelated helper that happens to take { url, method }
function myHelper(opts) { return opts; }
myHelper({ url: '/nope', method: 'POST' });

// Bare object literal, not a call argument at all
const cfg = { url: '/nope', method: 'POST' };
console.log(cfg);
`,
      );

      const contracts = await extractor.extract(null, dir, makeRepo(dir));
      const consumers = contracts.filter((c) => c.role === 'consumer');

      // None of the above should have produced any HTTP consumer contracts.
      const nopeConsumers = consumers.filter(
        (c) => typeof c.meta.path === 'string' && c.meta.path.includes('/nope'),
      );
      expect(nopeConsumers).toHaveLength(0);
    });

    it('extracts Python requests calls', async () => {
      const dir = path.join(tmpDir, 'python-consumer');
      fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
      fs.writeFileSync(
        path.join(dir, 'src', 'client.py'),
        `
import requests

def create_order():
    return requests.post("https://svc.local/api/orders/42", json={"id": 42})
`,
      );

      const contracts = await extractor.extract(null, dir, makeRepo(dir));
      const consumers = contracts.filter((c) => c.role === 'consumer');

      expect(
        consumers.find((c) => c.contractId === 'http::POST::/api/orders/{param}'),
      ).toBeDefined();
    });

    it('reads prefixed Python literals and f-string URLs as paths (#1675)', async () => {
      const dir = path.join(tmpDir, 'python-prefixed-consumer');
      fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
      fs.writeFileSync(
        path.join(dir, 'src', 'client.py'),
        `
import requests

BASE = "https://svc.local"

def calls(svc, item_id):
    requests.get(f"{BASE}/api/items")
    requests.get(F"/api/items/{item_id:d}")
    requests.post(rf"/api/raw")
    requests.put(b"/api/bytes")
    requests.delete(u'/api/legacy')
    requests.request("PATCH", f"https://svc.local/api/abs/{item_id!r}")
    requests.get(url=f"""{BASE}/api/keyword""")
    requests.get(f"{BASE}api/relative")
    requests.get(f"/api/odd/{ {} }")
    uri = f"{BASE}/api/wrapped/{item_id}"
    svc.fetch(uri=uri)
    relative = "api/v1/relative"
    svc.fetch(uri=relative)
    root = f"{BASE}/"
    svc.fetch(uri=root)
`,
      );

      const contracts = await extractor.extract(null, dir, makeRepo(dir));
      const consumerIds = contracts
        .filter((c) => c.role === 'consumer')
        .map((c) => c.contractId)
        .sort();

      // A leading interpolation followed by `/` is a host binding, as for a JS
      // template (#3111); one with no `/` after it is not a routable path, and
      // a variable url that is only the host is skipped like a literal root.
      expect(consumerIds).toEqual(
        [
          'http::DELETE::/api/legacy',
          'http::GET::/api/items',
          'http::GET::/api/items/{param}',
          'http::GET::/api/keyword',
          'http::GET::/api/odd/{param}',
          'http::GET::/api/v1/relative',
          'http::GET::/api/wrapped/{param}',
          'http::PATCH::/api/abs/{param}',
          'http::POST::/api/raw',
          'http::PUT::/api/bytes',
        ].sort(),
      );
    });

    it('extracts Python httpx.AsyncClient calls assigned to attributes or aliases', async () => {
      const dir = path.join(tmpDir, 'python-httpx-consumer');
      fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
      fs.writeFileSync(
        path.join(dir, 'src', 'client.py'),
        `
import httpx
import httpx as hx
from httpx import AsyncClient
from httpx import AsyncClient as HttpxAsyncClient

# Dotted-package look-alikes — must NOT be detected as httpx.
import my_pkg.httpx as evil_mod
from my_pkg.httpx import AsyncClient as evil_async
# Longer dotted path — must also NOT be detected.
import a.b.c.httpx as deep_evil
from a.b.c.httpx import AsyncClient as deep_evil_async
# Relative import — module_name is a relative_import node, not dotted_name, so
# it must not produce a contract either.
from .httpx import AsyncClient as rel_evil_async

module_client = httpx.AsyncClient(base_url="https://svc.local")
module_alias_client = hx.AsyncClient(base_url="https://svc.local")
module_direct_client = AsyncClient(base_url="https://svc.local")
module_renamed_client = HttpxAsyncClient(base_url="https://svc.local")
evil_mod_client = evil_mod.AsyncClient(base_url="https://svc.local")
evil_direct_client = evil_async(base_url="https://svc.local")
deep_evil_mod_client = deep_evil.AsyncClient(base_url="https://svc.local")
deep_evil_direct_client = deep_evil_async(base_url="https://svc.local")
rel_evil_direct_client = rel_evil_async(base_url="https://svc.local")

class TopicClient:
    def __init__(self):
        self._client = httpx.AsyncClient(base_url="https://svc.local")

    async def list_topics(self):
        return await self._client.get("/topic")

    async def publish(self):
        return await self._client.request("POST", "/questions/import")

    async def delete_topic(self):
        return await self._client.delete("/topic")

async def check_duplicate():
    async with httpx.AsyncClient() as client:
        data = {}
        data.get("/nope")
        service.request("POST", "/nope")
        return await client.post("https://svc.local/questions/duplicate-check")

async def import_aliases():
    local_alias_client = hx.AsyncClient(base_url="https://svc.local")
    local_direct_client = AsyncClient(base_url="https://svc.local")
    local_renamed_client = HttpxAsyncClient(base_url="https://svc.local")
    await local_alias_client.get("/alias-topic")
    await local_direct_client.patch("/direct-topic")
    await local_renamed_client.request("PUT", "/renamed-topic")
    async with hx.AsyncClient() as alias_context:
        await alias_context.delete("/alias-context")
    async with AsyncClient() as direct_context:
        return await direct_context.post("/direct-context")

def unrelated_scope_collision():
    client = acquire_cache_client()
    return client.get("/ignored-same-name")

def module_scope_shadow_collision():
    client = acquire_cache_client()
    return client.get("/ignored-module-same-name")

def shadow_direct_alias():
    AsyncClient = lambda: FakeClient()
    client = AsyncClient()
    return client.get("/shadow-direct-fp")

def shadow_module_alias():
    hx = FakeMod()
    client = hx.AsyncClient()
    return client.get("/shadow-module-fp")

async def shadow_direct_context():
    AsyncClient = lambda: FakeClient()
    async with AsyncClient() as client:
        return await client.get("/shadow-direct-context-fp")

def shadow_tuple_destructure():
    AsyncClient, _other = (lambda: FakeClient()), 42
    client = AsyncClient()
    return client.get("/shadow-tuple-fp")

# Class-body assignment of an imported alias is a class attribute under Python
# LEGB rules — methods inside still see the module binding. The detector must
# NOT poison the methods, so the legitimate httpx call below should still emit.
class ClassBodyRebindHolder:
    AsyncClient = lambda: FakeClient()

    def __init__(self):
        self._client = httpx.AsyncClient(base_url="https://svc.local")

    async def fetch(self):
        return await self._client.get("/class-body-rebind-ok")

module_client.get("/module-topic")
module_alias_client.get("/module-alias-topic")
module_direct_client.get("/module-direct-topic")
module_renamed_client.get("/module-renamed-topic")
evil_mod_client.get("/evil-module-dotted-fp")
evil_direct_client.get("/evil-direct-dotted-fp")
deep_evil_mod_client.get("/deep-evil-module-dotted-fp")
deep_evil_direct_client.get("/deep-evil-direct-dotted-fp")
rel_evil_direct_client.get("/rel-evil-direct-fp")
`,
      );

      // Isolated file for module-level rebind: shadowing applies file-wide, so
      // it must not affect the assertions in client.py above.
      fs.writeFileSync(
        path.join(dir, 'src', 'module_rebind.py'),
        `
from httpx import AsyncClient

# Module-level rebind: the rest of this file's bare AsyncClient calls must NOT
# emit httpx consumer contracts.
AsyncClient = lambda: FakeClient()

shadowed_module_client = AsyncClient(base_url="https://svc.local")
shadowed_module_client.get("/module-level-rebind-fp")
`,
      );

      const contracts = await extractor.extract(null, dir, makeRepo(dir));
      const consumers = contracts.filter((c) => c.role === 'consumer');

      const expected = [
        'http::GET::/topic',
        'http::POST::/questions/import',
        'http::DELETE::/topic',
        'http::POST::/questions/duplicate-check',
        'http::GET::/alias-topic',
        'http::PATCH::/direct-topic',
        'http::PUT::/renamed-topic',
        'http::DELETE::/alias-context',
        'http::POST::/direct-context',
        'http::GET::/module-topic',
        'http::GET::/module-alias-topic',
        'http::GET::/module-direct-topic',
        'http::GET::/module-renamed-topic',
        // Class-body rebind of `AsyncClient` is a class attribute, not a
        // method-scope shadow — the legitimate httpx.AsyncClient call inside
        // the class must still emit.
        'http::GET::/class-body-rebind-ok',
      ];

      for (const contractId of expected) {
        const consumer = consumers.find((c) => c.contractId === contractId);
        expect(consumer).toBeDefined();
        expect(consumer?.meta.framework).toBe('python-httpx');
      }

      // Positive control: the legitimate `module_direct_client = AsyncClient(...)`
      // path was actually exercised, so the negative dotted-package assertions
      // below are not passing vacuously.
      expect(
        consumers.find((c) => c.contractId === 'http::GET::/module-direct-topic'),
      ).toBeDefined();

      expect(consumers.find((c) => c.contractId === 'http::GET::/nope')).toBeUndefined();
      expect(consumers.find((c) => c.contractId === 'http::POST::/nope')).toBeUndefined();
      expect(
        consumers.find((c) => c.contractId === 'http::GET::/ignored-same-name'),
      ).toBeUndefined();
      expect(
        consumers.find((c) => c.contractId === 'http::GET::/ignored-module-same-name'),
      ).toBeUndefined();
      // Finding 1: dotted-package look-alikes (`my_pkg.httpx`, three-segment
      // `a.b.c.httpx`, and relative `.httpx`) must not be detected.
      expect(
        consumers.find((c) => c.contractId === 'http::GET::/evil-module-dotted-fp'),
      ).toBeUndefined();
      expect(
        consumers.find((c) => c.contractId === 'http::GET::/evil-direct-dotted-fp'),
      ).toBeUndefined();
      expect(
        consumers.find((c) => c.contractId === 'http::GET::/deep-evil-module-dotted-fp'),
      ).toBeUndefined();
      expect(
        consumers.find((c) => c.contractId === 'http::GET::/deep-evil-direct-dotted-fp'),
      ).toBeUndefined();
      expect(
        consumers.find((c) => c.contractId === 'http::GET::/rel-evil-direct-fp'),
      ).toBeUndefined();
      // Finding 2: locally rebound imported aliases must not be detected.
      expect(
        consumers.find((c) => c.contractId === 'http::GET::/shadow-direct-fp'),
      ).toBeUndefined();
      expect(
        consumers.find((c) => c.contractId === 'http::GET::/shadow-module-fp'),
      ).toBeUndefined();
      expect(
        consumers.find((c) => c.contractId === 'http::GET::/shadow-direct-context-fp'),
      ).toBeUndefined();
      // Tuple/list destructuring rebinds must also shadow the alias.
      expect(consumers.find((c) => c.contractId === 'http::GET::/shadow-tuple-fp')).toBeUndefined();
      // Module-level rebind in a separate file must shadow the whole file.
      expect(
        consumers.find((c) => c.contractId === 'http::GET::/module-level-rebind-fp'),
      ).toBeUndefined();
    });

    // ─── Kotlin consumers (RestTemplate / WebClient short+long / OkHttp) ──
    // Same shape as the Java consumer test above, but parsed by the
    // tree-sitter-kotlin grammar via `KOTLIN_HTTP_PLUGIN`. Four
    // consumer flavors covered here: RestTemplate (#1855), WebClient
    // short form (#1855), OkHttp (#1855), and WebClient long form
    // (`webClient.method(HttpMethod.X).uri(...)`, this PR / #1884) —
    // see kotlin.ts file header for the full list.
    //
    // tree-sitter-kotlin is an optionalDependency. If the binding is
    // unavailable, `getPluginForFile` returns undefined for `.kt` and
    // we skip the suite (matches the gating on the Provider tests).
    const kotlinConsumerAvailable = getPluginForFile('Probe.kt') !== undefined;
    const itKotlinConsumer = kotlinConsumerAvailable ? it : it.skip;

    itKotlinConsumer('extracts Kotlin RestTemplate verbs', async () => {
      const dir = path.join(tmpDir, 'kotlin-rest-template');
      fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
      fs.writeFileSync(
        path.join(dir, 'src', 'ApiClient.kt'),
        `package com.example
import org.springframework.web.client.RestTemplate

class ApiClient(private val restTemplate: RestTemplate) {
  fun run() {
    restTemplate.getForObject("/api/users/1", User::class.java)
    restTemplate.getForEntity("/api/users/2", User::class.java)
    restTemplate.postForObject("/api/users", body, User::class.java)
    restTemplate.postForEntity("/api/users", body, User::class.java)
    restTemplate.put("/api/users/3", body)
    restTemplate.delete("/api/users/4")
    restTemplate.patchForObject("/api/users/5", body, User::class.java)
  }
}
`,
      );

      const contracts = await extractor.extract(null, dir, makeRepo(dir));
      const consumers = contracts.filter((c) => c.role === 'consumer');

      expect(consumers.find((c) => c.contractId === 'http::GET::/api/users/{param}')).toBeDefined();
      expect(consumers.find((c) => c.contractId === 'http::POST::/api/users')).toBeDefined();
      expect(consumers.find((c) => c.contractId === 'http::PUT::/api/users/{param}')).toBeDefined();
      expect(
        consumers.find((c) => c.contractId === 'http::DELETE::/api/users/{param}'),
      ).toBeDefined();
      expect(
        consumers.find((c) => c.contractId === 'http::PATCH::/api/users/{param}'),
      ).toBeDefined();

      // Framework label must be the same `spring-rest-template` used
      // by the Java plugin so polyglot repos coalesce on a single key.
      const restConsumers = consumers.filter((c) => c.meta.framework === 'spring-rest-template');
      expect(restConsumers.length).toBeGreaterThanOrEqual(5);
    });

    itKotlinConsumer('extracts Kotlin WebClient short-form verbs', async () => {
      const dir = path.join(tmpDir, 'kotlin-web-client-short');
      fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
      fs.writeFileSync(
        path.join(dir, 'src', 'OrderClient.kt'),
        `package com.example
import org.springframework.web.reactive.function.client.WebClient
import org.springframework.web.reactive.function.client.awaitBody
import org.springframework.web.reactive.function.client.awaitBodilessEntity

class OrderClient(private val webClient: WebClient) {
  suspend fun run() {
    val r1 = webClient.get().uri("/api/orders/1").retrieve().awaitBody<Order>()
    val r2 = webClient.post().uri("/api/orders").retrieve().awaitBody<Order>()
    val r3 = webClient.put().uri("/api/orders/2").retrieve().awaitBody<Order>()
    val r4 = webClient.delete().uri("/api/orders/3").retrieve().awaitBodilessEntity()
    val r5 = webClient.patch().uri("/api/orders/4").retrieve().awaitBody<Order>()
  }
}
`,
      );

      const contracts = await extractor.extract(null, dir, makeRepo(dir));
      const consumers = contracts.filter((c) => c.role === 'consumer');

      expect(
        consumers.find((c) => c.contractId === 'http::GET::/api/orders/{param}'),
      ).toBeDefined();
      expect(consumers.find((c) => c.contractId === 'http::POST::/api/orders')).toBeDefined();
      expect(
        consumers.find((c) => c.contractId === 'http::PUT::/api/orders/{param}'),
      ).toBeDefined();
      expect(
        consumers.find((c) => c.contractId === 'http::DELETE::/api/orders/{param}'),
      ).toBeDefined();
      expect(
        consumers.find((c) => c.contractId === 'http::PATCH::/api/orders/{param}'),
      ).toBeDefined();

      const wcConsumers = consumers.filter((c) => c.meta.framework === 'spring-web-client');
      expect(wcConsumers.length).toBeGreaterThanOrEqual(5);
    });

    itKotlinConsumer('extracts Kotlin OkHttp Request.Builder().url(...)', async () => {
      const dir = path.join(tmpDir, 'kotlin-okhttp');
      fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
      fs.writeFileSync(
        path.join(dir, 'src', 'OkClient.kt'),
        `package com.example
import okhttp3.OkHttpClient
import okhttp3.Request

class OkClient(private val client: OkHttpClient) {
  fun fetch() {
    val req = Request.Builder().url("/api/items").build()
    val resp = client.newCall(req).execute()
  }
}
`,
      );

      const contracts = await extractor.extract(null, dir, makeRepo(dir));
      const consumers = contracts.filter((c) => c.role === 'consumer');

      const okConsumer = consumers.find((c) => c.contractId === 'http::GET::/api/items');
      expect(okConsumer).toBeDefined();
      expect(okConsumer!.meta.framework).toBe('okhttp');
    });

    itKotlinConsumer(
      'Kotlin OkHttp .url("/x").post(body) infers POST — verb-walk parity with Java (#2268)',
      async () => {
        // OkHttp encodes the HTTP verb on a sibling call (`.post(body)` / `.delete()`
        // / `.method("X")`), not on `.url(...)`. The Kotlin plugin now WALKS the
        // builder chain (`inferKotlinOkHttpMethod`) to recover it — the mirror of
        // the Java side's `inferOkHttpMethod`. So `Request.Builder().url("/api/users")`
        // `.post(body).build()` emits `http::POST::/api/users` (not GET) on `.kt`,
        // identical to `.java` (checked by the Java conformance suite).
        const dir = path.join(tmpDir, 'kotlin-okhttp-post-chain');
        fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
        fs.writeFileSync(
          path.join(dir, 'src', 'OkPostClient.kt'),
          `package com.example
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody

class OkPostClient(private val client: OkHttpClient, private val body: RequestBody) {
  fun create() {
    val req = Request.Builder().url("/api/users").post(body).build()
    client.newCall(req).execute()
  }
}
`,
        );

        const contracts = await extractor.extract(null, dir, makeRepo(dir));
        const fromThisFile = contracts.filter(
          (c) => c.role === 'consumer' && c.symbolRef.filePath.endsWith('OkPostClient.kt'),
        );

        // The sibling `.post(body)` is recovered: exactly one POST consumer, no GET.
        expect(fromThisFile).toHaveLength(1);
        expect(fromThisFile[0].contractId).toBe('http::POST::/api/users');
        expect(fromThisFile[0].meta.method).toBe('POST');
        expect(fromThisFile.find((c) => c.contractId === 'http::GET::/api/users')).toBeUndefined();
      },
    );

    itKotlinConsumer(
      'Kotlin OkHttp verb-walk: helpers, .method("X"), default GET, variable skip (#2268)',
      async () => {
        // Parity with the Java OkHttp verb cases: a verb helper resolves, a literal
        // `.method("X")` resolves, a bare `.build()` defaults to GET, and a
        // variable-bound `.method(verb)` is unresolvable → emits nothing.
        const dir = path.join(tmpDir, 'kotlin-okhttp-verbs');
        fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
        fs.writeFileSync(
          path.join(dir, 'src', 'OkVerbs.kt'),
          `package com.example
import okhttp3.Request
import okhttp3.RequestBody

class OkVerbs(private val body: RequestBody, private val verb: String) {
  fun run() {
    Request.Builder().url("/api/k-get").build()
    Request.Builder().url("/api/k-delete").delete().build()
    Request.Builder().url("/api/k-patch").method("PATCH", body).build()
    Request.Builder().url("/api/k-named").method(method = "REPORT", body = body).build()
    Request.Builder().url("/api/k-dyn").method(verb, body).build()
  }
}
`,
        );

        const contracts = await extractor.extract(null, dir, makeRepo(dir));
        const okhttp = contracts.filter(
          (c) =>
            c.role === 'consumer' &&
            c.meta.framework === 'okhttp' &&
            c.symbolRef.filePath.endsWith('OkVerbs.kt'),
        );

        // The variable-bound `.method(verb)` (`/api/k-dyn`) emits nothing; the
        // named-argument `.method(method = "REPORT")` resolves its literal verb.
        expect(new Set(okhttp.map((c) => c.contractId))).toEqual(
          new Set([
            'http::GET::/api/k-get',
            'http::DELETE::/api/k-delete',
            'http::PATCH::/api/k-patch',
            'http::REPORT::/api/k-named',
          ]),
        );
      },
    );

    itKotlinConsumer(
      'Kotlin OkHttp: builder call before .url(), with anti-overreach (#2268)',
      async () => {
        // Parity with the Java OkHttp pre-`.url()` support: a builder call BEFORE
        // `.url()` is captured (the chain roots at Request.Builder), the verb-walk
        // scans the whole chain so a verb before `.url()` resolves, and a `.url(...)`
        // on an unrelated object does NOT emit.
        const dir = path.join(tmpDir, 'kotlin-okhttp-pre-url');
        fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
        fs.writeFileSync(
          path.join(dir, 'src', 'OkPreUrl.kt'),
          `package com.example
import okhttp3.Request
import okhttp3.RequestBody

class OkPreUrl(private val body: RequestBody, private val other: SomeClient) {
  fun run() {
    Request.Builder().addHeader("A", "b").url("/api/k-pre-url").build()
    Request.Builder().post(body).url("/api/k-verb-first").build()
    other.url("/api/k-not-okhttp").build()
  }
}
`,
        );

        const contracts = await extractor.extract(null, dir, makeRepo(dir));
        const okhttp = contracts.filter(
          (c) =>
            c.role === 'consumer' &&
            c.meta.framework === 'okhttp' &&
            c.symbolRef.filePath.endsWith('OkPreUrl.kt'),
        );

        // header-before-url → GET, verb-before-url → POST; `other.url(...)` emits nothing.
        expect(new Set(okhttp.map((c) => c.contractId))).toEqual(
          new Set(['http::GET::/api/k-pre-url', 'http::POST::/api/k-verb-first']),
        );
      },
    );

    itKotlinConsumer('extracts Kotlin WebClient long form GET', async () => {
      const dir = path.join(tmpDir, 'kotlin-web-client-long-get');
      fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
      fs.writeFileSync(
        path.join(dir, 'src', 'LongGetClient.kt'),
        `package com.example
import org.springframework.http.HttpMethod
import org.springframework.web.reactive.function.client.WebClient
import org.springframework.web.reactive.function.client.awaitBody

class LongGetClient(private val webClient: WebClient) {
  suspend fun run() {
    val r = webClient.method(HttpMethod.GET).uri("/api/users").retrieve().awaitBody<User>()
  }
}
`,
      );

      const contracts = await extractor.extract(null, dir, makeRepo(dir));
      const consumers = contracts.filter((c) => c.role === 'consumer');

      const route = consumers.find((c) => c.contractId === 'http::GET::/api/users');
      expect(route).toBeDefined();
      expect(route!.meta.framework).toBe('spring-web-client');
    });

    itKotlinConsumer('extracts Kotlin WebClient long form POST/PUT/DELETE/PATCH', async () => {
      const dir = path.join(tmpDir, 'kotlin-web-client-long-verbs');
      fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
      fs.writeFileSync(
        path.join(dir, 'src', 'LongVerbClient.kt'),
        `package com.example
import org.springframework.http.HttpMethod
import org.springframework.web.reactive.function.client.WebClient
import org.springframework.web.reactive.function.client.awaitBody
import org.springframework.web.reactive.function.client.awaitBodilessEntity

class LongVerbClient(private val webClient: WebClient) {
  suspend fun run() {
    webClient.method(HttpMethod.POST).uri("/api/orders").retrieve().awaitBody<Order>()
    webClient.method(HttpMethod.PUT).uri("/api/orders/1").retrieve().awaitBody<Order>()
    webClient.method(HttpMethod.DELETE).uri("/api/orders/2").retrieve().awaitBodilessEntity()
    webClient.method(HttpMethod.PATCH).uri("/api/orders/3").retrieve().awaitBody<Order>()
  }
}
`,
      );

      const contracts = await extractor.extract(null, dir, makeRepo(dir));
      const consumers = contracts.filter((c) => c.role === 'consumer');

      expect(consumers.find((c) => c.contractId === 'http::POST::/api/orders')).toBeDefined();
      expect(
        consumers.find((c) => c.contractId === 'http::PUT::/api/orders/{param}'),
      ).toBeDefined();
      expect(
        consumers.find((c) => c.contractId === 'http::DELETE::/api/orders/{param}'),
      ).toBeDefined();
      expect(
        consumers.find((c) => c.contractId === 'http::PATCH::/api/orders/{param}'),
      ).toBeDefined();

      // All four should be tagged as `spring-web-client` so polyglot
      // repos coalesce on the same framework key as the short form.
      // The fixture is fully deterministic — exactly 4 long-form calls,
      // no short-form / RestTemplate / OkHttp calls mixed in — so an
      // exact count is meaningful (DoD §2.7). If a future change
      // accidentally emits a 5th consumer (e.g. duplicate query firing,
      // or a regressed receiver constraint matching unrelated calls),
      // this assertion catches it.
      const wcConsumers = consumers.filter((c) => c.meta.framework === 'spring-web-client');
      expect(wcConsumers).toHaveLength(4);
    });

    itKotlinConsumer(
      'short-form query does NOT also fire on Kotlin WebClient long form (no double-emit)',
      async () => {
        // The long-form query handles `webClient.method(HttpMethod.X).uri(...)`,
        // and the short-form query handles `webClient.get().uri(...)`. Both
        // queries carry sibling `(navigation_suffix (simple_identifier) @verb)`
        // constraints — short form requires the verb name itself
        // (`get`/`post`/...), long form requires the literal name
        // `method`. The two are disjoint.
        //
        // This test pins that disjointness: a single `.method(HttpMethod.GET)`
        // call must emit ONE consumer, not two (one from each query).
        const dir = path.join(tmpDir, 'kotlin-web-client-long-no-double');
        fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
        fs.writeFileSync(
          path.join(dir, 'src', 'NoDoubleClient.kt'),
          `package com.example
import org.springframework.http.HttpMethod
import org.springframework.web.reactive.function.client.WebClient
import org.springframework.web.reactive.function.client.awaitBody

class NoDoubleClient(private val webClient: WebClient) {
  suspend fun run() {
    webClient.method(HttpMethod.GET).uri("/api/single").retrieve().awaitBody<String>()
  }
}
`,
        );

        const contracts = await extractor.extract(null, dir, makeRepo(dir));
        const consumers = contracts.filter((c) => c.role === 'consumer');

        const fromThisFile = consumers.filter((c) =>
          c.symbolRef.filePath.endsWith('NoDoubleClient.kt'),
        );
        expect(fromThisFile).toHaveLength(1);
        expect(fromThisFile[0].contractId).toBe('http::GET::/api/single');
      },
    );

    itKotlinConsumer(
      'does NOT match Kotlin WebClient long form with variable-bound verb',
      async () => {
        // Anti-overreach: source-scan can't follow `val verb = HttpMethod.X`
        // back to the literal — that's a graph-aware concern. The long-form
        // query requires `(navigation_expression HttpMethod . verb)` as the
        // `value_argument` shape, so a bare `simple_identifier` (the
        // variable name) fails to match. Pin this so a future relaxation
        // of the value_argument shape cannot silently start guessing the
        // verb from arbitrary identifiers.
        const dir = path.join(tmpDir, 'kotlin-web-client-long-var-verb');
        fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
        fs.writeFileSync(
          path.join(dir, 'src', 'VariableVerbClient.kt'),
          `package com.example
import org.springframework.http.HttpMethod
import org.springframework.web.reactive.function.client.WebClient
import org.springframework.web.reactive.function.client.awaitBody

class VariableVerbClient(private val webClient: WebClient) {
  suspend fun run() {
    val verb = HttpMethod.PATCH
    val r = webClient.method(verb).uri("/api/dynamic").retrieve().awaitBody<String>()
  }
}
`,
        );

        const contracts = await extractor.extract(null, dir, makeRepo(dir));
        const consumers = contracts.filter((c) => c.role === 'consumer');

        const fromThisFile = consumers.filter((c) =>
          c.symbolRef.filePath.endsWith('VariableVerbClient.kt'),
        );
        expect(fromThisFile).toHaveLength(0);
      },
    );

    itKotlinConsumer(
      'does NOT pick up unrelated string-literal calls on a non-restTemplate receiver',
      async () => {
        // Anti-regression: the RestTemplate receiver constraint
        // (#eq? @obj "restTemplate") must hold. A field with a
        // different conventional name (e.g. `cacheClient`) calling
        // `.getForObject("/x", ...)` should NOT produce a route.
        const dir = path.join(tmpDir, 'kotlin-rest-template-other-receiver');
        fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
        fs.writeFileSync(
          path.join(dir, 'src', 'CacheClient.kt'),
          `package com.example

class CacheClient(private val cacheClient: SomeCache) {
  fun run() {
    cacheClient.getForObject("/cache/key", String::class.java)
  }
}
`,
        );

        const contracts = await extractor.extract(null, dir, makeRepo(dir));
        const consumers = contracts.filter((c) => c.role === 'consumer');

        expect(consumers.find((c) => c.contractId === 'http::GET::/cache/key')).toBeUndefined();
        const fromCache = consumers.filter((c) => c.symbolRef.filePath.endsWith('CacheClient.kt'));
        expect(fromCache).toHaveLength(0);
      },
    );

    // ─── Kotlin OpenFeign + Spring HTTP Interface consumers ──────────────
    // `@FeignClient` interfaces (Spring MVC `@*Mapping` methods) and Spring 6
    // declarative HTTP Interfaces (`@(Get|...)Exchange`) are the dominant
    // outbound-call patterns in Kotlin+Spring services. In tree-sitter-kotlin
    // an `interface` is a `class_declaration`, so without a `@FeignClient`
    // gate the `@*Mapping` methods would mis-classify as providers.
    itKotlinConsumer(
      'extracts Kotlin @FeignClient methods as consumers, not providers',
      async () => {
        const dir = path.join(tmpDir, 'kotlin-feign-consumer');
        fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
        fs.writeFileSync(
          path.join(dir, 'src', 'InventoryClient.kt'),
          `package com.example
import org.springframework.cloud.openfeign.FeignClient
import org.springframework.web.bind.annotation.GetMapping
import org.springframework.web.bind.annotation.PostMapping

@FeignClient(name = "inventory-service", configuration = [InventoryFeignClientConfig::class])
interface InventoryClient {
    @GetMapping("items/{itemId}", consumes = [MediaType.APPLICATION_JSON_VALUE], produces = [MediaType.APPLICATION_JSON_VALUE])
    fun getItem(@PathVariable("itemId") itemId: Int): ItemDto

    @PostMapping("items/search", consumes = [MediaType.APPLICATION_JSON_VALUE])
    fun getItems(@RequestBody query: ItemFilter): Page<ItemDto>
}
`,
        );

        const contracts = await extractor.extract(null, dir, makeRepo(dir));
        const consumers = contracts.filter((c) => c.role === 'consumer');
        const providers = contracts.filter((c) => c.role === 'provider');

        expect(
          consumers.find(
            (c) =>
              c.contractId === 'http::GET::/items/{param}' &&
              c.meta.framework === 'openfeign' &&
              c.confidence === 0.7,
          ),
        ).toBeDefined();
        expect(consumers.find((c) => c.contractId === 'http::POST::/items/search')).toBeDefined();
        // The Feign interface methods must NOT leak into providers.
        expect(
          providers.find((c) => c.symbolRef.filePath.endsWith('InventoryClient.kt')),
        ).toBeUndefined();
      },
    );

    itKotlinConsumer('applies @FeignClient(path) and @RequestMapping prefixes', async () => {
      // One interface per file — the real-world layout (e.g. InventoryClient.kt).
      const dir = path.join(tmpDir, 'kotlin-feign-prefix');
      fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
      fs.writeFileSync(
        path.join(dir, 'src', 'PrecedenceClient.kt'),
        `package com.example
import org.springframework.cloud.openfeign.FeignClient
import org.springframework.web.bind.annotation.GetMapping
import org.springframework.web.bind.annotation.RequestMapping

@FeignClient(name = "a", path = "/feign-path")
@RequestMapping("/rm-path")
interface PrecedenceClient {
    @GetMapping("/orders")
    fun getOrders(): Any
}
`,
      );
      fs.writeFileSync(
        path.join(dir, 'src', 'InventoryClient.kt'),
        `package com.example
import org.springframework.cloud.openfeign.FeignClient
import org.springframework.web.bind.annotation.GetMapping
import org.springframework.web.bind.annotation.RequestMapping

@FeignClient(name = "b")
@RequestMapping(path = "/api")
interface InventoryClient {
    @GetMapping("/inventory/{id}")
    fun getInventory(id: String): Any
}
`,
      );

      const contracts = await extractor.extract(null, dir, makeRepo(dir));
      const consumers = contracts.filter((c) => c.role === 'consumer');

      // @FeignClient(path) wins over @RequestMapping.
      expect(consumers.find((c) => c.contractId === 'http::GET::/feign-path/orders')).toBeDefined();
      expect(consumers.find((c) => c.contractId === 'http::GET::/rm-path/orders')).toBeUndefined();
      // @RequestMapping is the fallback prefix when there is no @FeignClient(path).
      expect(
        consumers.find((c) => c.contractId === 'http::GET::/api/inventory/{param}'),
      ).toBeDefined();
    });

    itKotlinConsumer(
      'extracts Kotlin Spring HTTP Interface @(Get|...)Exchange consumers',
      async () => {
        const dir = path.join(tmpDir, 'kotlin-http-exchange');
        fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
        fs.writeFileSync(
          path.join(dir, 'src', 'InventoryApi.kt'),
          `package com.example
import org.springframework.web.service.annotation.GetExchange
import org.springframework.web.service.annotation.PostExchange
import org.springframework.web.service.annotation.PutExchange
import org.springframework.web.service.annotation.PatchExchange
import org.springframework.web.service.annotation.DeleteExchange

interface InventoryApi {
    @GetExchange(url = "/items/{itemId}", accept = [MediaType.APPLICATION_JSON_VALUE])
    fun obtainItem(@PathVariable itemId: Int): Any

    @PostExchange(url = "/items/search")
    fun search(): Any

    @PutExchange(url = "/items")
    fun create(): Any

    @PatchExchange(url = "/items/update/{itemId}")
    fun update(@PathVariable itemId: Int): Any

    @DeleteExchange(url = "/items/{itemId}")
    fun remove(@PathVariable itemId: Int): Any
}
`,
        );

        const contracts = await extractor.extract(null, dir, makeRepo(dir));
        const consumers = contracts.filter((c) => c.role === 'consumer');
        const providers = contracts.filter((c) => c.role === 'provider');

        expect(
          consumers.find(
            (c) =>
              c.contractId === 'http::GET::/items/{param}' &&
              c.meta.framework === 'spring-http-interface' &&
              c.confidence === 0.75,
          ),
        ).toBeDefined();
        expect(consumers.find((c) => c.contractId === 'http::POST::/items/search')).toBeDefined();
        expect(consumers.find((c) => c.contractId === 'http::PUT::/items')).toBeDefined();
        expect(
          consumers.find((c) => c.contractId === 'http::PATCH::/items/update/{param}'),
        ).toBeDefined();
        expect(
          consumers.find((c) => c.contractId === 'http::DELETE::/items/{param}'),
        ).toBeDefined();
        // Declarative HTTP-interface methods are consumers, never providers.
        expect(
          providers.find((c) => c.symbolRef.filePath.endsWith('InventoryApi.kt')),
        ).toBeUndefined();
      },
    );

    itKotlinConsumer(
      'applies class-level @HttpExchange(url) prefix and a positional @GetExchange',
      async () => {
        const dir = path.join(tmpDir, 'kotlin-http-exchange-prefix');
        fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
        fs.writeFileSync(
          path.join(dir, 'src', 'ProductApi.kt'),
          `package com.example
import org.springframework.web.service.annotation.HttpExchange
import org.springframework.web.service.annotation.GetExchange

@HttpExchange(url = "/products")
interface ProductApi {
    @GetExchange("/{id}")
    fun get(@PathVariable id: Int): Any
}
`,
        );

        const contracts = await extractor.extract(null, dir, makeRepo(dir));
        const consumers = contracts.filter((c) => c.role === 'consumer');

        expect(
          consumers.find(
            (c) =>
              c.contractId === 'http::GET::/products/{param}' &&
              c.meta.framework === 'spring-http-interface',
          ),
        ).toBeDefined();
      },
    );

    itKotlinConsumer('extracts Kotlin OpenFeign native @RequestLine consumers', async () => {
      const dir = path.join(tmpDir, 'kotlin-feign-request-line');
      fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
      fs.writeFileSync(
        path.join(dir, 'src', 'AiClient.kt'),
        `package com.example
import org.springframework.cloud.openfeign.FeignClient
import feign.RequestLine

@FeignClient(name = "ai-backend")
interface AiClient {
    @RequestLine("POST /ai/summarize")
    fun summarize(): String

    @RequestLine("GET /ai/health")
    fun health(): String
}
`,
      );

      const contracts = await extractor.extract(null, dir, makeRepo(dir));
      const consumers = contracts.filter((c) => c.role === 'consumer');

      expect(
        consumers.find(
          (c) =>
            c.contractId === 'http::POST::/ai/summarize' &&
            c.meta.framework === 'openfeign' &&
            c.confidence === 0.75,
        ),
      ).toBeDefined();
      expect(consumers.find((c) => c.contractId === 'http::GET::/ai/health')).toBeDefined();
    });

    itKotlinConsumer(
      'applies the @RequestMapping interface prefix to @RequestLine consumers (no @FeignClient path) — #2254 P2 parity',
      async () => {
        // Parity with java.ts, which merges the @RequestMapping prefix into
        // feignPrefixByInterfaceId: an interface with @RequestMapping("/orders")
        // and a @RequestLine method (no @FeignClient(path)) must apply the prefix.
        // Kotlin previously dropped it (PR #2254 tri-review, kotlin.ts:978).
        const dir = path.join(tmpDir, 'kotlin-request-line-rm-prefix');
        fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
        fs.writeFileSync(
          path.join(dir, 'src', 'OrderClient.kt'),
          `package com.example
import org.springframework.cloud.openfeign.FeignClient
import org.springframework.web.bind.annotation.RequestMapping
import feign.RequestLine

@FeignClient(name = "order-service")
@RequestMapping("/orders")
interface OrderClient {
    @RequestLine("GET /{id}")
    fun get(id: String): Any
}
`,
        );

        const contracts = await extractor.extract(null, dir, makeRepo(dir));
        const consumers = contracts.filter((c) => c.role === 'consumer');

        expect(
          consumers.find(
            (c) =>
              c.contractId === 'http::GET::/orders/{param}' &&
              c.meta.framework === 'openfeign' &&
              c.confidence === 0.75,
          ),
        ).toBeDefined();
        // The un-prefixed form must NOT be emitted (the prefix was applied).
        expect(consumers.find((c) => c.contractId === 'http::GET::/{param}')).toBeUndefined();
      },
    );

    itKotlinConsumer(
      'prefers @FeignClient(path) over @RequestMapping for @RequestLine consumers',
      async () => {
        const dir = path.join(tmpDir, 'kotlin-request-line-feign-path-wins');
        fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
        fs.writeFileSync(
          path.join(dir, 'src', 'OrderClient.kt'),
          `package com.example
import org.springframework.cloud.openfeign.FeignClient
import org.springframework.web.bind.annotation.RequestMapping
import feign.RequestLine

@FeignClient(name = "order-service", path = "/feign-path")
@RequestMapping("/rm-path")
interface OrderClient {
    @RequestLine("GET /orders/{id}")
    fun get(id: String): Any
}
`,
        );

        const contracts = await extractor.extract(null, dir, makeRepo(dir));
        const consumers = contracts.filter((c) => c.role === 'consumer');

        // @FeignClient(path) wins over @RequestMapping (parity with the @GetMapping path).
        expect(
          consumers.find((c) => c.contractId === 'http::GET::/feign-path/orders/{param}'),
        ).toBeDefined();
        expect(
          consumers.find((c) => c.contractId === 'http::GET::/rm-path/orders/{param}'),
        ).toBeUndefined();
      },
    );

    itKotlinConsumer(
      'extracts Kotlin @RequestLine written with the named "value" argument (#2254 P2)',
      async () => {
        const dir = path.join(tmpDir, 'kotlin-request-line-named-value');
        fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
        fs.writeFileSync(
          path.join(dir, 'src', 'AiClient.kt'),
          `package com.example
import org.springframework.cloud.openfeign.FeignClient
import feign.RequestLine

@FeignClient(name = "ai-backend")
interface AiClient {
    @RequestLine(value = "POST /create")
    fun create(): String
}
`,
        );

        const contracts = await extractor.extract(null, dir, makeRepo(dir));
        const consumers = contracts.filter((c) => c.role === 'consumer');

        expect(
          consumers.find(
            (c) =>
              c.contractId === 'http::POST::/create' &&
              c.meta.framework === 'openfeign' &&
              c.confidence === 0.75,
          ),
        ).toBeDefined();
      },
    );

    itKotlinConsumer(
      'ignores Kotlin @RequestLine whose named argument is not "value"',
      async () => {
        const dir = path.join(tmpDir, 'kotlin-request-line-non-value-key');
        fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
        fs.writeFileSync(
          path.join(dir, 'src', 'AiClient.kt'),
          `package com.example
import org.springframework.cloud.openfeign.FeignClient
import feign.RequestLine

@FeignClient(name = "ai-backend")
interface AiClient {
    @RequestLine(name = "GET /should-not-extract")
    fun nope(): String
}
`,
        );

        const contracts = await extractor.extract(null, dir, makeRepo(dir));
        const consumers = contracts.filter((c) => c.role === 'consumer');

        expect(
          consumers.find((c) => c.contractId === 'http::GET::/should-not-extract'),
        ).toBeUndefined();
      },
    );

    itKotlinConsumer(
      'strips query strings from Kotlin @RequestLine values when forming contract IDs',
      async () => {
        const dir = path.join(tmpDir, 'kotlin-request-line-query');
        fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
        fs.writeFileSync(
          path.join(dir, 'src', 'SearchClient.kt'),
          `package com.example
import org.springframework.cloud.openfeign.FeignClient
import feign.RequestLine

@FeignClient(name = "search-service")
interface SearchClient {
    @RequestLine("GET /search?q={query}&limit={limit}")
    fun search(): Any
}
`,
        );

        const contracts = await extractor.extract(null, dir, makeRepo(dir));
        const consumers = contracts.filter((c) => c.role === 'consumer');

        expect(consumers.find((c) => c.contractId === 'http::GET::/search')).toBeDefined();
        expect(
          consumers.find((c) => c.contractId.includes('?') || c.contractId.includes('limit')),
        ).toBeUndefined();
      },
    );

    itKotlinConsumer(
      'mixes Kotlin @RequestLine and @GetMapping methods on the same @FeignClient interface',
      async () => {
        const dir = path.join(tmpDir, 'kotlin-feign-mixed-annotations');
        fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
        fs.writeFileSync(
          path.join(dir, 'src', 'MixedClient.kt'),
          `package com.example
import org.springframework.cloud.openfeign.FeignClient
import org.springframework.web.bind.annotation.GetMapping
import feign.RequestLine

@FeignClient(name = "mixed-service", path = "/api")
interface MixedClient {
    @GetMapping("/spring-style")
    fun springStyle(): String

    @RequestLine("GET /native-style")
    fun nativeStyle(): String
}
`,
        );

        const contracts = await extractor.extract(null, dir, makeRepo(dir));
        const consumers = contracts.filter((c) => c.role === 'consumer');

        // @GetMapping → @FeignClient(path) prefix; confidence 0.7.
        expect(
          consumers.find(
            (c) =>
              c.contractId === 'http::GET::/api/spring-style' &&
              c.meta.framework === 'openfeign' &&
              c.confidence === 0.7,
          ),
        ).toBeDefined();
        // @RequestLine → @FeignClient(path) prefix; confidence 0.75.
        expect(
          consumers.find(
            (c) =>
              c.contractId === 'http::GET::/api/native-style' &&
              c.meta.framework === 'openfeign' &&
              c.confidence === 0.75,
          ),
        ).toBeDefined();
      },
    );

    itKotlinConsumer(
      'ignores Kotlin @RequestLine values that are not a "VERB /path" line',
      async () => {
        const dir = path.join(tmpDir, 'kotlin-request-line-malformed');
        fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
        fs.writeFileSync(
          path.join(dir, 'src', 'MalformedClient.kt'),
          `package com.example
import feign.RequestLine

interface MalformedClient {
    @RequestLine("not a request line at all")
    fun noVerb(): String

    @RequestLine("GET relative/no/leading/slash")
    fun noLeadingSlash(): String

    @RequestLine("FETCH /unknown-verb")
    fun unknownVerb(): String
}
`,
        );

        const contracts = await extractor.extract(null, dir, makeRepo(dir));
        const consumers = contracts.filter((c) => c.role === 'consumer');

        expect(
          consumers.filter((c) => c.symbolRef.filePath.endsWith('MalformedClient.kt')),
        ).toHaveLength(0);
      },
    );

    itKotlinConsumer(
      'prefers @FeignClient(path) over @RequestMapping when @RequestMapping appears first (Kotlin)',
      async () => {
        // Source-order independence twin: @FeignClient(path) wins even when
        // @RequestMapping is the first annotation.
        const dir = path.join(tmpDir, 'kotlin-feign-prefix-precedence-reversed');
        fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
        fs.writeFileSync(
          path.join(dir, 'src', 'ReversedClient.kt'),
          `package com.example
import org.springframework.cloud.openfeign.FeignClient
import org.springframework.web.bind.annotation.GetMapping
import org.springframework.web.bind.annotation.RequestMapping

@RequestMapping("/rm-path")
@FeignClient(name = "order-service", path = "/feign-path")
interface ReversedClient {
    @GetMapping("/orders")
    fun getOrders(): Any
}
`,
        );

        const contracts = await extractor.extract(null, dir, makeRepo(dir));
        const consumers = contracts.filter((c) => c.role === 'consumer');

        expect(
          consumers.find((c) => c.contractId === 'http::GET::/feign-path/orders'),
        ).toBeDefined();
        expect(
          consumers.find((c) => c.contractId === 'http::GET::/rm-path/orders'),
        ).toBeUndefined();
      },
    );

    itKotlinConsumer(
      'classifies a @RestController class as provider and a @FeignClient interface as consumer',
      async () => {
        const dir = path.join(tmpDir, 'kotlin-controller-vs-feign');
        fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
        fs.writeFileSync(
          path.join(dir, 'src', 'Mixed.kt'),
          `package com.example
import org.springframework.web.bind.annotation.RestController
import org.springframework.web.bind.annotation.GetMapping
import org.springframework.cloud.openfeign.FeignClient

@RestController
class OrdersController {
    @GetMapping("/orders/{id}")
    fun getOrder(@PathVariable id: Int): Any = TODO()
}

@FeignClient(name = "pricing")
interface PricingClient {
    @GetMapping("/prices/{id}")
    fun getPrice(id: Int): Any
}
`,
        );

        const contracts = await extractor.extract(null, dir, makeRepo(dir));
        const providers = contracts.filter((c) => c.role === 'provider');
        const consumers = contracts.filter((c) => c.role === 'consumer');

        // Controller method → provider (not a consumer).
        expect(
          providers.find(
            (c) => c.contractId === 'http::GET::/orders/{param}' && c.meta.framework === 'spring',
          ),
        ).toBeDefined();
        expect(
          consumers.find((c) => c.contractId === 'http::GET::/orders/{param}'),
        ).toBeUndefined();
        // Feign interface method → consumer (not a provider).
        expect(
          consumers.find(
            (c) =>
              c.contractId === 'http::GET::/prices/{param}' && c.meta.framework === 'openfeign',
          ),
        ).toBeDefined();
        expect(
          providers.find((c) => c.contractId === 'http::GET::/prices/{param}'),
        ).toBeUndefined();
      },
    );

    itKotlinConsumer(
      'emits a provider for a class implementing a route interface (interface-based controller)',
      async () => {
        // One interface per file (real layout). Routes live on the interface; the
        // @RestController override carries none → inherited via projectScan.
        const dir = path.join(tmpDir, 'kotlin-interface-based-controller');
        fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
        fs.writeFileSync(
          path.join(dir, 'src', 'WarehouseApi.kt'),
          `package com.example
import org.springframework.web.bind.annotation.RequestMapping
import org.springframework.web.bind.annotation.GetMapping

@RequestMapping("/warehouses")
interface WarehouseApi {
    @GetMapping("/{id}/stock")
    fun listStock(id: String): Any
}
`,
        );
        fs.writeFileSync(
          path.join(dir, 'src', 'WarehouseController.kt'),
          `package com.example
import org.springframework.web.bind.annotation.RestController

@RestController
class WarehouseController(private val svc: Svc) : WarehouseApi {
    override fun listStock(id: String): Any = TODO()
}
`,
        );

        const contracts = await extractor.extract(null, dir, makeRepo(dir));
        const providers = contracts.filter((c) => c.role === 'provider');

        // The controller inherits the route declared on WarehouseApi → provider.
        expect(
          providers.find(
            (c) =>
              c.contractId === 'http::GET::/warehouses/{param}/stock' &&
              c.symbolRef.filePath.endsWith('WarehouseController.kt') &&
              c.meta.framework === 'spring' &&
              c.confidence === 0.8,
          ),
        ).toBeDefined();
      },
    );

    itKotlinConsumer(
      'recognises a fully-qualified @org…RestController as a controller (#2254 FQN parity)',
      async () => {
        // A FQN annotation parses to a user_type with one type_identifier per
        // segment; the controller gate must read the trailing segment, not "org".
        const dir = path.join(tmpDir, 'kotlin-fqn-controller');
        fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
        fs.writeFileSync(
          path.join(dir, 'src', 'WarehouseApi.kt'),
          `package com.example
import org.springframework.web.bind.annotation.RequestMapping
import org.springframework.web.bind.annotation.GetMapping

@RequestMapping("/warehouses")
interface WarehouseApi {
    @GetMapping("/{id}/stock")
    fun listStock(id: String): Any
}
`,
        );
        fs.writeFileSync(
          path.join(dir, 'src', 'WarehouseController.kt'),
          `package com.example

@org.springframework.web.bind.annotation.RestController
class WarehouseController(private val svc: Svc) : WarehouseApi {
    override fun listStock(id: String): Any = TODO()
}
`,
        );

        const contracts = await extractor.extract(null, dir, makeRepo(dir));
        const providers = contracts.filter((c) => c.role === 'provider');

        expect(
          providers.find(
            (c) =>
              c.contractId === 'http::GET::/warehouses/{param}/stock' &&
              c.symbolRef.filePath.endsWith('WarehouseController.kt'),
          ),
        ).toBeDefined();
      },
    );

    itKotlinConsumer(
      'resolves a fully-qualified supertype to its trailing segment for interface inheritance',
      async () => {
        // `: com.example.WarehouseApi` must resolve to "WarehouseApi" (trailing
        // segment), not "com", so the inherited interface route is matched.
        const dir = path.join(tmpDir, 'kotlin-fqn-supertype');
        fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
        fs.writeFileSync(
          path.join(dir, 'src', 'WarehouseApi.kt'),
          `package com.example
import org.springframework.web.bind.annotation.RequestMapping
import org.springframework.web.bind.annotation.GetMapping

@RequestMapping("/warehouses")
interface WarehouseApi {
    @GetMapping("/{id}/stock")
    fun listStock(id: String): Any
}
`,
        );
        fs.writeFileSync(
          path.join(dir, 'src', 'WarehouseController.kt'),
          `package com.example
import org.springframework.web.bind.annotation.RestController

@RestController
class WarehouseController(private val svc: Svc) : com.example.WarehouseApi {
    override fun listStock(id: String): Any = TODO()
}
`,
        );

        const contracts = await extractor.extract(null, dir, makeRepo(dir));
        const providers = contracts.filter((c) => c.role === 'provider');

        expect(
          providers.find(
            (c) =>
              c.contractId === 'http::GET::/warehouses/{param}/stock' &&
              c.symbolRef.filePath.endsWith('WarehouseController.kt'),
          ),
        ).toBeDefined();
      },
    );

    itKotlinConsumer(
      'a @FeignClient API interface implemented by a controller yields both a consumer and a provider',
      async () => {
        // catalog-service pattern: an `api` module publishes a @FeignClient contract that
        // the service's own @RestController implements. The interface is the
        // client SDK (consumer); the implementing controller is the provider.
        const dir = path.join(tmpDir, 'kotlin-feign-api-implemented');
        fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
        fs.writeFileSync(
          path.join(dir, 'src', 'WarehouseApi.kt'),
          `package com.example
import org.springframework.cloud.openfeign.FeignClient
import org.springframework.web.bind.annotation.RequestMapping
import org.springframework.web.bind.annotation.GetMapping

@FeignClient(name = "catalog-service")
@RequestMapping("/warehouses")
interface WarehouseApi {
    @GetMapping("/{id}/stock")
    fun listStock(id: String): Any
}
`,
        );
        fs.writeFileSync(
          path.join(dir, 'src', 'WarehouseController.kt'),
          `package com.example
import org.springframework.web.bind.annotation.RestController

@RestController
class WarehouseController(private val svc: Svc) : WarehouseApi {
    override fun listStock(id: String): Any = TODO()
}
`,
        );

        const contracts = await extractor.extract(null, dir, makeRepo(dir));
        const providers = contracts.filter((c) => c.role === 'provider');
        const consumers = contracts.filter((c) => c.role === 'consumer');

        // Interface (published @FeignClient client SDK) → consumer.
        expect(
          consumers.find(
            (c) =>
              c.contractId === 'http::GET::/warehouses/{param}/stock' &&
              c.meta.framework === 'openfeign',
          ),
        ).toBeDefined();
        // Implementing @RestController → provider (route inherited from the interface).
        expect(
          providers.find(
            (c) =>
              c.contractId === 'http::GET::/warehouses/{param}/stock' &&
              c.symbolRef.filePath.endsWith('WarehouseController.kt'),
          ),
        ).toBeDefined();
      },
    );

    itKotlinConsumer(
      'handles Kotlin array-form paths (["/x"], value = ["/x"]) for providers and consumers',
      async () => {
        // Spring path/value attributes are Array<String>; the array literal form
        // is common in Kotlin. Each route-bearing annotation must accept both a
        // bare string and a single-element array (collection_literal).
        const dir = path.join(tmpDir, 'kotlin-array-paths');
        fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
        // Provider: array class prefix + array method path.
        fs.writeFileSync(
          path.join(dir, 'src', 'ProductsController.kt'),
          `package com.example
import org.springframework.web.bind.annotation.RestController
import org.springframework.web.bind.annotation.RequestMapping
import org.springframework.web.bind.annotation.GetMapping

@RestController
@RequestMapping(["/api/products"])
class ProductsController {
    @GetMapping(value = ["/{id}"])
    fun get(id: Int): Any = TODO()
}
`,
        );
        // OpenFeign consumer: positional array path.
        fs.writeFileSync(
          path.join(dir, 'src', 'OrdersClient.kt'),
          `package com.example
import org.springframework.cloud.openfeign.FeignClient
import org.springframework.web.bind.annotation.PostMapping

@FeignClient(name = "orders")
interface OrdersClient {
    @PostMapping(["/orders/search"])
    fun search(): Any
}
`,
        );
        // Spring HTTP Interface consumer: named array url.
        fs.writeFileSync(
          path.join(dir, 'src', 'PricingApi.kt'),
          `package com.example
import org.springframework.web.service.annotation.GetExchange

interface PricingApi {
    @GetExchange(url = ["/pricing/{id}"])
    fun price(id: Int): Any
}
`,
        );

        const contracts = await extractor.extract(null, dir, makeRepo(dir));
        const providers = contracts.filter((c) => c.role === 'provider');
        const consumers = contracts.filter((c) => c.role === 'consumer');

        // Array class prefix + array method path → provider.
        expect(
          providers.find((c) => c.contractId === 'http::GET::/api/products/{param}'),
        ).toBeDefined();
        // @FeignClient positional array path → consumer.
        expect(
          consumers.find(
            (c) =>
              c.contractId === 'http::POST::/orders/search' && c.meta.framework === 'openfeign',
          ),
        ).toBeDefined();
        // @GetExchange(url = [...]) array → consumer.
        expect(
          consumers.find(
            (c) =>
              c.contractId === 'http::GET::/pricing/{param}' &&
              c.meta.framework === 'spring-http-interface',
          ),
        ).toBeDefined();
      },
    );

    itKotlinConsumer(
      'handles Kotlin arrayOf("/x") annotation arrays across families (#2254 P3)',
      async () => {
        // arrayOf(...) is the explicit (older) form of a Kotlin String[] arg,
        // distinct from the ["/x"] collection_literal. Each route-bearing
        // annotation must accept it, positional and named, in all families.
        const dir = path.join(tmpDir, 'kotlin-array-of');
        fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
        // Provider: positional arrayOf class prefix + named arrayOf method path.
        fs.writeFileSync(
          path.join(dir, 'src', 'ProductsController.kt'),
          `package com.example
import org.springframework.web.bind.annotation.RestController
import org.springframework.web.bind.annotation.RequestMapping
import org.springframework.web.bind.annotation.GetMapping

@RestController
@RequestMapping(arrayOf("/api/products"))
class ProductsController {
    @GetMapping(value = arrayOf("/{id}"))
    fun get(id: Int): Any = TODO()
}
`,
        );
        // OpenFeign consumer: named arrayOf path prefix.
        fs.writeFileSync(
          path.join(dir, 'src', 'OrdersClient.kt'),
          `package com.example
import org.springframework.cloud.openfeign.FeignClient
import org.springframework.web.bind.annotation.PostMapping

@FeignClient(name = "orders", path = arrayOf("/feign"))
interface OrdersClient {
    @PostMapping(arrayOf("/orders/search"))
    fun search(): Any
}
`,
        );
        // Spring HTTP Interface consumer: positional arrayOf class prefix + named arrayOf url.
        fs.writeFileSync(
          path.join(dir, 'src', 'PricingApi.kt'),
          `package com.example
import org.springframework.web.service.annotation.HttpExchange
import org.springframework.web.service.annotation.GetExchange

@HttpExchange(arrayOf("/pricing"))
interface PricingApi {
    @GetExchange(url = arrayOf("/{id}"))
    fun price(id: Int): Any
}
`,
        );

        const contracts = await extractor.extract(null, dir, makeRepo(dir));
        const providers = contracts.filter((c) => c.role === 'provider');
        const consumers = contracts.filter((c) => c.role === 'consumer');

        // class @RequestMapping(arrayOf) + method @GetMapping(value = arrayOf) → provider.
        expect(
          providers.find((c) => c.contractId === 'http::GET::/api/products/{param}'),
        ).toBeDefined();
        // @FeignClient(path = arrayOf) + @PostMapping(arrayOf) → consumer (path applied).
        expect(
          consumers.find(
            (c) =>
              c.contractId === 'http::POST::/feign/orders/search' &&
              c.meta.framework === 'openfeign',
          ),
        ).toBeDefined();
        // @HttpExchange(arrayOf) + @GetExchange(url = arrayOf) → consumer (prefix applied).
        expect(
          consumers.find(
            (c) =>
              c.contractId === 'http::GET::/pricing/{param}' &&
              c.meta.framework === 'spring-http-interface',
          ),
        ).toBeDefined();
      },
    );

    itKotlinConsumer(
      'registers a multi-element arrayOf("/a","/b") under every element (cross-product)',
      async () => {
        const dir = path.join(tmpDir, 'kotlin-array-of-multi');
        fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
        fs.writeFileSync(
          path.join(dir, 'src', 'MultiController.kt'),
          `package com.example
import org.springframework.web.bind.annotation.RestController
import org.springframework.web.bind.annotation.RequestMapping
import org.springframework.web.bind.annotation.GetMapping

@RestController
@RequestMapping(arrayOf("/a", "/b"))
class MultiController {
    @GetMapping(arrayOf("/x", "/y"))
    fun get(): Any = TODO()
}
`,
        );

        const contracts = await extractor.extract(null, dir, makeRepo(dir));
        const providers = contracts.filter((c) => c.role === 'provider');

        // 2 prefixes × 2 method paths → 4 contract IDs.
        for (const id of [
          'http::GET::/a/x',
          'http::GET::/a/y',
          'http::GET::/b/x',
          'http::GET::/b/y',
        ]) {
          expect(providers.find((c) => c.contractId === id)).toBeDefined();
        }
      },
    );

    itKotlinConsumer(
      'mixes arrayOf and collection-literal arrays without cannibalising either',
      async () => {
        // The dedicated arrayOf pattern must not drop the sibling ["/x"]
        // collection_literal match (the tree-sitter 0.21.x predicate-bucket hazard).
        const dir = path.join(tmpDir, 'kotlin-array-of-mixed');
        fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
        fs.writeFileSync(
          path.join(dir, 'src', 'ArrayOfController.kt'),
          `package com.example
import org.springframework.web.bind.annotation.RestController
import org.springframework.web.bind.annotation.RequestMapping
import org.springframework.web.bind.annotation.GetMapping

@RestController
@RequestMapping(arrayOf("/aof"))
class ArrayOfController {
    @GetMapping(arrayOf("/x"))
    fun get(): Any = TODO()
}
`,
        );
        fs.writeFileSync(
          path.join(dir, 'src', 'LiteralController.kt'),
          `package com.example
import org.springframework.web.bind.annotation.RestController
import org.springframework.web.bind.annotation.RequestMapping
import org.springframework.web.bind.annotation.GetMapping

@RestController
@RequestMapping(["/lit"])
class LiteralController {
    @GetMapping(["/y"])
    fun get(): Any = TODO()
}
`,
        );

        const contracts = await extractor.extract(null, dir, makeRepo(dir));
        const providers = contracts.filter((c) => c.role === 'provider');

        expect(providers.find((c) => c.contractId === 'http::GET::/aof/x')).toBeDefined();
        expect(providers.find((c) => c.contractId === 'http::GET::/lit/y')).toBeDefined();
      },
    );

    itKotlinConsumer(
      'does not treat a non-arrayOf call or a non-route arrayOf key as a route (anti-overreach)',
      async () => {
        const dir = path.join(tmpDir, 'kotlin-array-of-negative');
        fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
        // buildPath(...) is a call_expression but not arrayOf → no prefix.
        // produces = arrayOf(...) is a non-route key → no route.
        // arrayOf() is empty → no phantom route.
        fs.writeFileSync(
          path.join(dir, 'src', 'NegController.kt'),
          `package com.example
import org.springframework.web.bind.annotation.RestController
import org.springframework.web.bind.annotation.RequestMapping
import org.springframework.web.bind.annotation.GetMapping

@RestController
@RequestMapping(buildPath("/built"))
class NegController {
    @GetMapping(produces = arrayOf("application/json"))
    fun a(): Any = TODO()

    @GetMapping(arrayOf())
    fun b(): Any = TODO()
}
`,
        );

        const contracts = await extractor.extract(null, dir, makeRepo(dir));
        const providers = contracts.filter((c) =>
          c.symbolRef.filePath.endsWith('NegController.kt'),
        );

        // No route should be produced from any of the three anti-overreach forms.
        expect(providers).toHaveLength(0);
      },
    );

    itKotlinConsumer(
      'does not extract @RequestLine on a Kotlin class method (Feign proxies are interfaces only)',
      async () => {
        // Feign builds its proxy from an interface; a @RequestLine on a concrete
        // class is not a client call. Anti-overreach guard, parity with java.ts.
        const dir = path.join(tmpDir, 'kotlin-request-line-class');
        fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
        fs.writeFileSync(
          path.join(dir, 'src', 'AiClientImpl.kt'),
          `package com.example
import feign.RequestLine

class AiClientImpl {
    @RequestLine("GET /should-not-extract")
    fun health(): String = TODO()
}
`,
        );

        const contracts = await extractor.extract(null, dir, makeRepo(dir));
        expect(
          contracts.find((c) => c.contractId === 'http::GET::/should-not-extract'),
        ).toBeUndefined();
      },
    );

    itKotlinConsumer(
      'extracts Kotlin @RequestLine on a plain interface without @FeignClient (Feign.builder())',
      async () => {
        // Core-Feign usage: a plain interface with @RequestLine wired via
        // Feign.builder() — no @FeignClient. The structural interface check
        // (not a @FeignClient gate) admits it, matching the Java plugin.
        const dir = path.join(tmpDir, 'kotlin-request-line-plain-interface');
        fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
        fs.writeFileSync(
          path.join(dir, 'src', 'AiClient.kt'),
          `package com.example
import feign.RequestLine

interface AiClient {
    @RequestLine("POST /ai/summarize")
    fun summarize(): String

    @RequestLine("GET /ai/health")
    fun health(): String
}
`,
        );

        const contracts = await extractor.extract(null, dir, makeRepo(dir));
        const consumers = contracts.filter((c) => c.role === 'consumer');
        expect(
          consumers.find(
            (c) =>
              c.contractId === 'http::POST::/ai/summarize' &&
              c.meta.framework === 'openfeign' &&
              c.confidence === 0.75,
          ),
        ).toBeDefined();
        expect(
          consumers.find(
            (c) => c.contractId === 'http::GET::/ai/health' && c.meta.framework === 'openfeign',
          ),
        ).toBeDefined();
      },
    );

    itKotlinConsumer(
      'does not emit a provider for a non-controller class implementing a route interface',
      async () => {
        // Only a @RestController/@Controller implementer serves the interface's
        // routes. A plain service/adapter implementing the same interface must
        // NOT emit phantom providers (parity with Java's isController gate).
        const dir = path.join(tmpDir, 'kotlin-noncontroller-impl');
        fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
        fs.writeFileSync(
          path.join(dir, 'src', 'WarehouseApi.kt'),
          `package com.example
import org.springframework.web.bind.annotation.RequestMapping
import org.springframework.web.bind.annotation.GetMapping

@RequestMapping("/warehouses")
interface WarehouseApi {
    @GetMapping("/{id}/stock")
    fun listStock(id: String): Any
}
`,
        );
        fs.writeFileSync(
          path.join(dir, 'src', 'WarehouseServiceImpl.kt'),
          `package com.example

class WarehouseServiceImpl(private val svc: Svc) : WarehouseApi {
    override fun listStock(id: String): Any = TODO()
}
`,
        );

        const contracts = await extractor.extract(null, dir, makeRepo(dir));
        const providers = contracts.filter((c) => c.role === 'provider');
        expect(
          providers.find((c) => c.contractId === 'http::GET::/warehouses/{param}/stock'),
        ).toBeUndefined();
      },
    );

    itKotlinConsumer(
      'detects a controller using the arg-form @RestController("bean")',
      async () => {
        // The arg-form @RestController("bean") attaches under the class
        // `modifiers` as an `annotation` whose child is a `constructor_invocation`
        // (NOT a detached sibling). The controller gate reads its trailing name so
        // the inherited route is still emitted.
        const dir = path.join(tmpDir, 'kotlin-argform-restcontroller');
        fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
        fs.writeFileSync(
          path.join(dir, 'src', 'WarehouseApi.kt'),
          `package com.example
import org.springframework.web.bind.annotation.RequestMapping
import org.springframework.web.bind.annotation.GetMapping

@RequestMapping("/warehouses")
interface WarehouseApi {
    @GetMapping("/{id}/stock")
    fun listStock(id: String): Any
}
`,
        );
        fs.writeFileSync(
          path.join(dir, 'src', 'WarehouseController.kt'),
          `package com.example
import org.springframework.web.bind.annotation.RestController

@RestController("warehouseController")
class WarehouseController(private val svc: Svc) : WarehouseApi {
    override fun listStock(id: String): Any = TODO()
}
`,
        );

        const contracts = await extractor.extract(null, dir, makeRepo(dir));
        const providers = contracts.filter((c) => c.role === 'provider');
        expect(
          providers.find(
            (c) =>
              c.contractId === 'http::GET::/warehouses/{param}/stock' &&
              c.symbolRef.filePath.endsWith('WarehouseController.kt'),
          ),
        ).toBeDefined();
      },
    );

    itKotlinConsumer(
      'treats @(Get|...)Exchange as a consumer even on a concrete class (parity with Java)',
      async () => {
        // @(Get|...)Exchange is definitionally a client (HttpServiceProxyFactory)
        // annotation. Like java.ts, the extractor classifies it as a consumer
        // regardless of the enclosing type — so even a (mis-)use on a concrete
        // class yields a consumer, never a provider. Pins the accepted behavior.
        const dir = path.join(tmpDir, 'kotlin-exchange-on-class');
        fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
        fs.writeFileSync(
          path.join(dir, 'src', 'ReportClient.kt'),
          `package com.example
import org.springframework.stereotype.Component
import org.springframework.web.service.annotation.GetExchange

@Component
class ReportClient {
    @GetExchange("/reports/{id}")
    fun report(id: Int): Any = TODO()
}
`,
        );

        const contracts = await extractor.extract(null, dir, makeRepo(dir));
        expect(
          contracts.find(
            (c) =>
              c.role === 'consumer' &&
              c.contractId === 'http::GET::/reports/{param}' &&
              c.meta.framework === 'spring-http-interface',
          ),
        ).toBeDefined();
        // Never a provider.
        expect(
          contracts.find(
            (c) => c.role === 'provider' && c.contractId === 'http::GET::/reports/{param}',
          ),
        ).toBeUndefined();
      },
    );

    itKotlinConsumer(
      'emits one contract per element of a multi-element method-level path array',
      async () => {
        // Spring registers `@GetMapping(["/a", "/b"])` under BOTH paths, so the
        // extractor must emit N contracts (one per array element), not just one.
        const dir = path.join(tmpDir, 'kotlin-multi-method-array');
        fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
        fs.writeFileSync(
          path.join(dir, 'src', 'AliasController.kt'),
          `package com.example
import org.springframework.web.bind.annotation.RestController
import org.springframework.web.bind.annotation.RequestMapping
import org.springframework.web.bind.annotation.GetMapping

@RestController
@RequestMapping("/api")
class AliasController {
    @GetMapping(value = ["/primary", "/alias"])
    fun get(): Any = TODO()
}
`,
        );

        const contracts = await extractor.extract(null, dir, makeRepo(dir));
        const providers = contracts.filter((c) => c.role === 'provider');
        expect(providers.find((c) => c.contractId === 'http::GET::/api/primary')).toBeDefined();
        expect(providers.find((c) => c.contractId === 'http::GET::/api/alias')).toBeDefined();
      },
    );

    itKotlinConsumer(
      'emits one contract per element of a multi-element class-level prefix array',
      async () => {
        // Spring registers a method under EVERY class-level prefix, so a
        // `@RequestMapping(["/api/v1", "/api/v2"])` controller must yield a
        // contract per (prefix × method-path) combination, not just the last prefix.
        const dir = path.join(tmpDir, 'kotlin-multi-prefix-array');
        fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
        fs.writeFileSync(
          path.join(dir, 'src', 'VersionedController.kt'),
          `package com.example
import org.springframework.web.bind.annotation.RestController
import org.springframework.web.bind.annotation.RequestMapping
import org.springframework.web.bind.annotation.GetMapping

@RestController
@RequestMapping(["/base/one", "/base/two"])
class VersionedController {
    @GetMapping("/items")
    fun get(): Any = TODO()
}
`,
        );

        const contracts = await extractor.extract(null, dir, makeRepo(dir));
        const providers = contracts.filter((c) => c.role === 'provider');
        expect(providers.find((c) => c.contractId === 'http::GET::/base/one/items')).toBeDefined();
        expect(providers.find((c) => c.contractId === 'http::GET::/base/two/items')).toBeDefined();
      },
    );

    itKotlinConsumer(
      'combines a Kotlin controller class prefix with an inherited interface prefix',
      async () => {
        // Interface-based controller where BOTH the controller and the interface
        // carry a class-level @RequestMapping: the inherited route must be prefixed
        // by the controller prefix too (parity with java.ts joinInheritedSpringPath).
        const dir = path.join(tmpDir, 'kotlin-controller-prefix-inherit');
        fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
        fs.writeFileSync(
          path.join(dir, 'src', 'WidgetApi.kt'),
          `package com.example
import org.springframework.web.bind.annotation.RequestMapping
import org.springframework.web.bind.annotation.GetMapping

@RequestMapping("/v1")
interface WidgetApi {
    @GetMapping("/{id}")
    fun fetch(id: String): Any
}
`,
        );
        fs.writeFileSync(
          path.join(dir, 'src', 'WidgetController.kt'),
          `package com.example
import org.springframework.web.bind.annotation.RestController
import org.springframework.web.bind.annotation.RequestMapping

@RestController
@RequestMapping("/api")
class WidgetController : WidgetApi {
    override fun fetch(id: String): Any = TODO()
}
`,
        );

        const contracts = await extractor.extract(null, dir, makeRepo(dir));
        const providers = contracts.filter((c) => c.role === 'provider');
        expect(
          providers.find(
            (c) =>
              c.contractId === 'http::GET::/api/v1/{param}' &&
              c.symbolRef.filePath.endsWith('WidgetController.kt'),
          ),
        ).toBeDefined();
      },
    );

    itKotlinConsumer(
      'does not double a shared prefix when a Kotlin controller repeats the interface prefix',
      async () => {
        // #2057 parity: controller prefix == interface prefix must not be prepended
        // twice (no /shared/shared/...).
        const dir = path.join(tmpDir, 'kotlin-controller-prefix-dedup');
        fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
        fs.writeFileSync(
          path.join(dir, 'src', 'LedgerApi.kt'),
          `package com.example
import org.springframework.web.bind.annotation.RequestMapping
import org.springframework.web.bind.annotation.GetMapping

@RequestMapping("/shared")
interface LedgerApi {
    @GetMapping("/entries")
    fun entries(): Any
}
`,
        );
        fs.writeFileSync(
          path.join(dir, 'src', 'LedgerController.kt'),
          `package com.example
import org.springframework.web.bind.annotation.RestController
import org.springframework.web.bind.annotation.RequestMapping

@RestController
@RequestMapping("/shared")
class LedgerController : LedgerApi {
    override fun entries(): Any = TODO()
}
`,
        );

        const contracts = await extractor.extract(null, dir, makeRepo(dir));
        const providers = contracts.filter((c) => c.role === 'provider');
        expect(providers.find((c) => c.contractId === 'http::GET::/shared/entries')).toBeDefined();
        expect(
          providers.find((c) => c.contractId === 'http::GET::/shared/shared/entries'),
        ).toBeUndefined();
      },
    );

    itKotlinConsumer(
      'still combines distinct inherited Kotlin prefixes that share a leading segment',
      async () => {
        // Twin of the Java 'shared leading segment' case: controller @RequestMapping("/open")
        // + interface @RequestMapping("/open/ai") must combine to /open/open/ai/query, NOT
        // dedup to /open/ai/query (the dedup only fires on an exact prefix match).
        const dir = path.join(tmpDir, 'kotlin-shared-leading-prefix');
        fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
        fs.writeFileSync(
          path.join(dir, 'src', 'DataReleaseApi.kt'),
          `package com.example
import org.springframework.web.bind.annotation.RequestMapping
import org.springframework.web.bind.annotation.GetMapping

@RequestMapping("/open/ai")
interface DataReleaseApi {
    @GetMapping("/query")
    fun query(): Any
}
`,
        );
        fs.writeFileSync(
          path.join(dir, 'src', 'DataReleaseController.kt'),
          `package com.example
import org.springframework.web.bind.annotation.RestController
import org.springframework.web.bind.annotation.RequestMapping

@RestController
@RequestMapping("/open")
class DataReleaseController : DataReleaseApi {
    override fun query(): Any = TODO()
}
`,
        );

        const contracts = await extractor.extract(null, dir, makeRepo(dir));
        const providers = contracts.filter((c) => c.role === 'provider');
        expect(
          providers.find((c) => c.contractId === 'http::GET::/open/open/ai/query'),
        ).toBeDefined();
        expect(providers.find((c) => c.contractId === 'http::GET::/open/ai/query')).toBeUndefined();
      },
    );

    itKotlinConsumer(
      'keeps a Kotlin controller prefix when a prefix-less interface method starts with the same path',
      async () => {
        // Twin of the Java prefix-overlap case: controller @RequestMapping("/users")
        // + interface @GetMapping("/users/{id}") (no interface prefix) →
        // /users/users/{param}, not deduped to /users/{param}.
        const dir = path.join(tmpDir, 'kotlin-method-prefix-overlap');
        fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
        fs.writeFileSync(
          path.join(dir, 'src', 'UserApi.kt'),
          `package com.example
import org.springframework.web.bind.annotation.GetMapping

interface UserApi {
    @GetMapping("/users/{id}")
    fun getUser(id: String): Any
}
`,
        );
        fs.writeFileSync(
          path.join(dir, 'src', 'UserController.kt'),
          `package com.example
import org.springframework.web.bind.annotation.RestController
import org.springframework.web.bind.annotation.RequestMapping

@RestController
@RequestMapping("/users")
class UserController : UserApi {
    override fun getUser(id: String): Any = TODO()
}
`,
        );

        const contracts = await extractor.extract(null, dir, makeRepo(dir));
        const providers = contracts.filter((c) => c.role === 'provider');
        expect(
          providers.find((c) => c.contractId === 'http::GET::/users/users/{param}'),
        ).toBeDefined();
        expect(providers.find((c) => c.contractId === 'http::GET::/users/{param}')).toBeUndefined();
      },
    );

    itKotlinConsumer(
      'skips ambiguous inherited Kotlin routes when interfaces share a simple name',
      async () => {
        // Twin of the Java simple-name-collision case: two distinct interfaces both
        // named StatusApi → ambiguous, so the implementing controller emits nothing.
        const dir = path.join(tmpDir, 'kotlin-iface-name-collision');
        fs.mkdirSync(path.join(dir, 'src', 'a'), { recursive: true });
        fs.mkdirSync(path.join(dir, 'src', 'b'), { recursive: true });
        fs.writeFileSync(
          path.join(dir, 'src', 'a', 'StatusApi.kt'),
          `package com.example.a
import org.springframework.web.bind.annotation.GetMapping

interface StatusApi {
    @GetMapping("/a/status")
    fun getStatus(): Any
}
`,
        );
        fs.writeFileSync(
          path.join(dir, 'src', 'b', 'StatusApi.kt'),
          `package com.example.b
import org.springframework.web.bind.annotation.GetMapping

interface StatusApi {
    @GetMapping("/b/status")
    fun getStatus(): Any
}
`,
        );
        fs.writeFileSync(
          path.join(dir, 'src', 'StatusController.kt'),
          `package com.example
import org.springframework.web.bind.annotation.RestController

@RestController
class StatusController : StatusApi {
    override fun getStatus(): Any = TODO()
}
`,
        );

        const contracts = await extractor.extract(null, dir, makeRepo(dir));
        const providers = contracts.filter((c) => c.role === 'provider');
        expect(providers.find((c) => c.contractId === 'http::GET::/a/status')).toBeUndefined();
        expect(providers.find((c) => c.contractId === 'http::GET::/b/status')).toBeUndefined();
        expect(
          providers.filter((c) => c.symbolRef.filePath.endsWith('StatusController.kt')),
        ).toHaveLength(0);
      },
    );

    itKotlinConsumer(
      'emits routes from every distinctly-named interface a Kotlin controller implements',
      async () => {
        // Positive multi-interface case (untested in both languages before #2254):
        // a controller implementing two route interfaces emits both their routes.
        const dir = path.join(tmpDir, 'kotlin-multi-iface');
        fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
        fs.writeFileSync(
          path.join(dir, 'src', 'Apis.kt'),
          `package com.example
import org.springframework.web.bind.annotation.GetMapping

interface OrdersApi {
    @GetMapping("/orders")
    fun orders(): Any
}

interface UsersApi {
    @GetMapping("/users")
    fun users(): Any
}
`,
        );
        fs.writeFileSync(
          path.join(dir, 'src', 'GatewayController.kt'),
          `package com.example
import org.springframework.web.bind.annotation.RestController

@RestController
class GatewayController : OrdersApi, UsersApi {
    override fun orders(): Any = TODO()
    override fun users(): Any = TODO()
}
`,
        );

        const contracts = await extractor.extract(null, dir, makeRepo(dir));
        const providers = contracts.filter((c) => c.role === 'provider');
        expect(providers.find((c) => c.contractId === 'http::GET::/orders')).toBeDefined();
        expect(providers.find((c) => c.contractId === 'http::GET::/users')).toBeDefined();
      },
    );

    it('extracts Go stdlib and resty calls', async () => {
      const dir = path.join(tmpDir, 'go-consumer');
      fs.mkdirSync(path.join(dir, 'cmd'), { recursive: true });
      fs.writeFileSync(
        path.join(dir, 'cmd', 'client.go'),
        `
package main

import (
  "net/http"

  "github.com/go-resty/resty/v2"
)

func main() {
  http.Get("/api/health")
  client := resty.New()
  client.R().Delete("/api/orders/42")
}
`,
      );

      const contracts = await extractor.extract(null, dir, makeRepo(dir));
      const consumers = contracts.filter((c) => c.role === 'consumer');

      expect(consumers.find((c) => c.contractId === 'http::GET::/api/health')).toBeDefined();
      expect(
        consumers.find((c) => c.contractId === 'http::DELETE::/api/orders/{param}'),
      ).toBeDefined();
    });
  });

  describe('provider extraction — Laravel', () => {
    it('extracts Laravel Route::get patterns', async () => {
      const dir = path.join(tmpDir, 'laravel');
      fs.mkdirSync(path.join(dir, 'routes'), { recursive: true });
      fs.writeFileSync(
        path.join(dir, 'routes/api.php'),
        `<?php
Route::get('/users', [UserController::class, 'index']);
Route::post('/users', [UserController::class, 'store']);
Route::delete('/users/{id}', [UserController::class, 'destroy']);
`,
      );

      const contracts = await extractor.extract(null, dir, makeRepo(dir));
      const providers = contracts.filter((c) => c.role === 'provider');

      expect(providers.length).toBeGreaterThanOrEqual(3);
      expect(providers.find((c) => c.contractId === 'http::GET::/users')).toBeDefined();
      expect(providers.find((c) => c.contractId === 'http::POST::/users')).toBeDefined();
      expect(providers.find((c) => c.contractId === 'http::DELETE::/users/{param}')).toBeDefined();
    });
  });

  describe('consumer extraction — PHP', () => {
    it('extracts Laravel Http facade calls', async () => {
      const dir = path.join(tmpDir, 'php-http-facade');
      fs.mkdirSync(path.join(dir, 'app'), { recursive: true });
      fs.writeFileSync(
        path.join(dir, 'app/Client.php'),
        `<?php
use Illuminate\\Support\\Facades\\Http;

class Client {
    public function run() {
        Http::get('/api/users');
        Http::post('/api/orders/42');
        Http::delete('/api/users/7');
    }
}
`,
      );

      const contracts = await extractor.extract(null, dir, makeRepo(dir));
      const consumers = contracts.filter((c) => c.role === 'consumer');

      expect(consumers.find((c) => c.contractId === 'http::GET::/api/users')).toBeDefined();
      expect(
        consumers.find((c) => c.contractId === 'http::POST::/api/orders/{param}'),
      ).toBeDefined();
      expect(
        consumers.find((c) => c.contractId === 'http::DELETE::/api/users/{param}'),
      ).toBeDefined();
    });

    it('extracts Guzzle $client->method() calls', async () => {
      const dir = path.join(tmpDir, 'php-guzzle');
      fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
      fs.writeFileSync(
        path.join(dir, 'src/ApiClient.php'),
        `<?php
use GuzzleHttp\\Client;

class ApiClient {
    public function run(Client $client) {
        $client->get('/api/health');
        $client->post('/api/orders/42');
    }
}
`,
      );

      const contracts = await extractor.extract(null, dir, makeRepo(dir));
      const consumers = contracts.filter((c) => c.role === 'consumer');

      expect(consumers.find((c) => c.contractId === 'http::GET::/api/health')).toBeDefined();
      expect(
        consumers.find((c) => c.contractId === 'http::POST::/api/orders/{param}'),
      ).toBeDefined();
    });

    it('extracts file_get_contents HTTP calls', async () => {
      const dir = path.join(tmpDir, 'php-fgc');
      fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
      fs.writeFileSync(
        path.join(dir, 'src/fetch.php'),
        `<?php
function fetchRemote() {
    $data = file_get_contents('https://example.test/api/items/1');
    $local = file_get_contents('/tmp/local-file.txt');
    return $data;
}
`,
      );

      const contracts = await extractor.extract(null, dir, makeRepo(dir));
      const consumers = contracts.filter((c) => c.role === 'consumer');

      expect(consumers.find((c) => c.contractId === 'http::GET::/api/items/{param}')).toBeDefined();
      // file paths and stream wrappers must not emit consumer contracts
      expect(consumers.find((c) => c.meta.path === '/tmp/local-file.txt')).toBeUndefined();
    });
  });

  describe('provider extraction — FastAPI', () => {
    it('extracts FastAPI @app.get decorator patterns', async () => {
      const dir = path.join(tmpDir, 'fastapi');
      fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
      fs.writeFileSync(
        path.join(dir, 'src/main.py'),
        `from fastapi import FastAPI
app = FastAPI()

@app.get("/users")
async def list_users():
    return []

@app.post("/users")
async def create_user(user: UserCreate):
    return user
`,
      );

      const contracts = await extractor.extract(null, dir, makeRepo(dir));
      const providers = contracts.filter((c) => c.role === 'provider');

      expect(providers.length).toBeGreaterThanOrEqual(2);
      expect(providers.find((c) => c.contractId === 'http::GET::/users')).toBeDefined();
      expect(providers.find((c) => c.contractId === 'http::POST::/users')).toBeDefined();
    });

    it('joins FastAPI @router.<verb> path with include_router(prefix=...) from main.py (attribute shape)', async () => {
      const dir = path.join(tmpDir, 'fastapi-router-attr');
      fs.mkdirSync(path.join(dir, 'api'), { recursive: true });
      fs.writeFileSync(
        path.join(dir, 'main.py'),
        `from fastapi import FastAPI
from api import assistant
app = FastAPI()
app.include_router(assistant.router, prefix='/ai', tags=['ai'])
`,
      );
      fs.writeFileSync(
        path.join(dir, 'api/assistant.py'),
        `from fastapi import APIRouter
router = APIRouter()

@router.post("/assistant")
async def assistant(req):
    return {}
`,
      );

      const contracts = await extractor.extract(null, dir, makeRepo(dir));
      const providers = contracts.filter((c) => c.role === 'provider');

      expect(providers.find((c) => c.contractId === 'http::POST::/ai/assistant')).toBeDefined();
      // bare unprefixed form should not be emitted when a prefix mapping exists
      expect(providers.find((c) => c.contractId === 'http::POST::/assistant')).toBeUndefined();
    });

    it('joins FastAPI @router.<verb> path with include_router(prefix=...) (named-import shape)', async () => {
      const dir = path.join(tmpDir, 'fastapi-router-named');
      fs.mkdirSync(path.join(dir, 'api'), { recursive: true });
      fs.writeFileSync(
        path.join(dir, 'main.py'),
        `from fastapi import FastAPI
from api.predict import router as predict_router
app = FastAPI()
app.include_router(predict_router, prefix='/ai')
`,
      );
      fs.writeFileSync(
        path.join(dir, 'api/predict.py'),
        `from fastapi import APIRouter
router = APIRouter()

@router.get("/concurrent")
async def concurrent():
    return {}
`,
      );

      const contracts = await extractor.extract(null, dir, makeRepo(dir));
      const providers = contracts.filter((c) => c.role === 'provider');

      expect(providers.find((c) => c.contractId === 'http::GET::/ai/concurrent')).toBeDefined();
    });

    it('carries a package-router mount across unprefixed child includes without basename bleed', async () => {
      const dir = path.resolve(__dirname, '../../fixtures/fastapi-prefix-app');
      const contracts = await extractor.extract(null, dir, makeRepo(dir));
      const ids = new Set(contracts.filter((c) => c.role === 'provider').map((c) => c.contractId));

      expect(ids).toContain('http::GET::/api/agents');
      expect(ids).toContain('http::GET::/api/models');
      expect(ids).toContain('http::GET::/api/v1/models');
      expect(ids).not.toContain('http::GET::/agents');
      expect(ids).not.toContain('http::GET::/models');
      expect(ids).toContain('http::GET::/model-audit');
      expect(ids).not.toContain('http::GET::/api/model-audit');
      expect(ids).not.toContain('http::GET::/v1/model-audit');
      expect(ids).not.toContain('http::GET::/api/v1/model-audit');
    });

    describe('nested FastAPI router prefixes (#3408)', () => {
      async function providerIds(name: string, files: Record<string, string>) {
        const dir = path.join(tmpDir, name);
        for (const [rel, src] of Object.entries(files)) {
          fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
          fs.writeFileSync(path.join(dir, rel), src);
        }
        const contracts = await extractor.extract(null, dir, makeRepo(dir));
        return new Set(contracts.filter((c) => c.role === 'provider').map((c) => c.contractId));
      }
      const listRoute =
        'from fastapi import APIRouter\nrouter = APIRouter()\n\n@router.get("/list")\nasync def list_all():\n    return []\n';

      it('keeps an unresolved legacy mount alongside an import-resolved mount of the same file', async () => {
        const ids = await providerIds('fastapi-nested-legacy-union', {
          'main.py': [
            'import api.users as users',
            'from api import router as api_router',
            'app.include_router(users.router, prefix="/legacy")',
            'app.include_router(api_router, prefix="/api")',
            '',
          ].join('\n'),
          'api/__init__.py': [
            'from fastapi import APIRouter',
            'from .users import router as users_router',
            'router = APIRouter()',
            'router.include_router(users_router, prefix="/users")',
            '',
          ].join('\n'),
          'api/users.py': listRoute,
        });

        expect(ids).toContain('http::GET::/api/users/list');
        expect(ids).toContain('http::GET::/legacy/list');
        expect(ids).not.toContain('http::GET::/users/list');
      });

      it('joins the parent APIRouter(prefix=...) into child pass-through', async () => {
        const ids = await providerIds('fastapi-nested-parent-ctor', {
          'main.py':
            'from api import router as api_router\napp.include_router(api_router, prefix="/api")\n',
          'api/__init__.py': [
            'from fastapi import APIRouter',
            'from .agents import router as agents_router',
            'router = APIRouter(prefix="/v1")',
            'router.include_router(agents_router)',
            '',
          ].join('\n'),
          'api/agents.py': listRoute,
        });

        expect(ids).toContain('http::GET::/api/v1/list');
        expect(ids).not.toContain('http::GET::/api/list');
      });

      it('counts empty files when judging absolute-import ambiguity, like ingestion', async () => {
        // `tests/api/__init__.py` is empty but still makes `api` ambiguous.
        // Ingestion resolves over every scanned path, so both layers decline.
        const ids = await providerIds('fastapi-nested-empty-init', {
          'main.py':
            'from api import router as api_router\napp.include_router(api_router, prefix="/api")\n',
          'api/__init__.py': [
            'from fastapi import APIRouter',
            'from .agents import router as agents_router',
            'router = APIRouter()',
            'router.include_router(agents_router)',
            '',
          ].join('\n'),
          'api/agents.py': listRoute,
          'tests/api/__init__.py': '',
        });

        expect(ids).toContain('http::GET::/list');
        expect(ids).not.toContain('http::GET::/api/list');
      });

      it('carries a bare-mounted parent APIRouter(prefix=...) to unprefixed children', async () => {
        const ids = await providerIds('fastapi-nested-bare-parent-ctor', {
          'main.py': 'from api import router as api_router\napp.include_router(api_router)\n',
          'api/__init__.py': [
            'from fastapi import APIRouter',
            'from .agents import router as agents_router',
            'router = APIRouter(prefix="/v1")',
            'router.include_router(agents_router)',
            '',
          ].join('\n'),
          'api/agents.py': listRoute,
        });

        expect(ids).toContain('http::GET::/v1/list');
        expect(ids).not.toContain('http::GET::/list');
      });

      it('keeps an include prefix written after dependencies=[Depends(...)]', async () => {
        const ids = await providerIds('fastapi-include-depends-prefix', {
          'main.py': [
            'from api import items',
            'app.include_router(items.router, dependencies=[Depends(auth)], prefix="/items")',
            '',
          ].join('\n'),
          'api/items.py': listRoute,
        });

        expect(ids).toContain('http::GET::/items/list');
        expect(ids).not.toContain('http::GET::/list');
      });

      it('applies a child include prefix under a parent mounted without one', async () => {
        const ids = await providerIds('fastapi-nested-bare-parent', {
          'main.py': 'from api import router as api_router\napp.include_router(api_router)\n',
          'api/__init__.py': [
            'from fastapi import APIRouter',
            'from .agents import router as agents_router',
            'router = APIRouter()',
            'router.include_router(agents_router, prefix="/v1")',
            '',
          ].join('\n'),
          'api/agents.py': listRoute,
        });

        expect(ids).toContain('http::GET::/v1/list');
      });
    });

    it('joins FastAPI @router.<verb> path with APIRouter(prefix=...) in the same file', async () => {
      const dir = path.join(tmpDir, 'fastapi-router-constructor-prefix');
      fs.mkdirSync(path.join(dir, 'api'), { recursive: true });
      fs.writeFileSync(path.join(dir, 'main.py'), `app = None\n`);
      fs.writeFileSync(
        path.join(dir, 'api/items.py'),
        `from fastapi import APIRouter
router = APIRouter(prefix="/api/items", tags=["items"])

@router.get("")
async def list_items():
    return []

@router.post("/{item_id}")
async def update_item(item_id: str):
    return {}
`,
      );

      const contracts = await extractor.extract(null, dir, makeRepo(dir));
      const providers = contracts.filter((c) => c.role === 'provider');

      expect(providers.find((c) => c.contractId === 'http::GET::/api/items')).toBeDefined();
      expect(
        providers.find((c) => c.contractId === 'http::POST::/api/items/{param}'),
      ).toBeDefined();
      expect(providers.find((c) => c.contractId === 'http::GET::/')).toBeUndefined();
      expect(providers.find((c) => c.contractId === 'http::POST::/{param}')).toBeUndefined();
    });

    it('treats an empty APIRouter(prefix="") as no prefix', async () => {
      const dir = path.join(tmpDir, 'fastapi-router-empty-prefix');
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'main.py'), `app = None\n`);
      fs.writeFileSync(
        path.join(dir, 'items.py'),
        `from fastapi import APIRouter
router = APIRouter(prefix="")

@router.get("/list")
async def list_items():
    return []
`,
      );

      const contracts = await extractor.extract(null, dir, makeRepo(dir));
      const providers = contracts.filter((c) => c.role === 'provider');

      // Empty prefix is a clean no-op — the route keeps its bare decorator path.
      expect(providers.find((c) => c.contractId === 'http::GET::/list')).toBeDefined();
    });

    it('does not bleed root APIRouter(prefix=...) onto nested same-stem files', async () => {
      const dir = path.join(tmpDir, 'fastapi-router-constructor-prefix-no-bleed');
      fs.mkdirSync(path.join(dir, 'admin'), { recursive: true });
      fs.writeFileSync(path.join(dir, 'main.py'), `app = None\n`);
      fs.writeFileSync(
        path.join(dir, 'users.py'),
        `from fastapi import APIRouter
router = APIRouter(prefix="/root-users")

@router.get("/landing")
async def root_users_landing():
    return {}
`,
      );
      fs.writeFileSync(
        path.join(dir, 'admin/users.py'),
        `from fastapi import APIRouter
router = APIRouter()

@router.get("/audit")
async def audit():
    return {}
`,
      );

      const contracts = await extractor.extract(null, dir, makeRepo(dir));
      const providers = contracts.filter((c) => c.role === 'provider');

      expect(
        providers.find((c) => c.contractId === 'http::GET::/root-users/landing'),
      ).toBeDefined();
      expect(providers.find((c) => c.contractId === 'http::GET::/audit')).toBeDefined();
      expect(
        providers.find((c) => c.contractId === 'http::GET::/root-users/audit'),
      ).toBeUndefined();
    });

    it('stacks FastAPI APIRouter(prefix=...) with include_router(prefix=...)', async () => {
      const dir = path.join(tmpDir, 'fastapi-router-stacked-prefix');
      fs.mkdirSync(path.join(dir, 'api'), { recursive: true });
      fs.writeFileSync(
        path.join(dir, 'main.py'),
        `from fastapi import FastAPI
from api import items
app = FastAPI()
app.include_router(items.router, prefix="/v1")
`,
      );
      fs.writeFileSync(
        path.join(dir, 'api/items.py'),
        `from fastapi import APIRouter
router = APIRouter(prefix="/items")

@router.get("/{item_id}")
async def get_item(item_id: str):
    return {}
`,
      );

      const contracts = await extractor.extract(null, dir, makeRepo(dir));
      const providers = contracts.filter((c) => c.role === 'provider');

      expect(providers.find((c) => c.contractId === 'http::GET::/v1/items/{param}')).toBeDefined();
      expect(providers.find((c) => c.contractId === 'http::GET::/items/{param}')).toBeUndefined();
    });

    it('emits @router.<verb> path unmodified when no include_router prefix is configured', async () => {
      const dir = path.join(tmpDir, 'fastapi-router-no-prefix');
      fs.mkdirSync(path.join(dir, 'api'), { recursive: true });
      fs.writeFileSync(path.join(dir, 'main.py'), `app = None\n`);
      fs.writeFileSync(
        path.join(dir, 'api/loose.py'),
        `from fastapi import APIRouter
router = APIRouter()

@router.get("/standalone")
async def standalone():
    return {}
`,
      );

      const contracts = await extractor.extract(null, dir, makeRepo(dir));
      const providers = contracts.filter((c) => c.role === 'provider');
      expect(providers.find((c) => c.contractId === 'http::GET::/standalone')).toBeDefined();
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
    it('returns empty for repo with no matching files', async () => {
      const dir = path.join(tmpDir, 'empty-repo');
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'README.md'), '# Hello');

      const contracts = await extractor.extract(null, dir, makeRepo(dir));
      expect(contracts).toHaveLength(0);
    });

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
    interface SymbolRow {
      uid: string;
      name: string;
      filePath: string;
      startLine: number;
      endLine: number;
      labels: string[];
    }
    const isFileQuery = (q: string): boolean =>
      q.includes('UNION ALL') && q.includes('sym.filePath = $filePath');
    const isFilesQuery = (q: string): boolean =>
      q.includes('UNION ALL') && q.includes('UNWIND $filePaths');

    /**
     * A graph that answers the extractor's queries from `symbols` (kept in
     * storage order) and records every query. Each row carries `ord`, its
     * position in `symbols`, as the engine's rows carry their scan offset.
     * By default a symbol query returns the Function rows, then Method, then
     * CodeElement, each in storage order (what one execution thread gives);
     * `reversed` returns them back to front, standing in for the order several
     * threads can deliver. `failBatch` makes every CONTAINING_FILES_QUERY throw.
     */
    const recordingGraph = (opts: {
      routes?: Record<string, unknown>[];
      symbols: SymbolRow[];
      failBatch?: boolean;
      reversed?: boolean;
    }) => {
      const calls: Array<{ query: string; params: Record<string, unknown> }> = [];
      const stored = opts.symbols.map((sym, ord) => ({ ...sym, ord }));
      const rowsOf = (files: ReadonlySet<string>): Record<string, unknown>[] => {
        const rows = ['Function', 'Method', 'CodeElement'].flatMap((label) =>
          stored
            .filter((sym) => sym.labels[0] === label && files.has(sym.filePath))
            .map((sym) => ({ ...sym })),
        );
        return opts.reversed ? rows.reverse() : rows;
      };
      const db = async (
        query: string,
        params: Record<string, unknown> = {},
      ): Promise<Record<string, unknown>[]> => {
        calls.push({ query, params });
        if (query.includes("type: 'HANDLES_ROUTE'")) return opts.routes ?? [];
        if (isFilesQuery(query)) {
          if (opts.failBatch) throw new Error('batch query failed');
          return rowsOf(new Set(params.filePaths as string[]));
        }
        if (isFileQuery(query)) return rowsOf(new Set([String(params.filePath)]));
        return [];
      };
      return {
        db,
        batches: (): string[][] =>
          calls.filter((c) => isFilesQuery(c.query)).map((c) => c.params.filePaths as string[]),
        singles: (): string[] =>
          calls.filter((c) => isFileQuery(c.query)).map((c) => String(c.params.filePath)),
      };
    };

    const ORDERS = 'src/main/java/shop/OrderController.java';
    const USERS = 'src/main/java/shop/UserController.java';
    const ITEMS = 'src/main/java/shop/ItemController.java';
    const handler = (filePath: string, name: string, startLine: number): SymbolRow => ({
      uid: `Method:${filePath}:${name}`,
      name,
      filePath,
      startLine,
      endLine: startLine + 3,
      labels: ['Method'],
    });
    // Storage order mixes the files.
    const handlerSymbols = [
      handler(ORDERS, 'listOrders', 10),
      handler(USERS, 'listUsers', 8),
      handler(ORDERS, 'createOrder', 20),
      handler(ITEMS, 'listItems', 5),
    ];
    const route = (filePath: string, routeMethod: string, routePath: string, name: string) => ({
      fileId: `File:${filePath}`,
      filePath,
      routePath,
      routeId: `Route:${routeMethod}:${routePath}`,
      routeMethod,
      handlerSymbolId: `Method:${filePath}:${name}`,
      routeSource: 'framework-route',
    });
    const handlerRoutes = [
      route(ORDERS, 'GET', '/api/orders', 'listOrders'),
      route(ORDERS, 'POST', '/api/orders', 'createOrder'),
      route(USERS, 'GET', '/api/users', 'listUsers'),
      route(ITEMS, 'GET', '/api/items', 'listItems'),
    ];
    const summary = (contracts: { contractId: string; symbolUid: string; symbolName: string }[]) =>
      contracts.map((c) => [c.contractId, c.symbolUid, c.symbolName]);

    it('loads every handler file in one query instead of one query per file', async () => {
      const dir = fs.mkdtempSync(path.join(tmpDir, 'batch-handlers-'));
      const graph = recordingGraph({ routes: handlerRoutes, symbols: handlerSymbols });

      const contracts = await extractor.extract(graph.db, dir, makeRepo(dir));

      expect(graph.batches()).toEqual([[ITEMS, ORDERS, USERS]]);
      expect(graph.singles()).toEqual([]);
      expect(summary(contracts)).toEqual([
        ['http::GET::/api/items', `Method:${ITEMS}:listItems`, 'listItems'],
        ['http::GET::/api/orders', `Method:${ORDERS}:listOrders`, 'listOrders'],
        ['http::POST::/api/orders', `Method:${ORDERS}:createOrder`, 'createOrder'],
        ['http::GET::/api/users', `Method:${USERS}:listUsers`, 'listUsers'],
      ]);
    });

    it('names a source-scan file before resolving its detections', async () => {
      const dir = fs.mkdtempSync(path.join(tmpDir, 'batch-source-scan-'));
      // A FastAPI provider found by the per-file source scan: main.py is not a
      // route file, so it loads with the scanned files that have detections.
      fs.writeFileSync(
        path.join(dir, 'main.py'),
        `from fastapi import FastAPI
app = FastAPI()

@app.get("/api/health")
def health():
    return {}
`,
      );
      const graph = recordingGraph({
        routes: handlerRoutes,
        symbols: [
          ...handlerSymbols,
          {
            uid: 'Function:main.py:health',
            name: 'health',
            filePath: 'main.py',
            startLine: 4,
            endLine: 5,
            labels: ['Function'],
          },
        ],
      });

      const contracts = await extractor.extract(graph.db, dir, makeRepo(dir));

      expect(graph.batches()).toEqual([[ITEMS, ORDERS, USERS], ['main.py']]);
      expect(graph.singles()).toEqual([]);
      expect(contracts.find((c) => c.contractId === 'http::GET::/api/health')).toMatchObject({
        symbolUid: 'Function:main.py:health',
        symbolName: 'health',
      });
    });

    it('falls back to one query per file when the batch query fails, with the same contracts', async () => {
      const dir = fs.mkdtempSync(path.join(tmpDir, 'batch-fails-'));
      const working = recordingGraph({ routes: handlerRoutes, symbols: handlerSymbols });
      const failing = recordingGraph({
        routes: handlerRoutes,
        symbols: handlerSymbols,
        failBatch: true,
      });

      const expected = await extractor.extract(working.db, dir, makeRepo(dir));
      const actual = await new HttpRouteExtractor().extract(failing.db, dir, makeRepo(dir));

      expect(failing.batches()).toEqual([[ITEMS, ORDERS, USERS]]);
      // Each file once, when the loop first reaches it: no retry per route.
      expect(failing.singles()).toEqual([ITEMS, ORDERS, USERS]);
      expect(actual).toEqual(expected);
      expect(actual.map((c) => c.symbolName)).toEqual([
        'listItems',
        'listOrders',
        'createOrder',
        'listUsers',
      ]);
    });

    it('caches an empty result for a file the batch found no symbols in', async () => {
      const dir = fs.mkdtempSync(path.join(tmpDir, 'batch-empty-'));
      const LEGACY = 'src/main/java/shop/LegacyController.java';
      const graph = recordingGraph({
        routes: [
          ...handlerRoutes,
          route(LEGACY, 'GET', '/api/legacy', 'getLegacy'),
          route(LEGACY, 'DELETE', '/api/legacy', 'dropLegacy'),
        ],
        // No symbol rows for LEGACY at all.
        symbols: handlerSymbols,
      });

      const contracts = await extractor.extract(graph.db, dir, makeRepo(dir));

      expect(graph.batches()).toEqual([[ITEMS, LEGACY, ORDERS, USERS]]);
      // The empty answer is cached: neither LEGACY route queries it again.
      expect(graph.singles()).toEqual([]);
      expect(summary(contracts.filter((c) => c.contractId.endsWith('/api/legacy')))).toEqual([
        ['http::DELETE::/api/legacy', `Method:${LEGACY}:dropLegacy`, 'LegacyController.java'],
        ['http::GET::/api/legacy', `Method:${LEGACY}:getLegacy`, 'LegacyController.java'],
      ]);
    });

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
