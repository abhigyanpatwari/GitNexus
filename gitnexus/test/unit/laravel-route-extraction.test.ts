import { describe, expect, it } from 'vitest';
import Parser from 'tree-sitter';
import PHP from 'tree-sitter-php';
import { extractLaravelRoutes } from '../../src/core/ingestion/route-extractors/laravel.js';

const parser = new Parser();
parser.setLanguage(PHP.php_only);

const extract = (source: string) =>
  extractLaravelRoutes(parser.parse(source), 'routes/web.php').map((route) => ({
    httpMethod: route.httpMethod,
    routePath: route.routePath,
    controllerName: route.controllerName,
    controllerQualifiedName: route.controllerQualifiedName ?? null,
    methodName: route.methodName,
    routeName: route.routeName,
    middleware: route.middleware,
    prefix: route.prefix,
  }));

describe('Laravel route extraction', () => {
  it('Laravel group namespace leading backslash resets outer namespace', () => {
    const routes = extract(`<?php
Route::group(['namespace' => 'App\\\\Http\\\\Controllers'], function () {
    Route::group(['namespace' => '\\\\Other\\\\Ns'], function () {
        Route::get('/x', 'UserController@index');
    });
});
`);
    expect(routes).toContainEqual(
      expect.objectContaining({
        controllerQualifiedName: 'Other.Ns.UserController',
      }),
    );
  });

  it('extracts representative HTTP verb route declarations', () => {
    const routes = extract(`<?php
Route::get('/orders', [OrderController::class, 'index']);
Route::post('/orders', [OrderController::class, 'store']);
Route::put('/orders/{order}', [OrderController::class, 'update']);
Route::patch('/orders/{order}', [OrderController::class, 'patch']);
Route::delete('/orders/{order}', [OrderController::class, 'destroy']);
Route::options('/orders/options', [OrderController::class, 'options']);
Route::any('/orders/any', [OrderController::class, 'any']);
Route::match(['get', 'post'], '/orders/search', [OrderController::class, 'search']);
`);

    expect(routes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ httpMethod: 'get', routePath: '/orders', methodName: 'index' }),
        expect.objectContaining({ httpMethod: 'post', routePath: '/orders', methodName: 'store' }),
        expect.objectContaining({
          httpMethod: 'put',
          routePath: '/orders/{order}',
          methodName: 'update',
        }),
        expect.objectContaining({
          httpMethod: 'patch',
          routePath: '/orders/{order}',
          methodName: 'patch',
        }),
        expect.objectContaining({
          httpMethod: 'delete',
          routePath: '/orders/{order}',
          methodName: 'destroy',
        }),
        expect.objectContaining({
          httpMethod: 'options',
          routePath: '/orders/options',
          methodName: 'options',
        }),
        expect.objectContaining({
          httpMethod: 'any',
          routePath: '/orders/any',
          methodName: 'any',
        }),
        expect.objectContaining({
          httpMethod: 'match',
          routePath: '/orders/search',
          methodName: 'search',
        }),
      ]),
    );
  });

  it('expands resource and apiResource controller actions', () => {
    const routes = extract(`<?php
Route::resource('/photos', PhotoController::class);
Route::apiResource('/api/photos', ApiPhotoController::class);
`);

    const photos = routes.filter((route) => route.routePath === '/photos');
    expect(photos.map((route) => route.methodName)).toEqual([
      'index',
      'create',
      'store',
      'show',
      'edit',
      'update',
      'destroy',
    ]);
    expect(new Set(photos.map((route) => route.controllerName))).toEqual(
      new Set(['PhotoController']),
    );
    expect(photos.map((route) => route.routeName)).toEqual([
      'photos.index',
      'photos.create',
      'photos.store',
      'photos.show',
      'photos.edit',
      'photos.update',
      'photos.destroy',
    ]);

    const apiPhotos = routes.filter((route) => route.routePath === '/api/photos');
    expect(apiPhotos.map((route) => route.methodName)).toEqual([
      'index',
      'store',
      'show',
      'update',
      'destroy',
    ]);
    expect(new Set(apiPhotos.map((route) => route.controllerName))).toEqual(
      new Set(['ApiPhotoController']),
    );
    expect(apiPhotos.map((route) => route.routeName)).toEqual([
      'api.photos.index',
      'api.photos.store',
      'api.photos.show',
      'api.photos.update',
      'api.photos.destroy',
    ]);
  });

  it('does not fold a non-concatenation binary URI into a path', () => {
    const routes = extract(`<?php
Route::get($base ?? '/fallback', [OrderController::class, 'index']);
`);
    expect(routes).toHaveLength(1);
    expect(routes[0]).toMatchObject({
      routePath: null,
      controllerName: 'OrderController',
      methodName: 'index',
    });
  });

  it('folds a concatenated URI when tree-sitter hands out fresh node wrappers', () => {
    const tree = parser.parse(`<?php
Route::get('/a' . ('/b' . '/c'), [OrderController::class, 'index']);
`);
    // Every read returns a new wrapper, as node-tree-sitter does after a GC.
    const fresh = (node: Parser.SyntaxNode): Parser.SyntaxNode =>
      new Proxy(node, {
        get(target, prop) {
          const value = Reflect.get(target, prop, target);
          if (prop === 'children' || prop === 'namedChildren') {
            return (value as Parser.SyntaxNode[]).map(fresh);
          }
          if (prop === 'childForFieldName') {
            return (field: string) => {
              const child = target.childForFieldName(field);
              return child ? fresh(child) : null;
            };
          }
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
    const routes = extractLaravelRoutes(
      { rootNode: fresh(tree.rootNode) } as Parser.Tree,
      'routes/web.php',
    );
    expect(routes.map((route) => route.routePath)).toEqual(['/a/b/c']);
  });

  it('drops empty middleware strings', () => {
    const routes = extract(`<?php
Route::middleware('')->get('/a', [OrderController::class, 'index']);
Route::middleware(['', 'auth'])->get('/b', [OrderController::class, 'index']);
`);
    expect(routes.map((route) => route.middleware)).toEqual([[], ['auth']]);
  });

  it('ignores comments between call arguments', () => {
    const routes = extract(`<?php
Route::get(/* uri */ '/orders', /* action */ [OrderController::class, 'index']);
Route::match(['get', 'post'], /* uri */ '/search', 'SearchController@search');
`);
    expect(routes).toEqual([
      expect.objectContaining({
        routePath: '/orders',
        controllerName: 'OrderController',
        methodName: 'index',
      }),
      expect.objectContaining({
        routePath: '/search',
        controllerName: 'SearchController',
        methodName: 'search',
      }),
    ]);
  });

  it('does not read a keyed action array as a positional controller pair', () => {
    const routes = extract(`<?php
Route::get('/orders', ['middleware' => 'auth', 'as' => 'orders', function () {}]);
Route::get('/report', ['middleware' => 'auth', 'uses' => $handler]);
`);
    expect(routes).toEqual([
      expect.objectContaining({
        routePath: '/orders',
        routeName: 'orders',
        controllerName: null,
        methodName: null,
        middleware: ['auth'],
      }),
      expect.objectContaining({
        routePath: '/report',
        controllerName: null,
        methodName: null,
        middleware: ['auth'],
      }),
    ]);
  });

  it('does not double-prefix a string controller already under the group namespace', () => {
    const routes = extract(`<?php
Route::group(['namespace' => 'App\\\\Http\\\\Controllers'], function () {
    Route::get('/users', 'App\\\\Http\\\\Controllers\\\\UserController@index');
});
`);
    expect(routes).toContainEqual(
      expect.objectContaining({
        controllerName: 'App\\Http\\Controllers\\UserController',
        controllerQualifiedName: 'App.Http.Controllers.UserController',
        methodName: 'index',
      }),
    );
  });

  it('threads fluent namespace into grouped string-action routes', () => {
    const routes = extract(`<?php
Route::namespace('Admin\\\\Http\\\\Controllers')
    ->prefix('admin')
    ->group(function () {
        Route::get('/users', 'UserController@index');
    });
`);

    expect(routes).toContainEqual(
      expect.objectContaining({
        httpMethod: 'get',
        routePath: '/users',
        methodName: 'index',
        controllerName: 'UserController',
        controllerQualifiedName: 'Admin.Http.Controllers.UserController',
        prefix: 'admin',
      }),
    );
  });

  it('threads middleware, prefix, and controller chains into grouped routes', () => {
    const routes = extract(`<?php
Route::get('/loose', 'index');

Route::group([
    'prefix' => 'api',
    'middleware' => ['auth'],
    'controller' => ApiOrderController::class,
], function () {
    Route::post('/orders', 'store');
});

Route::middleware(['auth', 'verified'])
    ->prefix('admin')
    ->controller(OrderController::class)
    ->group(function () {
        Route::get('/orders', 'index');
    });
`);

    expect(routes).toContainEqual(
      expect.objectContaining({
        httpMethod: 'get',
        routePath: '/orders',
        controllerName: 'OrderController',
        methodName: 'index',
        middleware: ['auth', 'verified'],
        prefix: 'admin',
      }),
    );

    expect(routes).toContainEqual(
      expect.objectContaining({
        httpMethod: 'post',
        routePath: '/orders',
        controllerName: 'ApiOrderController',
        methodName: 'store',
        middleware: ['auth'],
        prefix: 'api',
      }),
    );

    expect(routes).toContainEqual(
      expect.objectContaining({
        httpMethod: 'get',
        routePath: '/loose',
        controllerName: null,
        methodName: null,
      }),
    );
  });

  it('splits a fully qualified group controller into short and qualified names', () => {
    const routes = extract(`<?php
Route::group([
    'controller' => \\App\\Http\\Controllers\\UserController::class,
], function () {
    Route::get('/qualified', 'show');
});
`);
    expect(routes).toContainEqual(
      expect.objectContaining({
        httpMethod: 'get',
        routePath: '/qualified',
        controllerName: 'UserController',
        controllerQualifiedName: 'App.Http.Controllers.UserController',
        methodName: 'show',
      }),
    );
  });

  it('extracts named routes from fluent routes and named groups', () => {
    const routes = extract(`<?php
Route::get('/login', [AuthController::class, 'login'])->name('login');
Route::post('/logout', [AuthController::class, 'logout'])->middleware('auth')->name('logout');

Route::name('admin.')
    ->prefix('admin')
    ->group(function () {
        Route::post('/settings/cache', [SettingsController::class, 'refresh'])
            ->name('settings.refresh-cache');
    });

Route::group([
    'as' => 'log-viewer.',
    'prefix' => 'logs',
], function () {
    Route::post('/login', [LogViewerController::class, 'login'])
        ->name('login.submit');
});
`);

    expect(routes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          httpMethod: 'get',
          routePath: '/login',
          routeName: 'login',
        }),
        expect.objectContaining({
          httpMethod: 'post',
          routePath: '/logout',
          routeName: 'logout',
          middleware: ['auth'],
        }),
        expect.objectContaining({
          httpMethod: 'post',
          routePath: '/settings/cache',
          routeName: 'admin.settings.refresh-cache',
          prefix: 'admin',
        }),
        expect.objectContaining({
          httpMethod: 'post',
          routePath: '/login',
          routeName: 'log-viewer.login.submit',
          prefix: 'logs',
        }),
      ]),
    );
  });
});

