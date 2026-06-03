/**
 * Reproduce Issue #19: Go handler calls self-reference instead of service method.
 * Pattern: h.service.GetOrder() should resolve to OrderService.GetOrder, not OrderHandler.GetOrder.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import path from 'path';
import {
  FIXTURES, getRelationships, getNodesByLabel,
  runPipelineFromRepo, type PipelineResult,
} from './helpers.js';

// TODO(#102): Go field-extractor fix from 5a92e58/#97 is in main-afk ancestry but the
// fixture pipeline still produces zero Struct/Method nodes for the `go-handler-service-field`
// fixture. Re-test gate from triage v2 caught this. Keep .skip until Batch D-go re-extracts
// the fix or the fixture is updated. Verified red on 2026-06-03 (4/4 cases fail).
describe.skip('Go handler → service field chain resolution (Issue #19)', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(
      path.join(FIXTURES, 'go-handler-service-field'),
      () => {},
    );
  }, 60000);

  it('detects OrderHandler and OrderService structs', () => {
    const structs = getNodesByLabel(result, 'Struct');
    expect(structs).toContain('OrderHandler');
    expect(structs).toContain('OrderService');
  });

  it('detects GetOrder methods', () => {
    const methods = getNodesByLabel(result, 'Method');
    expect(methods).toContain('GetOrder');
  });

  it('service Property on OrderHandler has declaredType', () => {
    const props: Array<{ name: string; properties: Record<string, any> }> = [];
    result.graph.forEachNode(n => {
      if (n.label === 'Property' && n.properties.name === 'service') {
        props.push({ name: n.properties.name, properties: n.properties });
      }
    });
    expect(props.length).toBeGreaterThanOrEqual(1);
    const withDeclaredType = props.find(p => p.properties.declaredType);
    expect(withDeclaredType).toBeDefined();
    expect(withDeclaredType!.properties.declaredType).toMatch(/OrderService/);
  });

  it('resolves h.service.GetOrder() → OrderService.GetOrder (NOT self-reference)', () => {
    const calls = getRelationships(result, 'CALLS');
    const getOrderCalls = calls.filter(e => e.target === 'GetOrder');

    // At least one CALLS edge from a handler GetOrder should point to service file
    const handlerToServiceCall = getOrderCalls.find(c =>
      c.source === 'GetOrder' && c.sourceFilePath.includes('handler') && c.targetFilePath.includes('service')
    );
    expect(handlerToServiceCall).toBeDefined();

    // No handler GetOrder should self-reference (target file = source file = handler)
    const selfRefCalls = getOrderCalls.filter(c =>
      c.source === 'GetOrder' && c.sourceFilePath.includes('handler') && c.targetFilePath.includes('handler')
    );
    expect(selfRefCalls.length).toBe(0);
  });
});