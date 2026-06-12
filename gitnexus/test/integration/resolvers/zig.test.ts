/**
 * Zig: container types, methods, calls, and @import resolution.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import path from 'path';
import {
  edgeSet,
  FIXTURES,
  getNodesByLabel,
  getRelationships,
  runPipelineFromRepo,
  type PipelineResult,
} from './helpers.js';

describe('Zig basic resolution', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(path.join(FIXTURES, 'zig-basic'), () => {});
  }, 60000);

  it('detects the Pioneer struct and State enum', () => {
    expect(getNodesByLabel(result, 'Struct')).toContain('Pioneer');
    expect(getNodesByLabel(result, 'Enum')).toContain('State');
  });

  it('labels `union(enum)` declarations as Union (not Class)', () => {
    expect(getNodesByLabel(result, 'Union')).toContain('Tag');
    // Negative-side check: Tag must NOT also appear under Class.
    expect(getNodesByLabel(result, 'Class')).not.toContain('Tag');
  });

  it('extracts top-level functions from main.zig', () => {
    const fns = getNodesByLabel(result, 'Function');
    expect(fns).toContain('main');
    expect(fns).toContain('helper');
  });

  it('extracts struct methods (tick, reset) as Methods', () => {
    const methods = getNodesByLabel(result, 'Method');
    expect(methods).toContain('tick');
    expect(methods).toContain('reset');
  });

  it('resolves the relative @import("./pioneer.zig") to pioneer.zig', () => {
    const imports = getRelationships(result, 'IMPORTS');
    const internal = imports.filter((e) => e.targetFilePath.endsWith('pioneer.zig'));
    expect(internal.length).toBeGreaterThan(0);
    expect(internal[0].sourceFilePath).toContain('main.zig');
  });

  it('emits a CALLS edge for the free call main → helper', () => {
    const calls = getRelationships(result, 'CALLS');
    expect(edgeSet(calls)).toContain('main → helper');
  });

  it('emits a CALLS edge for the receiver-bound method call main → tick', () => {
    const calls = getRelationships(result, 'CALLS');
    // `var p = pioneer.Pioneer{…}; p.tick()` — constructor-inferred receiver
    // type through the namespace import, dispatched onto Pioneer.tick.
    expect(edgeSet(calls)).toContain('main → tick');
  });
});
