/**
 * Unit Tests: Standalone Gin route extractor (#80, #6)
 *
 * GitNexus had no Go route extractor — Gin repos got 0 routes extracted.
 * `extractGinRoutes(tree, filePath)` walks the tree-sitter Go AST and
 * emits ExtractedRoute entries for `r.METHOD("/path", handler)` calls.
 *
 * Covered cases:
 *  1. `r.GET("/x", h)` → 1 route with method=GET
 *  2. `r.POST/PUT/DELETE/PATCH` → corresponding methods
 *  3. Multiple receivers (`r`, `router`, `engine`) → all emit routes
 *  4. Non-route calls (`r.Use(mw)`, `c.JSON(200, ...)`) → 0 routes
 */

import { describe, it, expect } from 'vitest';
import Parser from 'tree-sitter';
import Go from 'tree-sitter-go';
import path from 'path';
import fs from 'fs';
import { extractGinRoutes } from '../../../src/core/ingestion/route-extractors/go.js';

const FIXTURE_PATH = path.resolve(
  __dirname, '..', '..', 'fixtures', 'gin-basic', 'main.go',
);

function parseGo(source: string): Parser.Tree {
  const parser = new Parser();
  parser.setLanguage(Go);
  return parser.parse(source);
}

describe('extractGinRoutes (#80, #6)', () => {
  describe('basic single-method registration', () => {
    it('extracts a single r.GET("/x", h) as one route with method=GET', () => {
      const tree = parseGo(`
        package main
        func main() {
          r := gin.Default()
          r.GET("/users", listUsers)
        }
        func listUsers(c *gin.Context) {}
      `);
      const routes = extractGinRoutes(tree, 'main.go');
      expect(routes).toHaveLength(1);
      expect(routes[0].httpMethod).toBe('GET');
      expect(routes[0].routePath).toBe('/users');
      expect(routes[0].methodName).toBe('listUsers');
      expect(routes[0].controllerName).toBe('r');
      expect(routes[0].filePath).toBe('main.go');
      expect(routes[0].isControllerClass).toBe(false);
    });

    it('extracts a path with a colon parameter', () => {
      const tree = parseGo(`
        package main
        func main() {
          r := gin.Default()
          r.DELETE("/users/:id", deleteUser)
        }
      `);
      const routes = extractGinRoutes(tree, 'main.go');
      expect(routes).toHaveLength(1);
      expect(routes[0].httpMethod).toBe('DELETE');
      expect(routes[0].routePath).toBe('/users/:id');
      expect(routes[0].methodName).toBe('deleteUser');
    });
  });

  describe('all HTTP method verbs', () => {
    it('recognises POST/PUT/DELETE/PATCH/HEAD/OPTIONS', () => {
      const tree = parseGo(`
        package main
        func main() {
          r := gin.Default()
          r.POST("/a", a)
          r.PUT("/b", b)
          r.DELETE("/c", c)
          r.PATCH("/d", d)
          r.HEAD("/e", e)
          r.OPTIONS("/f", f)
        }
        func a(c *gin.Context) {}
        func b(c *gin.Context) {}
        func c(c *gin.Context) {}
        func d(c *gin.Context) {}
        func e(c *gin.Context) {}
        func f(c *gin.Context) {}
      `);
      const routes = extractGinRoutes(tree, 'main.go');
      const byMethod = Object.fromEntries(routes.map(r => [r.httpMethod, r.routePath]));
      expect(routes).toHaveLength(6);
      expect(byMethod.POST).toBe('/a');
      expect(byMethod.PUT).toBe('/b');
      expect(byMethod.DELETE).toBe('/c');
      expect(byMethod.PATCH).toBe('/d');
      expect(byMethod.HEAD).toBe('/e');
      expect(byMethod.OPTIONS).toBe('/f');
    });
  });

  describe('multiple receivers', () => {
    it('emits routes for r, router, and engine receivers', () => {
      const tree = parseGo(`
        package main
        func main() {
          r := gin.Default()
          r.GET("/a", a)
          router := gin.New()
          router.POST("/b", b)
          engine := gin.New()
          engine.PUT("/c", c)
        }
        func a(c *gin.Context) {}
        func b(c *gin.Context) {}
        func c(c *gin.Context) {}
      `);
      const routes = extractGinRoutes(tree, 'main.go');
      expect(routes).toHaveLength(3);
      const receivers = routes.map(r => r.controllerName).sort();
      expect(receivers).toEqual(['engine', 'r', 'router']);
      const byReceiver = Object.fromEntries(routes.map(r => [`${r.controllerName}:${r.httpMethod}`, r.routePath]));
      expect(byReceiver['r:GET']).toBe('/a');
      expect(byReceiver['router:POST']).toBe('/b');
      expect(byReceiver['engine:PUT']).toBe('/c');
    });

    it('still extracts routes when the receiver is an unknown identifier', () => {
      // Receivers in user code aren't limited to a fixed set. We trust the
      // Gin method-name match and accept any identifier receiver.
      const tree = parseGo(`
        package main
        func main() {
          banana := gin.New()
          banana.GET("/x", x)
        }
        func x(c *gin.Context) {}
      `);
      const routes = extractGinRoutes(tree, 'main.go');
      expect(routes).toHaveLength(1);
      expect(routes[0].controllerName).toBe('banana');
      expect(routes[0].httpMethod).toBe('GET');
    });
  });

  describe('non-route calls are ignored', () => {
    it('emits no routes for r.Use(mw), c.JSON(200, ...), or string-arg-less calls', () => {
      const tree = parseGo(`
        package main
        func main() {
          r := gin.Default()
          r.Use(middleware)
          r.Run(":8080")
        }
        func handler(c *gin.Context) {
          c.JSON(200, gin.H{"ok": true})
        }
      `);
      const routes = extractGinRoutes(tree, 'main.go');
      expect(routes).toHaveLength(0);
    });

    it('does not extract routes from calls where the first arg is not a string literal', () => {
      // `r.GET(somePath, h)` where somePath is an identifier should NOT
      // be a route — we can't resolve the path statically.
      const tree = parseGo(`
        package main
        func main() {
          r := gin.Default()
          r.GET(somePath, h)
          r.POST(other, h)
        }
      `);
      const routes = extractGinRoutes(tree, 'main.go');
      expect(routes).toHaveLength(0);
    });
  });

  describe('handler argument edge cases', () => {
    it('records methodName as null when the second argument is not an identifier', () => {
      // e.g. r.GET("/x", func(c *gin.Context) { ... }) — inline closure
      const tree = parseGo(`
        package main
        func main() {
          r := gin.Default()
          r.GET("/x", func(c *gin.Context) { c.String(200, "ok") })
        }
      `);
      const routes = extractGinRoutes(tree, 'main.go');
      expect(routes).toHaveLength(1);
      expect(routes[0].httpMethod).toBe('GET');
      expect(routes[0].routePath).toBe('/x');
      expect(routes[0].methodName).toBeNull();
    });
  });

  describe('fixture integration', () => {
    it('parses test/fixtures/gin-basic/main.go and emits 5 routes', () => {
      const source = fs.readFileSync(FIXTURE_PATH, 'utf-8');
      const tree = parseGo(source);
      const routes = extractGinRoutes(tree, FIXTURE_PATH);
      // Fixture has: r.GET, r.POST, router.DELETE, engine.PATCH, r.PUT
      expect(routes).toHaveLength(5);

      const summary = routes.map(r =>
        `${r.controllerName}.${r.httpMethod} ${r.routePath} -> ${r.methodName}`,
      ).sort();
      expect(summary).toEqual([
        'engine.PATCH /users/:id -> updateUser',
        'r.GET /users -> listUsers',
        'r.POST /users -> createUser',
        'r.PUT /users/:id -> replaceUser',
        'router.DELETE /users/:id -> deleteUser',
      ]);

      // Every route should report lineNumber >= 0
      for (const route of routes) {
        expect(route.lineNumber).toBeGreaterThanOrEqual(0);
        expect(route.isControllerClass).toBe(false);
      }
    });
  });

  describe('deferred scope (r.Group prefix handling)', () => {
    // (#M3) Gin route groups (`r.Group("/api")` returning a RouterGroup
    // whose `.GET/.POST` calls inherit the prefix) are explicitly out of
    // scope for this extractor. The go.ts header comment already calls
    // this out; surface it here so the gap is visible from the test file.
    //
    // Example source that this extractor DOES NOT currently model:
    //   api := r.Group("/api")
    //   api.GET("/users", listUsers)   // effective path: /api/users
    //
    // Tracked for a follow-up. See go.ts header (lines 14-16).
    it.todo('expands r.Group("/api") prefix onto child GET/POST registrations');
  });
});