describe('Laravel controller qualified-name resolution (RING4-2 follow-up)', () => {
  const routeFor = (source: string, routePath: string) =>
    extractLaravelRoutes(parser.parse(source), 'routes/web.php').find(
      (r) => r.routePath === routePath,
    );

  it('resolves an aliased controller import to its normalized FQN', () => {
    const route = routeFor(
      `<?php
use App\\Http\\Controllers\\OrderController as Orders;
Route::get('/orders', [Orders::class, 'index']);
`,
      '/orders',
    );
    expect(route?.controllerName).toBe('Orders');
    expect(route?.controllerQualifiedName).toBe('App.Http.Controllers.OrderController');
  });

  it('resolves a plain (non-aliased) controller import to its normalized FQN', () => {
    const route = routeFor(
      `<?php
use App\\Http\\Controllers\\OrderController;
Route::get('/orders', [OrderController::class, 'index']);
`,
      '/orders',
    );
    expect(route?.controllerName).toBe('OrderController');
    expect(route?.controllerQualifiedName).toBe('App.Http.Controllers.OrderController');
  });

  it('captures an inline qualified ::class reference as the normalized FQN', () => {
    const route = routeFor(
      `<?php
Route::get('/orders', [\\App\\Admin\\OrderController::class, 'index']);
`,
      '/orders',
    );
    expect(route?.controllerQualifiedName).toBe('App.Admin.OrderController');
  });

  it('leaves controllerQualifiedName null for a bare short name with no use import', () => {
    const route = routeFor(
      `<?php
Route::get('/orders', [OrderController::class, 'index']);
`,
      '/orders',
    );
    expect(route?.controllerName).toBe('OrderController');
    expect(route?.controllerQualifiedName ?? null).toBeNull();
  });

  it('threads the FQN through resource routes', () => {
    const routes = extractLaravelRoutes(
      parser.parse(`<?php
use App\\Http\\Controllers\\PhotoController as Photos;
Route::resource('/photos', Photos::class);
`),
      'routes/web.php',
    ).filter((r) => r.routePath === '/photos');
    expect(routes.length).toBeGreaterThan(0);
    for (const r of routes) {
      expect(r.controllerQualifiedName).toBe('App.Http.Controllers.PhotoController');
    }
  });
});
