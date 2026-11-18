import Parser from 'tree-sitter';
import Python from 'tree-sitter-python';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  PYTHON_SCOPE_QUERY,
  expandPythonScopeMatches,
  getPythonParser,
  pythonScopeQueryMatches,
} from '../../../../src/core/ingestion/languages/python/query.js';
import { getTreeSitterBufferSize } from '../../../../src/core/ingestion/constants.js';
import { parseSourceSafe } from '../../../../src/core/tree-sitter/safe-parse.js';

const language = Python as Parameters<Parser['setLanguage']>[0];

const rootOf = (source: string): Parser.SyntaxNode =>
  parseSourceSafe(getPythonParser(), source, undefined, {
    bufferSize: getTreeSitterBufferSize(source),
  })!.rootNode;

/** The query without comments, on one line: rules can be found and swapped by text. */
const squash = (query: string): string =>
  query
    .replace(/;[^\n]*/g, '')
    .replace(/\s+/g, ' ')
    .trim();

/**
 * Each end-anchored rule of PYTHON_SCOPE_QUERY next to the parent-rooted rule
 * it stands for. `expandPythonScopeMatches` must turn the matches of the left
 * column into exactly the matches of the right column, in the same order.
 */
const ANCHORED_RULES = [
  {
    rule: 'member call',
    anchored: '(call function: (attribute) @_member-callee) @_member-call',
    parentRooted:
      '(call function: (attribute object: (_) @reference.receiver attribute: (identifier) @reference.name)) @reference.call.member',
  },
  {
    rule: 'attribute',
    anchored: '(_ attribute: (identifier) @reference.name) @_attribute',
    parentRooted:
      '(attribute object: (_) @reference.receiver attribute: (identifier) @reference.name) @reference.read.member',
  },
  {
    rule: 'binary operand',
    anchored: '(binary_operator left: (identifier) @reference.name @reference.read.identifier)',
    parentRooted: '(binary_operator (identifier) @reference.name @reference.read.identifier)',
  },
  {
    rule: 'right operand',
    anchored:
      '(_ right: (identifier) @reference.name @reference.read.identifier) @_right-operand-of',
    parentRooted: '',
  },
  {
    rule: 'boolean operand',
    anchored: '(boolean_operator left: (identifier) @reference.name @reference.read.identifier)',
    parentRooted: '(boolean_operator (identifier) @reference.name @reference.read.identifier)',
  },
  {
    rule: 'positional argument read',
    anchored:
      '(_ arguments: (argument_list (identifier) @reference.name @reference.read.identifier))',
    parentRooted:
      '(call arguments: (argument_list (identifier) @reference.name @reference.read.identifier))',
  },
  {
    rule: 'keyword argument read',
    anchored:
      '(_ arguments: (argument_list (keyword_argument value: (identifier) @reference.name @reference.read.identifier)))',
    parentRooted:
      '(call arguments: (argument_list (keyword_argument value: (identifier) @reference.name @reference.read.identifier)))',
  },
  {
    rule: 'positional argument value',
    anchored: '(_ arguments: (argument_list (identifier) @reference.name @reference.value-ref))',
    parentRooted:
      '(call arguments: (argument_list (identifier) @reference.name @reference.value-ref))',
  },
  {
    rule: 'keyword argument value',
    anchored:
      '(_ arguments: (argument_list (keyword_argument value: (identifier) @reference.name @reference.value-ref)))',
    parentRooted:
      '(call arguments: (argument_list (keyword_argument value: (identifier) @reference.name @reference.value-ref)))',
  },
] as const;

const scopeQueryText = squash(PYTHON_SCOPE_QUERY);
const parentRootedQueryText = ANCHORED_RULES.reduce(
  (query, { anchored, parentRooted }) => query.replace(anchored, parentRooted),
  scopeQueryText,
);
const parentRootedQuery = new Parser.Query(language, parentRootedQueryText);

const matchKey = (captures: readonly Parser.QueryCapture[]): string =>
  captures.map((capture) => `${capture.name}:${capture.node.id}`).join(' ');

const anchoredMatches = (root: Parser.SyntaxNode): string[] =>
  [...expandPythonScopeMatches(pythonScopeQueryMatches(root))].map(matchKey);

const parentRootedMatches = (root: Parser.SyntaxNode): string[] =>
  parentRootedQuery.matches(root).map((match) => matchKey(match.captures));

