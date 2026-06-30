import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

const { parseSourceSafeSpy } = vi.hoisted(() => ({ parseSourceSafeSpy: vi.fn() }));

vi.mock('../../../src/core/tree-sitter/safe-parse.js', async () => {
  const { buildSafeParseMock } = await import('../../helpers/parse-source-safe-mock.js');
  return buildSafeParseMock(parseSourceSafeSpy);
});

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

  const toPosixPath = (filePath: string): string => filePath.replace(/\\/g, '/');

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
        if (query.includes('UNION ALL') && String(params?.filePath ?? '').includes('users.ts')) {
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
        if (query.includes('UNION ALL') && String(params?.filePath ?? '').includes('routes.ts')) {
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
        if (query.includes('UNION ALL') && String(params?.filePath ?? '').includes('routes.ts')) {
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
          return String(params?.filePath ?? '').includes('routes.ts') ? routesFileSyms : [];
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
          return String(params?.filePath ?? '').includes('routes.ts') ? routesFileSyms : [];
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
          return String(params?.filePath ?? '').includes('routes.ts') ? routesFileSyms : [];
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
          return String(params?.filePath ?? '').includes('routes.ts')
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
          return String(params?.filePath ?? '').includes('routes.ts') ? routesFileSyms : [];
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
          return String(params?.filePath ?? '').includes('routes.ts') ? routesFileSyms : [];
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
          return String(params?.filePath ?? '').includes('api.ts')
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
          return String(params?.filePath ?? '').includes('routes.ts')
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
          return String(params?.filePath ?? '').includes('routes.ts') ? routesFileSyms : [];
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

func main() {
  http.HandleFunc("/api/inline", func(w http.ResponseWriter, r *http.Request) {
    w.Write([]byte("ok"))
  })
}
`,
      );
      // main() spans source lines 3-7 → 0-based [2,6]; the HandleFunc
      // registration and its anonymous func are on line 4 (row 3), inside span.
      const mockDbExecutor = async (
        query: string,
        params?: Record<string, unknown>,
      ): Promise<Record<string, unknown>[]> => {
        if (query.includes('UNION ALL') && String(params?.filePath ?? '').includes('server.go')) {
          return [
            {
              uid: 'fn-main',
              name: 'main',
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
        (c) => c.role === 'provider' && c.contractId === 'http::GET::/api/inline',
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
        if (query.includes('UNION ALL') && String(params?.filePath ?? '').includes('server.go')) {
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
        if (query.includes('UNION ALL') && String(params?.filePath ?? '').includes('server.go')) {
          return [
            {
              uid: 'fn-healthHandler',
              name: 'healthHandler',
              filePath: 'cmd/server.go',
              startLine: 2,
              endLine: 2,
              labels: ['Function'],
            },
            {
              uid: 'fn-main',
              name: 'main',
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
        (c) => c.role === 'provider' && c.contractId === 'http::GET::/api/health',
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
        if (query.includes('UNION ALL') && String(params?.filePath ?? '').includes('server.go')) {
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
        if (query.includes('UNION ALL') && String(params?.filePath ?? '').includes('server.go')) {
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
        if (query.includes('UNION ALL') && String(params?.filePath ?? '').includes('server.go')) {
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
          String(params?.filePath ?? '').includes('RouteServiceProvider.php')
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
          String(params?.filePath ?? '').includes('RouteServiceProvider.php')
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
        if (query.includes('UNION ALL') && String(params?.filePath ?? '').includes('main.py')) {
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
        if (query.includes('UNION ALL') && String(params?.filePath ?? '').includes('main.py')) {
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
        if (query.includes('UNION ALL') && String(params?.filePath ?? '').includes('main.py')) {
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
        if (query.includes('UNION ALL') && String(params?.filePath ?? '').includes('main.py')) {
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

  describe('provider extraction — graph-first (Strategy A)', () => {
    it('extracts routes from Route/HANDLES_ROUTE graph + source scan for method', async () => {
      const dir = path.join(tmpDir, 'graph-first');
      fs.mkdirSync(path.join(dir, 'src/controller'), { recursive: true });
      fs.writeFileSync(
        path.join(dir, 'src/controller/UserController.java'),
        `
@RestController
@RequestMapping("/api/v2")
public class UserController {
    @GetMapping("/users")
    public List<User> list() { return service.findAll(); }

    @PostMapping("/users")
    public User create(@RequestBody User user) { return service.save(user); }
}
`,
      );

      const mockDbExecutor = async (query: string) => {
        if (query.includes('HANDLES_ROUTE')) {
          return [
            {
              fileId: 'file-uid-ctrl',
              filePath: 'src/controller/UserController.java',
              routePath: '/api/v2/users',
              routeId: 'route-uid-users',
              responseKeys: null,
              routeSource: 'decorator-GetMapping',
            },
          ];
        }
        if (query.includes('UNION ALL')) {
          return [
            {
              uid: 'uid-ctrl-list',
              name: 'list',
              filePath: 'src/controller/UserController.java',
              labels: ['Method'],
            },
            {
              uid: 'uid-ctrl-create',
              name: 'create',
              filePath: 'src/controller/UserController.java',
              labels: ['Method'],
            },
          ];
        }
        return [];
      };

      const contracts = await extractor.extract(mockDbExecutor, dir, makeRepo(dir));
      const providers = contracts.filter((c) => c.role === 'provider');

      const getRoute = providers.find((c) => c.contractId === 'http::GET::/api/v2/users');
      expect(getRoute).toBeDefined();
      expect(getRoute!.confidence).toBe(0.9);
      expect(getRoute!.symbolUid).not.toBe('file-uid-ctrl');
    });

    it('supplements graph providers with source-scan providers from other files', async () => {
      const dir = path.join(tmpDir, 'graph-source-provider-union');
      fs.mkdirSync(path.join(dir, 'src/controller'), { recursive: true });
      fs.mkdirSync(path.join(dir, 'cmd'), { recursive: true });
      fs.writeFileSync(
        path.join(dir, 'src/controller/UserController.java'),
        `
@RestController
@RequestMapping("/api/v2")
public class UserController {
    @GetMapping("/users")
    public List<User> list() { return service.findAll(); }
}
`,
      );
      fs.writeFileSync(
        path.join(dir, 'cmd/server.go'),
        `
package main

func healthHandler(w http.ResponseWriter, r *http.Request) {}

func main() {
  http.HandleFunc("/api/health", healthHandler)
}
`,
      );

      const mockDbExecutor = async (query: string) => {
        if (query.includes('HANDLES_ROUTE')) {
          return [
            {
              fileId: 'file-uid-ctrl',
              filePath: 'src/controller/UserController.java',
              routePath: '/api/v2/users',
              routeId: 'route-uid-users',
              responseKeys: null,
              routeSource: 'decorator-GetMapping',
            },
          ];
        }
        if (query.includes('FETCHES')) return [];
        if (query.includes('UNION ALL')) {
          return [
            {
              uid: 'uid-ctrl-list',
              name: 'list',
              filePath: 'src/controller/UserController.java',
              labels: ['Method'],
            },
          ];
        }
        return [];
      };

      const contracts = await extractor.extract(mockDbExecutor, dir, makeRepo(dir));
      const providers = contracts.filter((c) => c.role === 'provider');

      const graphRouteMatches = providers.filter(
        (c) => c.contractId === 'http::GET::/api/v2/users',
      );
      expect(graphRouteMatches).toHaveLength(1);
      expect(graphRouteMatches[0].symbolUid).toBe('uid-ctrl-list');
      expect(graphRouteMatches[0].meta.extractionStrategy).toBe('graph_assisted');

      const sourceRoute = providers.find((c) => c.contractId === 'http::GET::/api/health');
      expect(sourceRoute).toBeDefined();
      expect(sourceRoute?.symbolName).toBe('healthHandler');
      expect(sourceRoute?.meta.extractionStrategy).toBe('source_scan');
    });
  });

  describe('provider extraction — source-scan fallback (Strategy B)', () => {
    it('extracts Spring @GetMapping annotation', async () => {
      const dir = path.join(tmpDir, 'spring');
      fs.mkdirSync(path.join(dir, 'src/controller'), { recursive: true });
      fs.writeFileSync(
        path.join(dir, 'src/controller/UserController.java'),
        `
package com.example;
import org.springframework.web.bind.annotation.*;

@RestController
@RequestMapping("/api/v2")
public class UserController {
    @GetMapping("/users")
    public List<User> list() { return service.findAll(); }

    @PostMapping("/users")
    public User create(@RequestBody User user) { return service.save(user); }

    @GetMapping("/users/{id}")
    public User getById(@PathVariable Long id) { return service.findById(id); }
}
`,
      );

      const contracts = await extractor.extract(null, dir, makeRepo(dir));
      const providers = contracts.filter((c) => c.role === 'provider');

      expect(providers.length).toBeGreaterThanOrEqual(3);

      const listRoute = providers.find((c) => c.contractId === 'http::GET::/api/v2/users');
      expect(listRoute).toBeDefined();
      expect(listRoute!.meta.method).toBe('GET');
      expect(listRoute!.meta.path).toBe('/api/v2/users');

      const createRoute = providers.find((c) => c.contractId === 'http::POST::/api/v2/users');
      expect(createRoute).toBeDefined();

      const getByIdRoute = providers.find(
        (c) => c.contractId === 'http::GET::/api/v2/users/{param}',
      );
      expect(getByIdRoute).toBeDefined();
    });

    // ─── #1834 — Spring named annotation arguments ──────────────────
    // Spring annotations accept both positional shorthand
    // (`@GetMapping("/users")`) and named arguments
    // (`@GetMapping(value = "/users")` or `@GetMapping(path = "/users")`).
    // The two AST shapes produced by tree-sitter-java differ:
    //   @GetMapping("/users")          → annotation_argument_list > string_literal
    //   @GetMapping(value = "/users")  → annotation_argument_list > element_value_pair
    // The named-arg pattern in `http-patterns/java.ts` MUST constrain
    // the `key` field to `path`/`value`; without that constraint the
    // query also captures other string-valued attributes such as
    // `produces`, `consumes`, `headers`, `name`, `params` (see PR #1834
    // review). The tests below pin both the positive cases and the
    // negative anti-regression cases.
    it('extracts Spring class-level @RequestMapping(path = "/api")', async () => {
      const dir = path.join(tmpDir, 'spring-class-named-path');
      fs.mkdirSync(path.join(dir, 'src/controller'), { recursive: true });
      fs.writeFileSync(
        path.join(dir, 'src/controller/UserController.java'),
        `
package com.example;
import org.springframework.web.bind.annotation.*;

@RestController
@RequestMapping(path = "/api/v3")
public class UserController {
    @GetMapping("/users")
    public List<User> list() { return service.findAll(); }
}
`,
      );

      const contracts = await extractor.extract(null, dir, makeRepo(dir));
      const providers = contracts.filter((c) => c.role === 'provider');

      const route = providers.find((c) => c.contractId === 'http::GET::/api/v3/users');
      expect(route).toBeDefined();
      expect(route!.meta.path).toBe('/api/v3/users');
    });

    it('extracts Spring class-level @RequestMapping(value = "/api")', async () => {
      const dir = path.join(tmpDir, 'spring-class-named-value');
      fs.mkdirSync(path.join(dir, 'src/controller'), { recursive: true });
      fs.writeFileSync(
        path.join(dir, 'src/controller/OrderController.java'),
        `
package com.example;
import org.springframework.web.bind.annotation.*;

@RestController
@RequestMapping(value = "/orders")
public class OrderController {
    @GetMapping("/list")
    public List<Order> list() { return service.findAll(); }
}
`,
      );

      const contracts = await extractor.extract(null, dir, makeRepo(dir));
      const providers = contracts.filter((c) => c.role === 'provider');

      const route = providers.find((c) => c.contractId === 'http::GET::/orders/list');
      expect(route).toBeDefined();
    });

    it('extracts Spring method-level @GetMapping(value = "/users") (named value)', async () => {
      const dir = path.join(tmpDir, 'spring-method-named-value');
      fs.mkdirSync(path.join(dir, 'src/controller'), { recursive: true });
      fs.writeFileSync(
        path.join(dir, 'src/controller/UserController.java'),
        `
package com.example;
import org.springframework.web.bind.annotation.*;

@RestController
public class UserController {
    @GetMapping(value = "/users")
    public List<User> list() { return service.findAll(); }
}
`,
      );

      const contracts = await extractor.extract(null, dir, makeRepo(dir));
      const providers = contracts.filter((c) => c.role === 'provider');

      const route = providers.find((c) => c.contractId === 'http::GET::/users');
      expect(route).toBeDefined();
      expect(route!.symbolName).toBe('list');
    });

    it('extracts Spring method-level @GetMapping(path = "/users") (named path)', async () => {
      const dir = path.join(tmpDir, 'spring-method-named-path-get');
      fs.mkdirSync(path.join(dir, 'src/controller'), { recursive: true });
      fs.writeFileSync(
        path.join(dir, 'src/controller/UserController.java'),
        `
package com.example;
import org.springframework.web.bind.annotation.*;

@RestController
public class UserController {
    @GetMapping(path = "/users")
    public List<User> list() { return service.findAll(); }
}
`,
      );

      const contracts = await extractor.extract(null, dir, makeRepo(dir));
      const providers = contracts.filter((c) => c.role === 'provider');

      const route = providers.find((c) => c.contractId === 'http::GET::/users');
      expect(route).toBeDefined();
      expect(route!.symbolName).toBe('list');
    });

    it('extracts Spring method-level @PostMapping(path = "/users") (named path)', async () => {
      const dir = path.join(tmpDir, 'spring-method-named-path-post');
      fs.mkdirSync(path.join(dir, 'src/controller'), { recursive: true });
      fs.writeFileSync(
        path.join(dir, 'src/controller/UserController.java'),
        `
package com.example;
import org.springframework.web.bind.annotation.*;

@RestController
public class UserController {
    @PostMapping(path = "/users")
    public User create(@RequestBody User user) { return service.save(user); }
}
`,
      );

      const contracts = await extractor.extract(null, dir, makeRepo(dir));
      const providers = contracts.filter((c) => c.role === 'provider');

      const route = providers.find((c) => c.contractId === 'http::POST::/users');
      expect(route).toBeDefined();
      expect(route!.symbolName).toBe('create');
    });

    it('combines class named-arg prefix with method positional path', async () => {
      const dir = path.join(tmpDir, 'spring-mixed-class-named-method-pos');
      fs.mkdirSync(path.join(dir, 'src/controller'), { recursive: true });
      fs.writeFileSync(
        path.join(dir, 'src/controller/UserController.java'),
        `
package com.example;
import org.springframework.web.bind.annotation.*;

@RestController
@RequestMapping(path = "/api")
public class UserController {
    @GetMapping("/users")
    public List<User> list() { return service.findAll(); }
}
`,
      );

      const contracts = await extractor.extract(null, dir, makeRepo(dir));
      const providers = contracts.filter((c) => c.role === 'provider');

      const route = providers.find((c) => c.contractId === 'http::GET::/api/users');
      expect(route).toBeDefined();
    });

    it('combines class positional prefix with method named-arg path', async () => {
      const dir = path.join(tmpDir, 'spring-mixed-class-pos-method-named');
      fs.mkdirSync(path.join(dir, 'src/controller'), { recursive: true });
      fs.writeFileSync(
        path.join(dir, 'src/controller/UserController.java'),
        `
package com.example;
import org.springframework.web.bind.annotation.*;

@RestController
@RequestMapping("/api")
public class UserController {
    @GetMapping(value = "/users")
    public List<User> list() { return service.findAll(); }
}
`,
      );

      const contracts = await extractor.extract(null, dir, makeRepo(dir));
      const providers = contracts.filter((c) => c.role === 'provider');

      const route = providers.find((c) => c.contractId === 'http::GET::/api/users');
      expect(route).toBeDefined();
    });

    it('does NOT emit a provider for @GetMapping(produces = ...) without path/value', async () => {
      // Anti-regression: without the `key:` constraint, the named-arg
      // query would capture `produces = "application/json"` and emit
      // a bogus `http::GET::/application/json` contract.
      const dir = path.join(tmpDir, 'spring-produces-only');
      fs.mkdirSync(path.join(dir, 'src/controller'), { recursive: true });
      fs.writeFileSync(
        path.join(dir, 'src/controller/MisleadingController.java'),
        `
package com.example;
import org.springframework.web.bind.annotation.*;

@RestController
public class MisleadingController {
    @GetMapping(produces = "application/json")
    public List<User> list() { return service.findAll(); }
}
`,
      );

      const contracts = await extractor.extract(null, dir, makeRepo(dir));
      const providers = contracts.filter((c) => c.role === 'provider');

      // No GET provider should be emitted for this method — the only
      // string literal in the annotation is a non-route attribute.
      expect(
        providers.find((c) => c.contractId === 'http::GET::/application/json'),
      ).toBeUndefined();
      // And the controller has no other route, so providers list for
      // this file should be empty.
      const fromThisFile = providers.filter((c) =>
        c.symbolRef.filePath.endsWith('MisleadingController.java'),
      );
      expect(fromThisFile).toHaveLength(0);
    });

    it('emits exactly one provider for @GetMapping(name = "...", value = "/users")', async () => {
      // Anti-regression: without the `key:` constraint, the named-arg
      // query would capture both string literals and emit two
      // contracts (`/listUsers` + `/users`). With the constraint, only
      // `/users` is emitted.
      const dir = path.join(tmpDir, 'spring-name-and-value');
      fs.mkdirSync(path.join(dir, 'src/controller'), { recursive: true });
      fs.writeFileSync(
        path.join(dir, 'src/controller/UserController.java'),
        `
package com.example;
import org.springframework.web.bind.annotation.*;

@RestController
public class UserController {
    @GetMapping(name = "listUsers", value = "/users")
    public List<User> list() { return service.findAll(); }
}
`,
      );

      const contracts = await extractor.extract(null, dir, makeRepo(dir));
      const providers = contracts.filter((c) => c.role === 'provider');

      const usersRoute = providers.find((c) => c.contractId === 'http::GET::/users');
      expect(usersRoute).toBeDefined();
      expect(usersRoute!.symbolName).toBe('list');

      // The non-route `name` attribute must NOT produce a route.
      expect(providers.find((c) => c.contractId === 'http::GET::/listUsers')).toBeUndefined();

      const fromThisFile = providers.filter((c) =>
        c.symbolRef.filePath.endsWith('UserController.java'),
      );
      expect(fromThisFile).toHaveLength(1);
    });

    it('uses `path` (not non-route key) as class prefix when both appear', async () => {
      // Anti-regression: without the `key:` constraint, the LAST
      // element_value_pair in the annotation wins because
      // prefixByClassId.set is called per match, in document order. So
      // `@RequestMapping(path = "/api", name = "myApi")` would mistakenly
      // set the prefix to `myApi`. With the constraint, only the
      // `path`/`value` pair is captured and the prefix stays `/api`.
      const dir = path.join(tmpDir, 'spring-class-prefix-last-wins');
      fs.mkdirSync(path.join(dir, 'src/controller'), { recursive: true });
      fs.writeFileSync(
        path.join(dir, 'src/controller/UserController.java'),
        `
package com.example;
import org.springframework.web.bind.annotation.*;

@RestController
@RequestMapping(path = "/api", name = "myApi")
public class UserController {
    @GetMapping("/users")
    public List<User> list() { return service.findAll(); }
}
`,
      );

      const contracts = await extractor.extract(null, dir, makeRepo(dir));
      const providers = contracts.filter((c) => c.role === 'provider');

      const route = providers.find((c) => c.contractId === 'http::GET::/api/users');
      expect(route).toBeDefined();

      // Must NOT have used `myApi` as the class prefix.
      expect(providers.find((c) => c.contractId === 'http::GET::/myApi/users')).toBeUndefined();
    });

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

    it('does not emit annotated Java interfaces as concrete Spring provider routes', async () => {
      const dir = path.join(tmpDir, 'spring-interface-only');
      fs.mkdirSync(path.join(dir, 'src/rest'), { recursive: true });
      fs.writeFileSync(
        path.join(dir, 'src/rest/DepartmentApi.java'),
        `
package com.example.rest;
import org.springframework.web.bind.annotation.*;

@RequestMapping("/departments")
public interface DepartmentApi {
    @GetMapping("")
    Object list();

    @GetMapping("/{name}")
    Object getByName(@PathVariable String name);
}
`,
      );

      const contracts = await extractor.extract(null, dir, makeRepo(dir));
      const providers = contracts.filter((c) => c.role === 'provider');

      expect(providers).toHaveLength(0);
    });

    it('inherits Spring interface route mappings when controller methods omit annotations', async () => {
      const dir = path.join(tmpDir, 'spring-interface-inherited-methods');
      fs.mkdirSync(path.join(dir, 'src/rest'), { recursive: true });
      fs.mkdirSync(path.join(dir, 'src/controller'), { recursive: true });

      fs.writeFileSync(
        path.join(dir, 'src/rest/StatusApi.java'),
        `
package com.example.rest;
import org.springframework.web.bind.annotation.*;

@RequestMapping("/status")
public interface StatusApi {
    @GetMapping("")
    Object getStatus();
}
`,
      );

      fs.writeFileSync(
        path.join(dir, 'src/controller/StatusController.java'),
        `
package com.example.controller;
import com.example.rest.StatusApi;
import org.springframework.web.bind.annotation.*;

@RestController
public class StatusController implements StatusApi {
    @Override
    public Object getStatus() { return null; }
}
`,
      );

      const contracts = await extractor.extract(null, dir, makeRepo(dir));
      const providers = contracts.filter((c) => c.role === 'provider');

      const statusRoute = providers.find((c) => c.contractId === 'http::GET::/status');
      expect(statusRoute).toBeDefined();
      expect(toPosixPath(statusRoute!.symbolRef.filePath)).toBe(
        'src/controller/StatusController.java',
      );
      expect(statusRoute!.symbolName).toBe('getStatus');
      expect(providers.filter((c) => c.symbolRef.filePath.includes('StatusApi.java'))).toHaveLength(
        0,
      );
    });

    it('combines controller class mapping with inherited interface method mapping', async () => {
      const dir = path.join(tmpDir, 'spring-interface-controller-prefix');
      fs.mkdirSync(path.join(dir, 'src/rest'), { recursive: true });
      fs.mkdirSync(path.join(dir, 'src/controller'), { recursive: true });

      fs.writeFileSync(
        path.join(dir, 'src/rest/UserApi.java'),
        `
package com.example.rest;
import org.springframework.web.bind.annotation.*;

public interface UserApi {
    @GetMapping("/users")
    Object listUsers();
}
`,
      );

      fs.writeFileSync(
        path.join(dir, 'src/controller/UserController.java'),
        `
package com.example.controller;
import com.example.rest.UserApi;
import org.springframework.web.bind.annotation.*;

@RestController
@RequestMapping("/api")
public class UserController implements UserApi {
    @Override
    public Object listUsers() { return null; }
}
`,
      );

      const contracts = await extractor.extract(null, dir, makeRepo(dir));
      const providers = contracts.filter((c) => c.role === 'provider');

      const usersRoute = providers.find((c) => c.contractId === 'http::GET::/api/users');
      expect(usersRoute).toBeDefined();
      expect(toPosixPath(usersRoute!.symbolRef.filePath)).toBe(
        'src/controller/UserController.java',
      );
      expect(usersRoute!.meta.framework).toBe('spring');
      expect(usersRoute!.confidence).toBe(0.8);
    });

    it('does not duplicate inherited Spring prefixes already present on the controller', async () => {
      const dir = path.join(tmpDir, 'spring-inherited-prefix-dedup');
      fs.mkdirSync(path.join(dir, 'src/rest'), { recursive: true });
      fs.mkdirSync(path.join(dir, 'src/controller'), { recursive: true });

      fs.writeFileSync(
        path.join(dir, 'src/rest/DataReleaseFacade.java'),
        `
package com.example.rest;
import org.springframework.web.bind.annotation.*;

@RequestMapping("/open/ai")
public interface DataReleaseFacade {
    @GetMapping("/query")
    Object query();
}
`,
      );

      fs.writeFileSync(
        path.join(dir, 'src/controller/BaseFacadeService.java'),
        `
package com.example.controller;
import org.springframework.web.bind.annotation.*;

@RequestMapping("/open/ai")
public abstract class BaseFacadeService {
}
`,
      );

      fs.writeFileSync(
        path.join(dir, 'src/controller/DataReleaseFacadeImpl.java'),
        `
package com.example.controller;
import com.example.rest.DataReleaseFacade;
import org.springframework.web.bind.annotation.*;

@RestController
@RequestMapping("/open/ai")
public class DataReleaseFacadeImpl extends BaseFacadeService implements DataReleaseFacade {
    @Override
    public Object query() { return null; }
}
`,
      );

      const contracts = await extractor.extract(null, dir, makeRepo(dir));
      const providers = contracts.filter((c) => c.role === 'provider');

      const queryRoute = providers.find((c) => c.contractId === 'http::GET::/open/ai/query');
      expect(queryRoute).toBeDefined();
      expect(toPosixPath(queryRoute!.symbolRef.filePath)).toBe(
        'src/controller/DataReleaseFacadeImpl.java',
      );
      expect(providers.find((c) => c.contractId === 'http::GET::/open/ai/open/ai/query')).toBe(
        undefined,
      );
    });

    it('still combines distinct inherited Spring prefixes that share a leading segment', async () => {
      const dir = path.join(tmpDir, 'spring-interface-shared-leading-prefix');
      fs.mkdirSync(path.join(dir, 'src/rest'), { recursive: true });
      fs.mkdirSync(path.join(dir, 'src/controller'), { recursive: true });

      fs.writeFileSync(
        path.join(dir, 'src/rest/DataReleaseApi.java'),
        `
package com.example.rest;
import org.springframework.web.bind.annotation.*;

@RequestMapping("/open/ai")
public interface DataReleaseApi {
    @GetMapping("/query")
    Object query();
}
`,
      );

      fs.writeFileSync(
        path.join(dir, 'src/controller/DataReleaseFacadeImpl.java'),
        `
package com.example.controller;
import com.example.rest.DataReleaseApi;
import org.springframework.web.bind.annotation.*;

@RestController
@RequestMapping("/open")
public class DataReleaseFacadeImpl implements DataReleaseApi {
    @Override
    public Object query() { return null; }
}
`,
      );

      const contracts = await extractor.extract(null, dir, makeRepo(dir));
      const providers = contracts.filter((c) => c.role === 'provider');

      expect(
        providers.find((c) => c.contractId === 'http::GET::/open/open/ai/query'),
      ).toBeDefined();
      expect(providers.find((c) => c.contractId === 'http::GET::/open/ai/query')).toBeUndefined();
    });

    it('keeps a controller prefix when a prefix-less interface method starts with the same path', async () => {
      const dir = path.join(tmpDir, 'spring-interface-method-prefix-overlap');
      fs.mkdirSync(path.join(dir, 'src/rest'), { recursive: true });
      fs.mkdirSync(path.join(dir, 'src/controller'), { recursive: true });

      fs.writeFileSync(
        path.join(dir, 'src/rest/UserApi.java'),
        `
package com.example.rest;
import org.springframework.web.bind.annotation.*;

public interface UserApi {
    @GetMapping("/users/{id}")
    Object getUser();
}
`,
      );

      fs.writeFileSync(
        path.join(dir, 'src/controller/UserController.java'),
        `
package com.example.controller;
import com.example.rest.UserApi;
import org.springframework.web.bind.annotation.*;

@RestController
@RequestMapping("/users")
public class UserController implements UserApi {
    @Override
    public Object getUser() { return null; }
}
`,
      );

      const contracts = await extractor.extract(null, dir, makeRepo(dir));
      const providers = contracts.filter((c) => c.role === 'provider');

      expect(
        providers.find((c) => c.contractId === 'http::GET::/users/users/{param}'),
      ).toBeDefined();
      expect(providers.find((c) => c.contractId === 'http::GET::/users/{param}')).toBeUndefined();
    });

    it('skips ambiguous inherited routes when interfaces share a simple name', async () => {
      const dir = path.join(tmpDir, 'spring-interface-simple-name-collision');
      fs.mkdirSync(path.join(dir, 'src/a'), { recursive: true });
      fs.mkdirSync(path.join(dir, 'src/b'), { recursive: true });
      fs.mkdirSync(path.join(dir, 'src/controller'), { recursive: true });

      fs.writeFileSync(
        path.join(dir, 'src/a/StatusApi.java'),
        `
package com.example.a;
import org.springframework.web.bind.annotation.*;

public interface StatusApi {
    @GetMapping("/a/status")
    Object getStatus();
}
`,
      );

      fs.writeFileSync(
        path.join(dir, 'src/b/StatusApi.java'),
        `
package com.example.b;
import org.springframework.web.bind.annotation.*;

public interface StatusApi {
    @GetMapping("/b/status")
    Object getStatus();
}
`,
      );

      fs.writeFileSync(
        path.join(dir, 'src/controller/StatusController.java'),
        `
package com.example.controller;
import com.example.a.StatusApi;
import org.springframework.web.bind.annotation.*;

@RestController
public class StatusController implements StatusApi {
    @Override
    public Object getStatus() { return null; }
}
`,
      );

      const contracts = await extractor.extract(null, dir, makeRepo(dir));
      const providers = contracts.filter((c) => c.role === 'provider');

      expect(providers.find((c) => c.contractId === 'http::GET::/b/status')).toBeUndefined();
      expect(providers.find((c) => c.contractId === 'http::GET::/a/status')).toBeUndefined();
      expect(
        providers.filter((c) => c.symbolRef.filePath.includes('StatusController.java')),
      ).toHaveLength(0);
    });

    it('extracts fully-qualified Java route annotations (#2254 FQN follow-through)', async () => {
      // JAVA_ROUTE_ANNOTATION_PATTERNS now binds `name: [(identifier)
      // (scoped_identifier)]`; a deep FQN route annotation
      // (`@org.springframework…GetMapping`) is matched and the for-loop
      // normalizes the name to its trailing segment (`simpleName`). The
      // controller was already recognised (hasAnnotation trailing-segment match);
      // now the route string is extracted too — parity with the Kotlin plugin.
      const dir = path.join(tmpDir, 'java-fqn-route-annotation');
      fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
      fs.writeFileSync(
        path.join(dir, 'src', 'FqnController.java'),
        `
@org.springframework.web.bind.annotation.RestController
@org.springframework.web.bind.annotation.RequestMapping("/api")
class FqnController {
  @org.springframework.web.bind.annotation.GetMapping("/users")
  Object users() { return null; }
}
`,
      );

      const contracts = await extractor.extract(null, dir, makeRepo(dir));
      const providers = contracts.filter((c) => c.role === 'provider');

      expect(
        providers.find(
          (c) =>
            c.contractId === 'http::GET::/api/users' &&
            c.meta.framework === 'spring' &&
            c.confidence === 0.8,
        ),
      ).toBeDefined();
    });

    it('extracts FQN OpenFeign consumers + two-segment FQN, with anti-overreach', async () => {
      const dir = path.join(tmpDir, 'java-fqn-feign');
      fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
      fs.writeFileSync(
        path.join(dir, 'src', 'QualifiedClient.java'),
        `
@org.springframework.cloud.openfeign.FeignClient(name = "order-service", path = "/api")
interface QualifiedClient {
  @org.springframework.web.bind.annotation.GetMapping("/orders/{id}")
  OrderDto getOrder(String id);
}

@foo.RestController
@foo.RequestMapping("/v2")
class ShortFqnController {
  @foo.GetMapping("/items")
  Object items() { return null; }
}

@com.example.NotARoute("/should-not-extract")
class Unrelated {
  @com.example.AlsoNotARoute("/nope")
  Object noop() { return null; }
}
`,
      );

      const contracts = await extractor.extract(null, dir, makeRepo(dir));
      const fromFile = contracts.filter((c) =>
        c.symbolRef.filePath.endsWith('QualifiedClient.java'),
      );

      // Exactly two contracts: the FQN @FeignClient(path)+@GetMapping consumer and
      // the two-segment-FQN provider. The `Unrelated` class's non-route FQN
      // annotations contribute nothing (anti-overreach — simpleName misses them).
      expect(new Set(fromFile.map((c) => `${c.role} ${c.contractId} ${c.meta.framework}`))).toEqual(
        new Set([
          'consumer http::GET::/api/orders/{param} openfeign',
          'provider http::GET::/v2/items spring',
        ]),
      );
    });

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
router.get('/api/health', healthA);
`,
      );
      fs.writeFileSync(
        path.join(dir, 'src/routes/health-b.ts'),
        `
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

func healthHandler(w http.ResponseWriter, r *http.Request) {}

func main() {
  http.HandleFunc("/api/health", healthHandler)
}
`,
      );

      const contracts = await extractor.extract(null, dir, makeRepo(dir));
      const providers = contracts.filter((c) => c.role === 'provider');

      const healthRoute = providers.find((c) => c.contractId === 'http::GET::/api/health');
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
`,
      );

      const contracts = await extractor.extract(null, dir, makeRepo(dir));
      const consumers = contracts.filter((c) => c.role === 'consumer');

      expect(consumers.find((c) => c.contractId === 'http::POST::/api/orders')).toBeDefined();
      expect(consumers.find((c) => c.contractId === 'http::PUT::/api/users/{param}')).toBeDefined();
      expect(consumers.find((c) => c.contractId === 'http::GET::/api/defaults')).toBeDefined();
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

    it('extracts Java Spring RestTemplate, WebClient and OkHttp literal calls', async () => {
      const dir = path.join(tmpDir, 'java-consumer');
      fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
      fs.writeFileSync(
        path.join(dir, 'src', 'ApiClient.java'),
        `
import org.springframework.http.HttpMethod;
import org.springframework.web.client.RestTemplate;
import org.springframework.web.reactive.function.client.WebClient;
import okhttp3.Request;

class ApiClient {
  void run(RestTemplate restTemplate, WebClient webClient) {
    restTemplate.getForObject("/api/users/{id}", String.class, 42);
    restTemplate.exchange("/api/users/{id}/details", HttpMethod.GET, null, String.class);
    webClient.post().uri("/api/users");
    new Request.Builder().url("/api/orders/42").build();
  }
}
`,
      );

      const contracts = await extractor.extract(null, dir, makeRepo(dir));
      const consumers = contracts.filter((c) => c.role === 'consumer');

      expect(consumers.find((c) => c.contractId === 'http::GET::/api/users/{param}')).toBeDefined();
      expect(
        consumers.find((c) => c.contractId === 'http::GET::/api/users/{param}/details'),
      ).toBeDefined();
      expect(
        consumers.find((c) => c.contractId === 'http::GET::/api/orders/{param}'),
      ).toBeDefined();
      expect(
        consumers.find(
          (c) =>
            c.contractId === 'http::GET::/api/users/{param}/details' &&
            c.meta.framework === 'spring-rest-template' &&
            c.confidence === 0.7,
        ),
      ).toBeDefined();
      expect(
        consumers.find(
          (c) =>
            c.contractId === 'http::POST::/api/users' &&
            c.meta.framework === 'spring-web-client' &&
            c.confidence === 0.7,
        ),
      ).toBeDefined();
    });

    it('extracts Java RestTemplate URI.create(...) static paths', async () => {
      const dir = path.join(tmpDir, 'java-rest-template-uri-create');
      fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
      fs.writeFileSync(
        path.join(dir, 'src', 'UriClient.java'),
        `
import java.net.URI;
import org.springframework.http.HttpMethod;
import org.springframework.web.client.RestTemplate;

class UriClient {
  void run(RestTemplate restTemplate) {
    String dynamicPath = "/api/dynamic-users/99";
    restTemplate.getForEntity(URI.create("/api/uri-users/42"), String.class);
    restTemplate.exchange(URI.create("/api/uri-users/42/details"), HttpMethod.POST, null, String.class);
    restTemplate.getForObject(dynamicPath, String.class);
  }
}
`,
      );

      const contracts = await extractor.extract(null, dir, makeRepo(dir));
      const consumers = contracts.filter((c) => c.role === 'consumer');

      expect(
        consumers.find(
          (c) =>
            c.contractId === 'http::GET::/api/uri-users/{param}' &&
            c.meta.framework === 'spring-rest-template' &&
            c.confidence === 0.7,
        ),
      ).toBeDefined();
      expect(
        consumers.find((c) => c.contractId === 'http::POST::/api/uri-users/{param}/details'),
      ).toBeDefined();
      // Anti-overreach: a variable-bound path is not statically resolvable, so
      // the widened `(_) @path` capture must NOT emit a consumer for it.
      expect(
        consumers.find((c) => c.contractId === 'http::GET::/api/dynamic-users/{param}'),
      ).toBeUndefined();
    });

    it('extracts Java RestTemplate UriComponentsBuilder fluent-chain paths', async () => {
      const dir = path.join(tmpDir, 'java-rest-template-builder');
      fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
      fs.writeFileSync(
        path.join(dir, 'src', 'BuilderClient.java'),
        `
import org.springframework.web.client.RestTemplate;
import org.springframework.web.util.UriComponentsBuilder;

class BuilderClient {
  void run(RestTemplate restTemplate, String idVar) {
    restTemplate.getForObject(
        UriComponentsBuilder.fromPath("/api").path("/builder-users").pathSegment("42").build().toUriString(),
        String.class);
    restTemplate.getForObject(
        UriComponentsBuilder.fromUriString("/base").path("/sub").queryParam("page", "1").build().toUriString(),
        String.class);
    restTemplate.getForObject(
        UriComponentsBuilder.fromHttpUrl("https://example.com/api").path("/external-users").query("page=1").build().toUriString(),
        String.class);
    restTemplate.getForObject(
        UriComponentsBuilder.fromPath("/api").pathSegment(idVar).build().toUriString(),
        String.class);
  }
}
`,
      );

      const contracts = await extractor.extract(null, dir, makeRepo(dir));
      const consumers = contracts.filter((c) => c.role === 'consumer');

      // fromPath + path + numeric pathSegment → joined, numeric → {param}.
      expect(
        consumers.find((c) => c.contractId === 'http::GET::/api/builder-users/{param}'),
      ).toBeDefined();
      // fromUriString seed + path; the queryParam attribute does not alter the path.
      expect(consumers.find((c) => c.contractId === 'http::GET::/base/sub')).toBeDefined();
      // fromHttpUrl host seed: helper keeps the host; normalizeConsumerPath strips it.
      expect(
        consumers.find((c) => c.contractId === 'http::GET::/api/external-users'),
      ).toBeDefined();
      // Anti-overreach: the non-literal `pathSegment(idVar)` call defeats static
      // resolution, so exactly the three resolvable chains emit — not a fourth.
      expect(
        consumers.filter((c) => c.symbolRef.filePath.endsWith('BuilderClient.java')),
      ).toHaveLength(3);
    });

    it('strips a query string baked into a UriComponentsBuilder seed (#2268)', async () => {
      const dir = path.join(tmpDir, 'java-rest-template-builder-query-seed');
      fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
      fs.writeFileSync(
        path.join(dir, 'src', 'QuerySeedClient.java'),
        `
import org.springframework.web.client.RestTemplate;
import org.springframework.web.util.UriComponentsBuilder;

class QuerySeedClient {
  void run(RestTemplate restTemplate) {
    restTemplate.getForObject(
        UriComponentsBuilder.fromUriString("/base?x=1").path("/sub").build().toUriString(),
        String.class);
    restTemplate.getForObject(
        UriComponentsBuilder.fromHttpUrl("https://example.com/api?x=1").path("/y").build().toUriString(),
        String.class);
  }
}
`,
      );

      const contracts = await extractor.extract(null, dir, makeRepo(dir));
      const consumers = contracts.filter((c) => c.role === 'consumer');

      // Query in the seed must NOT swallow the later .path() segment:
      // fromUriString("/base?x=1").path("/sub") → /base/sub (was /base before the fix).
      expect(consumers.find((c) => c.contractId === 'http::GET::/base/sub')).toBeDefined();
      // Host + query seed: query stripped at the seed, host stripped downstream.
      expect(consumers.find((c) => c.contractId === 'http::GET::/api/y')).toBeDefined();
      // Count guard: exactly the two resolvable chains. A regression that
      // double-emitted (e.g. both /base and /base/sub) would slip past the two
      // `find` assertions above without this.
      expect(
        consumers.filter((c) => c.symbolRef.filePath.endsWith('QuerySeedClient.java')),
      ).toHaveLength(2);
    });

    it('resolves a UriComponentsBuilder argument passed to restTemplate.exchange (#2268)', async () => {
      // The exchange() path capture was widened to `(_) @path` alongside the
      // plain RestTemplate loop, but was only covered with URI.create. Pin that a
      // UriComponentsBuilder chain through exchange() also resolves end-to-end.
      const dir = path.join(tmpDir, 'java-rest-template-exchange-builder');
      fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
      fs.writeFileSync(
        path.join(dir, 'src', 'ExchangeBuilderClient.java'),
        `
import org.springframework.http.HttpMethod;
import org.springframework.web.client.RestTemplate;
import org.springframework.web.util.UriComponentsBuilder;

class ExchangeBuilderClient {
  void run(RestTemplate restTemplate) {
    restTemplate.exchange(
        UriComponentsBuilder.fromPath("/api").path("/exchange-users").build().toUriString(),
        HttpMethod.PUT, null, String.class);
  }
}
`,
      );

      const contracts = await extractor.extract(null, dir, makeRepo(dir));
      const consumers = contracts.filter((c) => c.role === 'consumer');
      expect(
        consumers.find((c) => c.contractId === 'http::PUT::/api/exchange-users'),
      ).toBeDefined();
    });

    it('appends UriComponentsBuilder .path() verbatim per Spring semantics (#2268)', async () => {
      // Spring `.path(p)` appends `p` as-is (no slash inserted) then collapses
      // duplicate slashes — unlike `.pathSegment`, which slash-joins. So a
      // no-leading-slash arg is NOT given a phantom slash, a leading-slash arg
      // joins cleanly, a trailing-slash base collapses, and a host seed keeps its
      // `://` until the downstream normalizer strips the host.
      const dir = path.join(tmpDir, 'java-rest-template-builder-path');
      fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
      fs.writeFileSync(
        path.join(dir, 'src', 'PathClient.java'),
        `
import org.springframework.web.client.RestTemplate;
import org.springframework.web.util.UriComponentsBuilder;

class PathClient {
  void run(RestTemplate restTemplate) {
    restTemplate.getForObject(UriComponentsBuilder.fromPath("/api").path("noslash").build().toUriString(), String.class);
    restTemplate.getForObject(UriComponentsBuilder.fromPath("/svc").path("/withslash").build().toUriString(), String.class);
    restTemplate.getForObject(UriComponentsBuilder.fromPath("/trail/").path("/seg").build().toUriString(), String.class);
    restTemplate.getForObject(UriComponentsBuilder.fromPath("/first-").path("value/").path("/end").build().toUriString(), String.class);
    restTemplate.getForObject(UriComponentsBuilder.fromHttpUrl("https://example.com/api").path("/ext").build().toUriString(), String.class);
    restTemplate.getForObject(UriComponentsBuilder.fromPath("/empty").path("").build().toUriString(), String.class);
  }
}
`,
      );

      const contracts = await extractor.extract(null, dir, makeRepo(dir));
      const fromFile = contracts.filter(
        (c) => c.role === 'consumer' && c.symbolRef.filePath.endsWith('PathClient.java'),
      );

      // Exactly these six — no phantom slash on the no-leading-slash arg, no
      // double slash from the trailing-slash base, no `://` corruption.
      expect(new Set(fromFile.map((c) => c.contractId))).toEqual(
        new Set([
          'http::GET::/apinoslash', // fromPath("/api").path("noslash") — verbatim, no slash
          'http::GET::/svc/withslash', // leading-slash arg joins cleanly
          'http::GET::/trail/seg', // trailing-slash base collapses
          'http::GET::/first-value/end', // value/ + /end → one slash
          'http::GET::/api/ext', // host seed: `://` kept, host stripped downstream
          'http::GET::/empty', // empty .path("") is a no-op
        ]),
      );
    });

    it('does not overflow on a pathological UriComponentsBuilder chain (#2268)', async () => {
      const dir = path.join(tmpDir, 'java-rest-template-builder-deep');
      fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
      // A chain far deeper than the recursion cap — exercises the depth guard.
      const deepChain = `UriComponentsBuilder.fromPath("/r")${'.path("/x")'.repeat(200)}.build().toUriString()`;
      fs.writeFileSync(
        path.join(dir, 'src', 'DeepClient.java'),
        `
import org.springframework.web.client.RestTemplate;
import org.springframework.web.util.UriComponentsBuilder;

class DeepClient {
  void run(RestTemplate restTemplate) {
    restTemplate.getForObject(${deepChain}, String.class);
  }
}
`,
      );

      // Must not throw (the depth guard caps recursion). A chain past the cap
      // resolves to null, so no consumer is emitted for it (without the guard it
      // would either overflow or resolve to a bogus deep path).
      const contracts = await extractor.extract(null, dir, makeRepo(dir));
      expect(
        contracts.filter(
          (c) => c.role === 'consumer' && c.symbolRef.filePath.endsWith('DeepClient.java'),
        ),
      ).toHaveLength(0);
    });

    it('infers Java OkHttp verbs from sibling Request.Builder calls', async () => {
      const dir = path.join(tmpDir, 'java-okhttp-verbs');
      fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
      fs.writeFileSync(
        path.join(dir, 'src', 'OkHttpVerbs.java'),
        `
import okhttp3.Request;
import okhttp3.RequestBody;

class OkHttpVerbs {
  void run(RequestBody body, String verb) {
    new Request.Builder().url("/api/orders/0").get().build();
    new Request.Builder().url("/api/orders/head").head().build();
    new Request.Builder().url("/api/orders").post(body).build();
    new Request.Builder().url("/api/orders/1").put(body).build();
    new Request.Builder().url("/api/orders/2").delete().build();
    new Request.Builder().url("/api/orders/3").method("PATCH", body).build();
    new Request.Builder().url("/api/bare-build").build();
    new Request.Builder().url("/api/dyn-verb").method(verb, body).build();
  }
}
`,
      );

      const contracts = await extractor.extract(null, dir, makeRepo(dir));
      const okhttp = contracts.filter(
        (c) =>
          c.role === 'consumer' &&
          c.meta.framework === 'okhttp' &&
          c.symbolRef.filePath.endsWith('OkHttpVerbs.java'),
      );

      // The bare `.build()` with no verb call gets its OWN path (`/api/bare-build`)
      // so the default-GET branch of inferOkHttpMethod is pinned independently.
      // An explicit `.method(verb, …)` with a *variable* verb (`/api/dyn-verb`) is
      // unresolvable and emits NOTHING — not a guessed GET (parity with WebClient
      // long-form). Explicit verbs resolve; numeric segments normalize to {param}.
      expect(okhttp.find((c) => c.contractId === 'http::GET::/api/bare-build')).toBeDefined();
      // Variable-bound `.method(verb)` produces no contract at all (any verb).
      expect(okhttp.find((c) => c.contractId.includes('/api/dyn-verb'))).toBeUndefined();
      expect(new Set(okhttp.map((c) => c.contractId))).toEqual(
        new Set([
          'http::GET::/api/bare-build',
          'http::GET::/api/orders/{param}',
          'http::POST::/api/orders',
          'http::PUT::/api/orders/{param}',
          'http::DELETE::/api/orders/{param}',
          'http::PATCH::/api/orders/{param}',
          'http::HEAD::/api/orders/head',
        ]),
      );
      expect(okhttp.every((c) => c.confidence === 0.7)).toBe(true);
    });

    it('does not emit a contract for an empty-string verb literal (#2268)', async () => {
      // `.method("", body)` is an explicit-but-unresolvable verb — `unquoteLiteral`
      // returns "" (not null), so the falsiness guard must skip it rather than
      // emit a malformed `http::::/path` contract or a guessed GET. Covers both
      // the OkHttp and Java-HttpClient verb-walks (shared `inferBuilderVerb`).
      const dir = path.join(tmpDir, 'java-empty-verb');
      fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
      fs.writeFileSync(
        path.join(dir, 'src', 'EmptyVerb.java'),
        `
import java.net.URI;
import java.net.http.HttpRequest;
import okhttp3.Request;
import okhttp3.RequestBody;

class EmptyVerb {
  void run(RequestBody body) throws Exception {
    new Request.Builder().url("/api/okhttp-empty").method("", body).build();
    HttpRequest hc = HttpRequest.newBuilder().uri(URI.create("/api/hc-empty")).method("", body).build();
  }
}
`,
      );

      const contracts = await extractor.extract(null, dir, makeRepo(dir));
      const fromFile = contracts.filter(
        (c) => c.role === 'consumer' && c.symbolRef.filePath.endsWith('EmptyVerb.java'),
      );

      // No contract at all — neither a malformed empty-method id nor a guessed GET.
      expect(fromFile.map((c) => c.contractId)).toEqual([]);
    });

    it('extracts OkHttp chains with a builder call before .url(), with anti-overreach (#2268)', async () => {
      // A builder call BEFORE .url() (`new Request.Builder().addHeader(...).url(...)`)
      // no longer drops the contract — the chain is matched as long as it roots at
      // `new Request.Builder()`. The verb-walk scans the whole chain, so a verb set
      // before .url() also resolves. A `.url(...)` on an unrelated object does NOT
      // emit (the root gate rejects it).
      const dir = path.join(tmpDir, 'java-okhttp-pre-url');
      fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
      fs.writeFileSync(
        path.join(dir, 'src', 'OkHttpPreUrl.java'),
        `
import okhttp3.Request;
import okhttp3.RequestBody;

class OkHttpPreUrl {
  void run(RequestBody body, SomeClient other) {
    new Request.Builder().addHeader("A", "b").url("/api/pre-url").build();
    new Request.Builder().post(body).url("/api/verb-first").build();
    other.url("/api/not-okhttp").build();
  }
}
`,
      );

      const contracts = await extractor.extract(null, dir, makeRepo(dir));
      const okhttp = contracts.filter(
        (c) =>
          c.role === 'consumer' &&
          c.meta.framework === 'okhttp' &&
          c.symbolRef.filePath.endsWith('OkHttpPreUrl.java'),
      );

      // The header-before-url chain (default GET) and the verb-before-url chain
      // (POST) both emit; `other.url(...)` does not (not a Request.Builder chain).
      expect(new Set(okhttp.map((c) => c.contractId))).toEqual(
        new Set(['http::GET::/api/pre-url', 'http::POST::/api/verb-first']),
      );
    });

    it('extracts Java WebClient long-form method(HttpMethod.X).uri(...) — #2254 parity', async () => {
      // Parity with the Kotlin plugin: a single structural query matches the
      // verb (HttpMethod.X field access) and path. Previously deferred on the
      // Java side; PR #2254 lifts it so .java and .kt detect it identically.
      const dir = path.join(tmpDir, 'java-web-client-long-form');
      fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
      fs.writeFileSync(
        path.join(dir, 'src', 'LongFormClient.java'),
        `
import org.springframework.http.HttpMethod;
import org.springframework.web.reactive.function.client.WebClient;

class LongFormClient {
  void run(WebClient webClient) {
    webClient.method(HttpMethod.GET).uri("/api/get").retrieve();
    webClient.method(HttpMethod.POST).uri("/api/post").retrieve();
    webClient.method(HttpMethod.PUT).uri("/api/put").retrieve();
    webClient.method(HttpMethod.DELETE).uri("/api/delete").retrieve();
    webClient.method(HttpMethod.PATCH).uri("/api/users/42").retrieve();
  }
}
`,
      );

      const contracts = await extractor.extract(null, dir, makeRepo(dir));
      const consumers = contracts.filter((c) => c.role === 'consumer');

      for (const [verb, p] of [
        ['GET', '/api/get'],
        ['POST', '/api/post'],
        ['PUT', '/api/put'],
        ['DELETE', '/api/delete'],
        ['PATCH', '/api/users/{param}'],
      ]) {
        expect(
          consumers.find(
            (c) =>
              c.contractId === `http::${verb}::${p}` &&
              c.meta.framework === 'spring-web-client' &&
              c.confidence === 0.7,
          ),
        ).toBeDefined();
      }
      // No double-emit: the short-form query cannot also fire on the long form.
      expect(consumers.filter((c) => c.contractId === 'http::GET::/api/get')).toHaveLength(1);
    });

    it('does NOT match Java WebClient long-form with a variable-bound verb', async () => {
      // The value carries a bare identifier, not a HttpMethod.X field access —
      // source-scan can't follow the binding (anti-overreach, parity with Kotlin).
      const dir = path.join(tmpDir, 'java-web-client-long-form-var');
      fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
      fs.writeFileSync(
        path.join(dir, 'src', 'VarVerbClient.java'),
        `
import org.springframework.http.HttpMethod;
import org.springframework.web.reactive.function.client.WebClient;

class VarVerbClient {
  void run(WebClient webClient, HttpMethod verb) {
    webClient.method(verb).uri("/api/users/42").retrieve();
  }
}
`,
      );

      const contracts = await extractor.extract(null, dir, makeRepo(dir));
      const consumers = contracts.filter((c) => c.role === 'consumer');

      expect(
        consumers.find(
          (c) => c.contractId.startsWith('http::') && c.contractId.includes('/api/users'),
        ),
      ).toBeUndefined();
    });

    it('handles Java array-form annotation paths ({"/x"}, key = {"/x"})', async () => {
      const dir = path.join(tmpDir, 'java-array-paths');
      fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
      // Provider: array class prefix + array method path.
      fs.writeFileSync(
        path.join(dir, 'src', 'ProductController.java'),
        `
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.GetMapping;

@RestController
@RequestMapping({"/api/products"})
class ProductController {
  @GetMapping(path = {"/{id}"})
  Product get(Integer id) { return null; }
}
`,
      );
      // OpenFeign consumer with array positional path.
      fs.writeFileSync(
        path.join(dir, 'src', 'OrdersClient.java'),
        `
import org.springframework.cloud.openfeign.FeignClient;
import org.springframework.web.bind.annotation.PostMapping;

@FeignClient(name = "orders")
interface OrdersClient {
  @PostMapping({"/orders/search"})
  Object search();
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
      // @FeignClient with array positional path → consumer.
      expect(
        consumers.find(
          (c) => c.contractId === 'http::POST::/orders/search' && c.meta.framework === 'openfeign',
        ),
      ).toBeDefined();
    });

    it('extracts OpenFeign clients as consumers, not providers', async () => {
      const dir = path.join(tmpDir, 'java-openfeign-consumer');
      fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
      fs.writeFileSync(
        path.join(dir, 'src', 'OrderClient.java'),
        `
import org.springframework.cloud.openfeign.FeignClient;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.PathVariable;

@FeignClient(name = "order-service", url = "\${order.service.url}", path = "/api")
interface OrderClient {
  @GetMapping("/orders/{id}")
  OrderDto getOrder(@PathVariable("id") String id);

  @PostMapping(path = "/orders")
  OrderDto createOrder(OrderDto body);
}
`,
      );

      const contracts = await extractor.extract(null, dir, makeRepo(dir));
      const consumers = contracts.filter((c) => c.role === 'consumer');
      const providers = contracts.filter((c) => c.role === 'provider');

      expect(
        consumers.find((c) => c.contractId === 'http::GET::/api/orders/{param}'),
      ).toBeDefined();
      expect(
        consumers.find(
          (c) =>
            c.contractId === 'http::POST::/api/orders' &&
            c.meta.framework === 'openfeign' &&
            c.confidence === 0.7,
        ),
      ).toBeDefined();
      expect(
        providers.find((c) => c.symbolRef.filePath.endsWith('OrderClient.java')),
      ).toBeUndefined();
    });

    it('extracts Spring HTTP Interface @(Get|...)Exchange clients as consumers', async () => {
      const dir = path.join(tmpDir, 'java-http-exchange-consumer');
      fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
      fs.writeFileSync(
        path.join(dir, 'src', 'InventoryApi.java'),
        `
import org.springframework.web.service.annotation.HttpExchange;
import org.springframework.web.service.annotation.GetExchange;
import org.springframework.web.service.annotation.PostExchange;

@HttpExchange(url = "/items")
interface InventoryApi {
  @GetExchange(url = "/{id}")
  Item getItem(Integer id);

  @PostExchange("/search")
  Page<Item> search(ItemFilter query);
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
      // Declarative HTTP-interface methods are consumers, never providers.
      expect(
        providers.find((c) => c.symbolRef.filePath.endsWith('InventoryApi.java')),
      ).toBeUndefined();
    });

    it('extracts OpenFeign clients without an interface path prefix', async () => {
      const dir = path.join(tmpDir, 'java-openfeign-no-prefix');
      fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
      fs.writeFileSync(
        path.join(dir, 'src', 'HealthClient.java'),
        `
import org.springframework.cloud.openfeign.FeignClient;
import org.springframework.web.bind.annotation.GetMapping;

@FeignClient(name = "health-service")
interface HealthClient {
  @GetMapping("/health")
  String health();
}
`,
      );

      const contracts = await extractor.extract(null, dir, makeRepo(dir));
      const consumers = contracts.filter((c) => c.role === 'consumer');
      const providers = contracts.filter((c) => c.role === 'provider');

      expect(
        consumers.find(
          (c) =>
            c.contractId === 'http::GET::/health' &&
            c.meta.framework === 'openfeign' &&
            c.confidence === 0.7,
        ),
      ).toBeDefined();
      expect(
        providers.find((c) => c.symbolRef.filePath.endsWith('HealthClient.java')),
      ).toBeUndefined();
    });

    it('does not treat @FeignClient text in an interface body as a Feign annotation', async () => {
      const dir = path.join(tmpDir, 'java-non-feign-interface-text');
      fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
      fs.writeFileSync(
        path.join(dir, 'src', 'NotFeignClient.java'),
        `
import org.springframework.web.bind.annotation.GetMapping;

interface NotFeignClient {
  String MARKER = "@FeignClient";

  @GetMapping("/not-feign")
  String call();
}
`,
      );

      const contracts = await extractor.extract(null, dir, makeRepo(dir));
      const consumers = contracts.filter((c) => c.role === 'consumer');
      const providers = contracts.filter((c) => c.role === 'provider');

      expect(consumers.find((c) => c.contractId === 'http::GET::/not-feign')).toBeUndefined();
      expect(providers.find((c) => c.contractId === 'http::GET::/not-feign')).toBeUndefined();
    });

    it('extracts OpenFeign clients with @RequestMapping interface prefixes', async () => {
      const dir = path.join(tmpDir, 'java-openfeign-request-mapping-prefix');
      fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
      fs.writeFileSync(
        path.join(dir, 'src', 'InventoryClient.java'),
        `
import org.springframework.cloud.openfeign.FeignClient;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMapping;

@FeignClient(name = "inventory-service")
@RequestMapping(path = "/api")
interface InventoryClient {
  @GetMapping("/inventory/{id}")
  InventoryDto getInventory(String id);
}
`,
      );

      const contracts = await extractor.extract(null, dir, makeRepo(dir));
      const consumers = contracts.filter((c) => c.role === 'consumer');

      expect(
        consumers.find(
          (c) =>
            c.contractId === 'http::GET::/api/inventory/{param}' &&
            c.meta.framework === 'openfeign',
        ),
      ).toBeDefined();
    });

    it('prefers @FeignClient(path=...) over @RequestMapping prefixes on OpenFeign clients', async () => {
      const dir = path.join(tmpDir, 'java-openfeign-prefix-precedence');
      fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
      fs.writeFileSync(
        path.join(dir, 'src', 'PrecedenceClient.java'),
        `
import org.springframework.cloud.openfeign.FeignClient;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMapping;

@FeignClient(name = "order-service", path = "/feign-path")
@RequestMapping("/rm-path")
interface PrecedenceClient {
  @GetMapping("/orders")
  OrderDto getOrders();
}
`,
      );

      const contracts = await extractor.extract(null, dir, makeRepo(dir));
      const consumers = contracts.filter((c) => c.role === 'consumer');

      expect(consumers.find((c) => c.contractId === 'http::GET::/feign-path/orders')).toBeDefined();
      expect(consumers.find((c) => c.contractId === 'http::GET::/rm-path/orders')).toBeUndefined();
    });

    it('extracts native @RequestLine consumers on @FeignClient interfaces', async () => {
      const dir = path.join(tmpDir, 'java-feign-request-line-basic');
      fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
      fs.writeFileSync(
        path.join(dir, 'src', 'AiClient.java'),
        `
import org.springframework.cloud.openfeign.FeignClient;
import feign.RequestLine;

@FeignClient(name = "ai-backend")
interface AiClient {
  @RequestLine("POST /ai/summarize")
  String summarize();

  @RequestLine("GET /ai/health")
  String health();
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
          (c) =>
            c.contractId === 'http::GET::/ai/health' &&
            c.meta.framework === 'openfeign' &&
            c.confidence === 0.75,
        ),
      ).toBeDefined();
    });

    it('joins @FeignClient(path=...) prefix with @RequestLine paths', async () => {
      const dir = path.join(tmpDir, 'java-feign-request-line-prefix');
      fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
      fs.writeFileSync(
        path.join(dir, 'src', 'OrderClient.java'),
        `
import org.springframework.cloud.openfeign.FeignClient;
import feign.RequestLine;

@FeignClient(name = "order-service", path = "/api")
interface OrderClient {
  @RequestLine("GET /orders/{id}")
  OrderDto get(Long id);

  @RequestLine("DELETE /orders/{id}")
  void delete(Long id);
}
`,
      );

      const contracts = await extractor.extract(null, dir, makeRepo(dir));
      const consumers = contracts.filter((c) => c.role === 'consumer');

      expect(
        consumers.find((c) => c.contractId === 'http::GET::/api/orders/{param}'),
      ).toBeDefined();
      expect(
        consumers.find((c) => c.contractId === 'http::DELETE::/api/orders/{param}'),
      ).toBeDefined();
    });

    it('strips query strings from @RequestLine values when forming contract IDs', async () => {
      const dir = path.join(tmpDir, 'java-feign-request-line-query');
      fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
      fs.writeFileSync(
        path.join(dir, 'src', 'SearchClient.java'),
        `
import org.springframework.cloud.openfeign.FeignClient;
import feign.RequestLine;

@FeignClient(name = "search-service")
interface SearchClient {
  @RequestLine("GET /search?q={query}&limit={limit}")
  SearchResult search();
}
`,
      );

      const contracts = await extractor.extract(null, dir, makeRepo(dir));
      const consumers = contracts.filter((c) => c.role === 'consumer');

      // Query string is dropped — contract ID is method+path only.
      expect(consumers.find((c) => c.contractId === 'http::GET::/search')).toBeDefined();
      expect(
        consumers.find((c) => c.contractId.includes('?') || c.contractId.includes('limit')),
      ).toBeUndefined();
    });

    it('extracts native @RequestLine on a plain interface without @FeignClient (Feign.builder())', async () => {
      // The canonical core-Feign usage: a plain interface with `@RequestLine`,
      // wired up via `Feign.builder()`. There is NO `@FeignClient` annotation
      // (that is the Spring Cloud variant, which uses Spring MVC annotations and
      // is mutually exclusive with `@RequestLine`). This is the shape used by
      // real client-jar consumers, so it must be recognized.
      const dir = path.join(tmpDir, 'java-request-line-no-feign');
      fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
      fs.writeFileSync(
        path.join(dir, 'src', 'BigModelClient.java'),
        `
import feign.Headers;
import feign.RequestLine;
import feign.Response;

public interface BigModelClient {
  @RequestLine("POST /ai/summarization")
  @Headers("Content-Type: application/json")
  Response summarize();

  @RequestLine("GET /ai/concurrent")
  Response concurrent();
}
`,
      );

      const contracts = await extractor.extract(null, dir, makeRepo(dir));
      const consumers = contracts.filter((c) => c.role === 'consumer');

      expect(
        consumers.find(
          (c) =>
            c.contractId === 'http::POST::/ai/summarization' &&
            c.meta.framework === 'openfeign' &&
            c.confidence === 0.75,
        ),
      ).toBeDefined();
      expect(
        consumers.find(
          (c) => c.contractId === 'http::GET::/ai/concurrent' && c.meta.framework === 'openfeign',
        ),
      ).toBeDefined();
    });

    it('mixes @RequestLine and @GetMapping methods on the same @FeignClient interface', async () => {
      const dir = path.join(tmpDir, 'java-feign-mixed-annotations');
      fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
      fs.writeFileSync(
        path.join(dir, 'src', 'MixedClient.java'),
        `
import org.springframework.cloud.openfeign.FeignClient;
import org.springframework.web.bind.annotation.GetMapping;
import feign.RequestLine;

@FeignClient(name = "mixed-service", path = "/api")
interface MixedClient {
  @GetMapping("/spring-style")
  String springStyle();

  @RequestLine("GET /native-style")
  String nativeStyle();
}
`,
      );

      const contracts = await extractor.extract(null, dir, makeRepo(dir));
      const consumers = contracts.filter((c) => c.role === 'consumer');

      // Both annotation styles produce contracts — they don't conflict.
      expect(
        consumers.find(
          (c) =>
            c.contractId === 'http::GET::/api/spring-style' &&
            c.meta.framework === 'openfeign' &&
            c.confidence === 0.7,
        ),
      ).toBeDefined();
      expect(
        consumers.find(
          (c) =>
            c.contractId === 'http::GET::/api/native-style' &&
            c.meta.framework === 'openfeign' &&
            c.confidence === 0.75,
        ),
      ).toBeDefined();
    });

    it('extracts @RequestLine values written with the named "value" argument', async () => {
      const dir = path.join(tmpDir, 'java-feign-request-line-named');
      fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
      fs.writeFileSync(
        path.join(dir, 'src', 'NamedArgClient.java'),
        `
import org.springframework.cloud.openfeign.FeignClient;
import feign.RequestLine;

@FeignClient(name = "named-arg-service")
interface NamedArgClient {
  @RequestLine(value = "POST /create")
  String create();
}
`,
      );

      const contracts = await extractor.extract(null, dir, makeRepo(dir));
      const consumers = contracts.filter((c) => c.role === 'consumer');

      expect(
        consumers.find(
          (c) => c.contractId === 'http::POST::/create' && c.meta.framework === 'openfeign',
        ),
      ).toBeDefined();
    });

    it('ignores @RequestLine whose named argument is not "value"', async () => {
      // The consolidated query matches every named annotation argument; the
      // scanRouteAnnotations loop drops a @RequestLine whose key is not `value`.
      const dir = path.join(tmpDir, 'java-feign-request-line-wrong-key');
      fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
      fs.writeFileSync(
        path.join(dir, 'src', 'WrongKeyClient.java'),
        `
import org.springframework.cloud.openfeign.FeignClient;
import feign.RequestLine;

@FeignClient(name = "wrong-key-service")
interface WrongKeyClient {
  @RequestLine(name = "GET /should-not-extract")
  String shouldNotBeExtracted();
}
`,
      );

      const contracts = await extractor.extract(null, dir, makeRepo(dir));
      const consumers = contracts.filter((c) => c.role === 'consumer');

      expect(
        consumers.find((c) => c.contractId === 'http::GET::/should-not-extract'),
      ).toBeUndefined();
    });

    it('ignores @RequestLine values that are not a "VERB /path" line', async () => {
      // `parseRequestLine` only accepts a recognized HTTP verb followed by a
      // path starting with `/`. Malformed values (no verb, no leading-slash
      // path, or unknown verb) must be dropped — this guards the relaxed
      // (no-@FeignClient) matcher from turning arbitrary `@RequestLine` string
      // literals into bogus contracts.
      const dir = path.join(tmpDir, 'java-request-line-malformed');
      fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
      fs.writeFileSync(
        path.join(dir, 'src', 'MalformedClient.java'),
        `
import feign.RequestLine;

interface MalformedClient {
  @RequestLine("not a request line at all")
  String noVerb();

  @RequestLine("GET relative/no/leading/slash")
  String noLeadingSlash();

  @RequestLine("FETCH /unknown-verb")
  String unknownVerb();
}
`,
      );

      const contracts = await extractor.extract(null, dir, makeRepo(dir));
      const consumers = contracts.filter((c) => c.role === 'consumer');

      // None of the three malformed values should yield a contract.
      expect(
        consumers.filter((c) => c.symbolRef.filePath.endsWith('MalformedClient.java')),
      ).toHaveLength(0);
    });

    it('ignores @RequestLine on a class method (Feign proxies are interfaces only)', async () => {
      // The relaxed matcher still requires an enclosing interface: Feign builds
      // its proxy from an interface, so a `@RequestLine` on a concrete class
      // method is not a Feign call and must not be emitted as a consumer.
      const dir = path.join(tmpDir, 'java-request-line-on-class');
      fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
      fs.writeFileSync(
        path.join(dir, 'src', 'NotAProxy.java'),
        `
import feign.RequestLine;

class NotAProxy {
  @RequestLine("GET /should-not-extract")
  String call() { return null; }
}
`,
      );

      const contracts = await extractor.extract(null, dir, makeRepo(dir));
      const consumers = contracts.filter((c) => c.role === 'consumer');

      expect(
        consumers.find((c) => c.contractId === 'http::GET::/should-not-extract'),
      ).toBeUndefined();
    });

    it('prefers @FeignClient(path=...) over @RequestMapping when @RequestMapping appears first', async () => {
      // Reverse-order companion to the precedence test above: @FeignClient(path)
      // must win even when @RequestMapping is the first annotation in source,
      // exercising the deferred interfaceRequestMappingPrefixes apply.
      const dir = path.join(tmpDir, 'java-openfeign-prefix-precedence-reversed');
      fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
      fs.writeFileSync(
        path.join(dir, 'src', 'ReversedPrecedenceClient.java'),
        `
import org.springframework.cloud.openfeign.FeignClient;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMapping;

@RequestMapping("/rm-path")
@FeignClient(name = "order-service", path = "/feign-path")
interface ReversedPrecedenceClient {
  @GetMapping("/orders")
  OrderDto getOrders();
}
`,
      );

      const contracts = await extractor.extract(null, dir, makeRepo(dir));
      const consumers = contracts.filter((c) => c.role === 'consumer');

      expect(consumers.find((c) => c.contractId === 'http::GET::/feign-path/orders')).toBeDefined();
      expect(consumers.find((c) => c.contractId === 'http::GET::/rm-path/orders')).toBeUndefined();
    });

    it('a @FeignClient API interface implemented by a controller yields both a consumer and a provider (Java)', async () => {
      // Java twin of the Kotlin dual-role case: an `api` module publishes a
      // @FeignClient contract (consumer) that the service's @RestController
      // implements (provider).
      const dir = path.join(tmpDir, 'java-feign-api-implemented');
      fs.mkdirSync(path.join(dir, 'src/rest'), { recursive: true });
      fs.mkdirSync(path.join(dir, 'src/controller'), { recursive: true });
      fs.writeFileSync(
        path.join(dir, 'src/rest/WarehouseApi.java'),
        `
package com.example.rest;
import org.springframework.cloud.openfeign.FeignClient;
import org.springframework.web.bind.annotation.*;

@FeignClient(name = "catalog-service")
@RequestMapping("/warehouses")
public interface WarehouseApi {
    @GetMapping("/{id}/stock")
    Object listStock();
}
`,
      );
      fs.writeFileSync(
        path.join(dir, 'src/controller/WarehouseController.java'),
        `
package com.example.controller;
import com.example.rest.WarehouseApi;
import org.springframework.web.bind.annotation.*;

@RestController
public class WarehouseController implements WarehouseApi {
    @Override
    public Object listStock() { return null; }
}
`,
      );

      const contracts = await extractor.extract(null, dir, makeRepo(dir));
      const providers = contracts.filter((c) => c.role === 'provider');
      const consumers = contracts.filter((c) => c.role === 'consumer');

      expect(
        consumers.find(
          (c) =>
            c.contractId === 'http::GET::/warehouses/{param}/stock' &&
            c.meta.framework === 'openfeign',
        ),
      ).toBeDefined();
      expect(
        providers.find(
          (c) =>
            c.contractId === 'http::GET::/warehouses/{param}/stock' &&
            c.symbolRef.filePath.endsWith('WarehouseController.java') &&
            c.confidence === 0.8,
        ),
      ).toBeDefined();
    });

    it('extracts Java and Apache HttpClient literal request construction', async () => {
      const dir = path.join(tmpDir, 'java-http-client-consumer');
      fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
      fs.writeFileSync(
        path.join(dir, 'src', 'HttpClients.java'),
        `
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import org.apache.http.client.methods.HttpGet;
import org.apache.http.client.methods.HttpPost;
import org.apache.http.client.methods.HttpPut;
import org.apache.http.client.methods.HttpDelete;
import org.apache.http.client.methods.HttpPatch;

class HttpClients {
  void run(HttpClient client) throws Exception {
    HttpRequest get = HttpRequest.newBuilder()
        .uri(URI.create("/api/users/1"))
        .GET()
        .build();
    HttpRequest post = HttpRequest.newBuilder()
        .uri(URI.create("/api/users"))
        .POST(HttpRequest.BodyPublishers.ofString("{}"))
        .build();

    new HttpGet("/api/orders/2");
    new HttpPost("/api/orders");
    new HttpPut("/api/orders/3");
    new HttpDelete("/api/orders/4");
    new HttpPatch("/api/orders/5");
  }
}
`,
      );

      const contracts = await extractor.extract(null, dir, makeRepo(dir));
      const consumers = contracts.filter((c) => c.role === 'consumer');

      expect(consumers.find((c) => c.contractId === 'http::GET::/api/users/{param}')).toBeDefined();
      expect(
        consumers.find(
          (c) =>
            c.contractId === 'http::POST::/api/users' &&
            c.meta.framework === 'java-http-client' &&
            c.confidence === 0.65,
        ),
      ).toBeDefined();
      expect(
        consumers.find((c) => c.contractId === 'http::GET::/api/orders/{param}'),
      ).toBeDefined();
      expect(
        consumers.find(
          (c) =>
            c.contractId === 'http::POST::/api/orders' &&
            c.meta.framework === 'apache-http-client' &&
            c.confidence === 0.65,
        ),
      ).toBeDefined();
      expect(
        consumers.find((c) => c.contractId === 'http::PUT::/api/orders/{param}'),
      ).toBeDefined();
      expect(
        consumers.find((c) => c.contractId === 'http::DELETE::/api/orders/{param}'),
      ).toBeDefined();
      expect(
        consumers.find((c) => c.contractId === 'http::PATCH::/api/orders/{param}'),
      ).toBeDefined();
    });

    it('extracts Java HttpClient HEAD, .method(), and default-GET forms', async () => {
      const dir = path.join(tmpDir, 'java-http-client-verbs');
      fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
      fs.writeFileSync(
        path.join(dir, 'src', 'HttpClientVerbs.java'),
        `
import java.net.URI;
import java.net.http.HttpRequest;

class HttpClientVerbs {
  void run(String verb) throws Exception {
    HttpRequest head = HttpRequest.newBuilder().uri(URI.create("/api/users/head")).HEAD().build();
    HttpRequest patch = HttpRequest.newBuilder().uri(URI.create("/api/users/2")).method("PATCH", HttpRequest.BodyPublishers.ofString("{}")).build();
    HttpRequest def = HttpRequest.newBuilder().uri(URI.create("/api/default-users/3")).build();
    HttpRequest dyn = HttpRequest.newBuilder().uri(URI.create("/api/dyn/4")).method(verb, HttpRequest.BodyPublishers.noBody()).build();
  }
}
`,
      );

      const contracts = await extractor.extract(null, dir, makeRepo(dir));
      const hc = contracts.filter(
        (c) =>
          c.role === 'consumer' &&
          c.meta.framework === 'java-http-client' &&
          c.symbolRef.filePath.endsWith('HttpClientVerbs.java'),
      );

      // HEAD via verb helper, PATCH via `.method("X")`, default GET via bare
      // `.build()`. The variable-bound `.method(verb, …)` is NOT resolved
      // (string literal only) → no contract. Exact set-equality also pins that
      // no chain double-emits (e.g. HEAD would never also yield a GET).
      expect(new Set(hc.map((c) => c.contractId))).toEqual(
        new Set([
          'http::HEAD::/api/users/head',
          'http::PATCH::/api/users/{param}',
          'http::GET::/api/default-users/{param}',
        ]),
      );
      expect(hc.every((c) => c.confidence === 0.65)).toBe(true);
    });

    it('extracts Java HttpClient verbs across intervening builder calls (#2268)', async () => {
      // The verb-walk is transparent to neutral calls AFTER `.uri(...)`, so a
      // `.header()`/`.timeout()` hop before the terminal no longer drops the
      // contract. Each verb-producing branch gets a DISTINCT non-numeric path so
      // the set-equality assertion cannot mask a branch. A call BEFORE `.uri()`,
      // a constructor-arg `newBuilder(uri)`, and a non-literal `.uri()` arg are
      // documented misses (must NOT extract).
      const dir = path.join(tmpDir, 'java-http-client-intervening');
      fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
      fs.writeFileSync(
        path.join(dir, 'src', 'HttpClientIntervening.java'),
        `
import java.net.URI;
import java.net.http.HttpRequest;
import java.net.http.HttpClient;
import java.time.Duration;

class HttpClientIntervening {
  void run(URI uriVar, Duration dur, HttpClient.Version ver, HttpRequest.BodyPublisher body) throws Exception {
    // Intervening calls AFTER .uri() — header/timeout transparent to the verb-walk.
    HttpRequest a = HttpRequest.newBuilder().uri(URI.create("/api/hdr")).header("Accept", "application/json").build();
    HttpRequest b = HttpRequest.newBuilder().uri(URI.create("/api/tmo")).timeout(dur).method("PUT", body).build();
    HttpRequest c = HttpRequest.newBuilder().uri(URI.create("/api/hdr-verb")).header("X", "y").DELETE().build();
    // Verb helper BEFORE an intervening call (walk does not stop at the first non-verb).
    HttpRequest d = HttpRequest.newBuilder().uri(URI.create("/api/verb-then-hdr")).POST(body).header("X", "y").build();
    // Unbuilt .uri() — no .build(); over-match emits the default GET (mirrors OkHttp).
    HttpRequest.Builder e = HttpRequest.newBuilder().uri(URI.create("/api/unbuilt"));
    // Call BEFORE .uri() and the constructor-arg form are now captured too (the
    // chain roots at HttpRequest.newBuilder); only a non-literal .uri() is a miss.
    HttpRequest f = HttpRequest.newBuilder().version(ver).uri(URI.create("/api/pre-uri")).build(); // call before .uri()
    HttpRequest g = HttpRequest.newBuilder(URI.create("/api/ctor")).build(); // constructor-arg, no .uri()
    HttpRequest h = HttpRequest.newBuilder().uri(uriVar).build(); // non-literal .uri() arg → miss
  }
}
`,
      );

      const contracts = await extractor.extract(null, dir, makeRepo(dir));
      const hc = contracts.filter(
        (c) =>
          c.role === 'consumer' &&
          c.meta.framework === 'java-http-client' &&
          c.symbolRef.filePath.endsWith('HttpClientIntervening.java'),
      );

      // The seven resolvable chains (incl. the pre-`.uri()` and constructor-arg
      // forms); only the non-literal `.uri(uriVar)` contributes nothing.
      expect(new Set(hc.map((c) => c.contractId))).toEqual(
        new Set([
          'http::GET::/api/hdr',
          'http::PUT::/api/tmo',
          'http::DELETE::/api/hdr-verb',
          'http::POST::/api/verb-then-hdr',
          'http::GET::/api/unbuilt',
          'http::GET::/api/pre-uri',
          'http::GET::/api/ctor',
        ]),
      );
      expect(hc.every((c) => c.confidence === 0.65)).toBe(true);
    });

    it('passes through a non-standard HttpClient .method("VERB") verb (#2268)', async () => {
      // A custom verb literal passes through (uppercased), matching the OkHttp
      // .method() precedent — the verb-walk does not restrict to known verbs.
      const dir = path.join(tmpDir, 'java-http-client-custom-verb');
      fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
      fs.writeFileSync(
        path.join(dir, 'src', 'CustomVerb.java'),
        `
import java.net.URI;
import java.net.http.HttpRequest;

class CustomVerb {
  void run(HttpRequest.BodyPublisher body) throws Exception {
    HttpRequest r = HttpRequest.newBuilder().uri(URI.create("/api/report")).method("REPORT", body).build();
  }
}
`,
      );

      const contracts = await extractor.extract(null, dir, makeRepo(dir));
      const hc = contracts.filter(
        (c) =>
          c.role === 'consumer' &&
          c.meta.framework === 'java-http-client' &&
          c.symbolRef.filePath.endsWith('CustomVerb.java'),
      );
      expect(new Set(hc.map((c) => c.contractId))).toEqual(new Set(['http::REPORT::/api/report']));
    });

    it('handles HttpClient constructor-URI override and rejects non-newBuilder .uri (#2268)', async () => {
      // A constructor URI overridden by a later `.uri(...)` emits ONLY the override
      // (not both), and a `.uri(URI.create(...))` on a chain that does not root at
      // HttpRequest.newBuilder (e.g. WebClient) is NOT a java-http-client consumer.
      const dir = path.join(tmpDir, 'java-http-client-ctor-override');
      fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
      fs.writeFileSync(
        path.join(dir, 'src', 'CtorOverride.java'),
        `
import java.net.URI;
import java.net.http.HttpRequest;
import org.springframework.web.reactive.function.client.WebClient;

class CtorOverride {
  void run(WebClient webClient) {
    HttpRequest a = HttpRequest.newBuilder(URI.create("/api/ctor-overridden")).uri(URI.create("/api/override-wins")).build();
    webClient.get().uri(URI.create("/api/webclient-not-hc")).retrieve();
  }
}
`,
      );

      const contracts = await extractor.extract(null, dir, makeRepo(dir));
      const hc = contracts.filter(
        (c) =>
          c.role === 'consumer' &&
          c.meta.framework === 'java-http-client' &&
          c.symbolRef.filePath.endsWith('CtorOverride.java'),
      );

      // Only the override URI, exactly once; the overridden constructor URI and the
      // WebClient `.uri()` are not java-http-client contracts.
      expect(new Set(hc.map((c) => c.contractId))).toEqual(
        new Set(['http::GET::/api/override-wins']),
      );
    });

    it('resolves the last verb when a chain sets two (runtime last-wins) (#2268)', async () => {
      // Each verb-setter overwrites the previous at runtime, so a chain that sets
      // two verbs resolves to the one nearest the terminal — not the first found.
      const dir = path.join(tmpDir, 'java-http-two-verb');
      fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
      fs.writeFileSync(
        path.join(dir, 'src', 'TwoVerb.java'),
        `
import java.net.URI;
import java.net.http.HttpRequest;
import okhttp3.Request;
import okhttp3.RequestBody;

class TwoVerb {
  void run(RequestBody body, HttpRequest.BodyPublisher pub) throws Exception {
    HttpRequest hc = HttpRequest.newBuilder().GET().uri(URI.create("/api/hc-two")).POST(pub).build();
    new Request.Builder().get().url("/api/ok-two").post(body).build();
  }
}
`,
      );

      const contracts = await extractor.extract(null, dir, makeRepo(dir));
      const fromFile = contracts.filter(
        (c) => c.role === 'consumer' && c.symbolRef.filePath.endsWith('TwoVerb.java'),
      );

      // Both resolve to the LAST verb (POST), not the first (GET).
      expect(new Set(fromFile.map((c) => `${c.meta.framework} ${c.contractId}`))).toEqual(
        new Set(['java-http-client http::POST::/api/hc-two', 'okhttp http::POST::/api/ok-two']),
      );
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
        // identical to `.java` (pinned by the Java↔Kotlin parity harness below).
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
        // @RestController override carries none → inherited via scanProject.
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

    it('emits one contract per element of a multi-element Java path array', async () => {
      // Java parity: @GetMapping({"/a", "/b"}) method array and a multi-element
      // class-level @RequestMapping must both expand to N contracts.
      const dir = path.join(tmpDir, 'java-multi-array');
      fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
      fs.writeFileSync(
        path.join(dir, 'src', 'AliasController.java'),
        `package com.example;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.GetMapping;

@RestController
@RequestMapping({"/base/one", "/base/two"})
public class AliasController {
    @GetMapping({"/primary", "/alias"})
    public Object get() { return null; }
}
`,
      );

      const contracts = await extractor.extract(null, dir, makeRepo(dir));
      const providers = contracts.filter((c) => c.role === 'provider');
      for (const id of [
        'http::GET::/base/one/primary',
        'http::GET::/base/one/alias',
        'http::GET::/base/two/primary',
        'http::GET::/base/two/alias',
      ]) {
        expect(providers.find((c) => c.contractId === id)).toBeDefined();
      }
    });

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

    // ─── Byte-identical Java↔Kotlin contract parity (set-equality harness) ─────
    // Independent per-side twin tests can both pass while the emitted contract
    // SETS differ (an extra contract on one side, or a confidence/framework
    // drift). This harness feeds matched .java/.kt fixtures through both plugins
    // and asserts the full projected contract set is equal across languages AND
    // equal to the expected set — the only check that actually verifies the
    // "byte-identical contract IDs" goal. Per-scenario twins above stay for
    // readability and language-specific cases; this covers the parity-critical
    // families. Drift in any covered family fails here directly.
    describe('Java↔Kotlin contract parity (set-equality)', () => {
      interface ParityFile {
        name: string;
        java: string;
        kotlin: string;
      }
      interface ParityContract {
        role: string;
        contractId: string;
        framework: unknown;
        confidence: number;
      }
      interface ParityRow {
        name: string;
        files: ParityFile[];
        expected: ParityContract[];
      }

      const sortContracts = (contracts: ParityContract[]): ParityContract[] =>
        [...contracts].sort((a, b) =>
          `${a.role} ${a.contractId}`.localeCompare(`${b.role} ${b.contractId}`),
        );

      const projectContracts = (
        contracts: Awaited<ReturnType<typeof extractor.extract>>,
      ): ParityContract[] =>
        sortContracts(
          contracts.map((c) => ({
            role: c.role,
            contractId: c.contractId,
            framework: c.meta.framework,
            confidence: c.confidence,
          })),
        );

      const rows: ParityRow[] = [
        {
          name: 'OkHttp builder verb inference',
          files: [
            {
              name: 'OkClient',
              java: `
import okhttp3.Request;
import okhttp3.RequestBody;

class OkClient {
  void run(RequestBody body) {
    new Request.Builder().url("/api/things").post(body).build();
  }
}
`,
              kotlin: `package com.example
import okhttp3.Request
import okhttp3.RequestBody

class OkClient(private val body: RequestBody) {
  fun run() {
    Request.Builder().url("/api/things").post(body).build()
  }
}
`,
            },
          ],
          expected: [
            {
              role: 'consumer',
              contractId: 'http::POST::/api/things',
              framework: 'okhttp',
              confidence: 0.7,
            },
          ],
        },
        {
          name: 'OkHttp verb + builder call before .url()',
          files: [
            {
              name: 'OkPre',
              java: `
import okhttp3.Request;
import okhttp3.RequestBody;

class OkPre {
  void run(RequestBody body) {
    new Request.Builder().post(body).url("/api/pre").build();
  }
}
`,
              kotlin: `package com.example
import okhttp3.Request
import okhttp3.RequestBody

class OkPre(private val body: RequestBody) {
  fun run() {
    Request.Builder().post(body).url("/api/pre").build()
  }
}
`,
            },
          ],
          expected: [
            {
              role: 'consumer',
              contractId: 'http::POST::/api/pre',
              framework: 'okhttp',
              confidence: 0.7,
            },
          ],
        },
        {
          name: '@RequestLine with @RequestMapping prefix fallback',
          files: [
            {
              name: 'OrderClient',
              java: `
import org.springframework.cloud.openfeign.FeignClient;
import org.springframework.web.bind.annotation.RequestMapping;
import feign.RequestLine;

@FeignClient(name = "order-service")
@RequestMapping("/orders")
interface OrderClient {
  @RequestLine("GET /{id}")
  Object get();
}
`,
              kotlin: `package com.example
import org.springframework.cloud.openfeign.FeignClient
import org.springframework.web.bind.annotation.RequestMapping
import feign.RequestLine

@FeignClient(name = "order-service")
@RequestMapping("/orders")
interface OrderClient {
    @RequestLine("GET /{id}")
    fun get(): Any
}
`,
            },
          ],
          expected: [
            {
              role: 'consumer',
              contractId: 'http::GET::/orders/{param}',
              framework: 'openfeign',
              confidence: 0.75,
            },
          ],
        },
        {
          name: 'named @RequestLine(value=...)',
          files: [
            {
              name: 'CreateClient',
              java: `
import org.springframework.cloud.openfeign.FeignClient;
import feign.RequestLine;

@FeignClient(name = "create-service")
interface CreateClient {
  @RequestLine(value = "POST /create")
  Object create();
}
`,
              kotlin: `package com.example
import org.springframework.cloud.openfeign.FeignClient
import feign.RequestLine

@FeignClient(name = "create-service")
interface CreateClient {
    @RequestLine(value = "POST /create")
    fun create(): Any
}
`,
            },
          ],
          expected: [
            {
              role: 'consumer',
              contractId: 'http::POST::/create',
              framework: 'openfeign',
              confidence: 0.75,
            },
          ],
        },
        {
          name: '@FeignClient(path) + @GetMapping',
          files: [
            {
              name: 'UsersClient',
              java: `
import org.springframework.cloud.openfeign.FeignClient;
import org.springframework.web.bind.annotation.GetMapping;

@FeignClient(name = "users-service", path = "/api")
interface UsersClient {
  @GetMapping("/users")
  Object users();
}
`,
              kotlin: `package com.example
import org.springframework.cloud.openfeign.FeignClient
import org.springframework.web.bind.annotation.GetMapping

@FeignClient(name = "users-service", path = "/api")
interface UsersClient {
    @GetMapping("/users")
    fun users(): Any
}
`,
            },
          ],
          expected: [
            {
              role: 'consumer',
              contractId: 'http::GET::/api/users',
              framework: 'openfeign',
              confidence: 0.7,
            },
          ],
        },
        {
          name: '@HttpExchange(url) prefix + @GetExchange',
          files: [
            {
              name: 'ProductApi',
              java: `
import org.springframework.web.service.annotation.HttpExchange;
import org.springframework.web.service.annotation.GetExchange;

@HttpExchange(url = "/products")
interface ProductApi {
  @GetExchange("/{id}")
  Object get();
}
`,
              kotlin: `package com.example
import org.springframework.web.service.annotation.HttpExchange
import org.springframework.web.service.annotation.GetExchange

@HttpExchange(url = "/products")
interface ProductApi {
    @GetExchange("/{id}")
    fun get(): Any
}
`,
            },
          ],
          expected: [
            {
              role: 'consumer',
              contractId: 'http::GET::/products/{param}',
              framework: 'spring-http-interface',
              confidence: 0.75,
            },
          ],
        },
        {
          name: 'WebClient long-form method(HttpMethod.X).uri(...)',
          files: [
            {
              name: 'LongFormClient',
              java: `
import org.springframework.http.HttpMethod;
import org.springframework.web.reactive.function.client.WebClient;

class LongFormClient {
  void run(WebClient webClient) {
    webClient.method(HttpMethod.GET).uri("/api/items").retrieve();
  }
}
`,
              kotlin: `package com.example
import org.springframework.http.HttpMethod
import org.springframework.web.reactive.function.client.WebClient

class LongFormClient {
    fun run(webClient: WebClient) {
        webClient.method(HttpMethod.GET).uri("/api/items").retrieve()
    }
}
`,
            },
          ],
          expected: [
            {
              role: 'consumer',
              contractId: 'http::GET::/api/items',
              framework: 'spring-web-client',
              confidence: 0.7,
            },
          ],
        },
        {
          name: 'interface-based controller inheritance',
          files: [
            {
              name: 'WarehouseApi',
              java: `
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.GetMapping;

@RequestMapping("/warehouses")
interface WarehouseApi {
  @GetMapping("/{id}/stock")
  Object listStock();
}
`,
              kotlin: `package com.example
import org.springframework.web.bind.annotation.RequestMapping
import org.springframework.web.bind.annotation.GetMapping

@RequestMapping("/warehouses")
interface WarehouseApi {
    @GetMapping("/{id}/stock")
    fun listStock(): Any
}
`,
            },
            {
              name: 'WarehouseController',
              java: `
import org.springframework.web.bind.annotation.RestController;

@RestController
class WarehouseController implements WarehouseApi {
  @Override
  public Object listStock() { return null; }
}
`,
              kotlin: `package com.example
import org.springframework.web.bind.annotation.RestController

@RestController
class WarehouseController : WarehouseApi {
    override fun listStock(): Any = TODO()
}
`,
            },
          ],
          expected: [
            {
              role: 'provider',
              contractId: 'http::GET::/warehouses/{param}/stock',
              framework: 'spring',
              confidence: 0.8,
            },
          ],
        },
      ];

      rows.forEach((row) => {
        itKotlinConsumer(`emits identical contracts for ${row.name}`, async () => {
          const base = path.join(tmpDir, `parity-${row.name.replace(/[^a-z0-9]+/gi, '-')}`);
          const javaDir = path.join(base, 'java');
          const kotlinDir = path.join(base, 'kotlin');
          fs.mkdirSync(path.join(javaDir, 'src'), { recursive: true });
          fs.mkdirSync(path.join(kotlinDir, 'src'), { recursive: true });
          for (const file of row.files) {
            fs.writeFileSync(path.join(javaDir, 'src', `${file.name}.java`), file.java);
            fs.writeFileSync(path.join(kotlinDir, 'src', `${file.name}.kt`), file.kotlin);
          }

          const javaContracts = projectContracts(
            await extractor.extract(null, javaDir, makeRepo(javaDir)),
          );
          const kotlinContracts = projectContracts(
            await extractor.extract(null, kotlinDir, makeRepo(kotlinDir)),
          );
          const expected = sortContracts(row.expected);

          // The two languages emit the same contract set...
          expect(kotlinContracts).toEqual(javaContracts);
          // ...and it is exactly the expected set (no extra/missing contracts).
          expect(javaContracts).toEqual(expected);
        });
      });
    });

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
          const fp = String(params?.filePath ?? '');
          const row = fp.includes('graph.ts')
            ? { uid: 'uid-fn-fetch', name: 'fetchUsers', filePath: 'src/api/graph.ts' }
            : fp.includes('health.ts')
              ? { uid: 'uid-fn-health', name: 'fetchHealth', filePath: 'src/api/health.ts' }
              : null;
          return row ? [{ ...row, startLine: 1, endLine: 4, labels: ['Function'] }] : [];
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
      fs.writeFileSync(path.join(dir, 'src/routes.ts'), `router.get('/api/health', handler);`);

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

  describe('Windows SIGSEGV regression — large input must route through parseSourceSafe', () => {
    it('routes >32 767-char source file through parseSourceSafe (not direct parser.parse)', async () => {
      parseSourceSafeSpy.mockClear();

      // >40 000-char Java controller file. Direct parser.parse(content) on
      // an input this size SIGSEGVs the process on Windows. The spy assertion
      // is what catches the regression — a "no throw" assertion alone is
      // satisfied by the bypass on Linux/macOS where parser.parse(40 000 chars)
      // succeeds.
      const padding = Array.from(
        { length: 600 },
        (_, i) => `    public String helper${i}() { return "padding-${i}-aaaaaaaaaaaaaaaaaaa"; }\n`,
      ).join('');
      const largeJava = `package com.example;\n\n@RestController\npublic class BigController {\n${padding}}\n`;
      expect(largeJava.length).toBeGreaterThan(40_000);

      // Use mkdtempSync rather than a fixed subdir name: satisfies CodeQL's
      // js/insecure-temporary-file rule by generating a unique random suffix
      // instead of relying on the parent tmpDir's predictable Date.now() name.
      const dir = fs.mkdtempSync(path.join(tmpDir, 'large-input-'));
      fs.mkdirSync(path.join(dir, 'src/controller'), { recursive: true });
      fs.writeFileSync(path.join(dir, 'src/controller/BigController.java'), largeJava);

      const mockDbExecutor = async (_query: string) => [];
      await extractor.extract(mockDbExecutor, dir, makeRepo(dir));

      expect(parseSourceSafeSpy).toHaveBeenCalled();
    });
  });
});
