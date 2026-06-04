<?php

// Two OrderControllers share a short name in different namespaces; the public
// one is imported plain, the admin one aliased. PhotoController is aliased too.
use App\Http\Controllers\OrderController;
use App\Admin\OrderController as AdminOrders;
use App\Http\Controllers\PhotoController as Photos;

// Plain `use` of a globally-duplicated short name → must resolve to the public one.
Route::get('/orders', [OrderController::class, 'index']);

// Aliased `use` of the other same-short-name controller → must resolve to the admin one.
Route::get('/admin/orders', [AdminOrders::class, 'index']);

// Aliased controller import → must resolve to PhotoController.
Route::get('/photos', [Photos::class, 'list']);
