import { describe, expect, it } from 'vitest';
import { isValidQueryParams } from '../../src/core/lbug/query-params.js';

describe('isValidQueryParams', () => {
  it('accepts plain objects', () => {
    expect(isValidQueryParams({})).toBe(true);
    expect(isValidQueryParams({ name: 'main', limit: 10 })).toBe(true);
    expect(isValidQueryParams({ enabled: true, score: null })).toBe(true);
    expect(isValidQueryParams(Object.create(null))).toBe(true);
  });

  it('rejects null and arrays', () => {
    expect(isValidQueryParams(null)).toBe(false);
    expect(isValidQueryParams([])).toBe(false);
  });

  it('rejects primitives', () => {
    expect(isValidQueryParams('x')).toBe(false);
    expect(isValidQueryParams(1)).toBe(false);
    expect(isValidQueryParams(false)).toBe(false);
    expect(isValidQueryParams(undefined)).toBe(false);
  });

  it('rejects non-plain objects and non-scalar values', () => {
    expect(isValidQueryParams(new Date())).toBe(false);
    expect(isValidQueryParams(new Map())).toBe(false);
    expect(isValidQueryParams({ nested: { value: 1 } })).toBe(false);
    expect(isValidQueryParams({ list: ['x'] })).toBe(false);
  });
});
