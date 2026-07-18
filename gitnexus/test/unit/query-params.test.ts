import { describe, expect, it } from 'vitest';
import { isValidQueryParams, relTypeEquals } from '../../src/core/lbug/query-params.js';

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

describe('relTypeEquals', () => {
  it('builds a single scalar equality for one type', () => {
    expect(relTypeEquals('r', ['CALLS'])).toEqual({
      clause: '(r.type = $relType0)',
      params: { relType0: 'CALLS' },
    });
  });

  it('builds an OR chain preserving list order', () => {
    expect(relTypeEquals('mr', ['HAS_METHOD', 'HAS_PROPERTY'])).toEqual({
      clause: '(mr.type = $relType0 OR mr.type = $relType1)',
      params: { relType0: 'HAS_METHOD', relType1: 'HAS_PROPERTY' },
    });
  });

  it('scales to the full context() 11-type list with one param per type', () => {
    const types = [
      'CALLS',
      'IMPORTS',
      'EXTENDS',
      'IMPLEMENTS',
      'USES',
      'HAS_METHOD',
      'HAS_PROPERTY',
      'METHOD_OVERRIDES',
      'OVERRIDES',
      'METHOD_IMPLEMENTS',
      'ACCESSES',
    ];
    const { clause, params } = relTypeEquals('r', types);
    expect(Object.keys(params)).toHaveLength(types.length);
    expect(Object.values(params)).toEqual(types);
    expect(clause.match(/ OR /g)).toHaveLength(types.length - 1);
    expect(clause).toContain('r.type = $relType10');
    expect(isValidQueryParams(params)).toBe(true);
  });

  it('keeps two predicates in one statement collision-free via paramPrefix', () => {
    const heritage = relTypeEquals('r', ['EXTENDS', 'IMPLEMENTS'], 'heritage');
    const consumer = relTypeEquals('r', ['CALLS'], 'consumer');
    expect(heritage.params).toEqual({ heritage0: 'EXTENDS', heritage1: 'IMPLEMENTS' });
    expect(consumer.params).toEqual({ consumer0: 'CALLS' });
    expect(Object.keys({ ...heritage.params, ...consumer.params })).toHaveLength(3);
  });

  it('preserves IN [] match-nothing semantics for an empty list', () => {
    expect(relTypeEquals('r', [])).toEqual({ clause: 'FALSE', params: {} });
  });
});
