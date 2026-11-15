import { describe, expect, it } from 'vitest';
import { emitPythonScopeCaptures } from '../../../../src/core/ingestion/languages/python/index.js';

// Python Language Reference §§6.3.1, 7.2, 7.2.1, 7.2.2, and 7.5.
describe('Python attribute read/write contexts', () => {
  it.each([
    { source: 'return p.value', reads: ['p.value'], writes: [] },
    { source: 'p.value = q.value', reads: ['q.value'], writes: ['p.value'] },
    { source: 'p.value += q.value', reads: ['p.value', 'q.value'], writes: ['p.value'] },
    { source: 'p.value: int', reads: [], writes: [] },
    { source: 'p.child.value: int', reads: ['p.child'], writes: [] },
    { source: 'p.value: types.Value = item', reads: [], writes: ['p.value'] },
    { source: 'p.value, q.value = items', reads: [], writes: ['p.value', 'q.value'] },
    { source: '[p.value, *q.value] = items', reads: [], writes: ['p.value', 'q.value'] },
    { source: 'p.child.value = 1', reads: ['p.child'], writes: ['p.child.value'] },
    { source: 'p.items[0] = 1', reads: ['p.items'], writes: [] },
    { source: 'for p.value in items: pass', reads: [], writes: ['p.value'] },
    { source: 'with ctx() as p.value: pass', reads: [], writes: ['p.value'] },
    {
      source: 'del p.value, p.child.value',
      reads: ['p.child'],
      writes: ['p.value', 'p.child.value'],
    },
    { source: 'p.method()', reads: [], writes: [] },
    { source: 'p.child.method()', reads: ['p.child'], writes: [] },
    { source: 'callback = p.method', reads: ['p.method'], writes: [] },
  ])('$source', ({ source, reads, writes }) => {
    const matches = emitPythonScopeCaptures(`def use(p, q):\n    ${source}\n`, 'accesses.py');
    const accesses = (kind: 'read' | 'write') =>
      matches
        .filter((match) => match[`@reference.${kind}.member`])
        .map((match) => `${match['@reference.receiver'].text}.${match['@reference.name'].text}`)
        .sort();
    expect(accesses('read')).toEqual([...reads].sort());
    expect(accesses('write')).toEqual([...writes].sort());
  });
});
