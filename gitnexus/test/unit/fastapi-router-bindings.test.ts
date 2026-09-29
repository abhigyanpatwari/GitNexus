/**
 * Unit tests for {@link extractFastAPIRouterBindings} — the per-file
 * regex extractor that the parse worker calls on every Python file.
 * The cross-file aggregation that turns these raw records into prefix
 * maps lives in parse-impl and is covered by
 * `fastapi-prefix-pipeline.test.ts` (integration) plus
 * `http-route-extractor.test.ts` (group layer). This file pins the
 * shape the worker emits, so a regression in either regex or in the
 * import-list parsing fails here first.
 *
 * What this file is responsible for:
 *   • Shape A `app.include_router(<mod>.router, prefix=…)` and
 *     Shape B `app.include_router(<local>, prefix=…)` are both
 *     captured.
 *   • `<host>.include_router` matches any host name, not just `app`.
 *   • Module path keying is two-tiered: short basename (always) and
 *     long `<parent>/<stem>` key (whenever the import path was
 *     multi-segment).
 *   • Relative imports (`from .calls import …`,
 *     `from ..siblings.calls import …`) are captured.
 *   • `as`-aliased imports route the prefix to the alias, not to
 *     `router`.
 *   • Unprefixed includes from any host are captured as `prefix: ''`
 *     propagation edges; calls whose `prefix=` is not a string literal
 *     are not captured.
 */

import { describe, it, expect } from 'vitest';
import {
  extractFastAPIRouterBindings,
  lastDottedSegment,
  lastTwoSegmentsAsPath,
  type ExtractedRouterConstructorPrefix,
  type ExtractedRouterInclude,
  type ExtractedRouterImport,
  type ExtractedRouterModuleAlias,
} from '../../src/core/ingestion/route-extractors/fastapi-router-bindings.js';
import { resolveFastAPIRouterPrefixes } from '../../src/core/ingestion/route-extractors/fastapi-router-prefixes.js';

function run(filePath: string, content: string) {
  const includes: ExtractedRouterInclude[] = [];
  const imports: ExtractedRouterImport[] = [];
  extractFastAPIRouterBindings(filePath, content, includes, imports);
  return { includes, imports };
}

function runFull(filePath: string, content: string) {
  const includes: ExtractedRouterInclude[] = [];
  const imports: ExtractedRouterImport[] = [];
  const moduleAliases: ExtractedRouterModuleAlias[] = [];
  const constructorPrefixes: ExtractedRouterConstructorPrefix[] = [];
  extractFastAPIRouterBindings(
    filePath,
    content,
    includes,
    imports,
    moduleAliases,
    constructorPrefixes,
  );
  return { includes, imports, moduleAliases, constructorPrefixes };
}

describe('lastDottedSegment', () => {
  it('returns the last segment of an absolute dotted path', () => {
    expect(lastDottedSegment('api.users')).toBe('users');
    expect(lastDottedSegment('api.v2.users')).toBe('users');
  });

  it('strips leading dots from a relative path', () => {
    expect(lastDottedSegment('.users')).toBe('users');
    expect(lastDottedSegment('..api.users')).toBe('users');
    expect(lastDottedSegment('...users')).toBe('users');
  });

  it('returns the input when there is no dot after stripping', () => {
    expect(lastDottedSegment('users')).toBe('users');
  });

  it('returns the empty string for pure-dot inputs', () => {
    expect(lastDottedSegment('.')).toBe('');
    expect(lastDottedSegment('..')).toBe('');
    expect(lastDottedSegment('...')).toBe('');
  });
});

