/**
 * Unit Tests: Route Node Schema Coverage
 *
 * BDD Feature: Route node persistence in LadybugDB
 *   As a code intelligence system
 *   I want Route nodes to be storable in LadybugDB
 *   So that Spring HTTP endpoints can be queried from the graph
 *
 * These tests are INTENTIONALLY FAILING until the following work items are done:
 *   WI-1: Add ROUTE_SCHEMA DDL to schema.ts
 *   WI-2: Add 'Route' to NODE_TABLES and NODE_SCHEMA_QUERIES in schema.ts
 *   WI-3: Add Route relation pairs to RELATION_SCHEMA in schema.ts
 *   WI-4: Add Route CSV writer to csv-generator.ts (streamAllCSVsToDisk)
 *
 * Required Route schema columns:
 *   id, name, httpMethod, routePath, controllerName, methodName,
 *   filePath, startLine, lineNumber, isInherited
 */

import { describe, it, expect } from 'vitest';
import {
  NODE_TABLES,
  NODE_SCHEMA_QUERIES,
  RELATION_SCHEMA,
} from '../../src/core/lbug/schema.js';

// ============================================================================
// Part 1: BDD Scenarios (Specification)
// ============================================================================
//
// Scenario: NODE_TABLES registry includes Route
//   Given the LadybugDB schema module is loaded
//   When NODE_TABLES is inspected
//   Then it contains the string 'Route'
//
// Scenario: NODE_SCHEMA_QUERIES includes Route DDL
//   Given the LadybugDB schema module is loaded
//   When NODE_SCHEMA_QUERIES is inspected
//   Then at least one entry contains 'CREATE NODE TABLE Route'
//
// Scenario: ROUTE_SCHEMA DDL has correct columns
//   Given the ROUTE_SCHEMA DDL string exists as a named export
//   When its text is inspected
//   Then it declares all required columns
//   And it declares a PRIMARY KEY on id
//
// Scenario: RELATION_SCHEMA supports File -> Route edges
//   Given the RELATION_SCHEMA DDL is loaded
//   When it is inspected for Route edge declarations
//   Then it contains 'FROM File TO Route'
//
// Scenario: RELATION_SCHEMA supports Route -> Method edges
//   Given the RELATION_SCHEMA DDL is loaded
//   When it is inspected for Route edge declarations
//   Then it contains 'FROM Route TO Method'
//
// Scenario Outline: Route CSV writer produces correct column header
//   Given a KnowledgeGraph containing a Route node
//   When streamAllCSVsToDisk processes the graph
//   Then a route.csv file is written
//   And its header row is:
//     id,name,httpMethod,routePath,controllerName,methodName,filePath,startLine,lineNumber,isInherited,repoId,responseKeys,errorKeys,middleware
//
// Scenario: Route node does not fall through to default/skip case
//   Given a KnowledgeGraph containing a Route node with all required properties
//   When streamAllCSVsToDisk processes the graph
//   Then nodeFiles in the result contains a 'Route' entry
//   And the Route entry has rows > 0

// ============================================================================
// Part 2: schema.ts — NODE_TABLES registry (WI-2)
// ============================================================================

describe('NODE_TABLES', () => {
  it("includes 'Route'", () => {
    // FAILS until WI-2: 'Route' is not in the current NODE_TABLES array
    expect(NODE_TABLES).toContain('Route');
  });
});

// ============================================================================
// Part 3: schema.ts — NODE_SCHEMA_QUERIES (WI-1 + WI-2)
// ============================================================================

describe('NODE_SCHEMA_QUERIES', () => {
  it('contains a DDL entry that creates the Route node table', () => {
    // FAILS until WI-1 (ROUTE_SCHEMA) and WI-2 (pushed into NODE_SCHEMA_QUERIES)
    const hasRouteTable = NODE_SCHEMA_QUERIES.some(q =>
      q.includes('CREATE NODE TABLE Route')
    );
    expect(hasRouteTable).toBe(true);
  });

  it('Route DDL declares all required columns', () => {
    // FAILS until WI-1: ROUTE_SCHEMA with all columns exists
    const routeDDL = NODE_SCHEMA_QUERIES.find(q =>
      q.includes('CREATE NODE TABLE Route')
    );
    // Guard: the table must exist before we can check columns
    expect(routeDDL, 'Route DDL not found in NODE_SCHEMA_QUERIES').toBeDefined();

    const required = [
      'id',
      'name',
      'httpMethod',
      'routePath',
      'controllerName',
      'methodName',
      'filePath',
      'startLine',
      'lineNumber',
      'isInherited',
    ];
    for (const col of required) {
      expect(routeDDL, `column '${col}' missing from Route DDL`).toContain(col);
    }
  });

  it('Route DDL declares PRIMARY KEY (id)', () => {
    // FAILS until WI-1
    const routeDDL = NODE_SCHEMA_QUERIES.find(q =>
      q.includes('CREATE NODE TABLE Route')
    );
    expect(routeDDL, 'Route DDL not found in NODE_SCHEMA_QUERIES').toBeDefined();
    expect(routeDDL).toMatch(/PRIMARY KEY\s*\(\s*id\s*\)/);
  });
});

