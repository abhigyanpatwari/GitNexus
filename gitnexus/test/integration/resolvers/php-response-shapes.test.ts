/**
 * Integration test for PHP response shape extraction.
 *
 * Runs the full pipeline on a PHP fixture with json_encode() calls
 * and verifies that Route nodes have correct responseKeys/errorKeys.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import path from 'path';
import {
  FIXTURES, getNodesByLabel, getNodesByLabelFull, getRelationships,
  runPipelineFromRepo, type PipelineResult,
} from './helpers.js';

describe('PHP response shape extraction (pipeline)', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(
      path.join(FIXTURES, 'php-response-shapes'),
      () => {},
    );
  }, 60000);

  it('creates Route nodes for PHP endpoints', () => {
    const routes = getNodesByLabel(result, 'Route');
    expect(routes).toContain('/api/items');
    expect(routes).toContain('/api/submit');
  });

  it('extracts responseKeys from json_encode success path (items.php)', () => {
    const routes = getNodesByLabelFull(result, 'Route');
    const items = routes.find(r => r.name === '/api/items');
    expect(items).toBeDefined();
    expect(items!.properties.responseKeys).toEqual(
      expect.arrayContaining(['data', 'total']),
    );
  });

  it('extracts errorKeys from json_encode with http_response_code >= 400 (items.php)', () => {
    const routes = getNodesByLabelFull(result, 'Route');
    const items = routes.find(r => r.name === '/api/items');
    expect(items).toBeDefined();
    expect(items!.properties.errorKeys).toEqual(
      expect.arrayContaining(['error']),
    );
  });

  it('keeps success and error keys separate (no cross-contamination)', () => {
    const routes = getNodesByLabelFull(result, 'Route');
    const items = routes.find(r => r.name === '/api/items');
    expect(items).toBeDefined();
    const successKeys = new Set(items!.properties.responseKeys ?? []);
    const errorKeys = new Set(items!.properties.errorKeys ?? []);
    expect(successKeys.has('error')).toBe(false);
    expect(errorKeys.has('data')).toBe(false);
    expect(errorKeys.has('total')).toBe(false);
  });

  it('extracts responseKeys from submit.php success path', () => {
    const routes = getNodesByLabelFull(result, 'Route');
    const submit = routes.find(r => r.name === '/api/submit');
    expect(submit).toBeDefined();
    expect(submit!.properties.responseKeys).toEqual(
      expect.arrayContaining(['ok', 'id', 'created_at']),
    );
  });

  it('extracts errorKeys from submit.php error paths', () => {
    const routes = getNodesByLabelFull(result, 'Route');
    const submit = routes.find(r => r.name === '/api/submit');
    expect(submit).toBeDefined();
    expect(submit!.properties.errorKeys).toEqual(
      expect.arrayContaining(['error']),
    );
  });

  it('respects exit(N) and die() as boundaries in submit.php', () => {
    const routes = getNodesByLabelFull(result, 'Route');
    const submit = routes.find(r => r.name === '/api/submit');
    expect(submit).toBeDefined();
    const successKeys = new Set(submit!.properties.responseKeys ?? []);
    expect(successKeys.has('ok')).toBe(true);
    expect(successKeys.has('id')).toBe(true);
    expect(successKeys.has('error')).toBe(false);
  });

  it('creates HANDLES_ROUTE edges from PHP files to Route nodes', () => {
    const edges = getRelationships(result, 'HANDLES_ROUTE');
    const itemsHandler = edges.find(e => e.target === '/api/items');
    expect(itemsHandler).toBeDefined();
    expect(itemsHandler!.sourceFilePath).toContain('api/items.php');
    const submitHandler = edges.find(e => e.target === '/api/submit');
    expect(submitHandler).toBeDefined();
    expect(submitHandler!.sourceFilePath).toContain('api/submit.php');
  });
});
