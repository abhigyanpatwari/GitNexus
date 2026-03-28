import { describe, it, expect, beforeAll } from 'vitest';
import path from 'path';
import { runPipelineFromRepo } from '../../src/core/ingestion/pipeline.js';
import type { PipelineResult } from '../../types/pipeline.js';

const EXPO_APP = path.resolve(__dirname, '..', 'fixtures', 'expo-app');

describe('Expo Router route detection', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(EXPO_APP, () => {});
  }, 60000);

  it('detects Route nodes for screen files', () => {
    const routes: string[] = [];
    result.graph.forEachNode((n) => {
      if (n.label === 'Route') routes.push(n.properties.name);
    });
    expect(routes).toContain('/');
    expect(routes).toContain('/login');
    expect(routes).toContain('/settings');
    expect(routes).toContain('/profile');
    expect(routes).toContain('/user/[id]');
  });

  it('skips _layout files', () => {
    const routes: string[] = [];
    result.graph.forEachNode((n) => {
      if (n.label === 'Route') routes.push(n.properties.name);
    });
    expect(routes).not.toContain('/_layout');
  });

  it('creates HANDLES_ROUTE edges', () => {
    let count = 0;
    result.graph.forEachRelationship((r) => {
      if (r.type === 'HANDLES_ROUTE') count++;
    });
    expect(count).toBeGreaterThanOrEqual(5);
  });

  it('extracts navigation patterns as FETCHES edges', () => {
    let count = 0;
    result.graph.forEachRelationship((r) => {
      if (r.type === 'FETCHES') count++;
    });
    expect(count).toBeGreaterThanOrEqual(2);
  });
});
