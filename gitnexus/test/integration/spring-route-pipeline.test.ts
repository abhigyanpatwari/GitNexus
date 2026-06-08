/**
 * End-to-end coverage of Spring @RequestMapping / @GetMapping route ingestion.
 *
 * This test verifies that the ingestion pipeline correctly:
 * 1. Extracts method-level route annotations (@GetMapping, @PostMapping, etc.)
 * 2. Joins class-level @RequestMapping prefix with method-level paths
 * 3. Handles both positional and named annotation arguments (path = "...", value = "...")
 * 4. Generates correct Route nodes without a class prefix when none exists
 *
 * The fixture lives at `test/fixtures/spring-route-app/`.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import path from 'node:path';
import { runPipelineFromRepo } from '../../src/core/ingestion/pipeline.js';
import type { PipelineResult } from '../../types/pipeline.js';

const FIXTURE = path.resolve(__dirname, '..', 'fixtures', 'spring-route-app');

describe('Spring @RequestMapping route ingestion pipeline', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(FIXTURE, () => {}, {});
  }, 60_000);

  function routeNames(): string[] {
    const out: string[] = [];
    result.graph.forEachNode((n) => {
      if (n.label === 'Route') out.push(String(n.properties.name));
    });
    return out.sort();
  }

  it('joins class-level @RequestMapping prefix with method-level @GetMapping/@PostMapping', () => {
    const names = routeNames();
    // UserController: @RequestMapping("/api/users") + @GetMapping("/list")
    expect(names).toContain('/api/users/list');
    // UserController: @RequestMapping("/api/users") + @PostMapping("/create")
    expect(names).toContain('/api/users/create');
  });

  it('handles named annotation arguments (path = "..." and value = "...")', () => {
    const names = routeNames();
    // UserController: @DeleteMapping(path = "/delete")
    expect(names).toContain('/api/users/delete');
    // UserController: @PutMapping(value = "/update")
    expect(names).toContain('/api/users/update');
  });

  it('joins prefix for OrderController routes', () => {
    const names = routeNames();
    // OrderController: @RequestMapping("/api/orders") + @GetMapping("/list")
    expect(names).toContain('/api/orders/list');
    // OrderController: @RequestMapping("/api/orders") + @PostMapping("/submit")
    expect(names).toContain('/api/orders/submit');
  });

  it('emits bare paths when no class-level @RequestMapping exists', () => {
    const names = routeNames();
    // HealthController: no class prefix, @GetMapping("/health") and @GetMapping("/ready")
    expect(names).toContain('/health');
    expect(names).toContain('/ready');
  });

  it('does NOT emit class-level @RequestMapping as a standalone Route', () => {
    const names = routeNames();
    // The prefix "/api/users" alone must not become a Route node
    expect(names).not.toContain('/api/users');
    expect(names).not.toContain('/api/orders');
  });

  it('handles multiple classes in one file with independent prefixes', () => {
    const names = routeNames();
    // MultiController.java: AdminController @RequestMapping("/api/admin") + @GetMapping("/dashboard")
    expect(names).toContain('/api/admin/dashboard');
    // MultiController.java: PublicController @RequestMapping("/api/public") + @GetMapping("/info")
    expect(names).toContain('/api/public/info');
    // Prefixes should not bleed between classes
    expect(names).not.toContain('/api/public/dashboard');
    expect(names).not.toContain('/api/admin/info');
  });

  it('supports @PatchMapping', () => {
    const names = routeNames();
    // MultiController.java: AdminController @PatchMapping("/settings")
    expect(names).toContain('/api/admin/settings');
  });

  it('emits HANDLES_ROUTE edges linking Route nodes to their handler files', () => {
    const handlesRouteEdges: Array<{ routeName: string; filePath: string }> = [];
    result.graph.forEachRelationship((r) => {
      if (r.type !== 'HANDLES_ROUTE') return;
      const targetNode = result.graph.getNode(r.targetId);
      const sourceNode = result.graph.getNode(r.sourceId);
      if (targetNode?.label === 'Route' && sourceNode?.label === 'File') {
        handlesRouteEdges.push({
          routeName: String(targetNode.properties.name),
          filePath: String(sourceNode.properties.name),
        });
      }
    });
    // At least one route should be linked to the UserController file
    const userRoutes = handlesRouteEdges.filter((e) => e.filePath.includes('UserController.java'));
    expect(userRoutes.length).toBeGreaterThanOrEqual(1);
  });
});
