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
    methodName: route.methodName,
    routeName: route.routeName,
    middleware: route.middleware,
    prefix: route.prefix,
  }));

describe('Laravel route extraction', () => {
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
        expect.objectContaining({ httpMethod: 'match', routePath: '/orders/search' }),
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