describe('Python scope query: end-anchored rules', () => {
  it.each(ANCHORED_RULES)('the query holds the $rule rule exactly once', ({ anchored }) => {
    expect(scopeQueryText.split(anchored)).toHaveLength(2);
  });

  it.each([
    { name: 'member read', source: 'x = a.b\n' },
    { name: 'member call', source: 'a.b(c)\n' },
    { name: 'call chain', source: 'x = a.f(p).g(q, k=r).h()\n' },
    { name: 'call of a call', source: 'a.b()()(c)(k=d)\n' },
    { name: 'subscripted receivers', source: 'x = a[0].b[i].c(d)[j].e\n' },
    { name: 'member targets', source: 'a.b = c.d\ne.f += g.h\ndel i.j\nk.l: int\n' },
    { name: 'operators', source: 'x = a + b.c * d - e @ f\ny = a and b or c.d and not e\n' },
    { name: 'right-nested power', source: 'x = a ** b ** c ** d\n' },
    { name: 'comparisons', source: 'x = a < b <= c.d != e\ny = (a < b) < (c is d)\n' },
    {
      name: 'right identifiers that are not operands',
      source: 'x = y\nx += y\nfor i in y:\n    z = [j for j in i]\n',
    },
    { name: 'arguments', source: 'f(a, b.c, d=e, *g, **h, i=j.k, l=m)\nf(a)(b, c=d)\n' },
    { name: 'nested arguments', source: 'f(g(a, h(b, k=c), d), e, k=i(j))\n' },
    {
      name: 'class bases are not call arguments',
      source: 'class C(Base, pkg.Mixin, metaclass=Meta):\n    x = f(Base, m=Meta)\n',
    },
    {
      name: 'decorators',
      source: '@plain\n@a.b\n@a.b.c\n@a.b(c, d=e)\n@f(g).h\ndef fn(p=q, r: T = s):\n    return p\n',
    },
    {
      name: 'for loops',
      source:
        'for i, v in enumerate(xs):\n    pass\nfor k, v in d.items():\n    pass\nfor v in d.values():\n    pass\nfor u in self.users:\n    u.save()\n',
    },
    {
      name: 'constructors and aliases',
      source:
        'u = User()\nv = models.User(a)\nw = u\nx = make() if c else None\ny = None or make()\n(z := pkg.Make(a))\n',
    },
    {
      name: 'lambda and comprehension',
      source: 'f = lambda a, b=c: a.b(c) + d\nx = [i.j for i in k if i.l(m) and n]\n',
    },
    {
      name: 'match statement',
      source: 'match v:\n    case A() as a:\n        a.b(c)\n    case p.Q(x=y):\n        pass\n',
    },
    {
      name: 'typed code',
      source: 'def f(a: A.B, b: C[D] = e.f) -> G.H:\n    x: I.J = k.l\n    return a.b + b\n',
    },
    {
      name: 'comments inside expressions',
      source:
        'x = (a  # one\n     .b  # two\n     .c(d,  # three\n        e=f)  # four\n     + g  # five\n     and h)\n',
    },
    { name: 'missing member name', source: 'x = a.\ny = b.c\n' },
    { name: 'missing receiver', source: 'x = .a\ny = ().b.c()\n' },
    { name: 'missing right operand', source: 'x = a +\ny = b and\nz = c.d or e\n' },
    { name: 'missing left operand', source: 'x = + a * b\ny = or c\n' },
    { name: 'broken argument list', source: 'f(a b, c=, =d, e.f g.h)\nk(l,, m)\n' },
    { name: 'unclosed call', source: 'x = a.b(c, d=e\ny = f.g\n' },
    { name: 'unclosed chain', source: 'x = a.b(c).d(e.\nf.g(h)\n' },
    { name: 'stray tokens', source: 'foo(1 2 $ %% ).c\na.$b.c + d\ne ? f : g.h(i)\n' },
    { name: 'call on an error receiver', source: '$$.a(b).c\n(a b).c(d)\n' },
    { name: 'broken class and decorator', source: '@a.b.\nclass C(B, m=k\n    x = y.z(w\n' },
    {
      name: 'truncated file',
      source: 'def f(a, b=c.d):\n    return a.b(c)(d).e + f and g.h(i, j=k',
    },
  ])('yields the parent-rooted matches in order: $name', ({ source }) => {
    const root = rootOf(source);
    expect(anchoredMatches(root)).toEqual(parentRootedMatches(root));
  });

  // The cases above derive the parent-rooted query from this one, so they
  // cannot see two rules trade places. This pins the order itself: the member
  // call before the member read, the read of an argument before its value-ref.
  it('yields the matches of a member call with arguments in the established order', () => {
    const matches = [
      ...expandPythonScopeMatches(pythonScopeQueryMatches(rootOf('x = a.b(c, k=d)\n'))),
    ];
    expect(
      matches.map((match) => match.map(({ name, node }) => `${name}=${node.text}`).join(' ')),
    ).toEqual([
      'scope.module=x = a.b(c, k=d)\n',
      'declaration.variable=x = a.b(c, k=d) declaration.name=x',
      'type-binding.constructor=x = a.b(c, k=d) type-binding.name=x type-binding.type=a.b',
      'reference.call.member=a.b(c, k=d) reference.receiver=a reference.name=b',
      'reference.read.member=a.b reference.receiver=a reference.name=b',
      'reference.name=c reference.read.identifier=c',
      'reference.name=c reference.value-ref=c',
      'reference.name=d reference.read.identifier=d',
      'reference.name=d reference.value-ref=d',
    ]);
  });
});

