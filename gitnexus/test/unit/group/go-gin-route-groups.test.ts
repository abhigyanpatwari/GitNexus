/**
 * Group HTTP-contract layer: Go gin/echo framework routes registered through
 * route groups and method-value handlers. Exercises `GO_HTTP_PLUGIN.scan`
 * directly with a real tree-sitter parser, asserting the FULL registered path
 * (every enclosing `x := y.Group("/p")` prefix joined in) and the handler name
 * the group layer resolves by. The last block runs the real extractor on a Go
 * provider repo and a fetch() consumer repo and pairs them with `runExactMatch`.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import Parser from 'tree-sitter';
import Go from 'tree-sitter-go';
import { GO_HTTP_PLUGIN } from '../../../src/core/group/extractors/http-patterns/go.js';
import {
  HttpRouteExtractor,
  RESOLVE_BY_NAME_QUERY,
} from '../../../src/core/group/extractors/http-route-extractor.js';
import { runExactMatch } from '../../../src/core/group/matching.js';
import type { RepoHandle, StoredContract } from '../../../src/core/group/types.js';

const parser = new Parser();

interface Provider {
  method: string;
  path: string;
  name: string | null;
}

function providers(src: string): Provider[] {
  parser.setLanguage(Go);
  return GO_HTTP_PLUGIN.scan(parser.parse(src))
    .filter((d) => d.role === 'provider')
    .map(({ method, path: p, name }) => ({ method, path: p, name }));
}

// Mirrors the shapes of a real gin `RegisterRoutes`: an engine-level group,
// `{ }` blocks, nested groups three levels deep, empty-prefix groups used only
// to attach middleware, method-value / package-func / identifier / inline
// handlers, and variadic middleware before the handler.
const GIN_ROUTES = `package handlers

import "github.com/gin-gonic/gin"

func RegisterRoutes(r *gin.Engine, svc *service.Service) {
	playerHandler := NewPlayerHandler(svc.Player)
	matchHandler := NewMatchHandler(svc.Match)
	r.GET("/ping", pingHandle)
	v1 := r.Group("/api/v1")
	{
		v1.GET("/health", func(c *gin.Context) { c.Status(200) })
		v1.GET("/players", playerHandler.GetPlayersHandle)
		v1.POST("/upload/avatar", UploadAvatarHandle)
		v1.GET("/exports", exports.ListExportsHandle)
		v1.PATCH("/players/:playerId", middleware.AuthRequired(svc.Auth), playerHandler.UpdatePlayerHandle)
		admin := v1.Group("/admin")
		admin.Use(middleware.AdminRequired(svc.AdminControl))
		{
			admin.POST("/seasons/:seasonId/rounds/:roundId/unfinalize", matchHandler.UnfinalizeRoundHandle)
			newsAdmin := admin.Group("/news")
			{
				newsAdmin.DELETE("/:id", newsHandler.DeleteNewsHandle)
			}
			knockoutAdmin := admin.Group("", middleware.KnockoutGuard())
			knockoutAdmin.POST("/seasons/:seasonId/knockout", knockoutHandler.CreateKnockoutHandle)
			adminOnly := admin.Group("")
			adminOnly.PUT("/seasons/:seasonId/streak-config", streakHandler.SaveStreakConfigHandle)
		}
	}
}
`;

describe('GO_HTTP_PLUGIN — gin route groups', () => {
  const got = providers(GIN_ROUTES);
  const find = (method: string, p: string) => got.find((d) => d.method === method && d.path === p);

  it('emits exactly one provider per registered route (Use() and Group() are not routes)', () => {
    expect(got).toHaveLength(10);
  });

  it('keeps a route on the engine root, outside any group, at its literal path', () => {
    expect(find('GET', '/ping')).toEqual({ method: 'GET', path: '/ping', name: 'pingHandle' });
  });

  it('prefixes an inline func_literal handler and leaves it unnamed', () => {
    expect(find('GET', '/api/v1/health')).toEqual({
      method: 'GET',
      path: '/api/v1/health',
      name: null,
    });
  });

  it('accepts a method-value handler and names it by its field', () => {
    expect(find('GET', '/api/v1/players')?.name).toBe('GetPlayersHandle');
  });

  it('accepts a package-qualified function handler and names it by its field', () => {
    expect(find('GET', '/api/v1/exports')?.name).toBe('ListExportsHandle');
  });

  it('keeps an identifier handler', () => {
    expect(find('POST', '/api/v1/upload/avatar')?.name).toBe('UploadAvatarHandle');
  });

  it('binds the last argument, not the variadic middleware before it', () => {
    expect(find('PATCH', '/api/v1/players/:playerId')?.name).toBe('UpdatePlayerHandle');
  });

  it('joins a nested group inside a { } block', () => {
    expect(find('POST', '/api/v1/admin/seasons/:seasonId/rounds/:roundId/unfinalize')?.name).toBe(
      'UnfinalizeRoundHandle',
    );
  });

  it('joins groups nested three levels deep', () => {
    expect(find('DELETE', '/api/v1/admin/news/:id')?.name).toBe('DeleteNewsHandle');
  });

  it('treats an empty-prefix group (with or without middleware) as its parent prefix', () => {
    expect(find('POST', '/api/v1/admin/seasons/:seasonId/knockout')?.name).toBe(
      'CreateKnockoutHandle',
    );
    expect(find('PUT', '/api/v1/admin/seasons/:seasonId/streak-config')?.name).toBe(
      'SaveStreakConfigHandle',
    );
  });
});

describe('GO_HTTP_PLUGIN — group binding edge cases', () => {
  it('follows plain `=` assignment and `var x = …` declarations', () => {
    const got = providers(`package main
func routes(r *gin.Engine) {
	var api *gin.RouterGroup
	api = r.Group("/v2")
	api.GET("/a", h.A)
	var ops = api.Group("/ops")
	ops.GET("/b", h.B)
}
`);
    expect(got).toEqual([
      { method: 'GET', path: '/v2/a', name: 'A' },
      { method: 'GET', path: '/v2/ops/b', name: 'B' },
    ]);
  });

  it('joins a Group() call chained directly onto the route call', () => {
    expect(
      providers(`package main
func routes(r *gin.Engine) {
	r.Group("/inline").GET("/y", h.Y)
}
`),
    ).toEqual([{ method: 'GET', path: '/inline/y', name: 'Y' }]);
  });

  it('uses the binding visible at the call site when a name is reused in sibling blocks', () => {
    expect(
      providers(`package main
func routes(r *gin.Engine) {
	{
		g := r.Group("/a")
		g.GET("/x", h.AX)
	}
	{
		g := r.Group("/b")
		g.GET("/x", h.BX)
	}
}
`),
    ).toEqual([
      { method: 'GET', path: '/a/x', name: 'AX' },
      { method: 'GET', path: '/b/x', name: 'BX' },
    ]);
  });

  it('uses the latest assignment that precedes the route, not one after it', () => {
    expect(
      providers(`package main
func routes(r *gin.Engine) {
	g := r.Group("/first")
	g.GET("/x", h.X)
	g = r.Group("/second")
	g.GET("/y", h.Y)
}
`),
    ).toEqual([
      { method: 'GET', path: '/first/x', name: 'X' },
      { method: 'GET', path: '/second/y', name: 'Y' },
    ]);
  });

  it('resolves a group captured by a closure registered inside the function', () => {
    expect(
      providers(`package main
func routes(r *gin.Engine) {
	v1 := r.Group("/api/v1")
	register := func() {
		v1.GET("/inner", h.Inner)
	}
	register()
}
`),
    ).toEqual([{ method: 'GET', path: '/api/v1/inner', name: 'Inner' }]);
  });

  it('keeps the literal path when the receiver is a parameter (group passed from another function)', () => {
    expect(
      providers(`package main
func registerAdmin(g *gin.RouterGroup) {
	g.GET("/extra", extraHandle)
}
`),
    ).toEqual([{ method: 'GET', path: '/extra', name: 'extraHandle' }]);
  });

  it('keeps the literal path when the receiver is bound to something other than Group()', () => {
    expect(
      providers(`package main
func routes() {
	g := newRouter("/ignored")
	g.GET("/x", h.X)
}
`),
    ).toEqual([{ method: 'GET', path: '/x', name: 'X' }]);
  });

  it('does not resolve a group bound in a different function', () => {
    expect(
      providers(`package main
func a(r *gin.Engine) {
	g := r.Group("/a")
	g.GET("/in-a", h.A)
}
func b(g *gin.RouterGroup) {
	g.GET("/in-b", h.B)
}
`),
    ).toEqual([
      { method: 'GET', path: '/a/in-a', name: 'A' },
      { method: 'GET', path: '/in-b', name: 'B' },
    ]);
  });

  it('ignores a Group() whose prefix is not a string literal and keeps the route literal', () => {
    expect(
      providers(`package main
func routes(r *gin.Engine) {
	g := r.Group(prefix)
	g.GET("/x", h.X)
}
`),
    ).toEqual([{ method: 'GET', path: '/x', name: 'X' }]);
  });

  it('uses the group bound by an if initializer in the body and in the else branch', () => {
    expect(
      providers(`package main
func routes(r *gin.Engine, cond bool) {
	g := r.Group("/outer")
	if g := r.Group("/inner"); cond {
		g.GET("/x", h.X)
	} else {
		g.GET("/y", h.Y)
	}
}
`),
    ).toEqual([
      { method: 'GET', path: '/inner/x', name: 'X' },
      { method: 'GET', path: '/inner/y', name: 'Y' },
    ]);
  });

  it('keeps the outer group when an if initializer binds a different name', () => {
    expect(
      providers(`package main
func routes(r *gin.Engine, cond bool) {
	g := r.Group("/outer")
	if x := prepare(); cond {
		g.GET("/x", h.X)
	}
}
`),
    ).toEqual([{ method: 'GET', path: '/outer/x', name: 'X' }]);
  });

  it('stops at an if initializer bound to something other than Group()', () => {
    expect(
      providers(`package main
func routes(r *gin.Engine, cond bool) {
	g := r.Group("/outer")
	if g := build(); cond {
		g.GET("/x", h.X)
	}
}
`),
    ).toEqual([{ method: 'GET', path: '/x', name: 'X' }]);
  });

  it('uses a switch initializer group and a group declared inside a case clause', () => {
    expect(
      providers(`package main
func routes(r *gin.Engine, cond bool) {
	g := r.Group("/outer")
	switch g := r.Group("/s"); g != nil {
	case cond:
		g.GET("/x", h.X)
	}
	switch {
	case cond:
		g := r.Group("/case")
		g.GET("/y", h.Y)
	}
}
`),
    ).toEqual([
      { method: 'GET', path: '/s/x', name: 'X' },
      { method: 'GET', path: '/case/y', name: 'Y' },
    ]);
  });

  it('stops at a type-switch guard binding and resolves groups declared in a type case', () => {
    expect(
      providers(`package main
func routes(r *gin.Engine, anyVal any) {
	g := r.Group("/outer")
	switch g := anyVal.(type) {
	case *Router:
		g.GET("/x", h.X)
	}
	switch anyVal.(type) {
	case interface{}:
		g := r.Group("/t")
		g.GET("/y", h.Y)
	}
}
`),
    ).toEqual([
      { method: 'GET', path: '/x', name: 'X' },
      { method: 'GET', path: '/t/y', name: 'Y' },
    ]);
  });

  it('stops at a select receive binding instead of inheriting an outer group', () => {
    // The value received from a channel is statically unknown, so a case that
    // rebinds `g` must shadow the outer group with "nothing traceable" (the
    // route keeps its literal path) — not leak `/outer` into the id. An
    // unrebound case still inherits, and a default clause declaring its own
    // group shadows like any other statement list.
    expect(
      providers(`package main
func routes(r *gin.Engine, ch chan *gin.RouterGroup) {
	g := r.Group("/outer")
	select {
	case g := <-ch:
		g.GET("/x", h.X)
	}
	select {
	case <-ch:
		g.GET("/y", h.Y)
	}
	select {
	default:
		g := r.Group("/d")
		g.GET("/z", h.Z)
	}
}
`),
    ).toEqual([
      { method: 'GET', path: '/x', name: 'X' },
      { method: 'GET', path: '/outer/y', name: 'Y' },
      { method: 'GET', path: '/d/z', name: 'Z' },
    ]);
  });

  it('keeps the outer group through a plain for init and stops at a range shadow binding', () => {
    expect(
      providers(`package main
func routes(r *gin.Engine, n int, subs []*gin.RouterGroup) {
	g := r.Group("/outer")
	for i := 0; i < n; i++ {
		g.GET("/i", h.I)
	}
	for _, g := range subs {
		g.GET("/r", h.R)
	}
	for g := r.Group("/loop"); ; {
		g.GET("/l", h.L)
	}
}
`),
    ).toEqual([
      { method: 'GET', path: '/outer/i', name: 'I' },
      { method: 'GET', path: '/r', name: 'R' },
      { method: 'GET', path: '/loop/l', name: 'L' },
    ]);
  });

  it('declines a route whose group a loop reassigns between iterations', () => {
    // The post statement (or the body) runs between iterations, so from the
    // second pass on the body sees the reassigned group rather than the one
    // it entered with: the prefix is control-flow dependent, so the route is
    // declined instead of emitting either value. A loop that never writes the
    // name keeps its initializer binding.
    expect(
      providers(`package main
func routes(r *gin.Engine, cond bool, n int) {
	g := r.Group("/old")
	for ; cond; g = r.Group("/post") {
		g.GET("/a", h.A)
	}
	for g := r.Group("/init"); ; g = r.Group("/post3") {
		g.GET("/c", h.C)
	}
	for k := r.Group("/k"); cond; {
		k.GET("/d", h.D)
	}
}
`),
    ).toEqual([{ method: 'GET', path: '/k/d', name: 'D' }]);
  });

  it('accepts a raw-string (backtick) group prefix', () => {
    expect(
      providers(`package main
func routes(r *gin.Engine) {
	g := r.Group(\`/api\`)
	g.GET("/x", h.X)
}
`),
    ).toEqual([{ method: 'GET', path: '/api/x', name: 'X' }]);
  });

  it('accepts a raw-string (backtick) route path, as ingestion does', () => {
    // Ingestion (Strategy A) decodes both Go string forms for the route path;
    // the group layer must emit the same contract for a backtick path, both
    // on a bound group and on a chained `Group(...).GET(...)` receiver.
    expect(
      providers(`package main
func routes(r *gin.Engine) {
	g := r.Group("/api")
	g.GET(\`/health\`, h.Health)
	r.Group("/v1").POST(\`/raw\\x2fy\`, h.Raw)
}
`),
    ).toEqual([
      { method: 'GET', path: '/api/health', name: 'Health' },
      { method: 'POST', path: '/v1/raw\\x2fy', name: 'Raw' },
    ]);
  });

  it('decodes Go string escapes in group prefixes and route paths', () => {
    // "/api\x2fv1" and "/health\x2fcheck" are `/api/v1` and `/health/check`
    // once Go processes the escapes — the id must match the registered URL.
    expect(
      providers(`package main
func routes(r *gin.Engine) {
	g := r.Group("/api\\x2fv1")
	g.GET("/health\\x2fcheck", h.H)
}
`),
    ).toEqual([{ method: 'GET', path: '/api/v1/health/check', name: 'H' }]);
  });

  it('leaves escapes literal inside a raw-string (backtick) prefix', () => {
    // Go raw strings process no escapes: the prefix is `/raw\x2fy`, backslash included.
    expect(
      providers(`package main
func routes(r *gin.Engine) {
	g := r.Group(\`/raw\\x2fy\`)
	g.GET("/z", h.Z)
}
`),
    ).toEqual([{ method: 'GET', path: '/raw\\x2fy/z', name: 'Z' }]);
  });

  it('collapses duplicate slashes so the path matches ingestion normalization', () => {
    // normalizeExtractedRoutePath collapses every "//" run; the downstream
    // contract-id normalizer does not — a path keeping "//" would get a
    // different id than the graph's route node for the same route.
    expect(
      providers(`package main
func routes(r *gin.Engine) {
	g := r.Group("/api//v1")
	g.GET("/a//b", h.A)
	r.GET("//root", h.R)
	r.GET("/ok", h.Ok)
}
`),
    ).toEqual([
      { method: 'GET', path: '/api/v1/a/b', name: 'A' },
      { method: 'GET', path: '/root', name: 'R' },
      { method: 'GET', path: '/ok', name: 'Ok' },
    ]);
  });

  it('forces a leading slash on slashless literals and group prefixes', () => {
    // Ingestion's normalizeExtractedRoutePath always adds a leading "/" but
    // normalizeHttpPath (the shared contract-id normalizer) does not — a path
    // like "x" would become `http::GET::x` here and `http::GET::/x` there,
    // splitting the id across the two strategies. Gin likewise panics when a
    // route is registered without one.
    expect(
      providers(`package main
func routes(r *gin.Engine) {
	r.GET("x", h.X)
	g := r.Group("api")
	g.GET("y", h.Y)
	r.GET("", h.Root)
}
`),
    ).toEqual([
      { method: 'GET', path: '/x', name: 'X' },
      { method: 'GET', path: '/api/y', name: 'Y' },
      { method: 'GET', path: '/', name: 'Root' },
    ]);
  });

  it("binds echo's handler (first argument) when the file imports echo only", () => {
    // echo is `GET(path, handler, middleware...)` — the handler is second,
    // not last, so a middleware selector must not become the route's name.
    expect(
      providers(`package main
import "github.com/labstack/echo/v4"

func routes(e *echo.Echo) {
	e.GET("/x", h.Handler, auth.Middleware)
	e.POST("/y", handlerID)
	e.PUT("/z", func(c echo.Context) error { return nil })
}
`),
    ).toEqual([
      { method: 'GET', path: '/x', name: 'Handler' },
      { method: 'POST', path: '/y', name: 'handlerID' },
      { method: 'PUT', path: '/z', name: null },
    ]);
  });

  it('picks the handler order from a typed receiver parameter in a mixed-import file', () => {
    // A parameter's static type proves its framework: `*echo.Echo` /
    // `*echo.Group` take echo's order (handler FIRST), gin's types and types
    // the file cannot tie to echo keep the last-argument fallback. Method
    // receivers and func-literal parameters count the same way.
    expect(
      providers(`package main
import (
	"github.com/gin-gonic/gin"
	"github.com/labstack/echo/v4"
)

func routes(e *echo.Echo, g *echo.Group, r *gin.RouterGroup, x *Router) {
	e.GET("/e", h.Handler, auth.Middleware)
	g.GET("/g", h.Handler, auth.Middleware)
	r.GET("/r", auth.Middleware, h.Handler)
	x.GET("/x", h.Handler, auth.Middleware)
	register := func(sub *echo.Group) {
		sub.GET("/f", h.Handler, auth.Middleware)
	}
	_ = register
}

type Server struct{}

func (s *Server) routes(api *echo.Group) {
	api.GET("/m", h.Handler, auth.Middleware)
}
`),
    ).toEqual([
      { method: 'GET', path: '/e', name: 'Handler' },
      { method: 'GET', path: '/g', name: 'Handler' },
      { method: 'GET', path: '/r', name: 'Handler' },
      { method: 'GET', path: '/x', name: 'Middleware' },
      { method: 'GET', path: '/f', name: 'Handler' },
      { method: 'GET', path: '/m', name: 'Handler' },
    ]);
  });

  it('matches framework imports by exact path, as ingestion does', () => {
    // `example.com/labstack/echo-wrapper` merely contains "labstack/echo": it
    // is not echo, so this gin-style call keeps the last-argument handler.
    expect(
      providers(`package main
import "example.com/labstack/echo-wrapper"

func routes(r *Router) {
	r.GET("/x", auth.Middleware, h.Handler)
}
`),
    ).toEqual([{ method: 'GET', path: '/x', name: 'Handler' }]);
    // The versioned module path is echo.
    expect(
      providers(`package main
import "github.com/labstack/echo/v4"

func routes(e *echo.Echo) {
	e.GET("/x", h.Handler, auth.Middleware)
}
`),
    ).toEqual([{ method: 'GET', path: '/x', name: 'Handler' }]);
  });

  it('picks the handler order per receiver constructor in a mixed-import file', () => {
    // Mixed imports are ambiguous at file scope, but `e := echo.New()` proves
    // this call follows echo's order (handler FIRST after the path) and
    // `r := gin.Default()` proves gin's (handler LAST).
    expect(
      providers(`package main
import (
	"github.com/gin-gonic/gin"
	"github.com/labstack/echo/v4"
)

func routes() {
	e := echo.New()
	r := gin.Default()
	e.GET("/x", h.Handler, auth.Middleware)
	r.POST("/y", auth.Middleware, h.Post)
}
`),
    ).toEqual([
      { method: 'GET', path: '/x', name: 'Handler' },
      { method: 'POST', path: '/y', name: 'Post' },
    ]);
  });

  it('does not treat an unrelated New() as a framework constructor', () => {
    // `wrapper.New()` is neither echo's nor gin's constructor: no proof →
    // conservative last-argument fallback, not a guessed echo order.
    expect(
      providers(`package main
import (
	"github.com/gin-gonic/gin"
	"github.com/labstack/echo/v4"
)

func routes() {
	e := wrapper.New()
	e.GET("/x", h.Handler, auth.Middleware)
}
`),
    ).toEqual([{ method: 'GET', path: '/x', name: 'Middleware' }]);
  });

  it('does not mistake a local shadowing the echo import for its constructor', () => {
    // A parameter named `echo` shadows the package qualifier: `echo.New()`
    // is then a method on that value, not echo's constructor, so the mixed
    // file keeps the conservative last-argument fallback.
    expect(
      providers(`package main
import (
	"github.com/gin-gonic/gin"
	"github.com/labstack/echo/v4"
)

func routes(echo *Factory) {
	e := echo.New()
	e.GET("/x", h.Handler, auth.Middleware)
}
`),
    ).toEqual([{ method: 'GET', path: '/x', name: 'Middleware' }]);
  });

  it('does not mistake a value-less local declaration of echo for the import', () => {
    // `var echo Factory` declares a local without an initializer; it still
    // shadows the package qualifier, so `echo.New()` proves nothing.
    expect(
      providers(`package main
import (
	"github.com/gin-gonic/gin"
	"github.com/labstack/echo/v4"
)

func routes() {
	var echo Factory
	e := echo.New()
	e.GET("/x", h.Handler, auth.Middleware)
}
`),
    ).toEqual([{ method: 'GET', path: '/x', name: 'Middleware' }]);
  });

  it('declines a route whose Group chain exceeds the depth cap', () => {
    // Past MAX_GROUP_DEPTH (32) the full prefix — and, in a mixed file, the
    // framework order — is unprovable: emitting the outer prefixes alone (or
    // gin's handler order for an echo chain) would be a silent guess.
    const chain = (ctor: string, imports: string) => {
      const lines = [`g0 := ${ctor}`];
      for (let i = 1; i <= 34; i++) lines.push(`g${i} := g${i - 1}.Group("/p${i}")`);
      return `package main
${imports}

func routes() {
	${lines.join('\n\t')}
	g34.GET("/x", h.Handler, auth.Middleware)
	g2.GET("/y", h.Handler, auth.Middleware)
}
`;
    };
    expect(providers(chain('gin.Default()', 'import "github.com/gin-gonic/gin"'))).toEqual([
      { method: 'GET', path: '/p1/p2/y', name: 'Middleware' },
    ]);
    const mixed = `import (
	"github.com/gin-gonic/gin"
	"github.com/labstack/echo/v4"
)`;
    expect(providers(chain('echo.New()', mixed))).toEqual([
      { method: 'GET', path: '/p1/p2/y', name: 'Handler' },
    ]);
  });

  it('traces a grouped receiver back to its framework constructor in a mixed file', () => {
    // The normal grouped shape: `users := api.Group(…)` ← `api := e.Group(…)`
    // ← `echo.New()` proves echo order through the Group chain, while the
    // gin chain resolves to gin.Default() and keeps the last-argument rule.
    expect(
      providers(`package main
import (
	"github.com/gin-gonic/gin"
	"github.com/labstack/echo/v4"
)

func routes() {
	e := echo.New()
	api := e.Group("/api")
	users := api.Group("/users")
	users.GET("/:id", h.Handler, auth.Middleware)
	r := gin.Default()
	v1 := r.Group("/v1")
	v1.POST("/x", auth.Middleware, h.Post)
}
`),
    ).toEqual([
      { method: 'GET', path: '/api/users/:id', name: 'Handler' },
      { method: 'POST', path: '/v1/x', name: 'Post' },
    ]);
  });

  it('marks handler resolution by how the handler is designated', () => {
    // `h.List` / `o.List` emit the field name `List`, but the operand does not
    // prove where `List` is declared: they are qualifiedHandler (repo-wide
    // unique match only, never a same-named local method). A bare name
    // declared more than once in the file (`Show` as function and method)
    // resolves only when unique in the file; a bare unique name keeps the
    // default resolution.
    parser.setLanguage(Go);
    const flags = GO_HTTP_PLUGIN.scan(
      parser.parse(`package main
import "github.com/gin-gonic/gin"

type A struct{}

func (a *A) List(c *gin.Context) {}
func (a *A) Show(c *gin.Context) {}
func Show(c *gin.Context) {}
func Ping(c *gin.Context) {}

func routes(r *gin.Engine, h *A, o *B) {
	r.GET("/a", h.List)
	r.GET("/b", o.List)
	r.GET("/s", Show)
	r.GET("/p", Ping)
}
`),
    )
      .filter((d) => d.role === 'provider')
      .map((d) => [
        d.path,
        d.name,
        d.qualifiedHandler ?? false,
        d.strictHandlerResolution ?? false,
      ]);
    expect(flags).toEqual([
      ['/a', 'List', true, false],
      ['/b', 'List', true, false],
      ['/s', 'Show', false, true],
      ['/p', 'Ping', false, false],
    ]);
  });

  it('resolves grouped var specs that precede the use', () => {
    // Earlier specs in a grouped `var (…)` are in scope for later ones; the
    // ingestion side emits /api/admin/x for this, so both strategies agree.
    expect(
      providers(`package main
func routes(r *gin.Engine) {
	var (
		api   = r.Group("/api")
		admin = api.Group("/admin")
	)
	admin.GET("/x", handler)
}
`),
    ).toEqual([{ method: 'GET', path: '/api/admin/x', name: 'handler' }]);
  });

  it('follows unconditional block writes and declines conditional ones', () => {
    // A bare `{ … }` always runs, so `{ g = r.Group("/new") }` makes the
    // route deterministically /new/x. A write in a branch (`if cond { k = … }`,
    // also when nested inside a bare block) may or may not run, so that
    // prefix is unprovable and the route is declined. A `:=` in a nested
    // block declares a new variable: writes after it never reach the outer m.
    expect(
      providers(`package main
func routes(r *gin.Engine, cond bool) {
	g := r.Group("/old")
	{ g = r.Group("/new") }
	g.GET("/x", handler)
	k := r.Group("/k")
	if cond { k = r.Group("/other") }
	k.GET("/y", handler)
	n := r.Group("/n")
	{ if cond { n = r.Group("/maybe") } }
	n.GET("/w", handler)
	m := r.Group("/m")
	{ m := r.Group("/inner"); m = r.Group("/inner2"); m.GET("/i", handler) }
	m.GET("/z", handler)
}
`),
    ).toEqual([
      { method: 'GET', path: '/new/x', name: 'handler' },
      { method: 'GET', path: '/inner2/i', name: 'handler' },
      { method: 'GET', path: '/m/z', name: 'handler' },
    ]);
  });

  it('declines a route whose group a shadowing initializer or a later closure writes', () => {
    // A `:=`/`var` shadowing the name runs its initializer BEFORE the new
    // variable is in scope, so a closure body there writes the OUTER group
    // and the prefix of a use outside the block is unprovable. A closure
    // declared before a direct assignment can also run AFTER it (`reset()`),
    // so captured writes are checked independently of statement order rather
    // than being hidden behind the block's last direct assignment. Both
    // shapes were declined before bare-block writes were followed, and a
    // closure that only READS the group must not decline anything.
    expect(
      providers(`package main
func routes(r *gin.Engine) {
	g := r.Group("/old")
	{
		g := func() *gin.RouterGroup {
			g = r.Group("/new")
			return r.Group("/inner")
		}()
		_ = g
	}
	g.GET("/a", h.A)
	k := r.Group("/k")
	{
		var k = func() *gin.RouterGroup {
			k = r.Group("/k2")
			return r.Group("/k3")
		}()
		_ = k
	}
	k.GET("/b", h.B)
	m := r.Group("/m")
	{
		reset := func() { m = r.Group("/closure") }
		m = r.Group("/new")
		reset()
	}
	m.GET("/c", h.C)
	n := r.Group("/n")
	{
		n = r.Group("/n2")
		register := func() { n.GET("/registered", h.R) }
		register()
	}
	n.GET("/d", h.D)
}
`),
    ).toEqual([
      { method: 'GET', path: '/n2/registered', name: 'R' },
      { method: 'GET', path: '/n2/d', name: 'D' },
    ]);
  });

  it('takes the last target of a repeated assignment and declines range and receive writes', () => {
    // Go carries an assignment out left to right, so `g, g = a, b` leaves the
    // LAST value in place. `for _, g = range xs` and `case g = <-ch` write the
    // existing name — the range only when its body runs, the receive with a
    // statically unknown value — so those blocks stay CONFLICT. Their `:=`
    // forms declare a loop- or case-local variable instead and leave the
    // outer group alone.
    expect(
      providers(`package main
func routes(r *gin.Engine, groups []*gin.RouterGroup, ch chan *gin.RouterGroup) {
	g := r.Group("/old")
	{ g, g = r.Group("/first"), r.Group("/second") }
	g.GET("/a", h.A)
	k := r.Group("/k")
	{
		k = r.Group("/k2")
		for _, k = range groups {}
	}
	k.GET("/b", h.B)
	m := r.Group("/m")
	{
		m = r.Group("/m2")
		select { case m = <-ch: }
	}
	m.GET("/c", h.C)
	n := r.Group("/n")
	{
		n = r.Group("/n2")
		for _, n := range groups {}
	}
	n.GET("/d", h.D)
}
`),
    ).toEqual([
      { method: 'GET', path: '/second/a', name: 'A' },
      { method: 'GET', path: '/n2/d', name: 'D' },
    ]);
  });

  it('resolves a name used in its own statement initializer to the outer binding', () => {
    // `if g := g.Group("/inner"); …` — the right-hand g is the OUTER group;
    // the new g only scopes over what follows. Same for a for initializer.
    expect(
      providers(`package main
func routes(r *gin.Engine, enabled bool) {
	g := r.Group("/api")
	if g := g.Group("/inner"); enabled {
		g.GET("/x", handler)
	}
	for g := g.Group("/loop"); enabled; {
		g.GET("/y", handler)
	}
}
`),
    ).toEqual([
      { method: 'GET', path: '/api/inner/x', name: 'handler' },
      { method: 'GET', path: '/api/loop/y', name: 'handler' },
    ]);
  });

  it('skips comments when locating the path and the handler', () => {
    // tree-sitter names comments, so they must not count as arguments: a
    // leading comment must not hide the path, and a comment must not be
    // picked as the echo (first) or gin (last) handler.
    expect(
      providers(`package main
import "github.com/labstack/echo/v4"
func routes(e *echo.Echo) {
	e.GET("/users", /* description */ users)
	e.POST(/* description */ "/posts", posts /* trailing */)
}
`),
    ).toEqual([
      { method: 'GET', path: '/users', name: 'users' },
      { method: 'POST', path: '/posts', name: 'posts' },
    ]);
    expect(
      providers(`package main
