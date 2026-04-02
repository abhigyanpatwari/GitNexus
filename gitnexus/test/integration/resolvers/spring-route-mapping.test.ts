import { describe, it, expect, beforeAll } from 'vitest';
import path from 'path';
import {
  FIXTURES,
  getRelationships,
  getNodesByLabel,
  getNodesByLabelFull,
  runPipelineFromRepo,
  type PipelineResult,
} from './helpers.js';

describe('Spring route mapping', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(path.join(FIXTURES, 'spring-route-mapping'), () => {});
  }, 60000);

  it('creates Route nodes for supported Spring request mappings only', () => {
    const routes = getNodesByLabel(result, 'Route');
    expect(routes).toContain('/api/users');
    expect(routes).toContain('/api/users/create');
    expect(routes).toContain('/api/users/profile');
    expect(routes).toContain('/api/users/search');
    expect(routes).toContain('/api/users/fqcn');
    expect(routes).toContain('/health');
    expect(routes).toContain('/status');

    expect(routes).not.toContain('/');
    expect(routes).not.toContain('/api');
    expect(routes).not.toContain('/api/users/array');
  });

  it('stores Spring route metadata on Route nodes', () => {
    const routes = getNodesByLabelFull(result, 'Route');
    const users = routes.find((r) => r.name === '/api/users');
    const create = routes.find((r) => r.name === '/api/users/create');
    const profile = routes.find((r) => r.name === '/api/users/profile');
    const search = routes.find((r) => r.name === '/api/users/search');
    const fqcn = routes.find((r) => r.name === '/api/users/fqcn');
    const health = routes.find((r) => r.name === '/health');
    const status = routes.find((r) => r.name === '/status');

    expect(users).toBeDefined();
    expect(users!.properties.httpMethod).toBe('GET');
    expect(users!.properties.controllerName).toBe('UserController');
    expect(users!.properties.methodName).toBe('listUsers');
    expect(users!.properties.prefix).toBe('/api');

    expect(create!.properties.httpMethod).toBe('POST');
    expect(create!.properties.methodName).toBe('createUser');
    expect(profile!.properties.httpMethod).toBe('PATCH');
    expect(profile!.properties.methodName).toBe('updateProfile');
    expect(search!.properties.httpMethod).toBe('POST');
    expect(search!.properties.methodName).toBe('searchUsers');
    expect(fqcn!.properties.httpMethod).toBe('PUT');
    expect(fqcn!.properties.methodName).toBe('fullyQualifiedUsers');

    expect(health).toBeDefined();
    expect(health!.properties.httpMethod).toBe('GET');
    expect(health!.properties.controllerName).toBe('HealthController');
    expect(health!.properties.methodName).toBe('health');
    expect(health!.properties.prefix).toBeUndefined();

    expect(status).toBeDefined();
    expect(status!.properties.httpMethod).toBe('GET');
    expect(status!.properties.controllerName).toBe('HealthController');
    expect(status!.properties.methodName).toBe('status');
  });

  it('creates HANDLES_ROUTE edges from controller files', () => {
    const edges = getRelationships(result, 'HANDLES_ROUTE');
    const usersRoute = edges.find((edge) => edge.target === '/api/users');
    const searchRoute = edges.find((edge) => edge.target === '/api/users/search');
    const fqcnRoute = edges.find((edge) => edge.target === '/api/users/fqcn');
    const healthRoute = edges.find((edge) => edge.target === '/health');
    const statusRoute = edges.find((edge) => edge.target === '/status');

    expect(usersRoute).toBeDefined();
    expect(usersRoute!.sourceFilePath).toContain('UserController.java');
    expect(searchRoute).toBeDefined();
    expect(searchRoute!.sourceFilePath).toContain('UserController.java');
    expect(fqcnRoute).toBeDefined();
    expect(fqcnRoute!.sourceFilePath).toContain('UserController.java');
    expect(healthRoute).toBeDefined();
    expect(healthRoute!.sourceFilePath).toContain('HealthController.java');
    expect(statusRoute).toBeDefined();
    expect(statusRoute!.sourceFilePath).toContain('HealthController.java');
  });

  it('creates framework CALLS edges from controller files to handler methods', () => {
    const edges = getRelationships(result, 'CALLS');
    expect(
      edges.some((edge) => edge.source === 'UserController.java' && edge.target === 'listUsers'),
    ).toBe(true);
    expect(
      edges.some((edge) => edge.source === 'UserController.java' && edge.target === 'createUser'),
    ).toBe(true);
    expect(
      edges.some((edge) => edge.source === 'UserController.java' && edge.target === 'updateProfile'),
    ).toBe(true);
    expect(
      edges.some((edge) => edge.source === 'UserController.java' && edge.target === 'searchUsers'),
    ).toBe(true);
    expect(
      edges.some((edge) => edge.source === 'UserController.java' && edge.target === 'fullyQualifiedUsers'),
    ).toBe(true);
    expect(
      edges.some((edge) => edge.source === 'HealthController.java' && edge.target === 'health'),
    ).toBe(true);
    expect(
      edges.some((edge) => edge.source === 'HealthController.java' && edge.target === 'status'),
    ).toBe(true);
  });
});
