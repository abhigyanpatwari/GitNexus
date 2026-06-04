/**
 * Unit Tests: FastAPI / Starlette route extractor (Issues #79, #5, #78)
 *
 * Mirrors the standalone `spring-route-extractor-standalone.test.ts`
 * style — inline source strings, exercised through the public entry
 * point, no fixture file IO at the unit level. (The fixture exists for
 * the dispatch-table integration test downstream.)
 */

import { describe, it, expect } from 'vitest';
import Parser from 'tree-sitter';
import Python from 'tree-sitter-python';
import { extractFastApiRoutes } from '../../../src/core/ingestion/route-extractors/python.js';

/** Parse a Python source string into a tree-sitter root node. */
function parsePython(source: string) {
  const parser = new Parser();
  parser.setLanguage(Python);
  return parser.parse(source);
}

describe('FastAPI route extractor (Issues #79, #5, #78)', () => {
  describe('basic patterns', () => {
    it('parses a single @app.get("/x") as one GET route', () => {
      const src = `
        from fastapi import FastAPI
        app = FastAPI()

        @app.get("/x")
        async def get_x():
            return {}
      `;
      const tree = parsePython(src);
      const routes = extractFastApiRoutes(tree, 'main.py');
      expect(routes).toHaveLength(1);
      expect(routes[0].httpMethod).toBe('GET');
      expect(routes[0].routePath).toBe('/x');
      expect(routes[0].controllerName).toBe('app');
      expect(routes[0].methodName).toBe('get_x');
      expect(routes[0].filePath).toBe('main.py');
      expect(routes[0].isControllerClass).toBe(false);
    });

    it('parses @app.post("/x") as one POST route', () => {
      const src = `
        @app.post("/x")
        async def post_x(): return {}
      `;
      const tree = parsePython(src);
      const routes = extractFastApiRoutes(tree, 'main.py');
      expect(routes).toHaveLength(1);
      expect(routes[0].httpMethod).toBe('POST');
      expect(routes[0].routePath).toBe('/x');
    });

    it('handles all eight standard HTTP verbs', () => {
      const src = `
        @app.get("/g")
        async def g(): pass
        @app.post("/p")
        async def p(): pass
        @app.put("/u")
        async def u(): pass
        @app.delete("/d")
        async def d(): pass
        @app.patch("/pa")
        async def pa(): pass
        @app.head("/h")
        async def h(): pass
        @app.options("/o")
        async def o(): pass
        @app.trace("/t")
        async def t(): pass
      `;
      const tree = parsePython(src);
      const routes = extractFastApiRoutes(tree, 'main.py');
      expect(routes).toHaveLength(8);
      const methods = routes.map(r => r.httpMethod).sort();
      expect(methods).toEqual(['DELETE', 'GET', 'HEAD', 'OPTIONS', 'PATCH', 'POST', 'PUT', 'TRACE']);
      // Every route should also carry the decorated function name.
      for (const r of routes) {
        expect(r.methodName).toMatch(/^[a-z]+$/);
      }
    });

    it('treats the receiver name case-insensitively for verb mapping', () => {
      // FastAPI's verb methods are lowercase; lowercasing is the only
      // sane mapping. Verify it sticks even with odd spacing.
      const src = `
        @app.   GET   ("/x")
        async def f(): pass
      `;
      const tree = parsePython(src);
      const routes = extractFastApiRoutes(tree, 'main.py');
      // Uppercase verb — the grammar still treats this as an attribute
      // access. Our extractor must lowercase it.
      expect(routes).toHaveLength(1);
      expect(routes[0].httpMethod).toBe('GET');
    });
  });

  describe('@router.<verb> pattern', () => {
    it('emits a route for @router.METHOD regardless of receiver name', () => {
      const src = `
        router = APIRouter()

        @router.get("/x")
        async def f(): pass
      `;
      const tree = parsePython(src);
      const routes = extractFastApiRoutes(tree, 'r.py');
      expect(routes).toHaveLength(1);
      expect(routes[0].httpMethod).toBe('GET');
      expect(routes[0].controllerName).toBe('router');
    });

    it('accepts any receiver (api_router, v1_router, custom names)', () => {
      const src = `
        api_router = APIRouter()
        v1_router  = APIRouter()
        whatever   = APIRouter()

        @api_router.get("/a")
        async def a(): pass
        @v1_router.post("/b")
        async def b(): pass
        @whatever.delete("/c")
        async def c(): pass
      `;
      const tree = parsePython(src);
      const routes = extractFastApiRoutes(tree, 'r.py');
      expect(routes).toHaveLength(3);
      const receivers = routes.map(r => r.controllerName).sort();
      expect(receivers).toEqual(['api_router', 'v1_router', 'whatever']);
      const methods = routes.map(r => r.httpMethod).sort();
      expect(methods).toEqual(['DELETE', 'GET', 'POST']);
    });
  });

  describe('multiple methods on the same receiver', () => {
    it('emits one route per (receiver, verb, path) tuple', () => {
      const src = `
        @app.get("/x")
        async def g(): pass
        @app.post("/x")
        async def p(): pass
        @app.delete("/x")
        async def d(): pass
        @app.get("/y")
        async def g_y(): pass
      `;
      const tree = parsePython(src);
      const routes = extractFastApiRoutes(tree, 'm.py');
      expect(routes).toHaveLength(4);
      const byPath = (path: string) => routes.filter(r => r.routePath === path).map(r => r.httpMethod).sort();
      expect(byPath('/x')).toEqual(['DELETE', 'GET', 'POST']);
      expect(byPath('/y')).toEqual(['GET']);
    });
  });

  describe('non-route decorators', () => {
    it('ignores @staticmethod, @classmethod, and other non-HTTP decorators', () => {
      const src = `
        class Foo:
            @staticmethod
            def bar(): return 1

            @classmethod
            def baz(cls): return 2

            @property
            def prop(self): return 3
      `;
      const tree = parsePython(src);
      const routes = extractFastApiRoutes(tree, 'cls.py');
      expect(routes).toHaveLength(0);
    });

    it('ignores @app.exception_handler and other non-HTTP-verb methods on app/router', () => {
      const src = `
        @app.exception_handler(Exception)
        async def handler(req, exc): return None

        @router.websocket("/ws")
        async def ws(ws): pass

        @app.on_event("startup")
        async def boot(): pass
      `;
      const tree = parsePython(src);
      const routes = extractFastApiRoutes(tree, 'main.py');
      expect(routes).toHaveLength(0);
    });

    it('ignores decorators with no first-argument string literal', () => {
      const src = `
        @app.middleware("http")
        async def mw(req, call_next): return await call_next(req)
      `;
      const tree = parsePython(src);
      const routes = extractFastApiRoutes(tree, 'm.py');
      // `middleware` is not an HTTP verb — must be ignored.
      expect(routes).toHaveLength(0);
    });
  });

  describe('path extraction', () => {
    it('handles single-quoted paths', () => {
      const src = `
        @app.get('/x')
        async def f(): pass
      `;
      const tree = parsePython(src);
      const routes = extractFastApiRoutes(tree, 'm.py');
      expect(routes).toHaveLength(1);
      expect(routes[0].routePath).toBe('/x');
    });

    it('handles paths with path parameters', () => {
      const src = `
        @app.get("/users/{id}")
        async def f(): pass
        @app.put("/users/{id}/posts/{post_id}")
        async def g(): pass
      `;
      const tree = parsePython(src);
      const routes = extractFastApiRoutes(tree, 'm.py');
      expect(routes).toHaveLength(2);
      expect(routes[0].routePath).toBe('/users/{id}');
      expect(routes[1].routePath).toBe('/users/{id}/posts/{post_id}');
    });

    it('skips keyword-only arguments and uses the first positional string', () => {
      const src = `
        @app.get("/x", response_model=str, status_code=200)
        async def f(): pass
      `;
      const tree = parsePython(src);
      const routes = extractFastApiRoutes(tree, 'm.py');
      expect(routes).toHaveLength(1);
      expect(routes[0].routePath).toBe('/x');
    });

    it('takes the path from the decorator literal, not the function signature default values', () => {
      // (#M2) The decorated function may carry query parameters with
      // default values (e.g. `q: str = None`). Those are FastAPI query
      // params, not part of the path. The route path must come from the
      // decorator's first positional string argument.
      const src = `
        @app.get("/items/{item_id}")
        async def f(item_id: int, q: str = None):
            return {"item_id": item_id, "q": q}
      `;
      const tree = parsePython(src);
      const routes = extractFastApiRoutes(tree, 'main.py');
      expect(routes).toHaveLength(1);
      expect(routes[0].httpMethod).toBe('GET');
      expect(routes[0].routePath).toBe('/items/{item_id}');
      expect(routes[0].methodName).toBe('f');
      expect(routes[0].controllerName).toBe('app');
    });
  });

  describe('edge cases', () => {
    it('returns an empty list on null/empty tree input', () => {
      expect(extractFastApiRoutes(null, 'x.py')).toEqual([]);
      expect(extractFastApiRoutes({ rootNode: null }, 'x.py')).toEqual([]);
    });

    it('returns an empty list on a Python file with no route decorators', () => {
      const src = `
        def helper(x):
            return x + 1

        class Service:
            def method(self):
                return 1
      `;
      const tree = parsePython(src);
      const routes = extractFastApiRoutes(tree, 'util.py');
      expect(routes).toHaveLength(0);
    });
  });
});