describe('lastTwoSegmentsAsPath', () => {
  it('joins the last two segments with `/`', () => {
    expect(lastTwoSegmentsAsPath('api.users')).toBe('api/users');
    expect(lastTwoSegmentsAsPath('app.api.users')).toBe('api/users');
  });

  it('strips leading dots before joining', () => {
    expect(lastTwoSegmentsAsPath('..api.users')).toBe('api/users');
  });

  it('returns the empty string when the path has only one segment', () => {
    // Single-segment imports cannot be promoted to a long key.
    expect(lastTwoSegmentsAsPath('users')).toBe('');
    expect(lastTwoSegmentsAsPath('.users')).toBe('');
  });

  it('returns the empty string for pure-dot inputs', () => {
    expect(lastTwoSegmentsAsPath('.')).toBe('');
    expect(lastTwoSegmentsAsPath('..')).toBe('');
  });
});

describe('extractFastAPIRouterBindings — Shape A (`<mod>.router`)', () => {
  it('captures app.include_router(<mod>.router, prefix=…)', () => {
    const { includes } = run(
      'main.py',
      [
        'from fastapi import FastAPI',
        'from api import users',
        'app = FastAPI()',
        "app.include_router(users.router, prefix='/users', tags=['users'])",
        '',
      ].join('\n'),
    );
    expect(includes).toHaveLength(1);
    expect(includes[0]).toMatchObject({
      filePath: 'main.py',
      routerExpr: 'users.router',
      prefix: '/users',
    });
    // Line number is 1-indexed and points to the include_router call.
    expect(includes[0].lineNumber).toBe(4);
  });

  it('captures non-`app` host variables', () => {
    // FINDING 4: production code commonly uses `api`, `application`,
    // `asgi_app` etc. Pinning the regex to `app.` would silently drop
    // these, which used to leave the ingestion and group layers
    // disagreeing on whether a prefix was applied.
    const { includes } = run(
      'main.py',
      [
        'from fastapi import FastAPI',
        'from api import users',
        'api = FastAPI()',
        "api.include_router(users.router, prefix='/users')",
        '',
      ].join('\n'),
    );
    expect(includes).toHaveLength(1);
    expect(includes[0].routerExpr).toBe('users.router');
    expect(includes[0].prefix).toBe('/users');
  });

  it('captures multiple Shape-A includes in the same file', () => {
    const { includes } = run(
      'main.py',
      [
        'from api import users, calls',
        'app = FastAPI()',
        "app.include_router(users.router, prefix='/users')",
        "app.include_router(calls.router, prefix='/calls')",
        '',
      ].join('\n'),
    );
    expect(includes).toHaveLength(2);
    expect(includes.map((i) => i.routerExpr).sort()).toEqual(['calls.router', 'users.router']);
  });
});

describe('extractFastAPIRouterBindings — Shape B (bare local name)', () => {
  it('captures app.include_router(<local>, prefix=…) and the import', () => {
    const { includes, imports } = run(
      'main.py',
      [
        'from fastapi import FastAPI',
        'from api.users import router as users_router',
        'app = FastAPI()',
        "app.include_router(users_router, prefix='/users')",
        '',
      ].join('\n'),
    );
    expect(imports).toHaveLength(1);
    expect(imports[0]).toMatchObject({
      filePath: 'main.py',
      localName: 'users_router',
      moduleKey: 'users',
      moduleKeyLong: 'api/users',
    });
    expect(includes).toHaveLength(1);
    expect(includes[0]).toMatchObject({
      filePath: 'main.py',
      routerExpr: 'users_router',
      prefix: '/users',
    });
  });

  it('captures the unaliased shape `from <mod> import router`', () => {
    const { imports } = run('main.py', ['from api.users import router', ''].join('\n'));
    expect(imports).toHaveLength(1);
    expect(imports[0]).toMatchObject({
      localName: 'router',
      moduleKey: 'users',
      moduleKeyLong: 'api/users',
    });
  });

  it('does NOT re-capture Shape A as Shape B (`<mod>.router` is not bare)', () => {
    // Anti-regression: INCLUDE_ROUTER_NAME_RE is intentionally
    // permissive (`(identifier)`). Without the lookahead in
    // extractFastAPIRouterBindings it would re-capture the bare
    // module name `users` from `users.router` and add a phantom
    // include with `routerExpr: "users"`.
    const { includes } = run(
      'main.py',
      ["app.include_router(users.router, prefix='/users')", ''].join('\n'),
    );
    const shapes = includes.map((i) => i.routerExpr).sort();
    expect(shapes).toEqual(['users.router']);
  });
});

