import { describe, it, expect, beforeEach } from 'vitest';
import Parser from 'tree-sitter';
import Java from 'tree-sitter-java';
import { extractSpringRoutes } from '../../src/core/ingestion/workers/spring-route-extractor.js';
import type { ExtractedRoute } from '../../src/core/ingestion/workers/parse-worker.js';

/**
 * Test suite for extractSpringRoutes function.
 *
 * These tests are currently FAILING because extractSpringRoutes is not yet implemented.
 * The function should extract HTTP routes from Spring Boot controller classes
 * by analyzing tree-sitter AST for Java annotations like @GetMapping, @PostMapping, etc.
 *
 * BDD Feature: Spring Route Extraction
 *   As a code intelligence system
 *   I want to extract HTTP routes from Spring Boot controllers
 *   So that I can map API endpoints to their handler methods
 */

// Helper to parse Java source and return tree-sitter Tree
function parseJava(source: string): Parser.Tree {
  const parser = new Parser();
  parser.setLanguage(Java);
  return parser.parse(source);
}

// ========================================
// Part 1: BDD Scenarios (Specification)
// ========================================

/**
 * Feature: Basic Controller Extraction
 *
 * Scenario: Extract route from @RestController with @GetMapping
 *   Given a Java class annotated with @RestController
 *   And a method annotated with @GetMapping("/users")
 *   When extractSpringRoutes processes the AST
 *   Then it should return one route with:
 *     - httpMethod: "GET"
 *     - routePath: "/users"
 *     - controllerName: the class name
 *     - methodName: the method name
 *     - isControllerClass: true
 *
 * Scenario Outline: Extract routes from all HTTP method annotations
 *   Given a @RestController class with a method annotated with <annotation>
 *   When the annotation path is "/test"
 *   Then the extracted route should have httpMethod = <method>
 *
 *   Examples:
 *     | annotation      | method |
 *     | @GetMapping     | GET    |
 *     | @PostMapping    | POST   |
 *     | @PutMapping     | PUT    |
 *     | @DeleteMapping  | DELETE |
 *     | @PatchMapping   | PATCH  |
 */