// The rules that start at a child trust the grammar for what the wildcard
// skipped. A grammar upgrade that breaks one of these has to come here.
describe('Python grammar facts the end-anchored rules rely on', () => {
  interface NodeTypeInfo {
    readonly type: string;
    readonly named: boolean;
    readonly fields?: Readonly<
      Record<string, { readonly multiple: boolean; readonly types: readonly { named: boolean }[] }>
    >;
    readonly children?: unknown;
  }
  const nodeTypes = (Python as unknown as { nodeTypeInfo: readonly NodeTypeInfo[] }).nodeTypeInfo;
  const typesWithField = (field: string): string[] =>
    nodeTypes.filter((info) => info.fields?.[field] !== undefined).map((info) => info.type);
  const nodeType = (type: string): NodeTypeInfo =>
    nodeTypes.find((info) => info.named && info.type === type)!;
  /** Fields that can hold a named node, e.g. not `operator`. */
  const namedFields = (type: string): string[] =>
    Object.entries(nodeType(type).fields ?? {})
      .filter(([, field]) => field.types.some((child) => child.named))
      .map(([name]) => name)
      .sort();

  it('only a call has an `arguments` field', () => {
    expect(typesWithField('arguments')).toEqual(['call']);
  });

  it('only an attribute has an `attribute` field', () => {
    expect(typesWithField('attribute')).toEqual(['attribute']);
  });

  it.each(['attribute', 'binary_operator', 'boolean_operator'])(
    'every named child of %s is in a single-node field',
    (type) => {
      expect(nodeType(type).children).toBeUndefined();
      expect(Object.values(nodeType(type).fields!).map((field) => field.multiple)).not.toContain(
        true,
      );
    },
  );

  it.each([
    { type: 'attribute', fields: ['attribute', 'object'] },
    { type: 'binary_operator', fields: ['left', 'right'] },
    { type: 'boolean_operator', fields: ['left', 'right'] },
  ])('the named children of $type are $fields', ({ type, fields }) => {
    expect(namedFields(type)).toEqual(fields);
  });
});

/**
 * Give every rule a capture on its root, so that every open match holds one
 * of the cursor's capture lists from its first node on. `matchLimit` caps the
 * number of lists, so `didExceedMatchLimit()` then says whether more matches
 * than the limit were open at once. tree-sitter visits every open match at
 * every node, so that number times the node count is the work of the query.
 */
const withRootCaptures = (query: string): string => {
  let depth = 0;
  // No string in this query holds a parenthesis.
  return query.replace(/[()]/g, (paren) => {
    depth += paren === '(' ? 1 : -1;
    return depth === 0 ? ') @_open' : paren;
  });
};

