import { describe, it, expect, beforeAll } from 'vitest';
import path from 'path';
import {
  FIXTURES,
  getRelationships,
  getNodesByLabel,
  getNodesByLabelFull,
  edgeSet,
  runPipelineFromRepo,
  type PipelineResult,
} from './helpers.js';

describe('Zig field and nested container resolution', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(path.join(FIXTURES, 'zig-field-types'), () => {});
  }, 60000);

  it('detects Zig struct, nested struct, method, and property nodes', () => {
    expect(getNodesByLabel(result, 'Struct')).toEqual(['Address', 'Http', 'Request', 'User']);
    expect(getNodesByLabel(result, 'Property')).toEqual(['address', 'city', 'value']);
    expect(getNodesByLabel(result, 'Method')).toEqual(['init', 'save']);
  });

  it('emits HAS_METHOD and HAS_PROPERTY edges for nested Zig types', () => {
    expect(edgeSet(getRelationships(result, 'HAS_METHOD'))).toEqual([
      'Address → save',
      'Request → init',
    ]);
    expect(edgeSet(getRelationships(result, 'HAS_PROPERTY'))).toEqual([
      'Address → city',
      'Request → value',
      'User → address',
    ]);
  });

  it('populates declaredType metadata for Zig container fields', () => {
    const properties = getNodesByLabelFull(result, 'Property');

    const address = properties.find((p) => p.name === 'address');
    expect(address).toBeDefined();
    expect(address!.properties.visibility).toBe('public');
    expect(address!.properties.isStatic).toBe(false);
    expect(address!.properties.isReadonly).toBe(false);
    expect(address!.properties.declaredType).toBe('Address');

    const value = properties.find((p) => p.name === 'value');
    expect(value).toBeDefined();
    expect(value!.properties.declaredType).toBe('u32');
  });

  it('resolves field-typed member calls through Zig container fields', () => {
    const calls = getRelationships(result, 'CALLS');
    const saveCall = calls.find((e) => e.source === 'processUser' && e.target === 'save');
    expect(saveCall).toBeDefined();
    expect(saveCall!.targetFilePath).toBe('main.zig');
  });
});
