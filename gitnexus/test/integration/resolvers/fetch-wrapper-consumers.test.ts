import { describe, it, expect, beforeAll } from 'vitest';
import path from 'path';
import {
  FIXTURES,
  getRelationships,
  getNodesByLabel,
  runPipelineFromRepo,
  type PipelineResult,
} from './helpers.js';

describe('Fetch wrapper consumer FETCHES edge extraction', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(path.join(FIXTURES, 'fetch-wrapper-consumers'), () => {});
  }, 60000);

  it('creates Route nodes for API endpoints', () => {
    const routes = getNodesByLabel(result, 'Route');
    expect(routes).toContain('/api/grants');
    expect(routes).toContain('/api/users');
  });

  it('creates FETCHES edge from GrantsList via apiFetch wrapper', () => {
    const edges = getRelationships(result, 'FETCHES');
    const grantsEdge = edges.find(
      (e) => e.sourceFilePath.includes('GrantsList') && e.target === '/api/grants',
    );
    expect(grantsEdge).toBeDefined();
  });

  it('creates FETCHES edge from UserList via apiFetch wrapper', () => {
    const edges = getRelationships(result, 'FETCHES');
    const usersEdge = edges.find(
      (e) => e.sourceFilePath.includes('UserList') && e.target === '/api/users',
    );
    expect(usersEdge).toBeDefined();
  });

  it('produces the correct total number of FETCHES edges', () => {
    const edges = getRelationships(result, 'FETCHES');
    expect(edges.length).toBe(2);
  });
});