describe('nested FastAPI router prefix resolution', () => {
  it('follows relative package and child imports without basename bleed', () => {
    const root = runFull(
      'src/one/app.py',
      "from .api import router as api_router\napp.include_router(api_router, prefix='/api')",
    );
    const pkg = runFull(
      'src/one/api/__init__.py',
      'from .models import router as models_router\nrouter.include_router(models_router)',
    );
    const resolved = resolveFastAPIRouterPrefixes(
      [
        'src/one/app.py',
        'src/one/api/__init__.py',
        'src/one/api/models.py',
        'src/two/api/models.py',
      ],
      [...root.includes, ...pkg.includes],
      [...root.imports, ...pkg.imports],
      [...root.moduleAliases, ...pkg.moduleAliases],
    );

    expect(resolved.prefixesByFile.get('src/one/api/models.py')).toEqual(new Set(['/api']));
    expect(resolved.prefixesByFile.has('src/two/api/models.py')).toBe(false);
    expect(pkg.includes[0]).toMatchObject({
      host: 'router',
      routerExpr: 'models_router',
      prefix: '',
    });
  });

  it('declines an absolute import shared by multiple source roots', () => {
    const root = runFull(
      'main.py',
      "from api.models import router as models_router\napp.include_router(models_router, prefix='/api')",
    );
    const resolved = resolveFastAPIRouterPrefixes(
      ['main.py', 'one/api/models.py', 'two/api/models.py'],
      root.includes,
      root.imports,
      root.moduleAliases,
    );

    expect(resolved.prefixesByFile.size).toBe(0);
    expect(resolved.resolvedIncludes.size).toBe(0);
  });
});

