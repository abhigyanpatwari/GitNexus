<?php

namespace App\Http\Controllers;

use Illuminate\Support\Facades\View;

class PostController
{
    public function index()
    {
        return view('posts.index', ['posts' => []]);
    }

    public function show(int $id)
    {
        return View::make('posts.show', ['id' => $id]);
    }

    public function missing()
    {
        return response()->view('errors.404', [], 404);
    }

    public function dynamic(string $name)
    {
        return view($name);
    }
}
