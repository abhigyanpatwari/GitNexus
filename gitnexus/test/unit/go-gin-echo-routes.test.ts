import { describe, expect, it } from 'vitest';
import Parser from 'tree-sitter';
import Go from 'tree-sitter-go';
import { extractGoGinEchoRoutes } from '../../src/core/ingestion/route-extractors/go-gin-echo.js';

const parser = new Parser();
parser.setLanguage(Go);

const GIN = `import "github.com/gin-gonic/gin"\n`;
const ECHO = `import "github.com/labstack/echo/v4"\n`;

const extract = (body: string, header = GIN) =>
  extractGoGinEchoRoutes(parser.parse(`package router\n${header}${body}`), 'router/router.go');

/** `VERB url -> handler` per route, so a lost handler reads as `undefined` in the diff. */
const summary = (body: string, header = GIN) =>
  extract(body, header).map((r) => `${r.httpMethod} ${r.routePath} -> ${r.handlerName}`);

describe('gin / echo route extraction', () => {
  it('joins nested Group prefixes for the issue #3402 router', () => {
    const routes = extract(`
func RegisterRoutes(r *gin.Engine, svc *service.Service) {
	matchHandler := NewMatchHandler(svc.Match)
	v1 := r.Group("/api/v1")
	{
		admin := v1.Group("/admin")
		admin.POST("/seasons/:seasonId/rounds/:roundId/unfinalize", matchHandler.UnfinalizeRoundHandle)
	}
}`);
    expect(routes).toEqual([
      {
        filePath: 'router/router.go',
        routePath: '/api/v1/admin/seasons/:seasonId/rounds/:roundId/unfinalize',
        httpMethod: 'POST',
        decoratorName: 'POST',
        lineNumber: 9,
        prefix: null,
        source: 'gin-route',
        handlerName: 'matchHandler.UnfinalizeRoundHandle',
        handlerReceiver: { kind: 'constructor', name: 'NewMatchHandler' },
      },
    ]);
  });

  it('follows chained Group calls and engine constructors', () => {
    expect(
      summary(`
func Setup() {
	r := gin.Default()
	r.Group("/api").Group("/v1").GET("/x", Health)
	gin.New().GET("/root", Health)
}`),
    ).toEqual(['GET /api/v1/x -> Health', 'GET /root -> Health']);
  });

  it('takes the last argument as the gin handler, skipping middleware', () => {
    expect(summary(`func S(r *gin.Engine) { r.GET("/x", authMW, h.List) }`)).toEqual([
      'GET /x -> h.List',
    ]);
  });

  it('takes the second argument as the echo handler, skipping trailing middleware', () => {
    const routes = extract(
      `func S(e *echo.Echo) { g := e.Group("/api"); g.GET("/users", h.List, authMW) }`,
      ECHO,
    );
    expect(routes.map((r) => `${r.source} ${r.routePath} -> ${r.handlerName}`)).toEqual([
      'echo-route /api/users -> h.List',
    ]);
  });

  it('honors an aliased framework import', () => {
    expect(
      summary(
        `func S() { e := g.Default(); e.PUT(\`/raw\`, H) }`,
        `import g "github.com/gin-gonic/gin"\n`,
      ),
    ).toEqual(['PUT /raw -> H']);
  });

  describe('fails closed on unproven prefixes', () => {
    it('drops routes on a RouterGroup parameter', () => {
      expect(summary(`func registerAdmin(g *gin.RouterGroup) { g.GET("/x", h) }`)).toEqual([]);
    });

    it('drops routes beneath a non-literal group path', () => {
      expect(
        summary(
          `func S(r *gin.Engine) { v := r.Group(base); v.GET("/x", h); v.Group("/a").GET("/y", h) }`,
        ),
      ).toEqual([]);
    });

    it('drops routes on a name assigned two different routers', () => {
      expect(
        summary(`func S(r *gin.Engine) { v := r.Group("/a"); v = r.Group("/b"); v.GET("/x", h) }`),
      ).toEqual([]);
    });

    it('drops routes on a struct-field engine', () => {
      expect(summary(`func (s *Server) routes() { s.router.GET("/x", h) }`)).toEqual([]);
    });

    it('drops routes whose path is not a literal', () => {
      expect(summary(`func S(r *gin.Engine) { r.GET(path, h) }`)).toEqual([]);
    });
  });

  describe('framework gate', () => {
    it('ignores .GET calls in a file that imports neither framework', () => {
      expect(
        summary(`func C() { client.R().GET("/x", h) }`, `import "github.com/go-resty/resty/v2"\n`),
      ).toEqual([]);
    });

    it('ignores a file that imports both frameworks', () => {
      expect(
        summary(
          `func S(r *gin.Engine) { r.GET("/x", h) }`,
          `import (\n "github.com/gin-gonic/gin"\n "github.com/labstack/echo/v4"\n)\n`,
        ),
      ).toEqual([]);
    });
  });

  describe('handler receiver hints', () => {
    /** `extraParams` joins the engine parameter; `decl` opens the body. */
    const hintFor = (decl: string, extraParams = '') =>
      extract(`func S(r *gin.Engine${extraParams}) {
	${decl}
	r.GET("/x", h.Do)
}`)[0]?.handlerReceiver;

    it.each([
      ['h := &T{}', { kind: 'type', name: 'T' }],
      ['h := T{}', { kind: 'type', name: 'T' }],
      ['h := &pkg.T{}', { kind: 'type', name: 'T', qualifier: 'pkg' }],
      ['var h *T', { kind: 'type', name: 'T' }],
      ['h, err := pkg.NewT(x)', { kind: 'constructor', name: 'NewT', qualifier: 'pkg' }],
      ['h := NewT()', { kind: 'constructor', name: 'NewT' }],
    ])('%s', (decl, expected) => {
      expect(hintFor(decl)).toEqual(expected);
    });

    it('reads a typed parameter', () => {
      expect(hintFor('', ', h *pkg.T')).toEqual({ kind: 'type', name: 'T', qualifier: 'pkg' });
    });

    it('marks an import qualifier as a module handler', () => {
      const routes = extract(
        `func S(r *gin.Engine) { r.GET("/health", handlers.Health) }`,
        `import (\n "github.com/gin-gonic/gin"\n "example.com/app/handlers"\n)\n`,
      );
      expect(routes[0]).toMatchObject({
        handlerName: 'handlers.Health',
        handlerReceiver: { kind: 'module', qualifier: 'handlers' },
      });
    });

    it('carries no hint when assignments disagree', () => {
      expect(hintFor('h := &A{}; h = &B{}')).toBeUndefined();
    });

    it('emits a func-literal handler without a handler name', () => {
      const routes = extract(`func S(r *gin.Engine) { r.GET("/x", func(c *gin.Context) {}) }`);
      expect(routes.map((r) => [r.routePath, r.handlerName])).toEqual([['/x', undefined]]);
    });
  });
});