describe('nested FastAPI router prefix resolution — edge cases', () => {
  function resolveSources(sources: Record<string, string>) {
    const parts = Object.entries(sources).map(([file, src]) => runFull(file, src));
    return resolveFastAPIRouterPrefixes(
      Object.keys(sources),
      parts.flatMap((p) => p.includes),
      parts.flatMap((p) => p.imports),
      parts.flatMap((p) => p.moduleAliases),
      parts.flatMap((p) => p.constructorPrefixes),
    );
  }

  it('joins the parent APIRouter(prefix=...) between the mount and the child', () => {
    const resolved = resolveSources({
      'main.py':
        "from api import router as api_router\napp.include_router(api_router, prefix='/api')",
      'api/__init__.py': [
        'from .agents import router as agents_router',
        "router = APIRouter(prefix='/v1')",
        'router.include_router(agents_router)',
      ].join('\n'),
      'api/agents.py': 'router = APIRouter()',
    });

    expect(resolved.prefixesByFile.get('api/agents.py')).toEqual(new Set(['/api/v1']));
  });

  it('carries the parent APIRouter(prefix=...) when the parent is mounted bare', () => {
    const resolved = resolveSources({
      'main.py': 'from api import router as api_router\napp.include_router(api_router)',
      'api/__init__.py': [
        'from .agents import router as agents_router',
        'from .models import router as models_router',
        "router = APIRouter(prefix='/v1')",
        'router.include_router(agents_router)',
        'router.include_router(models_router)',
      ].join('\n'),
      'api/agents.py': 'router = APIRouter()',
      'api/models.py': 'router = APIRouter()',
    });

    expect(resolved.prefixesByFile.get('api/agents.py')).toEqual(new Set(['/v1']));
    expect(resolved.prefixesByFile.has('api/__init__.py')).toBe(false);
  });

  it('records nothing for an all-empty bare chain', () => {
    const resolved = resolveSources({
      'main.py': 'from api import router as api_router\napp.include_router(api_router)',
      'api/__init__.py':
        'from .agents import router as agents_router\nrouter.include_router(agents_router)',
      'api/agents.py': 'router = APIRouter()',
    });

    expect(resolved.prefixesByFile.size).toBe(0);
    expect(resolved.resolvedIncludes.size).toBe(0);
  });

  it('expands a deep diamond-shaped include graph once per (file, prefix)', () => {
    // 40 layers of two routers that each include both routers of the next
    // layer: 2^40 root-to-leaf paths, 80 distinct files.
    const layers = 40;
    const sources: Record<string, string> = {
      'main.py': "from pkg.l0_0 import router as root\napp.include_router(root, prefix='/api')",
    };
    for (let i = 0; i < layers; i++) {
      for (const j of [0, 1]) {
        sources[`pkg/l${i}_${j}.py`] =
          i === layers - 1
            ? 'router = APIRouter()'
            : [
                `from .l${i + 1}_0 import router as a`,
                `from .l${i + 1}_1 import router as b`,
                'router.include_router(a)',
                'router.include_router(b)',
              ].join('\n');
      }
    }

    const resolved = resolveSources(sources);

    expect(resolved.prefixesByFile.get(`pkg/l${layers - 1}_1.py`)).toEqual(new Set(['/api']));
  });

  it('passes a prefix through only a host literally named `router`', () => {
    const resolved = resolveSources({
      'main.py': "from api import api_router\napp.include_router(api_router.router, prefix='/api')",
      'api/api_router.py': [
        'from .items import router as items_router',
        'api_router = APIRouter()',
        'api_router.include_router(items_router)',
      ].join('\n'),
      'api/items.py': 'router = APIRouter()',
    });

    expect(resolved.prefixesByFile.get('api/api_router.py')).toEqual(new Set(['/api']));
    expect(resolved.prefixesByFile.has('api/items.py')).toBe(false);
  });
});

describe('extractFastAPIRouterBindings — relative imports', () => {
  it('captures single-dot relative imports (`from .calls import router as …`)', () => {
    // FINDING 2: the previous regex `[A-Za-z_][\w.]*` rejected
    // module paths starting with `.`, silently dropping every
    // relative-import Shape-B include. The PR description's own
    // motivating example used this shape — now pinned.
    const { imports } = run(
      'main.py',
      ['from .calls import router as calls_router', ''].join('\n'),
    );
    expect(imports).toHaveLength(1);
    expect(imports[0]).toMatchObject({
      localName: 'calls_router',
      moduleKey: 'calls',
    });
    // Single-segment relative paths cannot be promoted to a long key.
    expect(imports[0].moduleKeyLong).toBeUndefined();
  });

  it('captures multi-segment relative imports and emits a long key', () => {
    const { imports } = run(
      'main.py',
      ['from ..api.users import router as users_router', ''].join('\n'),
    );
    expect(imports).toHaveLength(1);
    expect(imports[0]).toMatchObject({
      localName: 'users_router',
      moduleKey: 'users',
      moduleKeyLong: 'api/users',
    });
  });
});

describe('extractFastAPIRouterBindings — long-key precision', () => {
  it('emits long key `api/users` for a multi-segment absolute import', () => {
    // FINDING 3: short-key-only collides for `api/users.py` vs
    // `admin/users.py`. The long key gives parse-impl the precision
    // it needs to bind a Shape-B include to the right file.
    const { imports } = run('main.py', ['from api.users import router', ''].join('\n'));
    expect(imports[0].moduleKeyLong).toBe('api/users');
  });

  it('omits the long key for a single-segment top-level import', () => {
    const { imports } = run('main.py', ['from users import router', ''].join('\n'));
    expect(imports[0].moduleKey).toBe('users');
    expect(imports[0].moduleKeyLong).toBeUndefined();
  });
});

