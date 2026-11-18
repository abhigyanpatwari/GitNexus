import { describe, expect, it } from 'vitest';
import Parser from 'tree-sitter';
import PHP from 'tree-sitter-php';
import { extractPhpRouterRequireBindings } from '../../src/core/ingestion/route-extractors/php-router-require-bindings.js';
import {
  applyPhpRouterRequireContexts,
  resolvePhpRouterRequireBindings,
} from '../../src/core/ingestion/route-extractors/php-router-require-context.js';
import type { ExtractedRoute } from '../../src/core/ingestion/route-extractors/laravel.js';

const parser = new Parser();
parser.setLanguage(PHP.php_only);

const extractBindings = (source: string, filePath: string) => {
  const out = extractPhpRouterRequireBindings(parser.parse(source), filePath);
  return out;
};

describe('extractPhpRouterRequireBindings', () => {
  it('captures group require with prefix and namespace', () => {
    const bindings = extractBindings(
      `<?php
$app->router->group([
  'prefix' => 'api',
  'namespace' => 'App\\\\Http\\\\Controllers',
  'middleware' => ['jwt.auth'],
  'as' => 'api',
], function ($router) {
  require __DIR__ . '/../routes/web.php';
});
`,
      'bootstrap/app.php',
    );
    expect(bindings).toEqual([
      expect.objectContaining({
        filePath: 'bootstrap/app.php',
        requiredPath: 'routes/web.php',
        prefix: 'api',
        namespace: 'App\\Http\\Controllers',
        middleware: ['jwt.auth'],
        namePrefix: 'api',
      }),
    ]);
  });

  it('nested bootstrap groups compose outer prefix, middleware, and namespace', () => {
    const bindings = extractBindings(
      `<?php
$app->router->group([
  'prefix' => 'order',
  'middleware' => ['outer'],
  'namespace' => 'App\\\\Http\\\\Controllers',
  'as' => 'order',
], function ($router) {
  $router->group(['prefix' => 'v1', 'namespace' => 'Admin', 'as' => 'v1'], function ($router) {
    require __DIR__ . '/../routes/order.php';
  });
});
`,
      'bootstrap/app.php',
    );
    expect(bindings).toEqual([
      expect.objectContaining({
        requiredPath: 'routes/order.php',
        prefix: 'order/v1',
        namespace: 'App\\Http\\Controllers\\Admin',
        middleware: ['outer'],
        namePrefix: 'order.v1',
      }),
    ]);
  });

  it('extracts group+require from a non-bootstrap host file', () => {
    const bindings = extractBindings(
      `<?php
namespace App\\Providers;
class RouteServiceProvider {
  public function map($router) {
    $router->group(['prefix' => 'api'], function ($router) {
      require __DIR__ . '/../../routes/web.php';
    });
  }
}
`,
      'app/Providers/RouteServiceProvider.php',
    );
    expect(bindings[0]?.requiredPath).toBe('routes/web.php');
    expect(bindings[0]?.prefix).toBe('api');
  });

  it('supports $router->group with include', () => {
    const bindings = extractBindings(
      `<?php
$router->group(['prefix' => 'orders'], function ($router) {
  include __DIR__ . '/../routes/order.php';
});
`,
      'bootstrap/app.php',
    );
    expect(bindings[0]?.requiredPath).toBe('routes/order.php');
  });
});

describe('resolvePhpRouterRequireBindings', () => {
  const files = new Set(['bootstrap/app.php', 'routes/web.php', 'routes/order.php']);

  it('binds only when required path is an indexed route file', () => {
    const bindings = [
      {
        filePath: 'bootstrap/app.php',
        requiredPath: 'routes/order.php',
        prefix: 'orders',
        namespace: 'App\\Http\\Controllers',
        middleware: ['auth'],
        namePrefix: 'orders',
        lineNumber: 1,
        once: false,
        appliesContext: true,
        unguarded: true,
      },
      {
        filePath: 'bootstrap/app.php',
        requiredPath: 'vendor/missing.php',
        prefix: 'x',
        namespace: null,
        middleware: [],
        namePrefix: null,
        lineNumber: 2,
        once: false,
        appliesContext: true,
        unguarded: true,
      },
    ];
    const map = resolvePhpRouterRequireBindings(files, bindings);
    expect(map.get('routes/order.php')).toHaveLength(1);
    expect(map.has('vendor/missing.php')).toBe(false);
  });
});

