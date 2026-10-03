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
import { HttpRouteExtractor } from '../../../src/core/group/extractors/http-route-extractor.js';
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