describe('extractSpringRoutes', () => {
  // ========================================
  // 1. Basic Controller Extraction
  // ========================================

  describe('Basic controller extraction', () => {
    it('extracts GET route from @RestController with @GetMapping', () => {
      const source = `
        @RestController
        public class UserController {
          @GetMapping("/users")
          public List<User> getUsers() { return null; }
        }
      `;
      const tree = parseJava(source);
      const routes = extractSpringRoutes(tree, 'src/UserController.java');

      expect(routes).toHaveLength(1);
      expect(routes[0]).toMatchObject({
        filePath: 'src/UserController.java',
        httpMethod: 'GET',
        routePath: '/users',
        controllerName: 'UserController',
        methodName: 'getUsers',
        isControllerClass: true,
      });
      expect(routes[0].lineNumber).toBeGreaterThan(0);
    });

    it('extracts POST route from @RestController with @PostMapping', () => {
      const source = `
        @RestController
        public class OrderController {
          @PostMapping("/orders")
          public Order createOrder() { return null; }
        }
      `;
      const tree = parseJava(source);
      const routes = extractSpringRoutes(tree, 'src/OrderController.java');

      expect(routes).toHaveLength(1);
      expect(routes[0]).toMatchObject({
        httpMethod: 'POST',
        routePath: '/orders',
        controllerName: 'OrderController',
        methodName: 'createOrder',
        isControllerClass: true,
      });
    });

    it('extracts PUT route from @RestController with @PutMapping', () => {
      const source = `
        @RestController
        public class ProductController {
          @PutMapping("/products/{id}")
          public Product updateProduct() { return null; }
        }
      `;
      const tree = parseJava(source);
      const routes = extractSpringRoutes(tree, 'src/ProductController.java');

      expect(routes).toHaveLength(1);
      expect(routes[0]).toMatchObject({
        httpMethod: 'PUT',
        routePath: '/products/{id}',
        controllerName: 'ProductController',
        methodName: 'updateProduct',
      });
    });

    it('extracts DELETE route from @RestController with @DeleteMapping', () => {
      const source = `
        @RestController
        public class ItemController {
          @DeleteMapping("/items/{id}")
          public void deleteItem() { }
        }
      `;
      const tree = parseJava(source);
      const routes = extractSpringRoutes(tree, 'src/ItemController.java');

      expect(routes).toHaveLength(1);
      expect(routes[0]).toMatchObject({
        httpMethod: 'DELETE',
        routePath: '/items/{id}',
        controllerName: 'ItemController',
        methodName: 'deleteItem',
      });
    });

    it('extracts PATCH route from @RestController with @PatchMapping', () => {
      const source = `
        @RestController
        public class DocumentController {
          @PatchMapping("/docs/{id}")
          public Document patchDoc() { return null; }
        }
      `;
      const tree = parseJava(source);
      const routes = extractSpringRoutes(tree, 'src/DocumentController.java');

      expect(routes).toHaveLength(1);
      expect(routes[0]).toMatchObject({
        httpMethod: 'PATCH',
        routePath: '/docs/{id}',
        controllerName: 'DocumentController',
        methodName: 'patchDoc',
      });
    });
  });

  // ========================================
  // 2. Class + Method Path Combination
  // ========================================

  describe('Class + method path combination', () => {
    it('combines @RequestMapping at class level with @GetMapping at method level', () => {
      const source = `
        @RestController
        @RequestMapping("/api/v1")
        public class ApiController {
          @GetMapping("/users")
          public List<User> getUsers() { return null; }
        }
      `;
      const tree = parseJava(source);
      const routes = extractSpringRoutes(tree, 'src/ApiController.java');

      expect(routes).toHaveLength(1);
      expect(routes[0]).toMatchObject({
        httpMethod: 'GET',
        routePath: '/api/v1/users',
        prefix: '/api/v1',
      });
    });

    it('combines class prefix with multiple methods', () => {
      const source = `
        @RestController
        @RequestMapping("/api/v1")
        public class ApiController {
          @GetMapping("/users")
          public List<User> getUsers() { return null; }

          @PostMapping("/users")
          public User createUser() { return null; }

          @GetMapping("/health")
          public String health() { return "OK"; }
        }
      `;
      const tree = parseJava(source);
      const routes = extractSpringRoutes(tree, 'src/ApiController.java');

      expect(routes).toHaveLength(3);
      expect(routes.map(r => r.routePath).sort()).toEqual([
        '/api/v1/health',
        '/api/v1/users',
        '/api/v1/users',
      ]);
      expect(routes.find(r => r.httpMethod === 'POST')?.routePath).toBe('/api/v1/users');
    });

    it('handles @RequestMapping with value attribute', () => {
      const source = `
        @RestController
        @RequestMapping(value = "/api/v2")
        public class ApiController {
          @GetMapping("/items")
          public List<Item> getItems() { return null; }
        }
      `;
      const tree = parseJava(source);
      const routes = extractSpringRoutes(tree, 'src/ApiController.java');

      expect(routes).toHaveLength(1);
      expect(routes[0].routePath).toBe('/api/v2/items');
    });
  });

  // ========================================
  // 3. @RequestMapping with method attribute
  // ========================================

  describe('@RequestMapping with method attribute', () => {
    it('extracts POST from @RequestMapping(method=RequestMethod.POST)', () => {
      const source = `
        @RestController
        public class OrderController {
          @RequestMapping(value = "/orders", method = RequestMethod.POST)
          public Order createOrder() { return null; }
        }
      `;
      const tree = parseJava(source);
      const routes = extractSpringRoutes(tree, 'src/OrderController.java');

      expect(routes).toHaveLength(1);
      expect(routes[0]).toMatchObject({
        httpMethod: 'POST',
        routePath: '/orders',
      });
    });

    it('extracts PUT from @RequestMapping(method=RequestMethod.PUT)', () => {
      const source = `
        @RestController
        public class ProductController {
          @RequestMapping(value = "/products/{id}", method = RequestMethod.PUT)
          public Product updateProduct() { return null; }
        }
      `;
      const tree = parseJava(source);
      const routes = extractSpringRoutes(tree, 'src/ProductController.java');

      expect(routes).toHaveLength(1);
      expect(routes[0]).toMatchObject({
        httpMethod: 'PUT',
        routePath: '/products/{id}',
      });
    });

    it('extracts method from @RequestMapping with array syntax', () => {
      const source = `
        @RestController
        public class ApiController {
          @RequestMapping(value = "/test", method = {RequestMethod.PUT})
          public void testMethod() { }
        }
      `;
      const tree = parseJava(source);
      const routes = extractSpringRoutes(tree, 'src/ApiController.java');

      expect(routes).toHaveLength(1);
      expect(routes[0].httpMethod).toBe('PUT');
    });

    it('defaults to GET when @RequestMapping has no method attribute', () => {
      const source = `
        @RestController
        public class DefaultController {
          @RequestMapping("/default")
          public String defaultHandler() { return "default"; }
        }
      `;
      const tree = parseJava(source);
      const routes = extractSpringRoutes(tree, 'src/DefaultController.java');

      expect(routes).toHaveLength(1);
      expect(routes[0]).toMatchObject({
        httpMethod: 'GET',
        routePath: '/default',
      });
    });

    it('extracts from @RequestMapping(value="/path", method=RequestMethod.DELETE)', () => {
      const source = `
        @RestController
        public class ResourceController {
          @RequestMapping(value = "/resource/{id}", method = RequestMethod.DELETE)
          public void deleteResource() { }
        }
      `;
      const tree = parseJava(source);
      const routes = extractSpringRoutes(tree, 'src/ResourceController.java');

      expect(routes).toHaveLength(1);
      expect(routes[0]).toMatchObject({
        httpMethod: 'DELETE',
        routePath: '/resource/{id}',
      });
    });

    // WI-81: @DeleteMapping with path variable must produce method=DELETE
    // (regression guard — the array-form fallback in #91 must not regress this path)
    it('WI-81: @DeleteMapping("/foo/{id}") produces method=DELETE', () => {
      const source = `
        @RestController
        public class FooController {
          @DeleteMapping("/foo/{id}")
          public void deleteFoo() { }
        }
      `;
      const tree = parseJava(source);
      const routes = extractSpringRoutes(tree, 'src/FooController.java');

      expect(routes).toHaveLength(1);
      expect(routes[0]).toMatchObject({
        httpMethod: 'DELETE',
        routePath: '/foo/{id}',
        controllerName: 'FooController',
        methodName: 'deleteFoo',
      });
    });

    // WI-81: single-element array form is the case the user's failing repo was hitting
    it('WI-81: @RequestMapping(method = {RequestMethod.DELETE}) array form produces method=DELETE', () => {
      const source = `
        @RestController
        public class BarController {
          @RequestMapping(value = "/bar", method = {RequestMethod.DELETE})
          public void deleteBar() { }
        }
      `;
      const tree = parseJava(source);
      const routes = extractSpringRoutes(tree, 'src/BarController.java');

      expect(routes).toHaveLength(1);
      expect(routes[0]).toMatchObject({
        httpMethod: 'DELETE',
        routePath: '/bar',
        controllerName: 'BarController',
        methodName: 'deleteBar',
      });
    });
  });

  // ========================================
  // 4. Empty Path Handlers
  // ========================================

  describe('Empty path handlers', () => {
    it('handles @GetMapping with no arguments (empty path)', () => {
      const source = `
        @RestController
        @RequestMapping("/api")
        public class ApiController {
          @GetMapping
          public String getRoot() { return "root"; }
        }
      `;
      const tree = parseJava(source);
      const routes = extractSpringRoutes(tree, 'src/ApiController.java');

      expect(routes).toHaveLength(1);
      expect(routes[0]).toMatchObject({
        httpMethod: 'GET',
        routePath: '/api',
      });
    });

    it('handles @PostMapping("") with empty string', () => {
      const source = `
        @RestController
        @RequestMapping("/api")
        public class ApiController {
          @PostMapping("")
          public String createAtRoot() { return "created"; }
        }
      `;
      const tree = parseJava(source);
      const routes = extractSpringRoutes(tree, 'src/ApiController.java');

      expect(routes).toHaveLength(1);
      expect(routes[0].routePath).toBe('/api');
    });

    it('handles empty method path with no class prefix', () => {
      const source = `
        @RestController
        public class RootController {
          @GetMapping
          public String root() { return "root"; }
        }
      `;
      const tree = parseJava(source);
      const routes = extractSpringRoutes(tree, 'src/RootController.java');

      expect(routes).toHaveLength(1);
      expect(routes[0].routePath).toBe('');
    });
  });

  // ========================================
  // 5. Path Normalization
  // ========================================

  describe('Path normalization', () => {
    it('normalizes path without leading slash', () => {
      const source = `
        @RestController
        public class ServiceController {
          @GetMapping("classify")
          public String classify() { return "classified"; }
        }
      `;
      const tree = parseJava(source);
      const routes = extractSpringRoutes(tree, 'src/ServiceController.java');

      expect(routes).toHaveLength(1);
      expect(routes[0].routePath).toBe('/classify');
    });

    it('normalizes method path without leading slash combined with class prefix', () => {
      const source = `
        @RestController
        @RequestMapping("/api")
        public class ApiController {
          @GetMapping("users")
          public List<User> getUsers() { return null; }
        }
      `;
      const tree = parseJava(source);
      const routes = extractSpringRoutes(tree, 'src/ApiController.java');

      expect(routes).toHaveLength(1);
      expect(routes[0].routePath).toBe('/api/users');
    });

    it('removes trailing slash from class prefix', () => {
      const source = `
        @RestController
        @RequestMapping("/api/")
        public class ApiController {
          @GetMapping("/users")
          public List<User> getUsers() { return null; }
        }
      `;
      const tree = parseJava(source);
      const routes = extractSpringRoutes(tree, 'src/ApiController.java');

      expect(routes).toHaveLength(1);
      expect(routes[0].routePath).toBe('/api/users');
    });

    it('handles double slashes in combined paths', () => {
      const source = `
        @RestController
        @RequestMapping("/api/")
        public class ApiController {
          @GetMapping("/users")
          public List<User> getUsers() { return null; }
        }
      `;
      const tree = parseJava(source);
      const routes = extractSpringRoutes(tree, 'src/ApiController.java');

      expect(routes).toHaveLength(1);
      // Should not have double slashes
      expect(routes[0].routePath).not.toContain('//');
    });
  });

  // ========================================
  // 6. @FeignClient Exclusion
  // ========================================

  describe('@FeignClient exclusion', () => {
    it('excludes @FeignClient interfaces with @GetMapping', () => {
      const source = `
        @FeignClient(name = "user-service")
        public interface UserClient {
          @GetMapping("/users")
          List<User> getUsers();
        }
      `;
      const tree = parseJava(source);
      const routes = extractSpringRoutes(tree, 'src/UserClient.java');

      expect(routes).toHaveLength(0);
    });

    it('excludes @FeignClient with @PostMapping', () => {
      const source = `
        @FeignClient(name = "order-service", url = "http://orders.api")
        public interface OrderClient {
          @PostMapping("/orders")
          Order createOrder(Order order);
        }
      `;
      const tree = parseJava(source);
      const routes = extractSpringRoutes(tree, 'src/OrderClient.java');

      expect(routes).toHaveLength(0);
    });

    it('excludes @FeignClient even with multiple methods', () => {
      const source = `
        @FeignClient("product-service")
        public interface ProductClient {
          @GetMapping("/products")
          List<Product> getAll();

          @GetMapping("/products/{id}")
          Product getById(@PathVariable Long id);

          @PostMapping("/products")
          Product create(Product product);
        }
      `;
      const tree = parseJava(source);
      const routes = extractSpringRoutes(tree, 'src/ProductClient.java');

      expect(routes).toHaveLength(0);
    });

    it('processes regular @Controller after FeignClient in same file (edge case)', () => {
      // Note: This is a theoretical edge case - typically one class per file
      // But testing that FeignClient detection is per-class, not per-file
      const source = `
        @FeignClient("service")
        interface FeignServiceClient {
          @GetMapping("/feign")
          String feignMethod();
        }

        @RestController
        class RealController {
          @GetMapping("/real")
          String realMethod() { return "real"; }
        }
      `;
      const tree = parseJava(source);
      const routes = extractSpringRoutes(tree, 'src/MixedFile.java');

      // FeignClient should be excluded, RealController should be included
      expect(routes).toHaveLength(1);
      expect(routes[0]).toMatchObject({
        controllerName: 'RealController',
        methodName: 'realMethod',
        routePath: '/real',
        isControllerClass: true,
      });
    });
  });

  // ========================================
  // 7. Inherited Routes (isControllerClass flag)
  // ========================================

  describe('Inherited routes (isControllerClass flag)', () => {
    it('marks routes from @RestController class as isControllerClass: true', () => {
      const source = `
        @RestController
        public class UserController {
          @GetMapping("/users")
          public List<User> getUsers() { return null; }
        }
      `;
      const tree = parseJava(source);
      const routes = extractSpringRoutes(tree, 'src/UserController.java');

      expect(routes).toHaveLength(1);
      expect(routes[0].isControllerClass).toBe(true);
    });

    it('marks routes from @Controller class as isControllerClass: true', () => {
      const source = `
        @Controller
        public class WebController {
          @GetMapping("/web")
          public String webPage() { return "web"; }
        }
      `;
      const tree = parseJava(source);
      const routes = extractSpringRoutes(tree, 'src/WebController.java');

      expect(routes).toHaveLength(1);
      expect(routes[0].isControllerClass).toBe(true);
    });

    it('marks routes from non-controller class as isControllerClass: false', () => {
      // Base class with @RequestMapping but no @RestController/@Controller
      const source = `
        public abstract class BaseController {
          @GetMapping("/base")
          public String baseMethod() { return "base"; }
        }
      `;
      const tree = parseJava(source);
      const routes = extractSpringRoutes(tree, 'src/BaseController.java');

      expect(routes).toHaveLength(1);
      expect(routes[0].isControllerClass).toBe(false);
    });

    it('extracts routes from class with only @RequestMapping (potential base class)', () => {
      const source = `
        @RequestMapping("/api/base")
        public abstract class BaseApiController {
          @GetMapping("/items")
          public List<Item> getItems() { return null; }
        }
      `;
      const tree = parseJava(source);
      const routes = extractSpringRoutes(tree, 'src/BaseApiController.java');

      expect(routes).toHaveLength(1);
      expect(routes[0]).toMatchObject({
        routePath: '/api/base/items',
        isControllerClass: false,
      });
    });

    it('distinguishes @RestController from parent with only @RequestMapping', () => {
      // Child controller with @RestController
      const source = `
        @RestController
        @RequestMapping("/api/v1")
        public class ProductController {
          @GetMapping("/products")
          public List<Product> getProducts() { return null; }
        }
      `;
      const tree = parseJava(source);
      const routes = extractSpringRoutes(tree, 'src/ProductController.java');

      expect(routes).toHaveLength(1);
      expect(routes[0].isControllerClass).toBe(true);
    });
  });

  // ========================================
  // 8. Multiple Methods in Same Controller
  // ========================================

  describe('Multiple methods in same controller', () => {
    it('extracts all routes from controller with multiple methods', () => {
      const source = `
        @RestController
        @RequestMapping("/api/users")
        public class UserController {
          @GetMapping
          public List<User> list() { return null; }

          @GetMapping("/{id}")
          public User get(@PathVariable Long id) { return null; }

          @PostMapping
          public User create(@RequestBody User user) { return null; }

          @PutMapping("/{id}")
          public User update(@PathVariable Long id) { return null; }

          @DeleteMapping("/{id}")
          public void delete(@PathVariable Long id) { }
        }
      `;
      const tree = parseJava(source);
      const routes = extractSpringRoutes(tree, 'src/UserController.java');

      expect(routes).toHaveLength(5);

      const getRoutes = routes.filter(r => r.httpMethod === 'GET');
      expect(getRoutes).toHaveLength(2);

      const postRoutes = routes.filter(r => r.httpMethod === 'POST');
      expect(postRoutes).toHaveLength(1);

      const putRoutes = routes.filter(r => r.httpMethod === 'PUT');
      expect(putRoutes).toHaveLength(1);

      const deleteRoutes = routes.filter(r => r.httpMethod === 'DELETE');
      expect(deleteRoutes).toHaveLength(1);
    });

    it('extracts routes with different HTTP methods and paths', () => {
      const source = `
        @RestController
        public class MixedController {
          @GetMapping("/items")
          public List<Item> items() { return null; }

          @PostMapping("/items")
          public Item create() { return null; }

          @GetMapping("/categories")
          public List<Category> categories() { return null; }
        }
      `;
      const tree = parseJava(source);
      const routes = extractSpringRoutes(tree, 'src/MixedController.java');

      expect(routes).toHaveLength(3);

      const routePaths = routes.map(r => r.routePath);
      expect(routePaths).toContain('/items');
      expect(routePaths).toContain('/categories');
    });
  });

  // ========================================
  // 9. Line Numbers
  // ========================================

  describe('Line numbers', () => {
    it('reports correct line number for route annotation', () => {
      const source = `
        @RestController
        public class UserController {
          @GetMapping("/users")
          public List<User> getUsers() { return null; }
        }
      `;
      const tree = parseJava(source);
      const routes = extractSpringRoutes(tree, 'src/UserController.java');

      expect(routes).toHaveLength(1);
      // Line number should be where @GetMapping appears (0-indexed or 1-indexed depending on tree-sitter)
      // @GetMapping is on line 2 (0-indexed) or line 3 (1-indexed)
      expect(routes[0].lineNumber).toBeGreaterThanOrEqual(2);
    });

    it('reports different line numbers for different methods', () => {
      const source = `
        @RestController
        public class MultiController {
          @GetMapping("/first")
          public String first() { return "first"; }

          @PostMapping("/second")
          public String second() { return "second"; }

          @DeleteMapping("/third")
          public String third() { return "third"; }
        }
      `;
      const tree = parseJava(source);
      const routes = extractSpringRoutes(tree, 'src/MultiController.java');

      expect(routes).toHaveLength(3);

      const lineNumbers = routes.map(r => r.lineNumber);
      // Each route should have a distinct line number
      expect(new Set(lineNumbers).size).toBe(3);

      // Routes should be in order of appearance
      expect(lineNumbers).toEqual([...lineNumbers].sort((a, b) => a - b));
    });
  });

  // ========================================
  // 10. Edge Cases
  // ========================================

  describe('Edge cases', () => {
    it('returns empty array for class with no route annotations', () => {
      const source = `
        @RestController
        public class EmptyController {
          public void noRouteMethod() { }

          @Override
          public String toString() { return "EmptyController"; }
        }
      `;
      const tree = parseJava(source);
      const routes = extractSpringRoutes(tree, 'src/EmptyController.java');

      expect(routes).toHaveLength(0);
    });

    it('returns empty array for regular class without controller annotations', () => {
      const source = `
        public class Service {
          @GetMapping("/should-not-extract")
          public String shouldNotExtract() { return "no"; }
        }
      `;
      const tree = parseJava(source);
      const routes = extractSpringRoutes(tree, 'src/Service.java');

      // This class has @GetMapping but no @RestController/@Controller
      // It should still extract with isControllerClass: false (potential base class)
      expect(routes).toHaveLength(1);
      expect(routes[0].isControllerClass).toBe(false);
    });

    it('handles nested classes (extracts from outer class only)', () => {
      const source = `
        @RestController
        public class OuterController {
          @GetMapping("/outer")
          public String outer() { return "outer"; }

          public class InnerController {
            @GetMapping("/inner")
            public String inner() { return "inner"; }
          }
        }
      `;
      const tree = parseJava(source);
      const routes = extractSpringRoutes(tree, 'src/OuterController.java');

      // Should extract from the outer @RestController
      expect(routes.length).toBeGreaterThanOrEqual(1);
      const outerRoute = routes.find(r => r.methodName === 'outer');
      expect(outerRoute).toBeDefined();
      expect(outerRoute?.isControllerClass).toBe(true);
    });

    it('handles @Controller annotation (not @RestController)', () => {
      const source = `
        @Controller
        public class WebPageController {
          @GetMapping("/page")
          public String page() { return "page"; }
        }
      `;
      const tree = parseJava(source);
      const routes = extractSpringRoutes(tree, 'src/WebPageController.java');

      expect(routes).toHaveLength(1);
      expect(routes[0]).toMatchObject({
        httpMethod: 'GET',
        routePath: '/page',
        controllerName: 'WebPageController',
        isControllerClass: true,
      });
    });

    it('handles annotation with multiple attributes', () => {
      const source = `
        @RestController
        public class ApiDocController {
          @GetMapping(value = "/docs", produces = "application/json")
          public String docs() { return "{}"; }
        }
      `;
      const tree = parseJava(source);
      const routes = extractSpringRoutes(tree, 'src/ApiDocController.java');

      expect(routes).toHaveLength(1);
      expect(routes[0].routePath).toBe('/docs');
    });

    it('extracts filePath correctly for all routes', () => {
      const source = `
        @RestController
        public class TestController {
          @GetMapping("/test")
          public String test() { return "test"; }
        }
      `;
      const tree = parseJava(source);
      const routes = extractSpringRoutes(tree, 'com/example/TestController.java');

      expect(routes).toHaveLength(1);
      expect(routes[0].filePath).toBe('com/example/TestController.java');
    });

    it('handles interface without @FeignClient (should extract)', () => {
      const source = `
        public interface ServiceInterface {
          @GetMapping("/interface-method")
          String interfaceMethod();
        }
      `;
      const tree = parseJava(source);
      const routes = extractSpringRoutes(tree, 'src/ServiceInterface.java');

      // Interfaces without @FeignClient may have @RequestMapping methods
      // (though unusual, they could be implemented by @RestController classes)
      expect(routes).toHaveLength(1);
      expect(routes[0].isControllerClass).toBe(false);
    });
  });

  // ========================================
  // 11. Middleware (placeholder for future)
  // ========================================

  describe('Middleware field', () => {
    it('returns empty middleware array for simple routes', () => {
      const source = `
        @RestController
        public class SimpleController {
          @GetMapping("/simple")
          public String simple() { return "simple"; }
        }
      `;
      const tree = parseJava(source);
      const routes = extractSpringRoutes(tree, 'src/SimpleController.java');

      expect(routes).toHaveLength(1);
      expect(routes[0].middleware).toEqual([]);
    });
  });

  // ========================================
  // 12. @Controller with @RequestMapping at method level
  // ========================================

  describe('@Controller with method-level @RequestMapping', () => {
    it('extracts routes from @Controller annotated class', () => {
      const source = `
        @Controller
        @RequestMapping("/web")
        public class WebController {
          @RequestMapping(value = "/home", method = RequestMethod.GET)
          public String home() { return "home"; }
        }
      `;
      const tree = parseJava(source);
      const routes = extractSpringRoutes(tree, 'src/WebController.java');

      expect(routes).toHaveLength(1);
      expect(routes[0]).toMatchObject({
        httpMethod: 'GET',
        routePath: '/web/home',
        isControllerClass: true,
      });
    });
  });

  // ========================================
  // 13. Complex annotation patterns
  // ========================================

  describe('Complex annotation patterns', () => {
    it('handles @GetMapping with path attribute', () => {
      const source = `
        @RestController
        public class PathController {
          @GetMapping(path = "/items")
          public List<Item> items() { return null; }
        }
      `;
      const tree = parseJava(source);
      const routes = extractSpringRoutes(tree, 'src/PathController.java');

      expect(routes).toHaveLength(1);
      expect(routes[0].routePath).toBe('/items');
    });

    it('handles @RequestMapping with only method attribute (no value)', () => {
      const source = `
        @RestController
        @RequestMapping("/api")
        public class ApiController {
          @RequestMapping(method = RequestMethod.POST)
          public String postWithoutPath() { return "posted"; }
        }
      `;
      const tree = parseJava(source);
      const routes = extractSpringRoutes(tree, 'src/ApiController.java');

      expect(routes).toHaveLength(1);
      expect(routes[0]).toMatchObject({
        httpMethod: 'POST',
        routePath: '/api', // Uses class prefix only
      });
    });

    it('handles class with both @Controller and @RequestMapping', () => {
      const source = `
        @Controller
        @RequestMapping("/app")
        public class AppController {
          @GetMapping("/status")
          public String status() { return "OK"; }
        }
      `;
      const tree = parseJava(source);
      const routes = extractSpringRoutes(tree, 'src/AppController.java');

      expect(routes).toHaveLength(1);
      expect(routes[0].routePath).toBe('/app/status');
    });
  });

  // ========================================
  // 14. Return type verification
  // ========================================

  describe('Return type verification', () => {
    it('returns ExtractedRoute array with all required fields', () => {
      const source = `
        @RestController
        @RequestMapping("/api/v1")
        public class CompleteController {
          @GetMapping("/items/{id}")
          public Item getItem() { return null; }
        }
      `;
      const tree = parseJava(source);
      const routes = extractSpringRoutes(tree, 'src/CompleteController.java');

      expect(routes).toHaveLength(1);
      const route = routes[0];

      // Verify all fields exist and have correct types
      expect(typeof route.filePath).toBe('string');
      expect(typeof route.httpMethod).toBe('string');
      expect(typeof route.routePath).toBe('string');
      expect(typeof route.controllerName).toBe('string');
      expect(typeof route.methodName).toBe('string');
      expect(Array.isArray(route.middleware)).toBe(true);
      expect(typeof route.prefix).toBe('string');
      expect(typeof route.lineNumber).toBe('number');
      expect(typeof route.isControllerClass).toBe('boolean');

      // Verify specific values
      expect(route.filePath).toBe('src/CompleteController.java');
      expect(route.httpMethod).toBe('GET');
      expect(route.routePath).toBe('/api/v1/items/{id}');
      expect(route.controllerName).toBe('CompleteController');
      expect(route.methodName).toBe('getItem');
      expect(route.middleware).toEqual([]);
      expect(route.prefix).toBe('/api/v1');
      expect(route.isControllerClass).toBe(true);
    });
  });

  // ========================================
  // 15. Cross-file Constant Resolution
  // ========================================

  describe('cross-file constant resolution', () => {
    it('resolves @GetMapping(Constants.API_PATH) using provided constants map', () => {
      const java = `
        @RestController
        class TestController {
          @GetMapping(Constants.API_PATH)
          public void test() {}
        }
      `;
      const tree = parseJava(java);
      const constants = new Map([['Constants.API_PATH', '/api']]);
      // @ts-expect-error - constants param not yet implemented
      const routes = extractSpringRoutes(tree, 'TestController.java', constants);
      expect(routes).toHaveLength(1);
      expect(routes[0].routePath).toBe('/api');
    });

    it('resolves qualified reference Config.BASE_URL using constants map', () => {
      const java = `
        @RestController
        class ApiController {
          @GetMapping(Config.BASE_URL)
          public void endpoint() {}
        }
      `;
      const tree = parseJava(java);
      const constants = new Map([['Config.BASE_URL', '/v1/base']]);
      // @ts-expect-error - constants param not yet implemented
      const routes = extractSpringRoutes(tree, 'ApiController.java', constants);
      expect(routes).toHaveLength(1);
      expect(routes[0].routePath).toBe('/v1/base');
    });

    it('falls back to raw identifier when constant not in map', () => {
      const java = `
        @RestController
        class UserController {
          @GetMapping(Constants.UNKNOWN_PATH)
          public void handle() {}
        }
      `;
      const tree = parseJava(java);
      const constants = new Map<string, string>();
      // @ts-expect-error - constants param not yet implemented
      const routes = extractSpringRoutes(tree, 'UserController.java', constants);
      expect(routes).toHaveLength(1);
      // Should return the identifier as-is when constant is not found
      expect(routes[0].routePath).toBe('Constants.UNKNOWN_PATH');
    });

    it('resolves concatenated paths: Constants.PREFIX + "/users"', () => {
      const java = `
        @RestController
        class ItemController {
          @GetMapping(Constants.PREFIX + "/users")
          public void list() {}
        }
      `;
      const tree = parseJava(java);
      const constants = new Map([['Constants.PREFIX', '/api']]);
      // @ts-expect-error - constants param not yet implemented
      const routes = extractSpringRoutes(tree, 'ItemController.java', constants);
      expect(routes).toHaveLength(1);
      expect(routes[0].routePath).toBe('/api/users');
    });
  });

  // ========================================
  // 14. WI-92: produces / consumes extraction
  // ========================================

  describe('WI-92: produces/consumes attribute extraction', () => {
    it('extracts produces and consumes from @RequestMapping string form', () => {
      const source = `
        @RestController
        public class MediaTypeController {
          @RequestMapping(value = "/x", produces = "application/json", consumes = "application/json")
          public String x() { return "x"; }
        }
      `;
      const tree = parseJava(source);
      const routes = extractSpringRoutes(tree, 'src/MediaTypeController.java');

      expect(routes).toHaveLength(1);
      expect(routes[0].routePath).toBe('/x');
      expect(routes[0].produces).toEqual(['application/json']);
      expect(routes[0].consumes).toEqual(['application/json']);
    });

    it('extracts produces array form from @RequestMapping', () => {
      const source = `
        @RestController
        public class ArrayProducesController {
          @RequestMapping(value = "/y", produces = {"application/json", "application/xml"})
          public String y() { return "y"; }
        }
      `;
      const tree = parseJava(source);
      const routes = extractSpringRoutes(tree, 'src/ArrayProducesController.java');

      expect(routes).toHaveLength(1);
      expect(routes[0].routePath).toBe('/y');
      expect(routes[0].produces).toEqual(['application/json', 'application/xml']);
    });

    it('omits produces/consumes keys when not declared on the annotation', () => {
      const source = `
        @RestController
        public class PlainController {
          @GetMapping("/plain")
          public String plain() { return "plain"; }
        }
      `;
      const tree = parseJava(source);
      const routes = extractSpringRoutes(tree, 'src/PlainController.java');

      expect(routes).toHaveLength(1);
      expect(routes[0].produces).toBeUndefined();
      expect(routes[0].consumes).toBeUndefined();
    });

    it('extracts produces and consumes from per-method @GetMapping annotations', () => {
      const source = `
        @RestController
        public class GetMediaController {
          @GetMapping(value = "/z", produces = "text/plain", consumes = "text/plain")
          public String z() { return "z"; }
        }
      `;
      const tree = parseJava(source);
      const routes = extractSpringRoutes(tree, 'src/GetMediaController.java');

      expect(routes).toHaveLength(1);
      expect(routes[0].httpMethod).toBe('GET');
      expect(routes[0].produces).toEqual(['text/plain']);
      expect(routes[0].consumes).toEqual(['text/plain']);
    });
  });

  // ========================================
  // 16. WI-90: inherited @RequestMapping prefix from same-file superclass
  // ========================================

  describe('WI-90: inherited class-level @RequestMapping prefix', () => {
    it('uses superclass @RequestMapping prefix when subclass is @RestController', () => {
      const source = `
        @Controller
        @RequestMapping("/api")
        public class BaseApiController { }

        @RestController
        public class UserController extends BaseApiController {
          @GetMapping("/users")
          public List<User> list() { return null; }
        }
      `;
      const tree = parseJava(source);
      const routes = extractSpringRoutes(tree, 'src/UserController.java');

      expect(routes).toHaveLength(1);
      expect(routes[0]).toMatchObject({
        httpMethod: 'GET',
        routePath: '/api/users',
        controllerName: 'UserController',
        methodName: 'list',
        prefix: '/api',
        isInherited: true,
      });
    });

    it('uses superclass prefix when base class is plain @Controller (not @RestController)', () => {
      const source = `
        @Controller
        @RequestMapping("/v1")
        public class BaseController { }

        @RestController
        public class OrderController extends BaseController {
          @PostMapping("/orders")
          public Order create() { return null; }
        }
      `;
      const tree = parseJava(source);
      const routes = extractSpringRoutes(tree, 'src/OrderController.java');

      expect(routes).toHaveLength(1);
      expect(routes[0].routePath).toBe('/v1/orders');
      expect(routes[0].prefix).toBe('/v1');
      expect(routes[0].isInherited).toBe(true);
    });

    it('uses superclass prefix with @RequestMapping method (not just HTTP-method annotations)', () => {
      const source = `
        @Controller
        @RequestMapping("/api/v2")
        public class BaseController { }

        @RestController
        public class ThingController extends BaseController {
          @RequestMapping(value = "/things", method = RequestMethod.GET)
          public Thing get() { return null; }
        }
      `;
      const tree = parseJava(source);
      const routes = extractSpringRoutes(tree, 'src/ThingController.java');

      expect(routes).toHaveLength(1);
      expect(routes[0].routePath).toBe('/api/v2/things');
      expect(routes[0].prefix).toBe('/api/v2');
      expect(routes[0].isInherited).toBe(true);
    });

    it('does not set isInherited when subclass has its own class-level @RequestMapping', () => {
      const source = `
        @Controller
        @RequestMapping("/api")
        public class BaseApiController { }

        @RestController
        @RequestMapping("/v2")
        public class UserController extends BaseApiController {
          @GetMapping("/users")
          public List<User> list() { return null; }
        }
      `;
      const tree = parseJava(source);
      const routes = extractSpringRoutes(tree, 'src/UserController.java');

      expect(routes).toHaveLength(1);
      expect(routes[0].routePath).toBe('/v2/users');
      expect(routes[0].prefix).toBe('/v2');
      expect(routes[0].isInherited).toBe(false);
    });

    it('does not set isInherited when superclass has no @RequestMapping', () => {
      const source = `
        public class PlainBase { }

        @RestController
        public class UserController extends PlainBase {
          @GetMapping("/users")
          public List<User> list() { return null; }
        }
      `;
      const tree = parseJava(source);
      const routes = extractSpringRoutes(tree, 'src/UserController.java');

      expect(routes).toHaveLength(1);
      expect(routes[0].routePath).toBe('/users');
      expect(routes[0].prefix).toBeNull();
      expect(routes[0].isInherited).toBe(false);
    });

    it('does not affect routes on a controller that does not extend anything', () => {
      const source = `
        @RestController
        public class StandaloneController {
          @GetMapping("/items")
          public List<Item> list() { return null; }
        }
      `;
      const tree = parseJava(source);
      const routes = extractSpringRoutes(tree, 'src/StandaloneController.java');

      expect(routes).toHaveLength(1);
      expect(routes[0].routePath).toBe('/items');
      expect(routes[0].prefix).toBeNull();
      expect(routes[0].isInherited).toBe(false);
    });

    it('emits no route for the base class itself (it is not a controller with mapped methods)', () => {
      const source = `
        @Controller
        @RequestMapping("/api")
        public class BaseApiController { }

        @RestController
        public class UserController extends BaseApiController {
          @GetMapping("/users")
          public List<User> list() { return null; }
        }
      `;
      const tree = parseJava(source);
      const routes = extractSpringRoutes(tree, 'src/UserController.java');

      // Only one route (from UserController); BaseApiController has no mapped methods
      expect(routes).toHaveLength(1);
      expect(routes[0].controllerName).toBe('UserController');
    });

    // Cross-file inheritance is NOT supported by this fix; see #followup for the multi-file case.
    // The current extractor only walks the AST of the source it is given, so a subclass
    // that extends a base class defined in a different file has no entry for the base in
    // `classPrefixMap`, and therefore loses its inherited prefix.
    it('does NOT inherit prefix when superclass is defined in a different file (cross-file inheritance unsupported)', () => {
      // Subclass only — base class lives in another file and is therefore not
      // discoverable from the current AST walk.
      const source = `
        @RestController
        public class UserController extends BaseApiController {
          @GetMapping("/users")
          public List<User> list() { return null; }
        }
      `;
      const tree = parseJava(source);
      const routes = extractSpringRoutes(tree, 'src/UserController.java');

      // The route still gets extracted (the handler is concrete), but the
      // inherited /api prefix is silently dropped because BaseApiController
      // is not in this file's classPrefixMap.
      expect(routes).toHaveLength(1);
      expect(routes[0]).toMatchObject({
        httpMethod: 'GET',
        // routePath falls back to the method-level path only; no prefix
        routePath: '/users',
        controllerName: 'UserController',
        methodName: 'list',
      });
      expect(routes[0].prefix).toBeNull();
      expect(routes[0].isInherited).toBe(false);
    });
  });

  // ========================================
  // 17. WI-91: @RequestMapping multi-method array fan-out + @PatchMapping
  // ========================================

  describe('WI-91: @RequestMapping multi-method array fan-out', () => {
    it('produces TWO routes from method = {RequestMethod.GET, RequestMethod.POST} (not one)', () => {
      const source = `
        @RestController
        public class MultiMethodController {
          @RequestMapping(value = "/foo", method = {RequestMethod.GET, RequestMethod.POST})
          public String handle() { return "x"; }
        }
      `;
      const tree = parseJava(source);
      const routes = extractSpringRoutes(tree, 'src/MultiMethodController.java');

      // WI-91: must produce one route per HTTP method, not just the first
      expect(routes).toHaveLength(2);

      const methods = routes.map(r => r.httpMethod).sort();
      expect(methods).toEqual(['GET', 'POST']);

      for (const r of routes) {
        expect(r.routePath).toBe('/foo');
        expect(r.controllerName).toBe('MultiMethodController');
        expect(r.methodName).toBe('handle');
        expect(r.isControllerClass).toBe(true);
      }
    });

    it('produces THREE routes from method = {GET, POST, PUT}', () => {
      const source = `
        @RestController
        public class TripleController {
          @RequestMapping(value = "/items", method = {RequestMethod.GET, RequestMethod.POST, RequestMethod.PUT})
          public String handle() { return "x"; }
        }
      `;
      const tree = parseJava(source);
      const routes = extractSpringRoutes(tree, 'src/TripleController.java');

      expect(routes).toHaveLength(3);
      const methods = routes.map(r => r.httpMethod).sort();
      expect(methods).toEqual(['GET', 'POST', 'PUT']);
      for (const r of routes) {
        expect(r.routePath).toBe('/items');
      }
    });

    // Fan-out MUST propagate produces/consumes to every fanned-out route.
    // Guards against a refactor that pushes the route object before extracting
    // media types and therefore only attaches them to the first emitted route.
    it('fans out produces/consumes to ALL emitted routes, not just the first', () => {
      const source = `
        @RestController
        public class MediaFanOutController {
          @RequestMapping(value = "/x", method = {RequestMethod.GET, RequestMethod.POST}, produces = "application/json")
          public String handle() { return "x"; }
        }
      `;
      const tree = parseJava(source);
      const routes = extractSpringRoutes(tree, 'src/MediaFanOutController.java');

      expect(routes).toHaveLength(2);
      const methods = routes.map(r => r.httpMethod).sort();
      expect(methods).toEqual(['GET', 'POST']);

      // Every fanned-out route must carry the produces attribute.
      // A refactor that pushes the route object before extracting media
      // types would leave produces undefined on at least one of these.
      for (const r of routes) {
        expect(r.routePath).toBe('/x');
        expect(r.produces).toEqual(['application/json']);
      }
    });
  });

  describe('WI-91: @PatchMapping recognized', () => {
    it('produces ONE route with method=PATCH from @PatchMapping("/bar")', () => {
      const source = `
        @RestController
        public class PatchController {
          @PatchMapping("/bar")
          public String patch() { return "patched"; }
        }
      `;
      const tree = parseJava(source);
      const routes = extractSpringRoutes(tree, 'src/PatchController.java');

      // WI-91: @PatchMapping must be recognized
      expect(routes).toHaveLength(1);
      expect(routes[0]).toMatchObject({
        httpMethod: 'PATCH',
        routePath: '/bar',
        controllerName: 'PatchController',
        methodName: 'patch',
        isControllerClass: true,
      });
    });
  });
});
