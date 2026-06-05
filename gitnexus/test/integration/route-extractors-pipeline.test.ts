/**
 * End-to-end pipeline coverage for the FastAPI (#79, #5) and Gin (#80, #6)
 * route extractors.
 *
 * Regression guard: the extractors were originally wired ONLY into the
 * worker-pool path (parse-worker.ts), which activates only for very large
 * repos (>=1M files / >=1GB). Normal repos run processParsingSequential
 * (parsing-processor.ts), which had no Python/Go route dispatch — so the
 * `endpoints` tool / `MATCH (r:Route)` returned nothing for FastAPI / Gin
 * apps despite the extractors passing their unit tests in isolation.
 *
 * These tests run the REAL sequential pipeline against the fixtures and assert
 * Route nodes are created end-to-end (i.e. they survive processRoutesFromExtracted).
 */
import { describe, it, expect, beforeAll } from 'vitest';
import path from 'path';
import {
  FIXTURES, getNodesByLabelFull, getRelationships, runPipelineFromRepo, type PipelineResult,
} from './resolvers/helpers.js';

// FIXTURES points at .../fixtures/lang-resolution; the route fixtures sit one level up.
const ROUTES_ROOT = path.join(FIXTURES, '..');

describe('FastAPI route extraction via full pipeline (#79, #5)', () => {
  let result: PipelineResult;
  beforeAll(async () => {
    result = await runPipelineFromRepo(path.join(ROUTES_ROOT, 'fastapi-basic'), () => {});
  }, 60000);

  it('creates Route nodes for FastAPI decorators (end-to-end, not just the extractor)', () => {
    const routes = getNodesByLabelFull(result, 'Route');
    expect(routes.length).toBeGreaterThan(0);
  });

  it('captures the standard HTTP verbs', () => {
    const methods = new Set(getNodesByLabelFull(result, 'Route').map(r => r.properties.httpMethod));
    expect(methods.has('GET')).toBe(true);
    expect(methods.has('POST')).toBe(true);
    expect(methods.has('PUT')).toBe(true);
    expect(methods.has('DELETE')).toBe(true);
    expect(methods.has('PATCH')).toBe(true);
  });

  it('captures route paths from both app.<verb> and router.<verb>', () => {
    const paths = getNodesByLabelFull(result, 'Route').map(r => r.properties.routePath);
    expect(paths).toContain('/users');
    expect(paths.some(p => typeof p === 'string' && p.includes('/users/'))).toBe(true);
  });
});

describe('Gin route extraction via full pipeline (#80, #6)', () => {
  let result: PipelineResult;
  beforeAll(async () => {
    result = await runPipelineFromRepo(path.join(ROUTES_ROOT, 'gin-basic'), () => {});
  }, 60000);

  it('creates one Route node per Gin registration (r.GET/POST/PUT, router.DELETE, engine.PATCH)', () => {
    const routes = getNodesByLabelFull(result, 'Route');
    expect(routes.length).toBe(5);
  });

  it('captures GET/POST/PUT/DELETE/PATCH across receivers (r, router, engine)', () => {
    const methods = new Set(getNodesByLabelFull(result, 'Route').map(r => r.properties.httpMethod));
    for (const m of ['GET', 'POST', 'PUT', 'DELETE', 'PATCH']) {
      expect(methods.has(m)).toBe(true);
    }
  });

  it('captures the /users route paths', () => {
    const paths = getNodesByLabelFull(result, 'Route').map(r => r.properties.routePath);
    expect(paths).toContain('/users');
    expect(paths.some(p => typeof p === 'string' && p.includes('/users/'))).toBe(true);
  });
});

describe('Angular client-side route extraction via full pipeline (#7, #43)', () => {
  let result: PipelineResult;
  beforeAll(async () => {
    result = await runPipelineFromRepo(path.join(FIXTURES, 'angular-basic'), () => {});
  }, 60000);

  it('creates Route nodes for Angular routes (end-to-end, not just the extractor)', () => {
    const routes = getNodesByLabelFull(result, 'Route');
    expect(routes.length).toBeGreaterThan(0);
  });

  it('marks every Angular client-side route as GET', () => {
    const routes = getNodesByLabelFull(result, 'Route');
    expect(routes.every(r => r.properties.httpMethod === 'GET')).toBe(true);
  });

  it('captures the users + nested :id route paths', () => {
    const paths = getNodesByLabelFull(result, 'Route').map(r => String(r.properties.routePath));
    expect(paths.some(p => p.includes('users'))).toBe(true);
    expect(paths.some(p => p.includes(':id'))).toBe(true);
  });

  it('creates an Angular CALLS edge from @NgModule to its DI provider (#31)', () => {
    // app.module.ts: @NgModule({ providers: [UserService] }) → CALLS AppModule → UserService.
    // extractAngularCalls is now wired into the active sequential pipeline path.
    const calls = getRelationships(result, 'CALLS');
    expect(calls.some(e => e.source === 'AppModule' && e.target === 'UserService')).toBe(true);
  });
});
