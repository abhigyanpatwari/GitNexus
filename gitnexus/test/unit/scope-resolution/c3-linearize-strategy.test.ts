import { describe, expect, it } from 'vitest';
import {
  c3LinearizeStrategy,
  defaultLinearize,
} from '../../../src/core/ingestion/scope-resolution/passes/mro.js';

describe('c3LinearizeStrategy', () => {
  const parents = new Map<string, readonly string[]>([
    ['OrderedWorker', ['MroOrderMixin', 'OrderA', 'OrderB']],
    ['OrderA', ['OrderX']],
    ['MroOrderMixin', []],
    ['OrderX', []],
    ['OrderB', []],
  ]);

  it('ranks the deeper CPython base ahead of the direct breadth-first base', () => {
    expect(c3LinearizeStrategy('OrderedWorker', parents.get('OrderedWorker')!, parents)).toEqual([
      'MroOrderMixin',
      'OrderA',
      'OrderX',
      'OrderB',
    ]);
  });

  it('does not match breadth-first order on that diamond', () => {
    expect(defaultLinearize('OrderedWorker', parents.get('OrderedWorker')!, parents)).toEqual([
      'MroOrderMixin',
      'OrderA',
      'OrderB',
      'OrderX',
    ]);
  });
});
