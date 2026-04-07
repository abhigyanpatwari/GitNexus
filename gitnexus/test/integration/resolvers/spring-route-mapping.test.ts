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

function expectDefined<T>(value: T | undefined): T {
  expect(value).toBeDefined();
  return value as T;
}

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
    expect(routes).toHaveLength(7);

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

    const usersRoute = expectDefined(users);
    const createRoute = expectDefined(create);
    const profileRoute = expectDefined(profile);
    const searchRouteNode = expectDefined(search);
    const fqcnRouteNode = expectDefined(fqcn);
    const healthRouteNode = expectDefined(health);
    const statusRouteNode = expectDefined(status);

    expect(usersRoute.properties.httpMethod).toBe('GET');
    expect(usersRoute.properties.controllerName).toBe('UserController');
    expect(usersRoute.properties.methodName).toBe('listUsers');
    expect(usersRoute.properties.prefix).toBe('/api');

    expect(createRoute.properties.httpMethod).toBe('POST');
    expect(createRoute.properties.methodName).toBe('createUser');
    expect(profileRoute.properties.httpMethod).toBe('PATCH');
    expect(profileRoute.properties.methodName).toBe('updateProfile');
    expect(searchRouteNode.properties.httpMethod).toBe('POST');
    expect(searchRouteNode.properties.methodName).toBe('searchUsers');
    expect(fqcnRouteNode.properties.httpMethod).toBe('PUT');
    expect(fqcnRouteNode.properties.methodName).toBe('fullyQualifiedUsers');

    expect(healthRouteNode.properties.httpMethod).toBe('GET');
    expect(healthRouteNode.properties.controllerName).toBe('HealthController');
    expect(healthRouteNode.properties.methodName).toBe('health');
    expect(healthRouteNode.properties.prefix).toBeUndefined();

    expect(statusRouteNode.properties.httpMethod).toBe('GET');
    expect(statusRouteNode.properties.controllerName).toBe('HealthController');
    expect(statusRouteNode.properties.methodName).toBe('status');
  });

  it('creates HANDLES_ROUTE edges from controller files', () => {
    const edges = getRelationships(result, 'HANDLES_ROUTE');
    const usersRoute = edges.find((edge) => edge.target === '/api/users');
    const searchRoute = edges.find((edge) => edge.target === '/api/users/search');
    const fqcnRoute = edges.find((edge) => edge.target === '/api/users/fqcn');
    const healthRoute = edges.find((edge) => edge.target === '/health');
    const statusRoute = edges.find((edge) => edge.target === '/status');

    expect(expectDefined(usersRoute).sourceFilePath).toContain('UserController.java');
    expect(expectDefined(searchRoute).sourceFilePath).toContain('UserController.java');
    expect(expectDefined(fqcnRoute).sourceFilePath).toContain('UserController.java');
    expect(expectDefined(healthRoute).sourceFilePath).toContain('HealthController.java');
    expect(expectDefined(statusRoute).sourceFilePath).toContain('HealthController.java');
  });

  it('skips unresolved explicit constant mappings without emitting route links', () => {
    const routes = getNodesByLabel(result, 'Route');
    const handlesRouteEdges = getRelationships(result, 'HANDLES_ROUTE');
    const callEdges = getRelationships(result, 'CALLS');

    expect(routes).toHaveLength(7);
    expect(
      handlesRouteEdges.some(
        (edge) =>
          edge.sourceFilePath.includes('UserController.java') && edge.target.includes('broken'),
      ),
    ).toBe(false);
    expect(
      callEdges.some(
        (edge) => edge.source === 'UserController.java' && edge.target === 'brokenUsers',
      ),
    ).toBe(false);
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
      edges.some(
        (edge) => edge.source === 'UserController.java' && edge.target === 'updateProfile',
      ),
    ).toBe(true);
    expect(
      edges.some((edge) => edge.source === 'UserController.java' && edge.target === 'searchUsers'),
    ).toBe(true);
    expect(
      edges.some(
        (edge) => edge.source === 'UserController.java' && edge.target === 'fullyQualifiedUsers',
      ),
    ).toBe(true);
    expect(
      edges.some((edge) => edge.source === 'HealthController.java' && edge.target === 'health'),
    ).toBe(true);
    expect(
      edges.some((edge) => edge.source === 'HealthController.java' && edge.target === 'status'),
    ).toBe(true);
  });
});