describe('Python scope query: matches open at once', () => {
  const OPEN_MATCH_BUDGET = 64;
  const LINKS = 4000;
  const exceedsBudget = (query: Parser.Query, root: Parser.SyntaxNode): boolean => {
    query.matches(root, { matchLimit: OPEN_MATCH_BUDGET });
    return query.didExceedMatchLimit();
  };
  const scopeQuery = new Parser.Query(language, withRootCaptures(scopeQueryText));
  // One match open per link, like the rules this query no longer has. The
  // cursor and its capture lists are shared by the process and lists are never
  // freed, so a budget check passes for free once something has grown the
  // pool. This probe, on HALF the links, fails first if that happened.
  const onePerLink = new Parser.Query(
    language,
    '(attribute object: (_) attribute: (identifier)) @_open',
  );
  const halfChain = rootOf(`x = a${'.f'.repeat(LINKS / 2)}\n`);

  it('counts open matches: a rule open across its receiver exceeds the budget', () => {
    expect(exceedsBudget(onePerLink, halfChain)).toBe(true);
  });

  it.each([
    { shape: 'a call chain', source: `x = a${'.f()'.repeat(LINKS)}\n` },
    { shape: 'a call chain with arguments', source: `x = a${'.f(p, k=q)'.repeat(LINKS)}\n` },
    { shape: 'a call-only chain', source: `a${'()'.repeat(LINKS)}\n` },
    { shape: 'a member chain', source: `x = a${'.f'.repeat(LINKS)}\n` },
    { shape: 'a member-chain assignment target', source: `a${'.f'.repeat(LINKS)} = v\n` },
    { shape: 'a subscripted member chain', source: `x = a${'[0].f'.repeat(LINKS)}\n` },
    { shape: 'member terms', source: `x = ${'obj.value + '.repeat(LINKS)}obj.value\n` },
    { shape: 'bare terms', source: `x = ${'a + '.repeat(LINKS)}a\n` },
    { shape: 'boolean terms', source: `x = ${'a and '.repeat(LINKS)}a\n` },
  ])('stays within the budget across $shape', ({ source }) => {
    expect(exceedsBudget(scopeQuery, rootOf(source))).toBe(false);
    expect(exceedsBudget(onePerLink, halfChain)).toBe(true);
  });
});

describe('Python scope query on wide syntax', () => {
  const WIDTH = 70_000;
  const matchCount = (source: string, capture: string): number =>
    [...expandPythonScopeMatches(pythonScopeQueryMatches(rootOf(source)))].filter((match) =>
      match.some(({ name }) => name === capture),
    ).length;

  it.each([
    {
      shape: 'positional arguments',
      source: `f(${'a, '.repeat(WIDTH - 1)}a)\n`,
      capture: 'reference.value-ref',
    },
    {
      shape: 'keyword arguments',
      source: `f(${'k=a, '.repeat(WIDTH - 1)}k=a)\n`,
      capture: 'reference.value-ref',
    },
    {
      shape: 'member arguments',
      source: `f(${'a.b, '.repeat(WIDTH - 1)}a.b)\n`,
      capture: 'reference.read.member',
    },
    {
      shape: 'member-call statements',
      source: 'a.b(c)\n'.repeat(WIDTH),
      capture: 'reference.call.member',
    },
    {
      shape: 'comparison operands',
      source: `x = ${'a < '.repeat(WIDTH - 1)}a\n`,
      capture: 'reference.read.identifier',
    },
  ])('matches each of 70,000 $shape', ({ source, capture }) => {
    expect(matchCount(source, capture)).toBe(WIDTH);
  });
});

// tree-sitter's query cursor keeps the depth a match started at in 16 bits.
// Calls sit at every other level of a call chain, so 40,000 links are 80,000
// levels. Without a start-depth limit, a match started below level 65,535 gets
// a wrapped depth: it never finishes, is revisited at every later node (this
// query took 31 s), and matches again at the wrapped depth, which captured the
// arguments of the 7,234 outermost calls twice.
describe('Python scope query on a tree deeper than the cursor can count', () => {
  const LINKS = 40_000;
  let matches: (readonly Parser.QueryCapture[])[];
  beforeAll(() => {
    matches = [
      ...expandPythonScopeMatches(
        pythonScopeQueryMatches(rootOf(`x = a${'.f(p)'.repeat(LINKS)}\n`)),
      ),
    ];
  });
  const sites = (capture: string): number[] =>
    matches
      .filter((match) => match.some(({ name }) => name === capture))
      .map((match) => match[match.length - 1].node.startIndex);

  // The call of link k is at level 2k + 1 and its member name at 2k + 3.
  it.each([
    { capture: 'reference.call.member', count: 32_766 },
    { capture: 'reference.read.member', count: 32_766 },
    { capture: 'reference.value-ref', count: 32_767 },
  ])('captures each $capture above the limit once', ({ capture, count }) => {
    expect(sites(capture)).toHaveLength(count);
    expect(new Set(sites(capture)).size).toBe(count);
  });
});