describe('extractFastAPIRouterBindings — negative cases', () => {
  it('emits nothing for files without any include_router or import', () => {
    const { includes, imports } = run('helpers.py', 'def add(a, b):\n    return a + b\n');
    expect(includes).toEqual([]);
    expect(imports).toEqual([]);
  });

  it('captures unprefixed include_router calls with other keywords as propagation edges', () => {
    const { includes } = run(
      'main.py',
      [
        'app.include_router(users.router, tags=["users"])',
        'router.include_router(',
        '    items_router,',
        ')',
        '',
      ].join('\n'),
    );
    expect(includes.map(({ host, routerExpr, prefix }) => ({ host, routerExpr, prefix }))).toEqual([
      { host: 'app', routerExpr: 'users.router', prefix: '' },
      { host: 'router', routerExpr: 'items_router', prefix: '' },
    ]);
  });

  it('does not record an unprefixed edge when prefix= appears or a nested call hides it', () => {
    const { includes } = run(
      'main.py',
      [
        'app.include_router(users.router, tags=["users"], prefix="/users")',
        'app.include_router(items.router, dependencies=[Depends(auth)], prefix="/items")',
        '',
      ].join('\n'),
    );
    expect(includes.map(({ routerExpr, prefix }) => ({ routerExpr, prefix }))).toEqual([
      { routerExpr: 'users.router', prefix: '/users' },
    ]);
  });

  it('does not capture include_router calls with a non-string prefix', () => {
    // The current regex requires a string literal for the prefix
    // value. Variables / f-strings / concatenations are not
    // resolvable at parse time.
    const { includes } = run(
      'main.py',
      ['app.include_router(users.router, prefix=PREFIX_USERS)', ''].join('\n'),
    );
    expect(includes).toEqual([]);
  });

  it('ignores non-router names in `from … import` lists', () => {
    const { imports } = run('main.py', ['from api.users import schemas, helpers', ''].join('\n'));
    expect(imports).toEqual([]);
  });

  it('correctly handles a mixed import list (router + others)', () => {
    const { imports } = run(
      'main.py',
      ['from api.users import router, schemas, helpers', ''].join('\n'),
    );
    expect(imports).toHaveLength(1);
    expect(imports[0].localName).toBe('router');
    expect(imports[0].moduleKey).toBe('users');
  });
});

describe('extractFastAPIRouterBindings — APIRouter constructor prefix', () => {
  it('captures same-file APIRouter(prefix=...) declarations', () => {
    const { constructorPrefixes } = runFull(
      'api/items.py',
      [
        'from fastapi import APIRouter',
        'router = APIRouter(prefix="/api/items", tags=["items"])',
        '',
        '@router.get("")',
        'def list_items():',
        '    return []',
        '',
      ].join('\n'),
    );

    expect(constructorPrefixes).toEqual([{ filePath: 'api/items.py', prefix: '/api/items' }]);
  });

  it('captures prefix after nested APIRouter arguments', () => {
    const { constructorPrefixes } = runFull(
      'api/items.py',
      [
        'from fastapi import APIRouter, Depends',
        'router = APIRouter(dependencies=[Depends(get_db)], prefix="/api/items")',
        '',
        '@router.get("")',
        'def list_items():',
        '    return []',
        '',
      ].join('\n'),
    );

    expect(constructorPrefixes).toEqual([{ filePath: 'api/items.py', prefix: '/api/items' }]);
  });

  it('does not emit constructor prefixes for non-router receivers yet', () => {
    const { constructorPrefixes } = runFull(
      'api/items.py',
      [
        'from fastapi import APIRouter',
        'api_router = APIRouter(prefix="/api")',
        '',
        '@api_router.get("/items")',
        'def list_items():',
        '    return []',
        '',
      ].join('\n'),
    );

    expect(constructorPrefixes).toEqual([]);
  });
});
