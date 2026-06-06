/**
 * Reproduce Issue #18: FastAPI handler CALLS edges self-reference instead of service methods.
 * Pattern: `service.get_users()` where `service: UserService = Depends(...)` should resolve
 * to UserService.get_users, not self-reference the handler function.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import path from 'path';
import {
  FIXTURES, getRelationships, getNodesByLabel,
  runPipelineFromRepo, type PipelineResult,
} from './helpers.js';

describe('FastAPI handler → service CALLS resolution (Issue #18)', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(
      path.join(FIXTURES, 'python-fastapi-handler-service'),
      () => {},
    );
  }, 60000);

  it('detects UserService and OrderService classes', () => {
    const classes = getNodesByLabel(result, 'Class');
    expect(classes).toContain('UserService');
    expect(classes).toContain('OrderService');
  });

  it('detects handler functions and service methods', () => {
    // WI-H76: handler functions (get_users, create_user in routes/handlers.py) are module-level
    // — stay Function. service methods (UserService.get_users, etc.) are class methods — now Method.
    // The test asserts the symbols are discoverable; use label-flexible lookup.
    const functions = getNodesByLabel(result, 'Function');
    expect(functions).toContain('get_users');
    expect(functions).toContain('create_user');
    // Service methods should also be discoverable as Method nodes.
    const methods = getNodesByLabel(result, 'Method');
    expect(methods).toContain('get_users');
    expect(methods).toContain('create_user');
  });

  it('resolves service.get_users() → UserService.get_users (NOT self-reference)', () => {
    const calls = getRelationships(result, 'CALLS');
    // Find CALLS edges from the get_users handler
    const handlerCalls = calls.filter(c => c.source === 'get_users' && c.sourceFilePath.includes('handler'));

    // Should have a CALLS edge to the service method
    const toService = handlerCalls.find(c => c.target === 'get_users' && c.targetFilePath.includes('service'));
    expect(toService).toBeDefined();
  });

  it('no handler self-references for service calls', () => {
    const calls = getRelationships(result, 'CALLS');
    const handlers = ['get_users', 'create_user', 'get_order', 'delete_order'];

    for (const handler of handlers) {
      const handlerCalls = calls.filter(c => c.source === handler && c.sourceFilePath.includes('handler'));
      // No CALLS edge from handler should point back to the same handler file
      // (unless it's genuinely recursive, which these aren't)
      const selfRefs = handlerCalls.filter(c => c.source === c.target && c.sourceFilePath === c.targetFilePath);
      expect(selfRefs.length).toBe(0);
    }
  });
});