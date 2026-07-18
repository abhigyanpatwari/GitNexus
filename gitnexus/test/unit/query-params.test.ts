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

describe('rel-property IN predicate tripwire (#2508)', () => {
  // LadybugDB >=0.18.1 COPY-written CodeRelation layouts misevaluate
  // relationship-property IN-list predicates (dropped + duplicated rows).
  // Any `<alias>.type IN [...]` / `<alias>.type IN $param` in a Cypher string
  // must go through relTypeEquals instead. This scan keeps the pattern from
  // coming back.
  it('no source file filters a relationship type property with IN', async () => {
    const { readFile } = await import('node:fs/promises');
    const path = await import('node:path');
    const { glob } = await import('glob');
    const srcRoot = path.resolve(__dirname, '../../src');
    const files = await glob('**/*.ts', { cwd: srcRoot, absolute: true });
    expect(files.length).toBeGreaterThan(100);
    const offenders: string[] = [];
    for (const file of files) {
      const lines = (await readFile(file, 'utf8')).split('\n');
      offenders.push(
        ...lines
          .map((line, i) => ({ line, ref: `${path.relative(srcRoot, file)}:${i + 1}` }))
          .filter(({ line }) => /\.type\s+IN\s*(\[|\$)/.test(line))
          .map(({ line, ref }) => `${ref}: ${line.trim()} — use relTypeEquals (#2508)`),
      );
    }
    expect(offenders).toEqual([]);
  });
});
