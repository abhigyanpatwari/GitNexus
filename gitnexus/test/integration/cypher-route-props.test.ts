/**
 * Integration Test: Issue #67 — Route node properties accessible via Cypher
 *
 * Regression test for #67: Route nodes must expose the full ExtractedRoute
 * field set as node properties so agents can query them via Cypher.
 *
 * The fix in `processRoutesFromExtracted` adds these properties to every
 * Route node:
 *   - httpMethod
 *   - routePath
 *   - controllerClass (alias of controllerName)
 *   - handlerMethod (alias of methodName)
 *   - filePath
 *   - lineNumber
 *   - startLine
 *   - isInherited
 *   - isControllerClass
 *   - prefix
 *
 * Legacy `controllerName` / `methodName` aliases are preserved for
 * backwards compatibility with existing queries (route-node-e2e.test.ts).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { createKnowledgeGraph } from '../../src/core/graph/graph.js';
import { createResolutionContext, type ResolutionContext } from '../../src/core/ingestion/resolution-context.js';
import { processRoutesFromExtracted } from '../../src/core/ingestion/call-processor.js';

describe('cypher-route-props (#67)', () => {
  let graph: ReturnType<typeof createKnowledgeGraph>;
  let ctx: ResolutionContext;

  beforeEach(() => {
    graph = createKnowledgeGraph();
    ctx = createResolutionContext();
  });

  function registerController(opts: {
    filePath: string;
    className: string;
    methods: { name: string }[];
  }): void {
    const classId = `Class:${opts.filePath}:${opts.className}`;
    ctx.symbols.add(opts.filePath, opts.className, classId, 'Class');
    for (const m of opts.methods) {
      ctx.symbols.add(
        opts.filePath,
        m.name,
        `Method:${opts.filePath}:${m.name}`,
        'Method',
        { ownerId: classId },
      );
    }
  }

  it('exposes httpMethod, routePath, controllerClass, handlerMethod on a Route node', async () => {
    const filePath = 'com/example/web/UserController.java';
    registerController({
      filePath,
      className: 'UserController',
      methods: [{ name: 'getUser' }, { name: 'createUser' }],
    });

    const routes = [
      {
        filePath,
        httpMethod: 'GET',
        routePath: '/users/{id}',
        controllerName: 'UserController',
        methodName: 'getUser',
        middleware: [],
        prefix: '/api/v1',
        lineNumber: 12,
        isControllerClass: true,
        isInherited: false,
      },
      {
        filePath,
        httpMethod: 'POST',
        routePath: '/users',
        controllerName: 'UserController',
        methodName: 'createUser',
        middleware: [],
        prefix: '/api/v1',
        lineNumber: 18,
        isControllerClass: true,
        isInherited: false,
      },
    ];

    await processRoutesFromExtracted(graph, routes, ctx);

    const routeNodes = graph.nodes.filter(n => n.label === 'Route');
    expect(routeNodes.length).toBe(2);

    // The exact issue-spec property set must be queryable.
    for (const node of routeNodes) {
      expect(node.properties.httpMethod).toMatch(/^(GET|POST)$/);
      expect(node.properties.routePath).toBeTruthy();
      expect(node.properties.controllerClass).toBe('UserController');
      expect(node.properties.handlerMethod).toMatch(/^(getUser|createUser)$/);
      expect(node.properties.filePath).toBe(filePath);
      expect(node.properties.lineNumber).toBeGreaterThan(0);
      expect(node.properties.isInherited).toBe(false);
      expect(node.properties.isControllerClass).toBe(true);
      // prefix is part of the ExtractedRoute field set
      expect(node.properties.prefix).toBe('/api/v1');
    }

    // Legacy aliases are preserved.
    const sample = routeNodes[0];
    expect(sample.properties.controllerName).toBe(sample.properties.controllerClass);
    expect(sample.properties.methodName).toBe(sample.properties.handlerMethod);
  });

  it('exposes all properties on an inherited Route', async () => {
    const childFile = 'com/example/web/ChildController.java';
    const parentFile = 'com/example/web/BaseController.java';

    ctx.symbols.add(childFile, 'ChildController',
      `Class:${childFile}:ChildController`, 'Class');
    ctx.symbols.add(parentFile, 'BaseController',
      `Class:${parentFile}:BaseController`, 'Class');
    ctx.symbols.add(parentFile, 'listAll',
      `Method:${parentFile}:listAll`, 'Method', {
        ownerId: `Class:${parentFile}:BaseController`,
      });

    const routes = [{
      filePath: childFile,
      httpMethod: 'GET',
      routePath: '/items',
      controllerName: 'ChildController',
      methodName: 'listAll',
      middleware: [],
      prefix: null,
      lineNumber: 9,
      isControllerClass: true,
      isInherited: true,
    }];

    await processRoutesFromExtracted(graph, routes, ctx);

    const routeNodes = graph.nodes.filter(n => n.label === 'Route');
    expect(routeNodes.length).toBe(1);
    const props = routeNodes[0].properties;

    // Full Cypher-queryable surface (#67).
    expect(props.httpMethod).toBe('GET');
    expect(props.routePath).toBe('/items');
    expect(props.controllerClass).toBe('ChildController');
    expect(props.handlerMethod).toBe('listAll');
    expect(props.filePath).toBe(childFile);
    expect(props.startLine).toBe(9);
    expect(props.lineNumber).toBe(9);
    expect(props.isInherited).toBe(true);
    expect(props.isControllerClass).toBe(true);
  });

  it('Route node properties are queryable via Cypher-like filtering (simulated)', async () => {
    // Simulates the issue's failing query:
    //   MATCH (r:Route) RETURN r.method, r.path, r.controllerClass, r.handlerMethod
    // After the fix, the spec-named properties are present.
    const filePath = 'AuthController.java';
    registerController({
      filePath,
      className: 'AuthController',
      methods: [{ name: 'login' }],
    });
    await processRoutesFromExtracted(graph, routes_fixture(filePath), ctx);

    const matched = graph.nodes.filter(
      n => n.label === 'Route' &&
           n.properties.httpMethod === 'GET' &&
           n.properties.controllerClass === 'AuthController',
    );
    expect(matched.length).toBeGreaterThan(0);

    for (const r of matched) {
      // These are exactly the property names the agent should be able to query.
      expect(r.properties.httpMethod).toBe('GET');
      expect(r.properties.routePath).toBeTruthy();
      expect(r.properties.controllerClass).toBe('AuthController');
      expect(r.properties.handlerMethod).toBeTruthy();
      expect(r.properties.filePath).toBeTruthy();
    }
  });

  it('Route schema has the new columns (#67 — DB persistence)', async () => {
    // The Route table in lbug must have the new columns so the
    // properties survive a re-index and are queryable via Cypher.
    const { ROUTE_SCHEMA, ROUTE_SCHEMA_MIGRATION } = await import(
      '../../src/core/lbug/schema.js'
    );
    for (const col of [
      'controllerClass',
      'handlerMethod',
      'isControllerClass',
      'prefix',
    ]) {
      expect(ROUTE_SCHEMA).toContain(col);
      expect(ROUTE_SCHEMA_MIGRATION).toContain(col);
    }
  });
});

function routes_fixture(filePath: string) {
  return [{
    filePath,
    httpMethod: 'GET',
    routePath: '/auth/login',
    controllerName: 'AuthController',
    methodName: 'login',
    middleware: [],
    prefix: null,
    lineNumber: 5,
    isControllerClass: true,
    isInherited: false,
  }];
}
