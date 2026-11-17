import Parser from 'tree-sitter';
import { describe, expect, it } from 'vitest';
import { emitPythonScopeCaptures } from '../../../../src/core/ingestion/languages/python/index.js';
import { pythonAttributeAccessKinds } from '../../../../src/core/ingestion/languages/python/attribute-references.js';
import { getPythonParser } from '../../../../src/core/ingestion/languages/python/query.js';
import { getTreeSitterBufferSize } from '../../../../src/core/ingestion/constants.js';
import { parseSourceSafe } from '../../../../src/core/tree-sitter/safe-parse.js';

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

const memberSites = (source: string): number =>
  emitPythonScopeCaptures(source, 'deep.py').filter(
    (match) => match['@reference.read.member'] ?? match['@reference.call.member'],
  ).length;

// Counts `.parent` reads while `run` executes.
const countParentReads = (run: () => void): number => {
  const descriptor = Object.getOwnPropertyDescriptor(nodePrototype, 'parent')!;
  let reads = 0;
  Object.defineProperty(nodePrototype, 'parent', {
    ...descriptor,
    get() {
      reads++;
      return descriptor.get!.call(this);
    },
  });
  try {
    run();
  } finally {
    Object.defineProperty(nodePrototype, 'parent', descriptor);
  }
  return reads;
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
    {
      name: 'a 16,000-deep nested tuple target',
      source: `${'('.repeat(16000)}a,${'),'.repeat(15999)}) = v\n`,
      claim: 'a',
    },
  ])('claims the binding of $name', ({ source, claim }) => {
    expect(moduleClaimNames(source)).toContain(claim);
  });

  // tree-sitter keeps no parent pointers: each `.parent` re-walks from the
  // root. The previous annotation check climbed ancestors from every read,
  // n(n+1)/2 parent reads for an n-term chain (504,506 at n = 1,000).
  it.each([250, 1000])('reads a bounded number of parents for a %i-term chain', (terms) => {
    const reads = countParentReads(() =>
      expect(bareReads(`x = ${'a + '.repeat(terms)}a\n`)).toHaveLength(terms + 1),
    );
    expect(reads).toBeLessThanOrEqual(16);
  });

  // Classifying a member access read its parent three times, 3n + 3 reads
  // for n sites (3,003 at n = 1,000), each one a walk down from the root.
  it.each([
    {
      sites: 250,
      shape: 'member-read terms',
      source: `x = ${'obj.value + '.repeat(249)}obj.value\n`,
    },
    {
      sites: 1000,
      shape: 'member-read terms',
      source: `x = ${'obj.value + '.repeat(999)}obj.value\n`,
    },
    { sites: 250, shape: 'member-chain links', source: `x = a${'.f'.repeat(250)}\n` },
    { sites: 1000, shape: 'member-chain links', source: `x = a${'.f'.repeat(1000)}\n` },
    { sites: 250, shape: 'call-chain links', source: `x = a${'.f()'.repeat(250)}\n` },
    { sites: 1000, shape: 'call-chain links', source: `x = a${'.f()'.repeat(1000)}\n` },
  ])('reads a bounded number of parents for $sites $shape', ({ sites, source }) => {
    const reads = countParentReads(() => expect(memberSites(source)).toBe(sites));
    expect(reads).toBeLessThanOrEqual(16);
  });

  // The context query must not hold a match open across an assignment target.
  // A two-step pattern (`left: (_) @write right: (_)`) made every capture inside
  // the target wait in tree-sitter's capture buffer: quadratic, and past 65,535
  // buffered captures its 16-bit capture-list ids wrap and the process crashes.
  it('classifies an assignment target behind 70,000 call arguments', () => {
    const source = `f(${'g(), '.repeat(69_999)}g()).x = 1\n`;
    const tree = parseSourceSafe(getPythonParser(), source, undefined, {
      bufferSize: getTreeSitterBufferSize(source),
    })!;
    const [target] = tree.rootNode.descendantsOfType('attribute');
    expect(pythonAttributeAccessKinds(target)).toEqual(['write']);
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
