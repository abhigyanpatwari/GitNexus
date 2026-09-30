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

  describe('Go string literals', () => {
    it.each([
      [String.raw`"\x2fapi"`, String.raw`"\057users"`, '/api/users'],
      [String.raw`"\u002fapi"`, String.raw`"/\U0001F600"`, '/api/😀'],
      [String.raw`"/caf\xc3\xa9"`, String.raw`"/\303\251"`, '/café/é'],
      [String.raw`"/a\"b"`, String.raw`"/c\\d"`, '/a"b/c\\d'],
      ['`/a\rb`', '`/c\rd`', '/ab/cd'],
    ])('decodes group %s and route %s', (group, route, expected) => {
      expect(summary(`func S(r *gin.Engine) { r.Group(${group}).GET(${route}, H) }`)).toEqual([
        `GET ${expected} -> H`,
      ]);
    });

    it.each([
      String.raw`"/\q"`,
      String.raw`"/\400"`,
      String.raw`"/\uD800"`,
      String.raw`"/\U00110000"`,
      String.raw`"/\x2"`,
      String.raw`"/\'"`,
      // Go permits arbitrary byte strings, but these have no lossless UTF-8 URL.
      String.raw`"/\xff"`,
    ])('declines invalid or unrepresentable path %s', (route) => {
      expect(summary(`func S(r *gin.Engine) { r.GET(${route}, H) }`)).toEqual([]);
    });
  });

  describe('framework alias shadowing', () => {
    it.each([
      'func S(gin Factory) { gin.New().GET("/x", H) }',
      'func (gin Factory) S() { gin.New().GET("/x", H) }',
      'func S() (gin Factory) { gin.New().GET("/x", H); return }',
      'func S() { gin := Factory{}; gin.New().GET("/x", H) }',
      'func S() { var gin Factory; gin.New().GET("/x", H) }',
      'func S() { const gin = Factory(1); gin.New().GET("/x", H) }',
      'func S() { type gin = Factory; gin.New(value).GET("/x", H) }',
      'func S() { for gin := range factories { gin.New().GET("/x", H) } }',
      'func S() { select { case gin := <-factories: gin.New().GET("/x", H) } }',
      'func S(x any) { switch gin := x.(type) { case Factory: gin.New().GET("/x", H) } }',
      'func S(gin Factory) { func() { gin.New().GET("/x", H) }() }',
    ])('does not trust a shadowed constructor: %s', (body) => {
      expect(summary(body)).toEqual([]);
    });

    it('also checks an explicitly aliased echo import', () => {
      expect(
        summary(
          'func S(e Factory) { r := e.New(); r.GET("/x", H) }',
          'import e "github.com/labstack/echo/v4"\n',
        ),
      ).toEqual([]);
    });

    it('keeps independent functions using the real package', () => {
      expect(
        summary(`
func S(gin Factory) { gin.New().GET("/wrong", H) }
func T() { gin.New().GET("/right", H) }
`),
      ).toEqual(['GET /right -> H']);
    });
  });

  describe('fails closed on unproven prefixes', () => {
    it('drops routes on a RouterGroup parameter', () => {
      expect(summary(`func registerAdmin(g *gin.RouterGroup) { g.GET("/x", h) }`)).toEqual([]);
    });

    it('preserves an incoming group prefix as unknown after a later assignment', () => {
      expect(
        summary(`func S(r *gin.Engine, g *gin.RouterGroup) {
          g.GET("/before", H)
          g = r.Group("/api")
        }`),
      ).toEqual([]);
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

    it('drops routes on mutually-derived groups', () => {
      expect(
        summary(`func S(r *gin.Engine) { a := b.Group("/x"); b := a.Group("/y"); a.GET("/z", h) }`),
      ).toEqual([]);
    });

    it('drops routes a closure registers on an outer group', () => {
      expect(
        summary(`func S(r *gin.Engine) { v := r.Group("/a"); go func() { v.GET("/x", h) }() }`),
      ).toEqual([]);
    });

    it('drops routes on a name bound to the second value of a call', () => {
      expect(summary(`func S(r *gin.Engine) { _, v := pair(r); v.GET("/x", h) }`)).toEqual([]);
    });

    it('drops routes whose path is not a literal', () => {
      expect(summary(`func S(r *gin.Engine) { r.GET(path, h) }`)).toEqual([]);
    });
  });

  it('pairs a parallel assignment of groups positionally', () => {
    expect(
      summary(
        `func S(r *gin.Engine) { a, b := r.Group("/a"), r.Group("/b"); a.GET("/x", H); b.GET("/y", H) }`,
      ),
    ).toEqual(['GET /a/x -> H', 'GET /b/y -> H']);
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

    it('preserves incoming interface evidence alongside a later concrete assignment', () => {
      const routes = extract(`
type Handler interface{ Do(*gin.Context) }
func S(r *gin.Engine, h Handler) {
  r.GET("/before", h.Do)
  h = &A{}
}`);
      expect(routes).toHaveLength(1);
      expect(routes[0]).toMatchObject({ routePath: '/before', handlerName: 'h.Do' });
      expect(routes[0].handlerReceiver).toBeUndefined();
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

describe('Go lexical binding identity', () => {
  it('does not attach shadowed bare handlers or constructors to package names', () => {
    const routes = extract(`
func Handle(c *gin.Context) {}
func NewH() *A { return nil }
func S(r *gin.Engine, Handle gin.HandlerFunc, NewH func() *B) {
  r.GET("/bare", Handle)
  h := NewH()
  r.GET("/constructor", h.Do)
}`);
    expect(routes[0]?.handlerName).toBeUndefined();
    expect(routes[1]?.handlerReceiver).toBeUndefined();
  });

  it('keeps inner and outer router declarations separate', () => {
    expect(
      summary(`func S(r *gin.Engine) {
      { var r FakeRouter; r.GET("/fake", H) }
      r.GET("/real", H)
    }`),
    ).toEqual(['GET /real -> H']);
  });

  it.each([
    ['switch', 'switch x { default: r := gin.New(); _ = r; case 1: r.GET("/fake", H) }'],
    ['select', 'select { default: r := gin.New(); _ = r; case <-ready: r.GET("/fake", H) }'],
  ])('keeps a %s default declaration inside its clause', (_kind, statement) => {
    expect(summary(`func S(r FakeRouter, x int, ready chan bool) { ${statement} }`)).toEqual([]);
  });

  it('resolves a captured local before an imported qualifier', () => {
    const routes = extract(
      `func S(handlers *B) {
      func() { r := gin.New(); r.GET("/captured", handlers.Do) }()
    }`,
      GIN + 'import "example.com/app/handlers"\n',
    );
    expect(routes[0]?.handlerReceiver).toEqual({ kind: 'type', name: 'B' });
  });

  it('declines local type names that shadow package types', () => {
    const routes = extract(`func S(r *gin.Engine) {
      type A = B
      h := &A{}
      r.GET("/type", h.Do)
    }`);
    expect(routes[0]?.handlerReceiver).toBeUndefined();
  });

  it('invalidates handler and router facts after captured writes', () => {
    const routes = extract(`func S(r *gin.Engine) {
      var h interface{ Do(*gin.Context) } = &A{}
      g := r.Group("/a")
      func() { h = &B{}; g = r.Group("/b") }()
      r.GET("/handler", h.Do)
      g.GET("/group", H)
    }`);
    expect(routes.map((r) => r.routePath)).toEqual(['/handler']);
    expect(routes[0]?.handlerReceiver).toBeUndefined();
  });

  it.each([
    ['range', '[]', 'for _, h = range handlers {}; for _, g = range groups {}'],
    ['receive', 'chan ', 'select { case h = <-handlers: }; select { case g = <-groups: }'],
  ])(
    'invalidates handler and router facts after captured %s assignments',
    (_kind, container, writes) => {
      const routes = extract(`
type Handler interface{ Do(*gin.Context) }
func S(r *gin.Engine, handlers ${container}Handler, groups ${container}*gin.RouterGroup) {
  var h Handler = &A{}
  g := r.Group("/a")
  func() { ${writes} }()
  r.GET("/handler", h.Do)
  g.GET("/group", H)
}`);
      expect(routes.map((r) => r.routePath)).toEqual(['/handler']);
      expect(routes[0].handlerReceiver).toBeUndefined();
    },
  );

  it('does not confuse nested declarations with captured writes', () => {
    const routes = extract(`func S(r *gin.Engine) {
      h := &A{}
      func() { h := &B{}; _ = h }()
      r.GET("/handler", h.Do)
    }`);
    expect(routes[0]?.handlerReceiver).toEqual({ kind: 'type', name: 'A' });
  });

  it('honors declaration order and independent block scopes', () => {
    expect(
      summary(`func S() {
      gin.New().GET("/before", H)
      { gin := Factory{}; gin.New().GET("/fake", H) }
      gin := Factory{}
      gin.New().GET("/after", H)
    }`),
    ).toEqual(['GET /before -> H']);
  });

  it('does not shadow package names in a short declaration initializer', () => {
    expect(summary(`func S() { gin := gin.New(); gin.GET("/real", H) }`)).toEqual([
      'GET /real -> H',
    ]);
  });
});

describe('Go route type-parameter shadowing', () => {
  it('does not treat a type parameter as a same-named package type', () => {
    const routes = extract(`func S[T interface{ Do(*gin.Context) }](r *gin.Engine, h T) {
      r.GET("/generic", h.Do)
    }`);
    expect(routes).toHaveLength(1);
    expect(routes[0]).toMatchObject({ routePath: '/generic', handlerName: 'h.Do' });
    expect(routes[0].handlerReceiver).toBeUndefined();
  });
});
