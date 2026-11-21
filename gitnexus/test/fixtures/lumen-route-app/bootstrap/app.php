<?php

$app = new Laravel\Lumen\Application(dirname(__DIR__));

require __DIR__ . '/../config/helpers.php';

$app->router->group([
    'namespace' => 'App\Http\Controllers',
], function ($router) {
    require __DIR__ . '/../routes/web.php';
});

$app->router->group([
    'prefix' => 'orders',
    'namespace' => 'App\Http\Controllers',
    'middleware' => ['auth'],
    'as' => 'orders.',
], function ($router) {
    require_once __DIR__ . '/../routes/order.php';
});

$app->router->group([
    'prefix' => 'admin',
    'namespace' => 'App\Http\Controllers',
], function ($router) {
    if (getenv('ADMIN_ROUTES') !== 'off') {
        require __DIR__ . '/../routes/admin' . '.php';
    }
});

// order.php already ran above, so PHP skips this inclusion.
$app->router->group([
    'prefix' => 'legacy',
    'namespace' => 'App\Http\Controllers',
], function ($router) {
    require_once __DIR__ . '/../routes/order.php';
});