import "github.com/gin-gonic/gin"
func routes(r *gin.Engine) {
	r.GET(/* description */ "/users", users /* trailing */)
	g := r.Group(/* c */ "/api")
	g.GET("/x", h.X)
}
`),
    ).toEqual([
      { method: 'GET', path: '/users', name: 'users' },
      { method: 'GET', path: '/api/x', name: 'X' },
    ]);
  });

  it('applies the same group logic to echo', () => {
    expect(
      providers(`package main
func main() {
	e := echo.New()
	api := e.Group("/api")
	users := api.Group("/users")
	users.GET("/:id", userHandler.Get)
}
`),
    ).toEqual([{ method: 'GET', path: '/api/users/:id', name: 'Get' }]);
  });

  it('does not decline for a stored closure or a shadowed closure write', () => {
    // Storing a function literal in a value does not run its body, so a `:=`
    // whose initializer is an UNCALLED literal leaves the outer group alone;
    // only an invoked literal (`… }()`), which runs during initialization,
    // writes it. A closure whose own body declares the name — a nested `:=`
    // or a parameter — writes that local, not the captured outer group.
    expect(
      providers(`package main
func routes(r *gin.Engine) {
	g := r.Group("/old")
	{
		g := func() { g = r.Group("/stored") }
		_ = g
	}
	g.GET("/a", h.A)
	k := r.Group("/k")
	{
		reset := func() { k := r.Group("/local"); k = r.Group("/local2") }
		k = r.Group("/new")
		reset()
	}
	k.GET("/b", h.B)
	m := r.Group("/m")
	{
		reset := func(m *gin.RouterGroup) { m = r.Group("/param") }
		m = r.Group("/new")
		reset(m)
	}
	m.GET("/c", h.C)
}
`),
    ).toEqual([
      { method: 'GET', path: '/old/a', name: 'A' },
      { method: 'GET', path: '/new/b', name: 'B' },
      { method: 'GET', path: '/new/c', name: 'C' },
    ]);
  });

  it('resolves through closure-local range/receive shadows and parenthesized IIFEs', () => {
    // A range or receive `=` inside a closure writes the name that closure's
    // own body declares, so an earlier `if` holding it does not make the outer
    // prefix unprovable — while the same `=` against the captured outer name
    // does. A parenthesized immediately-invoked literal still runs its body,
    // so it writes the outer group exactly like the unparenthesized form,
    // whereas a stored parenthesized literal does not.
    expect(
      providers(`package main