describe('applyPhpRouterRequireContexts', () => {
  it('merges bootstrap group onto routes from required files', () => {
    const routes: ExtractedRoute[] = [
      {
        filePath: 'routes/order.php',
        httpMethod: 'get',
        routePath: '/x',
        routeName: 'x',
        controllerName: 'OrderController',
        methodName: 'index',
        middleware: [],
        prefix: 'v1',
        lineNumber: 1,
        stringAction: true,
      },
    ];
    const bindings = [
      {
        filePath: 'bootstrap/app.php',
        requiredPath: 'routes/order.php',
        prefix: 'order',
        namespace: 'App\\Http\\Controllers',
        middleware: ['auth'],
        namePrefix: 'order',
        lineNumber: 1,
        once: false,
        appliesContext: true,
        unguarded: true,
      },
    ];
    const merged = applyPhpRouterRequireContexts(
      routes,
      ['routes/order.php', 'bootstrap/app.php'],
      bindings,
    );
    expect(merged[0]).toMatchObject({
      prefix: 'order/v1',
      middleware: ['auth'],
      routeName: 'order.x',
      controllerQualifiedName: 'App.Http.Controllers.OrderController',
    });
  });

  it('composes bootstrap and in-file namespace for string actions only', () => {
    const routes: ExtractedRoute[] = [
      {
        filePath: 'routes/admin.php',
        httpMethod: 'get',
        routePath: '/dash',
        routeName: 'dash',
        controllerName: 'DashController',
        methodName: 'index',
        middleware: [],
        prefix: null,
        lineNumber: 1,
        stringAction: true,
        stringActionGroupNamespace: 'Admin',
      },
      {
        filePath: 'routes/admin.php',
        httpMethod: 'get',
        routePath: '/abs',
        routeName: null,
        controllerName: 'Vendor\\AbsController',
        methodName: 'go',
        middleware: [],
        prefix: null,
        lineNumber: 2,
        stringAction: true,
        stringActionAbsoluteController: true,
        controllerQualifiedName: 'Vendor.AbsController',
      },
    ];
    const bindings = [
      {
        filePath: 'bootstrap/app.php',
        requiredPath: 'routes/admin.php',
        prefix: null,
        namespace: 'App\\Http\\Controllers',
        middleware: [],
        namePrefix: null,
        lineNumber: 1,
        once: false,
        appliesContext: true,
        unguarded: true,
      },
    ];
    const merged = applyPhpRouterRequireContexts(
      routes,
      ['routes/admin.php', 'bootstrap/app.php'],
      bindings,
    );
    expect(merged[0]?.controllerQualifiedName).toBe('App.Http.Controllers.Admin.DashController');
    expect(merged[1]?.controllerQualifiedName).toBe('Vendor.AbsController');
  });

  it('bootstrap namespace does not prefix in-file absolute namespace reset', () => {
    const routes: ExtractedRoute[] = [
      {
        filePath: 'routes/admin.php',
        httpMethod: 'get',
        routePath: '/x',
        routeName: null,
        controllerName: 'UserController',
        methodName: 'index',
        middleware: [],
        prefix: null,
        lineNumber: 1,
        stringAction: true,
        stringActionGroupNamespace: 'Other.Ns',
        stringActionGroupNamespaceResets: true,
      },
    ];
    const bindings = [
      {
        filePath: 'bootstrap/app.php',
        requiredPath: 'routes/admin.php',
        prefix: null,
        namespace: 'App\\Http\\Controllers',
        middleware: [],
        namePrefix: null,
        lineNumber: 1,
        once: false,
        appliesContext: true,
        unguarded: true,
      },
    ];
    const merged = applyPhpRouterRequireContexts(
      routes,
      ['routes/admin.php', 'bootstrap/app.php'],
      bindings,
    );
    expect(merged[0]?.controllerQualifiedName).toBe('Other.Ns.UserController');
  });
});

