import Parser from 'tree-sitter';
import { describe, expect, it } from 'vitest';
import { emitPythonScopeCaptures } from '../../../../src/core/ingestion/languages/python/index.js';

// The runtime exports the class; the typings declare SyntaxNode only as an interface.
const nodePrototype = (Parser as unknown as { SyntaxNode: { prototype: object } }).SyntaxNode
  .prototype;

const bareReads = (source: string): string[] =>
  emitPythonScopeCaptures(source, 'deep.py')
    .filter((match) => match['@reference.read.identifier'])
    .map((match) => match['@reference.read.identifier']!.text);

// `@scope.name-claims` is a synthetic capture: its text is JSON.stringify(env.claims).
const moduleClaimNames = (source: string): string[] => {
  const moduleMatch = emitPythonScopeCaptures(source, 'deep.py').find(
    (match) => match['@scope.module'],
  )!;
  const claims = JSON.parse(moduleMatch['@scope.name-claims']!.text) as { name: string }[];
  return claims.map((claim) => claim.name);
};

// Syntax depth is input-controlled: generated code can chain thousands of
// operators. A recursive lexical walk overflowed V8's stack near depth 2,000,
// and the per-read ancestor climb for annotations cost O(depth^2) per read.
describe('Python captures on deep syntax', () => {
  const depth = 3000;

  it('captures every read in a long operator chain', () => {
    expect(bareReads(`x = ${'a + '.repeat(depth)}a\n`)).toHaveLength(depth + 1);
  });

  it('walks deeply nested literals', () => {
    const source = `x = ${'['.repeat(depth)}a${']'.repeat(depth)}\n`;
    expect(moduleClaimNames(source)).toContain('x');
  });

  const nestedTuple = `${'('.repeat(2000)}a,${'),'.repeat(1999)})`;
  it.each([
    {
      name: 'a 2,000-deep class pattern',
      source: `match v:\n    case ${'P(k='.repeat(2000)}q${')'.repeat(2000)}:\n        pass\n`,
      claim: 'q',
    },
    {
      name: 'a 2,000-deep nested tuple target',
      source: `${nestedTuple} = v\n`,
      claim: 'a',
    },
  ])('claims the binding of $name', ({ source, claim }) => {
    expect(moduleClaimNames(source)).toContain(claim);
  });

  // tree-sitter keeps no parent pointers: each `.parent` re-walks from the
  // root. The previous annotation check climbed ancestors from every read,
  // n(n+1)/2 parent reads for an n-term chain (504,506 at n = 1,000).
  it.each([250, 1000])('reads a bounded number of parents for a %i-term chain', (terms) => {
    const descriptor = Object.getOwnPropertyDescriptor(nodePrototype, 'parent')!;
    let parentReads = 0;
    Object.defineProperty(nodePrototype, 'parent', {
      ...descriptor,
      get() {
        parentReads++;
        return descriptor.get!.call(this);
      },
    });
    try {
      expect(bareReads(`x = ${'a + '.repeat(terms)}a\n`)).toHaveLength(terms + 1);
    } finally {
      Object.defineProperty(nodePrototype, 'parent', descriptor);
    }
    expect(parentReads).toBeLessThanOrEqual(16);
  });

  it('skips a deeply nested annotation but keeps the body reads', () => {
    // Each `List[` level adds three syntax levels.
    const annotation = `${'List['.repeat(1000)}int${']'.repeat(1000)}`;
    expect(bareReads(`def f(p: ${annotation}) -> T:\n    return p + q\n`)).toEqual(['p', 'q']);
  });
});

describe('Python annotation reads', () => {
  it.each([
    { name: 'annotated assignment', source: 'x: Dict[str, A] = B\n', reads: ['B'] },
    {
      name: 'parameter and return annotations',
      source: 'def f(p: List["Q"] = d) -> Optional[R]:\n    return p + q\n',
      reads: ['d', 'p', 'q'],
    },
    { name: 'type alias', source: 'type Alias = Dict[K, V]\n', reads: [] },
    {
      name: 'union annotation',
      source: 'def f(p: A | B, r: C = D) -> E:\n    return F\n',
      reads: ['D', 'F'],
    },
  ])('$name', ({ source, reads }) => {
    expect(bareReads(source)).toEqual(reads);
  });
});
