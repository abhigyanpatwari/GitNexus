/**
 * End-to-end pipeline coverage for ingestion-side Spring interface-inheritance
 * route resolution (#2288). A concrete `@RestController` that implements an
 * interface declaring `@*Mapping`s must produce `Route` nodes for the inherited
 * paths, attributed to the controller — and the interface itself must NOT yield
 * a standalone (unprefixed, wrong-owner) Route node.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runPipelineFromRepo } from '../../src/core/ingestion/pipeline.js';
import type { PipelineResult } from '../../types/pipeline.js';

const ORDER_API = `package com.example;
import org.springframework.web.bind.annotation.*;

@RequestMapping("/orders")
public interface OrderApi {
  @GetMapping("/list") Object list();
  @PostMapping("/create") Object create();
}
`;

const ORDER_CONTROLLER = `package com.example;
import org.springframework.web.bind.annotation.*;

@RestController
public class OrderController implements OrderApi {
  public Object list() { return null; }
  public Object create() { return null; }
}
`;

describe('Spring interface-inheritance route ingestion pipeline (#2288)', () => {
  let dir: string;
  let result: PipelineResult;

  beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gn-spring-inherit-'));
    fs.writeFileSync(path.join(dir, 'OrderApi.java'), ORDER_API);
    fs.writeFileSync(path.join(dir, 'OrderController.java'), ORDER_CONTROLLER);
    result = await runPipelineFromRepo(dir, () => {}, {});
  }, 60_000);

  afterAll(() => {
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  });

  function routeNames(): string[] {
    const out: string[] = [];
    result.graph.forEachNode((n) => {
      if (n.label === 'Route') out.push(String(n.properties.name));
    });
    return out.sort();
  }

  it('emits exactly the two inherited Route nodes, with the interface prefix joined', () => {
    // Full set-equality (not toContain) so a spurious extra Route node — e.g. a
    // leaked unprefixed interface route — would fail this assertion.
    expect(new Set(routeNames())).toEqual(new Set(['/orders/create', '/orders/list']));
  });

  it('attributes the inherited Route handler to the controller method', () => {
    let handlerNode: { properties: Record<string, unknown> } | undefined;
    result.graph.forEachNode((n) => {
      if (n.label === 'Route' && n.properties.name === '/orders/list') {
        const hid = n.properties.handlerSymbolId;
        if (hid) handlerNode = result.graph.getNode(String(hid)) ?? undefined;
      }
    });
    expect(handlerNode, 'inherited Route should resolve a handler symbol').toBeTruthy();
    expect(handlerNode!.properties.name).toBe('list');
    expect(String(handlerNode!.properties.filePath)).toContain('OrderController.java');
  });

  it('does NOT emit a standalone unprefixed Route for the interface method', () => {
    const names = routeNames();
    // The interface route must be attributed to the controller WITH the prefix,
    // never leaked as a bare `/list` / `/create` (the pre-#2288 wrong behaviour).
    expect(names).not.toContain('/list');
    expect(names).not.toContain('/create');
  });
});