describe('extractPhpRouterRequireBindings — PHP include semantics', () => {
  it('concatenates require path operands verbatim, as PHP `.` does', () => {
    const bindings = extractBindings(
      `<?php
$app->router->group(['prefix' => 'api'], function ($router) {
  require __DIR__ . '/../routes/web' . '.php';
});
`,
      'bootstrap/app.php',
    );
    expect(bindings.map((b) => b.requiredPath)).toEqual(['routes/web.php']);
  });

  it('visits requires nested under if, loop, and block statements', () => {
    const bindings = extractBindings(
      `<?php
$app->router->group(['prefix' => 'api'], function ($router) {
  if (env('A')) {
    require __DIR__ . '/../routes/a.php';
  } else {
    foreach ([1] as $x) {
      $router->group(['prefix' => 'v1'], function ($router) {
        require __DIR__ . '/../routes/b.php';
      });
    }
  }
});
`,
      'bootstrap/app.php',
    );
    expect(bindings.map((b) => [b.requiredPath, b.prefix])).toEqual([
      ['routes/a.php', 'api'],
      ['routes/b.php', 'api/v1'],
    ]);
  });

  it('does not bind requires inside functions or closures that the group does not run', () => {
    const bindings = extractBindings(
      `<?php
$app->router->group(['prefix' => 'api'], function ($router) {
  function later() { require __DIR__ . '/../routes/a.php'; }
  $cb = function () { require __DIR__ . '/../routes/b.php'; };
});
`,
      'bootstrap/app.php',
    );
    expect(bindings).toEqual([]);
  });

  it('marks require_once and include_once bindings', () => {
    const bindings = extractBindings(
      `<?php
$app->router->group(['prefix' => 'api'], function ($router) {
  require __DIR__ . '/../routes/a.php';
  require_once __DIR__ . '/../routes/b.php';
  include_once __DIR__ . '/../routes/c.php';
});
`,
      'bootstrap/app.php',
    );
    expect(bindings.map((b) => [b.requiredPath, b.once])).toEqual([
      ['routes/a.php', false],
      ['routes/b.php', true],
      ['routes/c.php', true],
    ]);
  });

  it('a require_once of an already-included routes file adds no context', () => {
    const bindings = extractBindings(
      `<?php
$app->router->group(['prefix' => 'first'], function ($router) {
  require_once __DIR__ . '/../routes/order.php';
});
$app->router->group(['prefix' => 'second'], function ($router) {
  require_once __DIR__ . '/../routes/order.php';
});
$app->router->group(['prefix' => 'third'], function ($router) {
  require __DIR__ . '/../routes/order.php';
});
`,
      'bootstrap/app.php',
    );
    const map = resolvePhpRouterRequireBindings(
      new Set(['bootstrap/app.php', 'routes/order.php']),
      bindings,
    );
    expect(map.get('routes/order.php')?.map((ctx) => ctx.prefix)).toEqual(['first', 'third']);
  });

  it('a top-level require counts as already run for a later require_once', () => {
    const bindings = extractBindings(
      `<?php
require __DIR__ . '/../routes/web.php';
$app->router->group(['prefix' => 'api'], function ($router) {
  require_once __DIR__ . '/../routes/web.php';
});
`,
      'bootstrap/app.php',
    );
    const map = resolvePhpRouterRequireBindings(
      new Set(['bootstrap/app.php', 'routes/web.php']),
      bindings,
    );
    expect(map.has('routes/web.php')).toBe(false);
  });

  it('a conditional grouped require_once does not suppress a later require_once', () => {
    const bindings = extractBindings(
      `<?php
$app->router->group(['prefix' => 'maybe'], function ($router) {
  if (env('X')) { require_once __DIR__ . '/../routes/web.php'; }
});
$app->router->group(['prefix' => 'api'], function ($router) {
  require_once __DIR__ . '/../routes/web.php';
});
`,
      'bootstrap/app.php',
    );
    const map = resolvePhpRouterRequireBindings(
      new Set(['bootstrap/app.php', 'routes/web.php']),
      bindings,
    );
    expect(map.get('routes/web.php')?.map((ctx) => ctx.prefix)).toEqual(['maybe', 'api']);
  });

  it('a require nested in a condition does not count as already run', () => {
    const bindings = extractBindings(
      `<?php
if (env('X')) { require __DIR__ . '/../routes/web.php'; }
$app->router->group(['prefix' => 'api'], function ($router) {
  require_once __DIR__ . '/../routes/web.php';
});
`,
      'bootstrap/app.php',
    );
    const map = resolvePhpRouterRequireBindings(
      new Set(['bootstrap/app.php', 'routes/web.php']),
      bindings,
    );
    expect(map.get('routes/web.php')?.map((ctx) => ctx.prefix)).toEqual(['api']);
  });

  it('a require inside a function does not count as already run', () => {
    const bindings = extractBindings(
      `<?php
function boot() { require __DIR__ . '/../routes/web.php'; }
$app->router->group(['prefix' => 'api'], function ($router) {
  require_once __DIR__ . '/../routes/web.php';
});
`,
      'bootstrap/app.php',
    );
    const map = resolvePhpRouterRequireBindings(
      new Set(['bootstrap/app.php', 'routes/web.php']),
      bindings,
    );
    expect(map.get('routes/web.php')?.map((ctx) => ctx.prefix)).toEqual(['api']);
  });

  it('folds a parenthesized require path', () => {
    const bindings = extractBindings(
      `<?php
$app->router->group(['prefix' => 'api'], function ($router) {
  require (__DIR__ . '/../routes/web.php');
});
`,
      'bootstrap/app.php',
    );
    expect(bindings.map((b) => b.requiredPath)).toEqual(['routes/web.php']);
  });
});

describe('extractPhpRouterRequireBindings — negatives', () => {
  it('require of non-routes file inside group does not bind route context', () => {
    const bindings = extractBindings(
      `<?php
$app->router->group(['prefix' => 'api'], function ($router) {
  require __DIR__ . '/../config/helpers.php';
});
`,
      'bootstrap/app.php',
    );
    const map = resolvePhpRouterRequireBindings(
      new Set(['bootstrap/app.php', 'config/helpers.php']),
      bindings,
    );
    expect(map.size).toBe(0);
  });
});
