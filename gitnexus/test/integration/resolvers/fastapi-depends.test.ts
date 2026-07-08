import { describe, it, expect, beforeAll } from 'vitest';
import path from 'path';
import { FIXTURES, getRelationships, runPipelineFromRepo, type PipelineResult } from './helpers.js';

describe('FastAPI Depends() CALLS edge extraction', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(path.join(FIXTURES, 'fastapi-depends'), () => {});
  }, 60000);

  it('emits CALLS edges from route handlers to get_current_user_record via Depends()', () => {
    const edges = getRelationships(result, 'CALLS');
    const dependsEdges = edges.filter((e) => e.target === 'get_current_user_record');
    expect(dependsEdges.length).toBe(2);
    const sources = dependsEdges.map((e) => e.source).sort();
    expect(sources).toContain('list_calls');
    expect(sources).toContain('get_user');
  });

  it('emits CALLS edges from route handlers to get_db via Depends()', () => {
    const edges = getRelationships(result, 'CALLS');
    const dependsEdges = edges.filter((e) => e.target === 'get_db');
    expect(dependsEdges.length).toBe(2);
    const sources = dependsEdges.map((e) => e.source).sort();
    expect(sources).toContain('list_calls');
    expect(sources).toContain('create_user');
  });

  it('traces typed default parameter: user: User = Depends(get_current_user_record)', () => {
    const edges = getRelationships(result, 'CALLS');
    const edge = edges.find(
      (e) => e.target === 'get_current_user_record' && e.sourceFilePath.includes('calls.py'),
    );
    expect(edge).toBeDefined();
  });

  it('traces untyped default parameter: db=Depends(get_db)', () => {
    const edges = getRelationships(result, 'CALLS');
    const edge = edges.find((e) => e.target === 'get_db' && e.sourceFilePath.includes('users.py'));
    expect(edge).toBeDefined();
  });
});
