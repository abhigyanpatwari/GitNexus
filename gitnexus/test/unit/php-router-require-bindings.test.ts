import { describe, expect, it } from 'vitest';
import Parser from 'tree-sitter';
import PHP from 'tree-sitter-php';
import {
  extractPhpRouterRequireBindings,
  shouldExtractPhpRouterRequireBindings,
} from '../../src/core/ingestion/languages/php/router-require-bindings.js';
import {
  applyPhpRouterRequireContexts,
  resolvePhpRouterRequireBindings,
} from '../../src/core/ingestion/languages/php/router-require-context.js';
import { qualifyStringActionController } from '../../src/core/ingestion/languages/php/route-group.js';
import {
  extractLaravelRoutes,
  type ExtractedRoute,
} from '../../src/core/ingestion/route-extractors/laravel.js';

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
        column: 0,
        controller: null,
        namespaceResets: false,
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
        column: 0,
        controller: null,
        namespaceResets: false,
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
        column: 0,
        controller: null,
        namespaceResets: false,
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
        column: 0,
        controller: null,
        namespaceResets: false,
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
        column: 0,
        controller: null,
        namespaceResets: false,
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

  it('does not give the group context to requires in functions or closures it does not run', () => {
    const bindings = extractBindings(
      `<?php
$app->router->group(['prefix' => 'api'], function ($router) {
  function later() { require __DIR__ . '/../routes/a.php'; }
  $cb = function () { require __DIR__ . '/../routes/b.php'; };
});
`,
      'bootstrap/app.php',
    );
    expect(bindings.map((b) => [b.requiredPath, b.appliesContext, b.unguarded])).toEqual([
      ['routes/a.php', false, false],
      ['routes/b.php', false, false],
    ]);
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

  it('a group under a condition still applies its context', () => {
    const bindings = extractBindings(
      `<?php
if (env('X')) {
  $app->router->group(['prefix' => 'api'], function ($router) {
    require __DIR__ . '/../routes/web.php';
  });
}
`,
      'bootstrap/app.php',
    );
    const map = resolvePhpRouterRequireBindings(
      new Set(['bootstrap/app.php', 'routes/web.php']),
      bindings,
    );
    expect(map.get('routes/web.php')?.map((ctx) => ctx.prefix)).toEqual(['api']);
  });

  it('require_once in unrelated host files does not share include state', () => {
    const hostA = extractBindings(
      `<?php
$app->router->group(['prefix' => 'a'], function ($router) {
  require_once __DIR__ . '/../routes/web.php';
});
`,
      'bootstrap/a.php',
    );
    const hostB = extractBindings(
      `<?php
$app->router->group(['prefix' => 'b'], function ($router) {
  require_once __DIR__ . '/../routes/web.php';
});
`,
      'bootstrap/b.php',
    );
    const files = new Set(['bootstrap/a.php', 'bootstrap/b.php', 'routes/web.php']);
    const forward = resolvePhpRouterRequireBindings(files, [...hostA, ...hostB]);
    const reversed = resolvePhpRouterRequireBindings(files, [...hostB, ...hostA]);
    expect(forward.get('routes/web.php')?.map((ctx) => ctx.prefix)).toEqual(['a', 'b']);
    expect(reversed).toEqual(forward);
  });

  it('resolves the same contexts whatever order bindings arrive in', () => {
    const bindings = extractBindings(
      `<?php
$app->router->group(['prefix' => 'first'], function ($router) {
  require_once __DIR__ . '/../routes/web.php';
});
$app->router->group(['prefix' => 'second'], function ($router) {
  require_once __DIR__ . '/../routes/web.php';
});
`,
      'bootstrap/app.php',
    );
    const files = new Set(['bootstrap/app.php', 'routes/web.php']);
    const forward = resolvePhpRouterRequireBindings(files, bindings);
    const reversed = resolvePhpRouterRequireBindings(files, [...bindings].reverse());
    expect(forward.get('routes/web.php')?.map((ctx) => ctx.prefix)).toEqual(['first']);
    expect(reversed).toEqual(forward);
  });

  it('require_once inside a method group does not suppress a later top-level require_once', () => {
    const bindings = extractBindings(
      `<?php
class Routes {
  public function map($app) {
    $app->router->group(['prefix' => 'inner'], function ($router) {
      require_once __DIR__ . '/../routes/web.php';
    });
  }
}
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
    expect(map.get('routes/web.php')?.map((ctx) => ctx.prefix)).toEqual(['inner', 'api']);
  });

  it('treats require in finally as unguarded', () => {
    const bindings = extractBindings(
      `<?php
$app->router->group(['prefix' => 'api'], function ($router) {
  try {
    // no require
  } finally {
    require_once __DIR__ . '/../routes/web.php';
  }
});
`,
      'bootstrap/app.php',
    );
    expect(bindings).toEqual([
      expect.objectContaining({ prefix: 'api', unguarded: true, once: true }),
    ]);
  });

  it('treats require in finally as unguarded even when the try body may return', () => {
    const bindings = extractBindings(
      `<?php
$app->router->group(['prefix' => 'api'], function ($router) {
  try {
    return;
  } finally {
    require_once __DIR__ . '/../routes/web.php';
  }
});
`,
      'bootstrap/app.php',
    );
    expect(bindings).toEqual([
      expect.objectContaining({ prefix: 'api', unguarded: true, once: true }),
    ]);
    const map = resolvePhpRouterRequireBindings(
      new Set(['bootstrap/app.php', 'routes/web.php']),
      bindings,
    );
    expect(map.get('routes/web.php')?.map((ctx) => ctx.prefix)).toEqual(['api']);
  });

  it('does not treat a break inside a loop as guarding a later require in the same block', () => {
    const source = `<?php
$app->router->group(['prefix' => 'api'], function ($router) {
  foreach ([1] as $x) {
    break;
  }
  require __DIR__ . '/../routes/web.php';
});
$app->router->group(['prefix' => 'later'], function ($router) {
  require_once __DIR__ . '/../routes/web.php';
});
`;
    const bindings = extractBindings(source, 'bootstrap/app.php');
    expect(
      bindings.find((b) => b.requiredPath === 'routes/web.php' && b.prefix === 'api')?.unguarded,
    ).toBe(true);
    expect(webContexts(source)).toEqual(['api']);
  });

  it('drops a second unguarded require_once of the same file in one host', () => {
    expect(
      webContexts(`<?php
$app->router->group(['prefix' => 'a'], function ($router) {
  require_once __DIR__ . '/../routes/web.php';
  require_once __DIR__ . '/../routes/web.php';
});
`),
    ).toEqual(['a']);
  });

  it('matches uppercase router GROUP for extraction gate', () => {
    expect(
      shouldExtractPhpRouterRequireBindings(`<?php
$app->router->GROUP([], function () { require __DIR__ . '/routes/web.php'; });
`),
    ).toBe(true);
  });

  it('matches uppercase REQUIRE inside a group for extraction gate', () => {
    expect(
      shouldExtractPhpRouterRequireBindings(`<?php
$app->router->group([], function () { REQUIRE __DIR__ . '/routes/web.php'; });
`),
    ).toBe(true);
  });

  it('treats require inside do-while body as unguarded', () => {
    const bindings = extractBindings(
      `<?php
$app->router->group(['prefix' => 'first'], function ($router) {
  do {
    require_once __DIR__ . '/../routes/web.php';
  } while (false);
});
$app->router->group(['prefix' => 'second'], function ($router) {
  require_once __DIR__ . '/../routes/web.php';
});
`,
      'bootstrap/app.php',
    );
    const map = resolvePhpRouterRequireBindings(
      new Set(['bootstrap/app.php', 'routes/web.php']),
      bindings,
    );
    expect(map.get('routes/web.php')?.map((ctx) => ctx.prefix)).toEqual(['first']);
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
    expect(map.get('routes/web.php')?.map((ctx) => ctx.prefix)).toEqual([null, 'api']);
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
    expect(map.get('routes/web.php')?.map((ctx) => ctx.prefix)).toEqual([null, 'api']);
  });

  const webContexts = (source: string): (string | null)[] | undefined =>
    resolvePhpRouterRequireBindings(
      new Set(['bootstrap/app.php', 'routes/web.php']),
      extractBindings(source, 'bootstrap/app.php'),
    )
      .get('routes/web.php')
      ?.map((ctx) => ctx.prefix);

  it('a require on the right of && does not count as already run', () => {
    expect(
      webContexts(`<?php
$on && require_once __DIR__ . '/../routes/web.php';
$app->router->group(['prefix' => 'api'], function ($router) {
  require_once __DIR__ . '/../routes/web.php';
});
`),
    ).toEqual([null, 'api']);
  });

  it('a require after a possible early return does not count as already run for require_once', () => {
    const source = `<?php
if (!$on) { return; }
require __DIR__ . '/../routes/web.php';
$app->router->group(['prefix' => 'api'], function ($router) {
  require_once __DIR__ . '/../routes/web.php';
});
`;
    const bindings = extractBindings(source, 'bootstrap/app.php');
    expect(bindings.find((b) => !b.once && !b.appliesContext)?.unguarded).toBe(false);
    // Guarded bare require does not populate the host included set, so the later
    // require_once may-context remains (contract: every context the file may load under).
    expect(webContexts(source)).toEqual([null, 'api']);
  });

  it('a caught try throw does not guard a later unconditional require', () => {
    const source = `<?php
try { throw new Exception(); } catch (Throwable $e) {}
require __DIR__ . '/../routes/web.php';
$app->router->group(['prefix' => 'api'], function ($router) {
  require_once __DIR__ . '/../routes/web.php';
});
`;
    const bindings = extractBindings(source, 'bootstrap/app.php');
    expect(bindings.find((b) => !b.once && !b.appliesContext)?.unguarded).toBe(true);
    expect(webContexts(source)).toBeUndefined();
  });

  it('a throw inside a caught try still guards the rest of that try body', () => {
    const source = `<?php
try {
  if ($x) throw new Exception();
  require __DIR__ . '/../routes/web.php';
} catch (Throwable $e) {}
$app->router->group(['prefix' => 'api'], function ($router) {
  require_once __DIR__ . '/../routes/web.php';
});
`;
    const bindings = extractBindings(source, 'bootstrap/app.php');
    expect(bindings.find((b) => !b.once)?.unguarded).toBe(false);
    expect(webContexts(source)).toEqual([null, 'api']);
  });

  it('a type-restricted catch does not treat a throw as handled', () => {
    const source = `<?php
try { throw new RuntimeException(); } catch (Error $e) {}
require __DIR__ . '/../routes/web.php';
$app->router->group(['prefix' => 'api'], function ($router) {
  require_once __DIR__ . '/../routes/web.php';
});
`;
    const bindings = extractBindings(source, 'bootstrap/app.php');
    expect(bindings.find((b) => !b.once && !b.appliesContext)?.unguarded).toBe(false);
    expect(webContexts(source)).toEqual([null, 'api']);
  });

  it('an unqualified Throwable inside a namespace does not count as caught', () => {
    const source = `<?php
namespace App;
try { throw new \\RuntimeException(); } catch (Throwable $e) {}
require __DIR__ . '/../routes/web.php';
`;
    const bindings = extractBindings(source, 'bootstrap/app.php');
    expect(bindings.find((b) => !b.once)?.unguarded).toBe(false);
  });

  it('an outer Throwable catch covers a throw the inner catch misses', () => {
    const source = `<?php
try {
  try { throw new Exception(); } catch (Error $e) {}
} catch (Throwable $e) {}
require __DIR__ . '/../routes/web.php';
`;
    const bindings = extractBindings(source, 'bootstrap/app.php');
    expect(bindings.find((b) => !b.once)?.unguarded).toBe(true);
  });

  it('forwards a group controller onto the require binding', () => {
    const bindings = extractBindings(
      `<?php
$app->router->group(['controller' => HomeController::class, 'prefix' => 'api'], function ($router) {
  require __DIR__ . '/../routes/web.php';
});
`,
      'bootstrap/app.php',
    );
    expect(bindings[0]?.controller).toBe('HomeController');
  });

  it('does not prepend a group namespace that already qualifies the action ignoring case', () => {
    expect(
      qualifyStringActionController(
        'app\\http\\controllers\\UserController',
        'App\\Http\\Controllers',
        false,
        null,
      ),
    ).toBe('app.http.controllers.UserController');
  });

  it('a require after break in a do-body is not a definite load', () => {
    const source = `<?php
do {
  break;
  require_once __DIR__ . '/../routes/web.php';
} while (0);
$app->router->group(['prefix' => 'api'], function ($router) {
  require_once __DIR__ . '/../routes/web.php';
});
`;
    const bindings = extractBindings(source, 'bootstrap/app.php');
    expect(bindings.find((b) => b.lineNumber === 3)).toBeUndefined();
    expect(webContexts(source)).toEqual(['api']);
  });

  it('break 2 does not treat a require in the outer loop as a definite load', () => {
    const source = `<?php
foreach ([1] as $i) {
  foreach ([1] as $j) { break 2; }
  require_once __DIR__ . '/../routes/web.php';
}
$app->router->group(['prefix' => 'api'], function ($router) {
  require_once __DIR__ . '/../routes/web.php';
});
`;
    const bindings = extractBindings(source, 'bootstrap/app.php');
    expect(bindings.find((b) => b.lineNumber === 3)?.unguarded).toBe(false);
    expect(webContexts(source)).toContain('api');
  });

  it('goto does not hide a require at the target label', () => {
    const bindings = extractBindings(
      `<?php
goto done;
done:
require __DIR__ . '/../routes/web.php';
`,
      'bootstrap/app.php',
    );
    expect(bindings.some((b) => b.requiredPath === 'routes/web.php')).toBe(true);
  });

  it('cross-host require_once skips after an unguarded load in another host', () => {
    const apiBindings = extractBindings(
      `<?php
$app->router->group(['prefix' => 'api'], function ($router) {
  require_once __DIR__ . '/../routes/web.php';
});
`,
      'routes/api.php',
    );
    const webBindings = extractBindings(
      `<?php
require __DIR__ . '/web.php';
`,
      'routes/web.php',
    );
    const bootstrapBindings = extractBindings(
      `<?php
require __DIR__ . '/../routes/api.php';
$app->router->group(['prefix' => 'v2'], function ($router) {
  require_once __DIR__ . '/../routes/web.php';
});
`,
      'bootstrap/app.php',
    );
    const files = new Set(['bootstrap/app.php', 'routes/api.php', 'routes/web.php']);
    const map = resolvePhpRouterRequireBindings(files, [
      ...bootstrapBindings,
      ...apiBindings,
      ...webBindings,
    ]);
    expect(map.get('routes/web.php')?.map((ctx) => ctx.prefix)).toEqual(['api']);
  });

  it('skipping require_once in one entry walk keeps it for another entry', () => {
    const entryA = extractBindings(
      `<?php
require __DIR__ . '/../routes/web.php';
require __DIR__ . '/../routes/mid.php';
`,
      'bootstrap/a.php',
    );
    const entryC = extractBindings(
      `<?php
$app->router->group(['prefix' => 'c'], function ($router) {
  require __DIR__ . '/../routes/mid.php';
});
`,
      'bootstrap/c.php',
    );
    const mid = extractBindings(
      `<?php
$app->router->group(['prefix' => 'mid'], function ($router) {
  require_once __DIR__ . '/web.php';
});
`,
      'routes/mid.php',
    );
    const map = resolvePhpRouterRequireBindings(
      new Set(['bootstrap/a.php', 'bootstrap/c.php', 'routes/mid.php', 'routes/web.php']),
      [...entryA, ...entryC, ...mid],
    );
    expect(map.get('routes/web.php')?.map((ctx) => ctx.prefix)).toEqual([null, 'c/mid']);
  });

  it('a return inside a group closure only guards the rest of that closure', () => {
    expect(
      webContexts(`<?php
$app->router->group(['prefix' => 'first'], function ($router) {
  require __DIR__ . '/../routes/web.php';
  return;
});
$app->router->group(['prefix' => 'api'], function ($router) {
  require_once __DIR__ . '/../routes/web.php';
});
`),
    ).toEqual(['first']);
  });

  it('an unbraced conditional do-body does not count as already run', () => {
    expect(
      webContexts(`<?php
$app->router->group(['prefix' => 'first'], function ($router) {
  do if ($on) require_once __DIR__ . '/../routes/web.php'; while (0);
});
$app->router->group(['prefix' => 'api'], function ($router) {
  require_once __DIR__ . '/../routes/web.php';
});
`),
    ).toEqual(['first', 'api']);
  });

  it('a file required both bare and inside a group keeps both contexts', () => {
    expect(
      webContexts(`<?php
$app->router->group(['prefix' => 'api'], function ($router) {
  require __DIR__ . '/../routes/web.php';
});
require __DIR__ . '/../routes/web.php';
`),
    ).toEqual(['api', null]);
  });

  it('orders same-line requires by column whatever order bindings arrive in', () => {
    const bindings = extractBindings(
      `<?php
$app->router->group(['prefix' => 'api'], function ($router) { require_once __DIR__ . '/../routes/web.php'; }); require_once __DIR__ . '/../routes/web.php';
`,
      'bootstrap/app.php',
    );
    const files = new Set(['bootstrap/app.php', 'routes/web.php']);
    const forward = resolvePhpRouterRequireBindings(files, bindings);
    const reversed = resolvePhpRouterRequireBindings(files, [...bindings].reverse());
    expect(forward.get('routes/web.php')?.map((ctx) => ctx.prefix)).toEqual(['api']);
    expect(reversed).toEqual(forward);
  });

  it('deduplicates identical contexts', () => {
    expect(
      webContexts(`<?php
$app->router->group(['prefix' => 'api'], function ($router) {
  require __DIR__ . '/../routes/web.php';
  require __DIR__ . '/../routes/web.php';
});
`),
    ).toEqual(['api']);
  });

  it('accepts (__DIR__) and lowercase __dir__ in a require path', () => {
    const bindings = extractBindings(
      `<?php
$app->router->group([], function ($router) {
  require (__DIR__) . '/../routes/a.php';
  require __dir__ . '/../routes/b.php';
});
`,
      'bootstrap/app.php',
    );
    expect(bindings.map((b) => b.requiredPath)).toEqual(['routes/a.php', 'routes/b.php']);
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

describe('route files required by other route files', () => {
  const bootstrap = extractBindings(
    `<?php
$app->router->group([
  'prefix' => 'api',
  'namespace' => 'App\\\\Http\\\\Controllers',
  'middleware' => 'jwt',
  'as' => 'api',
], function ($router) {
  require __DIR__ . '/../routes/web.php';
});
`,
    'bootstrap/app.php',
  );
  const web = extractBindings(
    `<?php
$router->group(['prefix' => 'v1', 'namespace' => 'Admin', 'middleware' => 'admin', 'as' => 'v1'], function ($router) {
  require __DIR__ . '/admin.php';
});
`,
    'routes/web.php',
  );
  const files = ['bootstrap/app.php', 'routes/web.php', 'routes/admin.php'];

  it('composes the host route file contexts with the inner group', () => {
    const map = resolvePhpRouterRequireBindings(files, [...web, ...bootstrap]);
    expect(map.get('routes/admin.php')).toEqual([
      {
        prefix: 'api/v1',
        namespace: 'App\\Http\\Controllers\\Admin',
        middleware: ['jwt', 'admin'],
        namePrefix: 'api.v1',
        controller: null,
      },
    ]);
  });

  it.each(['require_once', 'require'])(
    'a %s back into a file that is already running adds no context',
    (keyword) => {
      const admin = extractBindings(
        `<?php
${keyword} __DIR__ . '/web.php';
`,
        'routes/admin.php',
      );
      const map = resolvePhpRouterRequireBindings(files, [...bootstrap, ...web, ...admin]);
      expect(map.get('routes/web.php')?.map((ctx) => ctx.prefix)).toEqual(['api']);
      expect(map.get('routes/admin.php')?.map((ctx) => ctx.prefix)).toEqual(['api/v1']);
    },
  );

  it('bounds the contexts a chain of multiplying route files can produce', () => {
    const chain: string[] = ['bootstrap/app.php'];
    const bindings = [];
    for (let i = 0; i < 12; i++) {
      const host = i === 0 ? 'bootstrap/app.php' : `routes/r${i - 1}.php`;
      const target = `routes/r${i}.php`;
      chain.push(target);
      bindings.push(
        ...extractBindings(
          `<?php
$router->group(['prefix' => 'a'], function ($router) { require '${target}'; });
$router->group(['prefix' => 'b'], function ($router) { require '${target}'; });
`,
          host,
        ),
      );
    }
    const map = resolvePhpRouterRequireBindings(chain, bindings);
    expect(map.get('routes/r11.php')).toHaveLength(256);
  });

  it('applies bare and grouped contexts to extracted routes', () => {
    const routesSource = `<?php
$router->get('/orders', ['as' => 'orders', 'uses' => 'OrderController@index']);
`;
    const routes = extractLaravelRoutes(parser.parse(routesSource), 'routes/orders.php');
    const host = extractBindings(
      `<?php
require __DIR__ . '/../routes/orders.php';
$app->router->group(['prefix' => 'api', 'middleware' => 'jwt', 'as' => 'api'], function ($router) {
  require __DIR__ . '/../routes/orders.php';
});
`,
      'bootstrap/app.php',
    );
    const merged = applyPhpRouterRequireContexts(
      routes,
      ['bootstrap/app.php', 'routes/orders.php'],
      host,
    );
    expect(merged.map((r) => [r.prefix, r.middleware, r.routeName])).toEqual([
      [null, [], 'orders'],
      ['api', ['jwt'], 'api.orders'],
    ]);
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
