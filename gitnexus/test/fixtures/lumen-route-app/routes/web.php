<?php

$router->get('/home', 'HomeController@show');

$router->group(['prefix' => 'users'], function () use ($router) {
    $router->get('', 'HomeController@show');
});