func routes(r *gin.Engine, cond bool, groups []*gin.RouterGroup, ch chan *gin.RouterGroup) {
	g := r.Group("/old")
	{
		if cond {
			func() {
				g := r.Group("/local")
				for _, g = range groups {}
			}()
		}
		g.GET("/a", h.A)
	}
	k := r.Group("/k")
	{
		if cond {
			func() {
				k := r.Group("/local")
				select { case k = <-ch: _ = k }
			}()
		}
		k.GET("/b", h.B)
	}
	m := r.Group("/m")
	{
		if cond {
			func() {
				for _, m = range groups {}
			}()
		}
		m.GET("/c", h.C)
	}
	n := r.Group("/n")
	{
		n := (func() *gin.RouterGroup { n = r.Group("/paren"); return r.Group("/inner") })()
		_ = n
	}
	n.GET("/d", h.D)
	p := r.Group("/p")
	{
		p := (func() { p = r.Group("/stored") })
		_ = p
	}
	p.GET("/e", h.E)
}
`),
    ).toEqual([
      { method: 'GET', path: '/old/a', name: 'A' },
      { method: 'GET', path: '/k/b', name: 'B' },
      { method: 'GET', path: '/p/e', name: 'E' },
    ]);
  });
});

describe('Go gin provider ↔ fetch() consumer pairing', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gitnexus-go-gin-groups-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  const repoHandle = (repoPath: string, id: string): RepoHandle => ({
    id,
    path: id,
    repoPath,
    storagePath: path.join(repoPath, '.gitnexus'),
  });

  it('does not bind a qualified handler to an unrelated same-named local method', async () => {
    // routes.go declares A.List; the route's handler is b.List, with B.List in
    // b.go. The file-first name lookup would pick A.List, so a qualified
    // handler skips it: a repo-wide unique List resolves, an ambiguous one
    // keeps the file-level fallback (empty symbolUid) instead of A.List.
    const repo = path.join(tmpDir, 'repo');
    fs.mkdirSync(repo, { recursive: true });
    fs.writeFileSync(
      path.join(repo, 'routes.go'),
      `package main

