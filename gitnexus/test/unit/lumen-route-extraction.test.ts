import { describe, expect, it } from 'vitest';
import Parser from 'tree-sitter';
import PHP from 'tree-sitter-php';
import { extractLaravelRoutes } from '../../src/core/ingestion/route-extractors/laravel.js';

const parser = new Parser();
parser.setLanguage(PHP.php_only);

const extract = (source: string, filePath = 'routes/web.php') =>
  extractLaravelRoutes(parser.parse(source), filePath).map((route) => ({
    httpMethod: route.httpMethod,
    routePath: route.routePath,
    controllerName: route.controllerName,
    controllerQualifiedName: route.controllerQualifiedName ?? null,
    methodName: route.methodName,
    routeName: route.routeName,
    middleware: route.middleware,
    prefix: route.prefix,
  }));

describe('Lumen $router route extraction', () => {
  it('A1: extracts GET with qualified controller string', () => {
    const routes = extract(`<?php
$router->get('/x', 'Ns\\\\Ctrl@m');
`);
    expect(routes).toContainEqual(
      expect.objectContaining({
        httpMethod: 'get',
        routePath: '/x',
        controllerName: 'Ns\\Ctrl',
        methodName: 'm',
      }),
    );
  });

  it('A2: parses uses/as/middleware array action', () => {
    const routes = extract(`<?php
$router->post('/items', [
  'uses' => 'ItemController@store',
  'as' => 'items.store',
  'middleware' => ['auth', 'throttle'],
]);
`);
    expect(routes).toEqual([
      expect.objectContaining({
        httpMethod: 'post',
        routePath: '/items',
        controllerName: 'ItemController',
        methodName: 'store',
        routeName: 'items.store',
        middleware: ['auth', 'throttle'],
      }),
    ]);
  });

  it('A3: Lumen nested group as, namespace, and middleware', () => {
    const routes = extract(`<?php
$router->group(['prefix' => 'api', 'middleware' => ['auth'], 'namespace' => 'App\\\\Http\\\\Controllers', 'as' => 'api'], function () use ($router) {
    $router->group(['prefix' => 'v1', 'namespace' => 'V1', 'as' => 'v1'], function () use ($router) {
        $router->get('/users', ['uses' => 'UserController@index', 'as' => 'users']);
    });
});
`);
    expect(routes).toContainEqual(
      expect.objectContaining({
        httpMethod: 'get',
        routePath: '/users',
        controllerName: 'UserController',
        methodName: 'index',
        prefix: 'api/v1',
        middleware: ['auth'],
        routeName: 'api.v1.users',
        controllerQualifiedName: 'App.Http.Controllers.V1.UserController',
      }),
    );
  });

  it('Lumen group as without route as inherits group name', () => {
    const routes = extract(`<?php
$router->group(['as' => 'api'], function () use ($router) {
  $router->get('/ping', 'PingController@ping');
});
`);
    expect(routes).toContainEqual(
      expect.objectContaining({ routePath: '/ping', routeName: 'api' }),
    );
  });

  it('Lumen group as plus route as uses dot separator', () => {
    const routes = extract(`<?php
$router->group(['as' => 'api'], function () use ($router) {
  $router->get('/x', ['uses' => 'UserController@index', 'as' => 'users']);
});
`);
    expect(routes).toContainEqual(expect.objectContaining({ routeName: 'api.users' }));
  });

  it('Lumen relative controller path receives group namespace', () => {
    const routes = extract(`<?php
$router->group(['namespace' => 'App\\\\Http\\\\Controllers'], function () use ($router) {
  $router->get('/x', 'Admin\\\\UserController@index');
});
`);
    expect(routes).toContainEqual(
      expect.objectContaining({
        controllerQualifiedName: 'App.Http.Controllers.Admin.UserController',
      }),
    );
  });

  it('Lumen nested namespace with leading backslash resets outer', () => {
    const routes = extract(`<?php
$router->group(['namespace' => 'App\\\\Http\\\\Controllers'], function () use ($router) {
  $router->group(['namespace' => '\\\\Other\\\\Ns'], function () use ($router) {
    $router->get('/x', 'UserController@index');
  });
});
`);
    expect(routes).toContainEqual(
      expect.objectContaining({
        controllerQualifiedName: 'Other.Ns.UserController',
      }),
    );
  });

  it('Lumen middleware string splits on pipe', () => {
    const routes = extract(`<?php
$router->group(['middleware' => 'jwt.auth|throttle'], function () use ($router) {
  $router->get('/x', 'Ctrl@m');
});
`);
    expect(routes).toContainEqual(
      expect.objectContaining({ middleware: ['jwt.auth', 'throttle'] }),
    );
  });

  it('Lumen URI: pure literal concatenation', () => {
    const routes = extract(`<?php
$router->get('/api/' . 'x', 'HomeController@show');
`);
    expect(routes).toContainEqual(expect.objectContaining({ routePath: '/api/x' }));
  });

  it('Lumen URI: non-literal first argument still extracts handler with null path', () => {
    const routes = extract(`<?php
$router->get($uri, 'HomeController@show');
`);
    expect(routes).toEqual([
      expect.objectContaining({
        routePath: null,
        controllerName: 'HomeController',
        methodName: 'show',
      }),
    ]);
  });

  it('Lumen empty URI literal under prefix leaves routePath empty string', () => {
    const routes = extract(`<?php
$router->group(['prefix' => 'users'], function () use ($router) {
  $router->get('', 'UserController@index');
});
`);
    expect(routes).toEqual([
      expect.objectContaining({
        routePath: '',
        prefix: 'users',
        controllerName: 'UserController',
        methodName: 'index',
      }),
    ]);
  });

  it('X1: double-quoted URI with interpolation is non-literal (null path)', () => {
    const routes = extract(`<?php
$router->group(['prefix' => 'users'], function () use ($router) {
  $router->get("$u", 'UserController@index');
  $router->get('/users', 'UserController@list');
});
$router->get("/a/{$id}", 'UserController@dyn');
`);
    expect(routes).toContainEqual(
      expect.objectContaining({
        routePath: null,
        prefix: 'users',
        controllerName: 'UserController',
        methodName: 'index',
      }),
    );
    expect(routes).toContainEqual(
      expect.objectContaining({ routePath: '/users', methodName: 'list' }),
    );
    expect(routes).toContainEqual(expect.objectContaining({ routePath: null, methodName: 'dyn' }));
  });

  it('X1: plain double-quoted URI literal still parses', () => {
    const routes = extract(`<?php
$router->get("/plain", 'UserController@plain');
`);
    expect(routes).toContainEqual(
      expect.objectContaining({ routePath: '/plain', methodName: 'plain' }),
    );
  });

  it('decodes double-quoted escapes and keeps single-quoted backslashes', () => {
    const routes = extract(`<?php
$router->get("/a\\x2Fb\\101", 'UserController@hex');
$router->get('/a\\nb', 'UserController@single');
$router->get("/x", "Admin\\Ns\\UserController@dq");
`);
    expect(routes).toContainEqual(
      expect.objectContaining({ routePath: '/a/bA', methodName: 'hex' }),
    );
    expect(routes).toContainEqual(
      expect.objectContaining({ routePath: '/a\\nb', methodName: 'single' }),
    );
    expect(routes).toContainEqual(
      expect.objectContaining({ controllerName: 'Admin\\Ns\\UserController', methodName: 'dq' }),
    );
  });

  it('a bare backslash namespace resets to the root namespace', () => {
    const lumen = extract(`<?php
$router->group(['namespace' => 'App\\\\Http\\\\Controllers'], function () use ($router) {
  $router->group(['namespace' => '\\\\'], function () use ($router) {
    $router->get('/x', 'Vendor\\\\UserController@index');
  });
});
`);
    expect(lumen).toContainEqual(
      expect.objectContaining({ controllerQualifiedName: 'Vendor.UserController' }),
    );

    const laravel = extract(`<?php
Route::group(['namespace' => 'App\\\\Http\\\\Controllers'], function () {
  Route::group(['namespace' => '\\\\'], function () {
    Route::get('/x', 'Vendor\\\\UserController@index');
  });
});
`);
    expect(laravel).toContainEqual(
      expect.objectContaining({ controllerQualifiedName: 'Vendor.UserController' }),
    );
  });

  it('Lumen middleware array keeps pipe inside elements', () => {
    const routes = extract(`<?php
$router->group(['middleware' => ['a|b']], function () use ($router) {
  $router->get('/x', 'Ctrl@m');
});
`);
    expect(routes).toContainEqual(expect.objectContaining({ middleware: ['a|b'] }));
  });

  it('does not treat method-call chains as router receivers', () => {
    const routes = extract(`<?php
$router->getRoutes()->get('/trap', 'HomeController@show');
`);
    expect(routes).toHaveLength(0);
  });

  it('closure action array keeps as name without uses', () => {
    const routes = extract(`<?php
$router->get('/q', ['as' => 'q', function () { return 'ok'; }]);
`);
    expect(routes).toEqual([
      expect.objectContaining({
        routePath: '/q',
        routeName: 'q',
        controllerName: null,
        methodName: null,
      }),
    ]);
  });

  it('A5: Route::get with uses array and Route::group namespace', () => {
    const routes = extract(`<?php
Route::group(['namespace' => 'App\\\\Admin'], function () {
    Route::get('/x', ['uses' => 'Ctrl@m']);
});
`);
    expect(routes).toContainEqual(
      expect.objectContaining({
        httpMethod: 'get',
        routePath: '/x',
        controllerName: 'Ctrl',
        methodName: 'm',
        controllerQualifiedName: 'App.Admin.Ctrl',
      }),
    );
  });

  it('Route:: empty URI literal and non-literal URI keep extracted routes', () => {
    const routes = extract(`<?php
Route::get('', 'OrderController@index');
Route::get($uri, 'OrderController@show');
class R { const URI = '/x'; }
Route::get(R::URI, 'OrderController@edit');
`);
    expect(routes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          httpMethod: 'get',
          routePath: '',
          controllerName: 'OrderController',
          methodName: 'index',
        }),
        expect.objectContaining({
          routePath: null,
          methodName: 'show',
        }),
        expect.objectContaining({
          routePath: null,
          methodName: 'edit',
        }),
      ]),
    );
  });

  it('X1: Route:: interpolated URI yields null path', () => {
    const routes = extract(`<?php
Route::get("/a/{$id}", 'OrderController@dyn');
`);
    expect(routes).toContainEqual(
      expect.objectContaining({
        routePath: null,
        controllerName: 'OrderController',
        methodName: 'dyn',
      }),
    );
  });

  it('Route:: URI: pure literal concatenation', () => {
    const routes = extract(`<?php
Route::get('/api/' . 'y', 'Ctrl@ok');
`);
    expect(routes).toContainEqual(expect.objectContaining({ routePath: '/api/y' }));
  });

  it('Route:: group middleware accepts double-quoted string', () => {
    const routes = extract(`<?php
Route::group(['middleware' => "jwt.auth|throttle"], function () {
  Route::get('/x', 'Ctrl@m');
});
`);
    expect(routes).toContainEqual(expect.objectContaining({ middleware: ['jwt.auth|throttle'] }));
  });

  it('A9: ignores non-router GET receivers', () => {
    const routes = extract(`<?php
$client->get('/x', 'handler');
$request->get('field');
$this->get('/y', 'handler');
Route::get('/ok', 'Ctrl@ok');
`);
    expect(routes).toHaveLength(1);
    expect(routes[0]).toMatchObject({ routePath: '/ok' });
  });

  it('supports $app->router member receiver in routes file', () => {
    const routes = extract(`<?php
$app->router->get('/ping', 'PingController@ping');
`);
    expect(routes).toContainEqual(
      expect.objectContaining({
        httpMethod: 'get',
        routePath: '/ping',
        controllerName: 'PingController',
        methodName: 'ping',
      }),
    );
  });

  it('accepts $this->router and rejects ->router on other objects', () => {
    const routes = extract(`<?php
$this->router->get('/self', 'SelfController@show');
$client->router->get('/client', 'X@y');
$this->http->router->get('/nested', 'X@y');
$client->router->group([], function () {});
`);
    expect(routes.map((route) => route.routePath)).toEqual(['/self']);
  });

  it('F3: use import + class array in namespace group keeps imported FQCN', () => {
    const routes = extract(`<?php
use App\\Admin\\UserController;
Route::group(['namespace' => 'Api'], function () {
    Route::get('/u', [UserController::class, 'index']);
    Route::get('/s', 'ShortController@show');
});
`);
    expect(routes).toContainEqual(
      expect.objectContaining({
        routePath: '/u',
        controllerName: 'UserController',
        controllerQualifiedName: 'App.Admin.UserController',
      }),
    );
    expect(routes).toContainEqual(
      expect.objectContaining({
        routePath: '/s',
        controllerName: 'ShortController',
        controllerQualifiedName: 'Api.ShortController',
      }),
    );
  });

  it('absolute string controller strips leading backslash', () => {
    const routes = extract(`<?php
Route::get('/abs', '\\\\Vendor\\\\Abs\\\\Ctrl@m');
`);
    expect(routes).toContainEqual(
      expect.objectContaining({
        routePath: '/abs',
        controllerQualifiedName: 'Vendor.Abs.Ctrl',
      }),
    );
  });

  it('recognizes uppercase Lumen and Route method names', () => {
    const routes = extract(`<?php
$router->GROUP(['prefix' => 'api'], function () use ($router) {
  $router->GET('/x', 'UserController@show');
});
Route::GET('/y', 'UserController@list');
Route::ApiResource('/photos', 'PhotoController');
`);
    expect(routes).toContainEqual(
      expect.objectContaining({
        httpMethod: 'get',
        routePath: '/x',
        prefix: 'api',
        methodName: 'show',
      }),
    );
    expect(routes).toContainEqual(
      expect.objectContaining({ httpMethod: 'get', routePath: '/y', methodName: 'list' }),
    );
    expect(
      routes.filter((route) => route.routePath === '/photos').map((route) => route.methodName),
    ).toEqual(['index', 'store', 'show', 'update', 'destroy']);
  });

  it('folds a parenthesized literal URI', () => {
    const routes = extract(`<?php
$router->get(('/users'), 'UserController@show');
Route::get(('/users/' . 'x'), 'UserController@list');
`);
    expect(routes).toContainEqual(
      expect.objectContaining({ routePath: '/users', methodName: 'show' }),
    );
    expect(routes).toContainEqual(
      expect.objectContaining({ routePath: '/users/x', methodName: 'list' }),
    );
  });

  it('a controller() group class reference is not prefixed by the route namespace', () => {
    const routes = extract(`<?php
use App\\Controllers\\OrderController as Orders;
Route::group(['namespace' => 'Legacy'], function () {
  Route::controller(Orders::class)->group(function () {
    Route::get('/x', 'index');
  });
});
`);
    expect(routes).toContainEqual(
      expect.objectContaining({
        routePath: '/x',
        controllerName: 'Orders',
        controllerQualifiedName: 'App.Controllers.OrderController',
        methodName: 'index',
      }),
    );
  });

  it('emits closure routes without controller', () => {
    const routes = extract(`<?php
$router->get('/', function () {
    return 'ok';
});
`);
    expect(routes).toEqual([
      expect.objectContaining({
        httpMethod: 'get',
        routePath: '/',
        controllerName: null,
        methodName: null,
      }),
    ]);
  });
});
