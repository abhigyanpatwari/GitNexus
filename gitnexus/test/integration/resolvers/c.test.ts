/**
 * C: struct + include-based imports + function calls across files
 */
import { describe, expect, beforeAll } from 'vitest';
import path from 'path';
import {
  FIXTURES,
  createResolverParityIt,
  getRelationships,
  getNodesByLabel,
  edgeSet,
  runPipelineFromRepo,
  type PipelineResult,
} from './helpers.js';

const it = createResolverParityIt('c');

// ---------------------------------------------------------------------------
// C structs + include-based imports + cross-file function calls
// ---------------------------------------------------------------------------

describe('C struct & include resolution', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(path.join(FIXTURES, 'c-structs'), () => {});
  }, 60000);

  it('detects User and Service structs', () => {
    const structs = getNodesByLabel(result, 'Struct');
    expect(structs).toContain('User');
    expect(structs).toContain('Service');
  });

  it('detects functions across all files', () => {
    const fns = getNodesByLabel(result, 'Function');
    expect(fns).toContain('main');
    expect(fns).toContain('create_user');
    expect(fns).toContain('free_user');
    expect(fns).toContain('get_user_age');
    expect(fns).toContain('create_service');
    expect(fns).toContain('service_add_user');
    expect(fns).toContain('destroy_service');
  });

  it('resolves #include imports between .c and .h files', () => {
    const imports = getRelationships(result, 'IMPORTS');
    const edges = edgeSet(imports);
    // user.c includes user.h
    expect(edges).toContain('user.c → user.h');
    // service.h includes user.h
    expect(edges).toContain('service.h → user.h');
    // service.c includes service.h
    expect(edges).toContain('service.c → service.h');
    // main.c includes service.h
    expect(edges).toContain('main.c → service.h');
  });

  it('emits CALLS edges for cross-file function calls', () => {
    const calls = getRelationships(result, 'CALLS');
    const edges = edgeSet(calls);
    // main.c calls functions from service
    expect(edges).toContain('main → create_service');
    expect(edges).toContain('main → service_add_user');
    expect(edges).toContain('main → destroy_service');
    // service.c calls functions from user
    expect(edges).toContain('service_add_user → create_user');
    expect(edges).toContain('service_add_user → free_user');
    expect(edges).toContain('destroy_service → free_user');
  });
});
