import { describe, it, expect, beforeAll } from 'vitest';
import path from 'path';
import {
  FIXTURES,
  getRelationships,
  getNodesByLabel,
  runPipelineFromRepo,
  type PipelineResult,
} from './helpers.js';

describe('Spring route mapping', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(path.join(FIXTURES, 'spring-route-mapping'), () => {});
  }, 60000);

  it('creates Route nodes for Spring request mappings', () => {
    const routes = getNodesByLabel(result, 'Route');
    expect(routes).toContain('/api/users');
    expect(routes).toContain('/api/users/create');
    expect(routes).toContain('/api/users/profile');
    expect(routes).toContain('/health');
  });

  it('creates HANDLES_ROUTE edges from controller files', () => {
    const edges = getRelationships(result, 'HANDLES_ROUTE');
    const usersRoute = edges.find((edge) => edge.target === '/api/users');
    const healthRoute = edges.find((edge) => edge.target === '/health');

    expect(usersRoute).toBeDefined();
    expect(usersRoute!.sourceFilePath).toContain('UserController.java');
    expect(healthRoute).toBeDefined();
    expect(healthRoute!.sourceFilePath).toContain('HealthController.java');
  });

  it('creates framework CALLS edges from controller files to handler methods', () => {
    const edges = getRelationships(result, 'CALLS');
    expect(
      edges.some((edge) => edge.source === 'UserController.java' && edge.target === 'listUsers'),
    ).toBe(true);
    expect(
      edges.some((edge) => edge.source === 'HealthController.java' && edge.target === 'health'),
    ).toBe(true);
  });
});
