/**
 * Integration Tests: Java Spring Route Node Creation
 *
 * Tests the end-to-end flow of:
 * 1. Parsing a Java Spring controller file
 * 2. Registering Class and Method symbols in the symbol table
 * 3. Extracting Spring routes via @RestController/@GetMapping/etc.
 * 4. Creating Route nodes with correct DEFINES and CALLS edges
 *
 * Bug: WI-1 - Route node creation fails when same-file symbol resolution
 * returns multiple candidates due to path normalization issues.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import fs from 'fs/promises';
import path from 'path';
import { createKnowledgeGraph } from '../../src/core/graph/graph.js';
import { createResolutionContext, type ResolutionContext } from '../../src/core/ingestion/resolution-context.js';
import { extractSpringRoutes } from '../../src/core/ingestion/workers/spring-route-extractor.js';
import { processRoutesFromExtracted } from '../../src/core/ingestion/call-processor.js';
import Parser from 'tree-sitter';
import Java from 'tree-sitter-java';

// Mock worker pool to avoid full pipeline complexity
vi.mock('../../src/core/ingestion/workers/worker-pool.js', () => ({
  createWorkerPool: vi.fn(() => ({
    dispatch: vi.fn(),
    terminate: vi.fn(),
  })),
}));

const JAVA_FIXTURES_DIR = path.join(process.cwd(), 'test', 'fixtures', 'lang-resolution', 'java-rest-api');

function parseJava(source: string): Parser.Tree {
  const parser = new Parser();
  parser.setLanguage(Java);
  return parser.parse(source);
}

describe('java-route-creation integration', () => {
  let graph: ReturnType<typeof createKnowledgeGraph>;
  let ctx: ResolutionContext;

  beforeEach(() => {
    graph = createKnowledgeGraph();
    ctx = createResolutionContext();
  });

  // ============================================================================
  // Test 1: Single controller - Class symbol registered + Route nodes created
  // ============================================================================
  describe('single controller', () => {
    it('creates Route nodes for @RestController with @GetMapping', async () => {
      const source = `
package org.example.web;

import org.springframework.web.bind.annotation.*;

@RestController
@RequestMapping("/auth")
public class AuthController {
    @GetMapping("/login")
    public String login() { return "login"; }

    @GetMapping("/users/me")
    public String me() { return "me"; }
}
`;
      const filePath = 'org/example/web/AuthController.java';
      const tree = parseJava(source);

      // Register Class and Method symbols (simulating parse-worker.ts behavior)
      ctx.symbols.add(filePath, 'AuthController', 'Class:org/example/web/AuthController.java:AuthController', 'Class');
      ctx.symbols.add(filePath, 'login', 'Method:org/example/web/AuthController.java:login', 'Method', {
        ownerId: 'Class:org/example/web/AuthController.java:AuthController',
      });
      ctx.symbols.add(filePath, 'me', 'Method:org/example/web/AuthController.java:me', 'Method', {
        ownerId: 'Class:org/example/web/AuthController.java:AuthController',
      });

      // Extract routes
      const routes = extractSpringRoutes(tree, filePath);
      expect(routes.length).toBe(2);

      // Process routes -> create Route nodes
      await processRoutesFromExtracted(graph, routes, ctx);

      // Verify Route nodes created
      const routeNodes = graph.nodes.filter(n => n.label === 'Route');
      expect(routeNodes.length).toBe(2);

      // Verify DEFINES edges (File -> Route)
      const definesEdges = graph.relationships.filter(r => r.type === 'DEFINES');
      expect(definesEdges.length).toBe(2);

      // Verify CALLS edges (Route -> Method)
      const callsEdges = graph.relationships.filter(r => r.type === 'CALLS');
      expect(callsEdges.length).toBe(2);
    });

    it('creates Route nodes from fixture file AuthController.java', async () => {
      const fixturePath = path.join(JAVA_FIXTURES_DIR, 'controller', 'AuthController.java');
      const source = await fs.readFile(fixturePath, 'utf-8');
      const filePath = 'org/example/web/AuthController.java'; // Matches package in file
      const tree = parseJava(source);

      // Register Class and Method symbols
      ctx.symbols.add(filePath, 'AuthController', 'Class:org/example/web/AuthController.java:AuthController', 'Class');
      ctx.symbols.add(filePath, 'login', 'Method:org/example/web/AuthController.java:login', 'Method', {
        ownerId: 'Class:org/example/web/AuthController.java:AuthController',
      });
      ctx.symbols.add(filePath, 'refresh', 'Method:org/example/web/AuthController.java:refresh', 'Method', {
        ownerId: 'Class:org/example/web/AuthController.java:AuthController',
      });
      ctx.symbols.add(filePath, 'me', 'Method:org/example/web/AuthController.java:me', 'Method', {
        ownerId: 'Class:org/example/web/AuthController.java:AuthController',
      });

      // Extract routes
      const routes = extractSpringRoutes(tree, filePath);
      expect(routes.length).toBe(3); // /auth/login, /auth/refresh, /auth/users/me

      // Process routes
      await processRoutesFromExtracted(graph, routes, ctx);

      // Verify Route nodes
      const routeNodes = graph.nodes.filter(n => n.label === 'Route');
      expect(routeNodes.length).toBe(3);

      // Verify httpMethod values
      const httpMethods = routeNodes.map(n => n.properties.httpMethod).sort();
      expect(httpMethods).toEqual(['GET', 'POST', 'POST']);

      // Verify route paths contain /auth prefix
      const routePaths = routeNodes.map(n => n.properties.routePath);
      expect(routePaths).toContain('/auth/login');
      expect(routePaths).toContain('/auth/refresh');
      expect(routePaths).toContain('/auth/users/me');
    });

    it('uses same-file resolution tier for controller lookup', async () => {
      const source = `
@RestController
public class TestController {
    @GetMapping("/test")
    public String test() { return "test"; }
}
`;
      const filePath = 'TestController.java';
      const tree = parseJava(source);

      // Register symbols
      ctx.symbols.add(filePath, 'TestController', 'Class:TestController.java:TestController', 'Class');
      ctx.symbols.add(filePath, 'test', 'Method:TestController.java:test', 'Method', {
        ownerId: 'Class:TestController.java:TestController',
      });

      // Extract and process routes
      const routes = extractSpringRoutes(tree, filePath);
      await processRoutesFromExtracted(graph, routes, ctx);

      // Verify CALLS edge has high confidence (same-file = 0.95)
      const callsEdges = graph.relationships.filter(r => r.type === 'CALLS');
      expect(callsEdges.length).toBe(1);
      expect(callsEdges[0].confidence).toBe(0.95);
      expect(callsEdges[0].reason).toBe('spring-route');
    });
  });

  // ============================================================================
  // Test 2: Multiple controllers with same class name
  // ============================================================================
  describe('multiple controllers same name', () => {
    it('skips ambiguous global resolution when controller name exists in multiple files', async () => {
      // Register same class name in different files (simulating ambiguity)
      ctx.symbols.add('com/example/web/AuthController.java', 'AuthController',
        'Class:com/example/web/AuthController.java:AuthController', 'Class');
      ctx.symbols.add('com/admin/web/AuthController.java', 'AuthController',
        'Class:com/admin/web/AuthController.java:AuthController', 'Class');

      const source = `
@RestController
public class AuthController {
    @GetMapping("/test")
    public String test() { return "test"; }
}
`;
      const filePath = 'com/example/web/AuthController.java';
      const tree = parseJava(source);

      // Extract and process routes
      const routes = extractSpringRoutes(tree, filePath);
      await processRoutesFromExtracted(graph, routes, ctx);

      // Should NOT create Route node due to ambiguous global resolution
      // (tier === 'global' && candidates.length > 1)
      const routeNodes = graph.nodes.filter(n => n.label === 'Route');
      expect(routeNodes.length).toBe(0);
    });

    it('creates Route node when controller is resolved via same-file tier', async () => {
      // Register ONLY in the same file (same-file resolution succeeds)
      const filePath = 'com/example/web/AuthController.java';
      ctx.symbols.add(filePath, 'AuthController',
        'Class:com/example/web/AuthController.java:AuthController', 'Class');
      ctx.symbols.add(filePath, 'test',
        'Method:com/example/web/AuthController.java:test', 'Method', {
          ownerId: 'Class:com/example/web/AuthController.java:AuthController',
        });

      const source = `
@RestController
public class AuthController {
    @GetMapping("/test")
    public String test() { return "test"; }
}
`;
      const tree = parseJava(source);

      // Extract and process routes
      const routes = extractSpringRoutes(tree, filePath);
      await processRoutesFromExtracted(graph, routes, ctx);

      // Should create Route node because same-file resolution succeeds
      const routeNodes = graph.nodes.filter(n => n.label === 'Route');
      expect(routeNodes.length).toBe(1);
      expect(routeNodes[0].properties.routePath).toBe('/test');
    });
  });

  // ============================================================================
  // Test 3: Inherited method handling
  // ============================================================================
  describe('inherited method', () => {
    it('creates Route node for inherited controller method', async () => {
      const filePath = 'com/example/web/ChildController.java';

      // Child controller
      ctx.symbols.add(filePath, 'ChildController',
        'Class:com/example/web/ChildController.java:ChildController', 'Class');
      // Parent class with actual method
      ctx.symbols.add('com/example/web/BaseController.java', 'BaseController',
        'Class:com/example/web/BaseController.java:BaseController', 'Class');
      ctx.symbols.add('com/example/web/BaseController.java', 'listAll',
        'Method:com/example/web/BaseController.java:listAll', 'Method', {
          ownerId: 'Class:com/example/web/BaseController.java:BaseController',
        });

      // Simulate inherited route extraction
      const routes = [{
        filePath,
        httpMethod: 'GET',
        routePath: '/items',
        controllerName: 'ChildController',
        methodName: 'listAll', // Inherited from BaseController
        middleware: [],
        prefix: null,
        lineNumber: 10,
        isControllerClass: true,
        isInherited: true,
      }];

      await processRoutesFromExtracted(graph, routes, ctx);

      // Route should be created with isInherited: true
      const routeNodes = graph.nodes.filter(n => n.label === 'Route');
      expect(routeNodes.length).toBe(1);
      expect(routeNodes[0].properties.isInherited).toBe(true);
    });
  });

  // ============================================================================
  // Test 4: Path normalization edge cases
  // ============================================================================
  describe('path normalization', () => {
    it('handles file paths with different separators', async () => {
      const source = `
@RestController
public class TestController {
    @GetMapping("/test")
    public String test() { return "test"; }
}
`;

      // Simulate path stored with backslash (Windows) but resolved with forward slash
      const windowsPath = 'src\\controllers\\TestController.java';
      const normalizedPath = 'src/controllers/TestController.java';

      const tree = parseJava(source);

      // Register with normalized path
      ctx.symbols.add(normalizedPath, 'TestController',
        `Class:${normalizedPath}:TestController`, 'Class');
      ctx.symbols.add(normalizedPath, 'test',
        `Method:${normalizedPath}:test`, 'Method', {
          ownerId: `Class:${normalizedPath}:TestController`,
        });

      // Extract routes with different path
      const routes = extractSpringRoutes(tree, normalizedPath);
      await processRoutesFromExtracted(graph, routes, ctx);

      // Route should be created when paths match
      const routeNodes = graph.nodes.filter(n => n.label === 'Route');
      expect(routeNodes.length).toBe(1);
    });
  });

  // ============================================================================
  // Test 5: WI-90 inherited class-level @RequestMapping prefix
  // ============================================================================
  describe('WI-90 inherited class-level prefix', () => {
    it('inherits superclass @RequestMapping prefix for @RestController subclass', async () => {
      // Base class is plain @Controller with @RequestMapping("/api")
      // Subclass is @RestController with no class-level mapping, plus a @GetMapping.
      // Expected: route is created with path "/api/users".
      const source = `
package org.example.web;

import org.springframework.web.bind.annotation.*;

@Controller
@RequestMapping("/api")
public class BaseApiController { }

@RestController
public class UserController extends BaseApiController {
    @GetMapping("/users")
    public List<String> list() { return java.util.Collections.emptyList(); }
}
`;
      const filePath = 'org/example/web/UserController.java';
      const tree = parseJava(source);

      // Register the subclass only (the base class is not a real controller
      // from the routing perspective; routes belong to the concrete subclass).
      ctx.symbols.add(filePath, 'UserController',
        'Class:org/example/web/UserController.java:UserController', 'Class');
      ctx.symbols.add(filePath, 'list',
        'Method:org/example/web/UserController.java:list', 'Method', {
          ownerId: 'Class:org/example/web/UserController.java:UserController',
        });

      const routes = extractSpringRoutes(tree, filePath);
      await processRoutesFromExtracted(graph, routes, ctx);

      const routeNodes = graph.nodes.filter(n => n.label === 'Route');
      expect(routeNodes.length).toBe(1);
      expect(routeNodes[0].properties.routePath).toBe('/api/users');
      // The inherited flag should be set because the prefix came from a superclass
      expect(routeNodes[0].properties.isInherited).toBe(true);
    });

    it('inherits superclass prefix from a plain @Controller base class', async () => {
      const source = `
package org.example.web;

import org.springframework.web.bind.annotation.*;

@Controller
@RequestMapping("/v1")
public class BaseController { }

@RestController
public class OrderController extends BaseController {
    @PostMapping("/orders")
    public String create() { return "ok"; }
}
`;
      const filePath = 'org/example/web/OrderController.java';
      const tree = parseJava(source);

      ctx.symbols.add(filePath, 'OrderController',
        'Class:org/example/web/OrderController.java:OrderController', 'Class');
      ctx.symbols.add(filePath, 'create',
        'Method:org/example/web/OrderController.java:create', 'Method', {
          ownerId: 'Class:org/example/web/OrderController.java:OrderController',
        });

      const routes = extractSpringRoutes(tree, filePath);
      await processRoutesFromExtracted(graph, routes, ctx);

      const routeNodes = graph.nodes.filter(n => n.label === 'Route');
      expect(routeNodes.length).toBe(1);
      expect(routeNodes[0].properties.routePath).toBe('/v1/orders');
      expect(routeNodes[0].properties.isInherited).toBe(true);
    });
  });
});