import "github.com/gin-gonic/gin"

type A struct{}

func (a *A) List(c *gin.Context) {}

func routes(r *gin.Engine, b *B) {
	r.GET("/bs", b.List)
}
`,
    );
    const aList = {
      uid: 'Method:routes.go:A.List',
      name: 'List',
      filePath: 'routes.go',
      startLine: 6,
      endLine: 6,
      labels: ['Method'],
    };
    const bList = { uid: 'Method:b.go:B.List', name: 'List', filePath: 'b.go' };
    const run = async (repoWide: Record<string, unknown>[]) => {
      const db = async (query: string, params?: Record<string, unknown>) => {
        if (query === RESOLVE_BY_NAME_QUERY) return params?.name === 'List' ? repoWide : [];
        if (query.includes('UNION ALL') && params?.filePath === 'routes.go') return [aList];
        return [];
      };
      const out = await new HttpRouteExtractor().extract(db, repo, repoHandle(repo, 'repo'));
      return out.find((c) => c.contractId === 'http::GET::/bs')?.symbolUid;
    };
    expect(await run([aList, bList])).toBe('');
    expect(await run([bList])).toBe(bList.uid);
  });

  it('cross-links a grouped method-value route to a ${API_BASE}-prefixed fetch', async () => {
    const backend = path.join(tmpDir, 'backend');
    const web = path.join(tmpDir, 'web');
    fs.mkdirSync(path.join(backend, 'internal/handlers'), { recursive: true });
    fs.mkdirSync(path.join(web, 'src/pages'), { recursive: true });
    fs.writeFileSync(path.join(backend, 'internal/handlers/routes.go'), GIN_ROUTES);
    fs.writeFileSync(
      path.join(web, 'src/pages/AdminMatchesPage.tsx'),
      `const API_BASE = import.meta.env.VITE_API_BASE;

export async function handleUnfinalize(seasonId: string, roundId: string) {
  await fetch(\`\${API_BASE}/api/v1/admin/seasons/\${seasonId}/rounds/\${roundId}/unfinalize\`, {
    method: 'POST',
  });
}
`,
    );

    const extractor = new HttpRouteExtractor();
    const contracts: StoredContract[] = [
      ...(await extractor.extract(null, backend, repoHandle(backend, 'backend'))).map((c) => ({
        ...c,
        repo: 'backend',
      })),
      ...(await extractor.extract(null, web, repoHandle(web, 'web'))).map((c) => ({
        ...c,
        repo: 'web',
      })),
    ];

    const { matched } = runExactMatch(contracts);
    const link = matched.find(
      (l) => l.contractId === 'http::POST::/api/v1/admin/seasons/{param}/rounds/{param}/unfinalize',
    );
    expect(link).toMatchObject({
      from: { repo: 'web', symbolRef: { filePath: 'src/pages/AdminMatchesPage.tsx' } },
      to: {
        repo: 'backend',
        symbolRef: { filePath: 'internal/handlers/routes.go', name: 'UnfinalizeRoundHandle' },
      },
      matchType: 'exact',
    });
  });
});