// ============================================================================
// Part 4: schema.ts — RELATION_SCHEMA edge declarations (WI-3)
// ============================================================================

describe('RELATION_SCHEMA', () => {
  it("contains 'FROM File TO Route'", () => {
    // FAILS until WI-3: RELATION_SCHEMA does not yet declare File->Route edges
    expect(RELATION_SCHEMA).toContain('FROM File TO Route');
  });

  it("contains 'FROM Route TO Method'", () => {
    // FAILS until WI-3: RELATION_SCHEMA does not yet declare Route->Method edges
    expect(RELATION_SCHEMA).toContain('FROM Route TO Method');
  });
});

// ============================================================================
// Part 5: csv-generator.ts — Route node is handled (WI-4)
//
// Strategy: we test the observable output of streamAllCSVsToDisk with a
// minimal in-memory graph that contains exactly one Route node. If Route is
// not handled, nodeFiles will not contain a 'Route' entry and rows will be 0.
//
// We use dynamic import so the test file can still be parsed and the earlier
// schema-only tests can run even before csv-generator compiles cleanly.
// ============================================================================

describe('streamAllCSVsToDisk — Route node handling', () => {
  it('produces a route.csv with the correct column header for a Route node', async () => {
    // FAILS until WI-4: Route has no CSV writer branch so nodeFiles won't include 'Route'

    // Minimal stub that satisfies the KnowledgeGraph interface used by
    // streamAllCSVsToDisk (iterNodes / iterRelationships).
    const routeNode = {
      id: 'route-1',
      label: 'Route',
      properties: {
        name: 'GET /users',
        httpMethod: 'GET',
        routePath: '/users',
        controllerName: 'UserController',
        methodName: 'getUsers',
        filePath: 'src/UserController.java',
        startLine: 10,
        lineNumber: 12,
        isInherited: false,
      },
    };

    const fakeGraph = {
      *iterNodes() { yield routeNode; },
      *iterRelationships() { /* no edges needed for this test */ },
    };

    // Dynamic import so schema-only tests above still run independently
    const { streamAllCSVsToDisk } = await import(
      '../../src/core/lbug/csv-generator.js'
    );

    const os = await import('node:os');
    const path = await import('node:path');
    const fs = await import('node:fs/promises');

    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'route-schema-test-'));
    try {
      const result = await streamAllCSVsToDisk(fakeGraph as any, '/', tmpDir);

      // The result's nodeFiles map must contain an entry for 'Route'
      expect(
        result.nodeFiles.has('Route'),
        "nodeFiles does not contain 'Route' — Route CSV writer is not implemented"
      ).toBe(true);

      const routeEntry = result.nodeFiles.get('Route');
      expect(routeEntry?.rows, 'Route CSV has 0 rows').toBeGreaterThan(0);

      // Verify the header row of route.csv matches the expected schema columns
      const csvContent = await fs.readFile(routeEntry!.csvPath, 'utf-8');
      const headerRow = csvContent.split('\n')[0];
      // #67: header now includes controllerClass/handlerMethod/isControllerClass/prefix
      expect(headerRow).toBe(
        'id,name,httpMethod,routePath,controllerName,methodName,filePath,startLine,lineNumber,isInherited,repoId,responseKeys,errorKeys,middleware,controllerClass,handlerMethod,isControllerClass,prefix'
      );
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it('Route node does not silently fall through to the multi-language default branch', async () => {
    // FAILS until WI-4: without a Route branch, the node is silently skipped
    // (multiLangWriters has no 'Route' key, so mlWriter is undefined → no write)

    const routeNode = {
      id: 'route-silent-2',
      label: 'Route',
      properties: {
        name: 'POST /orders',
        httpMethod: 'POST',
        routePath: '/orders',
        controllerName: 'OrderController',
        methodName: 'createOrder',
        filePath: 'src/OrderController.java',
        startLine: 20,
        lineNumber: 22,
        isInherited: false,
      },
    };

    const fakeGraph = {
      *iterNodes() { yield routeNode; },
      *iterRelationships() {},
    };

    const { streamAllCSVsToDisk } = await import(
      '../../src/core/lbug/csv-generator.js'
    );

    const os = await import('node:os');
    const path = await import('node:path');
    const fs = await import('node:fs/promises');

    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'route-schema-test-silent-'));
    try {
      const result = await streamAllCSVsToDisk(fakeGraph as any, '/', tmpDir);

      // If Route silently falls through, rows would be 0 and 'Route' absent from nodeFiles
      expect(
        result.nodeFiles.has('Route'),
        'Route node was silently skipped — it fell through to an unhandled default branch'
      ).toBe(true);
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });
});
