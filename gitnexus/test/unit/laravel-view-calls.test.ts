import { describe, expect, it } from 'vitest';
import Parser from 'tree-sitter';
import PHP from 'tree-sitter-php';
import { extractLaravelViewCalls } from '../../src/core/ingestion/languages/php/laravel-view-calls.js';

const parser = new Parser();
parser.setLanguage(PHP.php_only);

const extract = (source: string) =>
  extractLaravelViewCalls(parser.parse(source)).map(({ viewName, lineNumber, kind }) => ({
    viewName,
    lineNumber,
    kind,
  }));

describe('Laravel view-render call extraction', () => {
  it('finds the helper, facade, response and route forms', () => {
    expect(
      extract(`<?php
class PostController {
    public function show() { return view('posts.show', ['post' => 1]); }
    public function legacy() { return View::make("posts.legacy"); }
    public function missing() { return response()->view('errors.404', [], 404); }
}
Route::view('/welcome', 'welcome');
`),
    ).toEqual([
      { viewName: 'posts.show', lineNumber: 2, kind: 'helper' },
      { viewName: 'posts.legacy', lineNumber: 3, kind: 'facade' },
      { viewName: 'errors.404', lineNumber: 4, kind: 'response' },
      { viewName: 'welcome', lineNumber: 6, kind: 'route' },
    ]);
  });

  it('accepts fully qualified helper and facade names', () => {
    expect(
      extract(`<?php
\\view('a.one');
\\Illuminate\\Support\\Facades\\View::make('a.two');
`).map((c) => c.viewName),
    ).toEqual(['a.one', 'a.two']);
  });

  it('matches names case-insensitively, as PHP does', () => {
    expect(
      extract(`<?php
VIEW('a.one');
view::MAKE('a.two');
ROUTE::View('/x', 'a.three');
Response()->VIEW('a.four');
`).map((c) => c.viewName),
    ).toEqual(['a.one', 'a.two', 'a.three', 'a.four']);
  });

  it('skips names built at runtime and package views', () => {
    expect(
      extract(`<?php
view($name);
view("{$prefix}.nav");
view('admin.' . $page);
view('mail::message');
View::make($template);
Route::view('/x', $view);
`),
    ).toEqual([]);
  });

  it('skips named and unpacked arguments', () => {
    expect(
      extract(`<?php
view(view: 'posts.show');
view(...$args);
`),
    ).toEqual([]);
  });

  it('ignores look-alike calls that do not render a view', () => {
    expect(
      extract(`<?php
$mailer->view('emails.welcome');
Cache::make('posts.show');
Route::get('/posts', 'posts.index');
preview('posts.show');
`),
    ).toEqual([]);
  });

  it('finds calls nested in closures and arguments', () => {
    expect(
      extract(`<?php
Route::get('/', function () {
    return view('home');
});
return redirect()->with('html', view('partials.flash')->render());
`).map((c) => c.viewName),
    ).toEqual(['home', 'partials.flash']);
  });
});
