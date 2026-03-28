import { describe, it, expect } from 'vitest';
import { routeRubyCall } from '../../../src/core/ingestion/call-routing.js';

// ── Mock AST node helpers ────────────────────────────────────────────────────

/**
 * Build a minimal mock tree-sitter node. Only the fields actually accessed
 * by routeRubyCall are populated; everything else is left undefined so that
 * accidental property reads surface as undefined (the same as a real node
 * that lacks the field) rather than silently returning a wrong value.
 */

interface MockNode {
  type: string;
  text: string;
  isNamed?: boolean;
  startPosition?: { row: number; col?: number };
  endPosition?: { row: number; col?: number };
  children?: MockNode[];
  parent?: MockNode | null;
  previousSibling?: MockNode | null;
  childForFieldName?: (name: string) => MockNode | undefined;
}

/** Build a string node as tree-sitter-ruby emits it: string → string_content */
function makeStringNode(content: string): MockNode {
  const contentNode: MockNode = { type: 'string_content', text: content };
  return {
    type: 'string',
    text: `"${content}"`,
    children: [contentNode],
  };
}

/**
 * Build a mock `call` node for require/require_relative with a single string
 * argument.
 */
function makeRequireCallNode(path: string | null): MockNode {
  const argChildren: MockNode[] = path !== null ? [makeStringNode(path)] : [];
  const argList: MockNode = { type: 'argument_list', text: '', children: argChildren };
  const node: MockNode = {
    type: 'call',
    text: '',
    childForFieldName: (name: string) => (name === 'arguments' ? argList : undefined),
  };
  return node;
}

/**
 * Build a call node where the argument list contains a string node whose
 * string_content child is absent (simulates a non-literal string argument).
 */
function makeRequireCallNodeNoContent(): MockNode {
  const stringNodeNoContent: MockNode = { type: 'string', text: '""', children: [] };
  const argList: MockNode = { type: 'argument_list', text: '', children: [stringNodeNoContent] };
  return {
    type: 'call',
    text: '',
    childForFieldName: (name: string) => (name === 'arguments' ? argList : undefined),
  };
}

/** Build a mock call node for include/extend/prepend with a chain of parents. */
function makeHeritageCallNode(
  argNodes: MockNode[],
  enclosingType: 'class' | 'module' | null,
  enclosingName: string | null,
  extraDepth = 0,
): MockNode {
  const argList: MockNode = { type: 'argument_list', text: '', children: argNodes };
  const callNode: MockNode = {
    type: 'call',
    text: '',
    parent: null,
    childForFieldName: (name: string) => (name === 'arguments' ? argList : undefined),
  };

  if (enclosingType === null) {
    // No enclosing class at all — parent chain ends without a class/module node
    const intermediate: MockNode = { type: 'body', text: '', parent: null };
    callNode.parent = intermediate;
    return callNode;
  }

  // Build extra intermediate nodes to test deep parent walking
  let leaf: MockNode = callNode;
  for (let i = 0; i < extraDepth; i++) {
    const wrapper: MockNode = { type: 'body_statement', text: '', parent: null };
    leaf.parent = wrapper;
    leaf = wrapper;
  }

  const nameNode: MockNode | undefined = enclosingName
    ? { type: 'constant', text: enclosingName }
    : undefined;

  const classNode: MockNode = {
    type: enclosingType,
    text: '',
    parent: null,
    childForFieldName: (name: string) => (name === 'name' ? nameNode : undefined),
  };
  leaf.parent = classNode;

  return callNode;
}

/** Build a constant arg node (used as mixin name) */
function makeConstantArg(text: string): MockNode {
  return { type: 'constant', text };
}

/** Build a scope_resolution arg node (e.g. Foo::Bar) */
function makeScopeResolutionArg(text: string): MockNode {
  return { type: 'scope_resolution', text };
}

/** Build an identifier arg that is neither constant nor scope_resolution */
function makeIdentifierArg(text: string): MockNode {
  return { type: 'identifier', text };
}

/** Build a simple_symbol arg (used in attr_accessor etc.) */
function makeSimpleSymbol(name: string, row = 0): MockNode {
  return {
    type: 'simple_symbol',
    text: `:${name}`,
    startPosition: { row },
    endPosition: { row },
  };
}

/**
 * Build a call node for attr_accessor/attr_reader/attr_writer with optional
 * preceding comment siblings.
 */
function makeAccessorCallNode(symbolArgs: MockNode[], previousSiblings: MockNode[] = []): MockNode {
  const argList: MockNode = { type: 'argument_list', text: '', children: symbolArgs };

  // Link previousSiblings as a chain (last element is the direct previousSibling)
  let prevSibling: MockNode | null = null;
  for (const s of previousSiblings) {
    s.previousSibling = prevSibling;
    prevSibling = s;
  }

  const callNode: MockNode = {
    type: 'call',
    text: '',
    previousSibling: prevSibling,
    childForFieldName: (name: string) => (name === 'arguments' ? argList : undefined),
  };
  return callNode;
}

/** Build a comment node (isNamed = false by default, matching real tree-sitter Ruby) */
function makeCommentNode(text: string, named = false): MockNode {
  return { type: 'comment', text, isNamed: named };
}

/** Build a named non-comment sibling (causes yard-scan loop to stop) */
function makeNamedSibling(type = 'expression_statement'): MockNode {
  return { type, text: '', isNamed: true };
}

// ── require / require_relative ───────────────────────────────────────────────

describe('routeRubyCall — require / require_relative', () => {
  it('require with a valid string path returns import with isRelative=false', () => {
    const node = makeRequireCallNode('net/http');
    const result = routeRubyCall('require', node);

    expect(result).toEqual({ kind: 'import', importPath: 'net/http', isRelative: false });
  });

  it('require_relative without leading dot prepends "./"', () => {
    const node = makeRequireCallNode('models/user');
    const result = routeRubyCall('require_relative', node);

    expect(result).toEqual({ kind: 'import', importPath: './models/user', isRelative: true });
  });

  it('require_relative with path already starting with "." does not double-prepend', () => {
    const node = makeRequireCallNode('./helpers/formatter');
    const result = routeRubyCall('require_relative', node);

    expect(result).toEqual({ kind: 'import', importPath: './helpers/formatter', isRelative: true });
  });

  it('require_relative with "../" prefix is left unchanged', () => {
    const node = makeRequireCallNode('../shared/utils');
    const result = routeRubyCall('require_relative', node);

    expect(result).toEqual({ kind: 'import', importPath: '../shared/utils', isRelative: true });
  });

  it('returns skip when there is no string_content node (non-literal argument)', () => {
    const node = makeRequireCallNodeNoContent();
    expect(routeRubyCall('require', node)).toEqual({ kind: 'skip' });
  });

  it('returns skip when import path is an empty string', () => {
    const node = makeRequireCallNode('');
    expect(routeRubyCall('require', node)).toEqual({ kind: 'skip' });
  });

  it('returns skip when import path contains a control character (\\x00)', () => {
    const node = makeRequireCallNode('some\x00path');
    expect(routeRubyCall('require', node)).toEqual({ kind: 'skip' });
  });

  it('returns skip when import path contains a newline control character (\\n)', () => {
    const node = makeRequireCallNode('path\ninjection');
    expect(routeRubyCall('require', node)).toEqual({ kind: 'skip' });
  });

  it('returns skip when import path exceeds 1024 characters', () => {
    const longPath = 'a'.repeat(1025);
    const node = makeRequireCallNode(longPath);
    expect(routeRubyCall('require', node)).toEqual({ kind: 'skip' });
  });

  it('accepts import path of exactly 1024 characters', () => {
    const maxPath = 'a'.repeat(1024);
    const node = makeRequireCallNode(maxPath);
    const result = routeRubyCall('require', node);
    expect(result).toEqual({ kind: 'import', importPath: maxPath, isRelative: false });
  });

  it('returns skip when argument list has no string child at all', () => {
    // argList has only a non-string child
    const argList: MockNode = {
      type: 'argument_list',
      text: '',
      children: [{ type: 'identifier', text: 'MY_CONST' }],
    };
    const node: MockNode = {
      type: 'call',
      text: '',
      childForFieldName: (name: string) => (name === 'arguments' ? argList : undefined),
    };
    expect(routeRubyCall('require', node)).toEqual({ kind: 'skip' });
  });

  it('returns skip when childForFieldName is absent (undefined callNode fields)', () => {
    // callNode has no childForFieldName method at all
    const node: MockNode = { type: 'call', text: '' };
    expect(routeRubyCall('require', node)).toEqual({ kind: 'skip' });
  });
});

// ── include / extend / prepend ───────────────────────────────────────────────

describe('routeRubyCall — include / extend / prepend', () => {
  it('include with a single constant arg inside a class returns heritage', () => {
    const node = makeHeritageCallNode([makeConstantArg('Serializable')], 'class', 'User');
    const result = routeRubyCall('include', node);

    expect(result).toEqual({
      kind: 'heritage',
      items: [{ enclosingClass: 'User', mixinName: 'Serializable', heritageKind: 'include' }],
    });
  });

  it('extend with a scope_resolution arg (Foo::Bar) returns heritage', () => {
    const node = makeHeritageCallNode(
      [makeScopeResolutionArg('ActiveSupport::Concern')],
      'class',
      'Post',
    );
    const result = routeRubyCall('extend', node);

    expect(result).toEqual({
      kind: 'heritage',
      items: [
        { enclosingClass: 'Post', mixinName: 'ActiveSupport::Concern', heritageKind: 'extend' },
      ],
    });
  });

  it('prepend records heritageKind as "prepend"', () => {
    const node = makeHeritageCallNode([makeConstantArg('Instrumented')], 'class', 'Service');
    const result = routeRubyCall('prepend', node);

    expect(result).toEqual({
      kind: 'heritage',
      items: [{ enclosingClass: 'Service', mixinName: 'Instrumented', heritageKind: 'prepend' }],
    });
  });

  it('include inside a module (not a class) still resolves enclosing name', () => {
    const node = makeHeritageCallNode([makeConstantArg('Helpers')], 'module', 'ApplicationHelper');
    const result = routeRubyCall('include', node);

    expect(result).toEqual({
      kind: 'heritage',
      items: [
        { enclosingClass: 'ApplicationHelper', mixinName: 'Helpers', heritageKind: 'include' },
      ],
    });
  });

  it('include with multiple constant args produces one item per arg', () => {
    const args = [makeConstantArg('Mod1'), makeConstantArg('Mod2'), makeConstantArg('Mod3')];
    const node = makeHeritageCallNode(args, 'class', 'MyClass');
    const result = routeRubyCall('include', node);

    expect(result).toEqual({
      kind: 'heritage',
      items: [
        { enclosingClass: 'MyClass', mixinName: 'Mod1', heritageKind: 'include' },
        { enclosingClass: 'MyClass', mixinName: 'Mod2', heritageKind: 'include' },
        { enclosingClass: 'MyClass', mixinName: 'Mod3', heritageKind: 'include' },
      ],
    });
  });

  it('returns skip when no enclosing class or module is found in parent chain', () => {
    const node = makeHeritageCallNode([makeConstantArg('Mod')], null, null);
    expect(routeRubyCall('include', node)).toEqual({ kind: 'skip' });
  });

  it('returns skip when enclosing class node has no name child', () => {
    // nameNode is undefined — childForFieldName('name') returns undefined
    const argList: MockNode = {
      type: 'argument_list',
      text: '',
      children: [makeConstantArg('Mod')],
    };
    const classNode: MockNode = {
      type: 'class',
      text: '',
      parent: null,
      childForFieldName: (_name: string) => undefined,
    };
    const bodyNode: MockNode = { type: 'body', text: '', parent: classNode };
    const callNode: MockNode = {
      type: 'call',
      text: '',
      parent: bodyNode,
      childForFieldName: (name: string) => (name === 'arguments' ? argList : undefined),
    };
    expect(routeRubyCall('include', callNode)).toEqual({ kind: 'skip' });
  });

  it('returns skip when arg list contains only non-constant/non-scope_resolution args', () => {
    const node = makeHeritageCallNode([makeIdentifierArg('some_var')], 'class', 'Foo');
    expect(routeRubyCall('include', node)).toEqual({ kind: 'skip' });
  });

  it('returns skip when arg list is empty', () => {
    const node = makeHeritageCallNode([], 'class', 'Foo');
    expect(routeRubyCall('include', node)).toEqual({ kind: 'skip' });
  });

  it('walks nested scopes to find the nearest enclosing class', () => {
    // callNode is 5 levels deep inside a class body
    const node = makeHeritageCallNode([makeConstantArg('DeepMixin')], 'class', 'DeepClass', 5);
    const result = routeRubyCall('include', node);

    expect(result).toEqual({
      kind: 'heritage',
      items: [{ enclosingClass: 'DeepClass', mixinName: 'DeepMixin', heritageKind: 'include' }],
    });
  });

  it('returns skip when parent depth exceeds MAX_PARENT_DEPTH (50)', () => {
    // Build a chain of 51 intermediate nodes with no class/module in it
    const argList: MockNode = {
      type: 'argument_list',
      text: '',
      children: [makeConstantArg('Mod')],
    };
    const callNode: MockNode = {
      type: 'call',
      text: '',
      parent: null,
      childForFieldName: (name: string) => (name === 'arguments' ? argList : undefined),
    };

    let current: MockNode = callNode;
    // Create 51 parents — all plain body nodes, never a class/module
    for (let i = 0; i < 51; i++) {
      const parent: MockNode = { type: 'body_statement', text: '', parent: null };
      current.parent = parent;
      current = parent;
    }

    expect(routeRubyCall('include', callNode)).toEqual({ kind: 'skip' });
  });

  it('finds class at exactly depth 50 (boundary — must succeed)', () => {
    // 49 plain wrappers, then the class at depth 50
    const argList: MockNode = {
      type: 'argument_list',
      text: '',
      children: [makeConstantArg('BoundaryMixin')],
    };
    const callNode: MockNode = {
      type: 'call',
      text: '',
      parent: null,
      childForFieldName: (name: string) => (name === 'arguments' ? argList : undefined),
    };

    let leaf: MockNode = callNode;
    for (let i = 0; i < 49; i++) {
      const wrapper: MockNode = { type: 'body_statement', text: '', parent: null };
      leaf.parent = wrapper;
      leaf = wrapper;
    }

    const nameNode: MockNode = { type: 'constant', text: 'BoundaryClass' };
    const classNode: MockNode = {
      type: 'class',
      text: '',
      parent: null,
      childForFieldName: (name: string) => (name === 'name' ? nameNode : undefined),
    };
    leaf.parent = classNode;

    const result = routeRubyCall('include', callNode);
    expect(result).toEqual({
      kind: 'heritage',
      items: [
        { enclosingClass: 'BoundaryClass', mixinName: 'BoundaryMixin', heritageKind: 'include' },
      ],
    });
  });

  it('skips non-constant args mixed with constant args, collecting only constants', () => {
    const args = [
      makeIdentifierArg('local_var'),
      makeConstantArg('ValidMixin'),
      makeIdentifierArg('another_var'),
    ];
    const node = makeHeritageCallNode(args, 'class', 'Foo');
    const result = routeRubyCall('include', node);

    expect(result).toEqual({
      kind: 'heritage',
      items: [{ enclosingClass: 'Foo', mixinName: 'ValidMixin', heritageKind: 'include' }],
    });
  });
});

// ── attr_accessor / attr_reader / attr_writer ────────────────────────────────

describe('routeRubyCall — attr_accessor / attr_reader / attr_writer', () => {
  it('attr_accessor with a single symbol returns a property item', () => {
    const node = makeAccessorCallNode([makeSimpleSymbol('name', 5)]);
    const result = routeRubyCall('attr_accessor', node);

    expect(result).toEqual({
      kind: 'properties',
      items: [{ propName: 'name', accessorType: 'attr_accessor', startLine: 5, endLine: 5 }],
    });
  });

  it('attr_reader sets accessorType to "attr_reader"', () => {
    const node = makeAccessorCallNode([makeSimpleSymbol('age', 3)]);
    const result = routeRubyCall('attr_reader', node);

    expect(result).toEqual({
      kind: 'properties',
      items: [{ propName: 'age', accessorType: 'attr_reader', startLine: 3, endLine: 3 }],
    });
  });

  it('attr_writer sets accessorType to "attr_writer"', () => {
    const node = makeAccessorCallNode([makeSimpleSymbol('email', 7)]);
    const result = routeRubyCall('attr_writer', node);

    expect(result).toEqual({
      kind: 'properties',
      items: [{ propName: 'email', accessorType: 'attr_writer', startLine: 7, endLine: 7 }],
    });
  });

  it('strips leading colon from symbol text', () => {
    // makeSimpleSymbol already prefixes with ':', this validates the slice(1) branch
    const symNode: MockNode = {
      type: 'simple_symbol',
      text: ':title',
      startPosition: { row: 2 },
      endPosition: { row: 2 },
    };
    const node = makeAccessorCallNode([symNode]);
    const result = routeRubyCall('attr_accessor', node);

    expect(result).toMatchObject({ kind: 'properties', items: [{ propName: 'title' }] });
  });

  it('handles symbol text without colon prefix (no double-strip)', () => {
    // Simulate a symbol whose text does NOT start with ':'
    const symNode: MockNode = {
      type: 'simple_symbol',
      text: 'status',
      startPosition: { row: 1 },
      endPosition: { row: 1 },
    };
    const node = makeAccessorCallNode([symNode]);
    const result = routeRubyCall('attr_accessor', node);

    expect(result).toMatchObject({ kind: 'properties', items: [{ propName: 'status' }] });
  });

  it('multiple symbols produce one item each', () => {
    const args = [
      makeSimpleSymbol('first_name', 10),
      makeSimpleSymbol('last_name', 10),
      makeSimpleSymbol('dob', 10),
    ];
    const node = makeAccessorCallNode(args);
    const result = routeRubyCall('attr_accessor', node);

    expect(result).toEqual({
      kind: 'properties',
      items: [
        { propName: 'first_name', accessorType: 'attr_accessor', startLine: 10, endLine: 10 },
        { propName: 'last_name', accessorType: 'attr_accessor', startLine: 10, endLine: 10 },
        { propName: 'dob', accessorType: 'attr_accessor', startLine: 10, endLine: 10 },
      ],
    });
  });

  it('extracts simple YARD @return [Type] from preceding comment', () => {
    const comment = makeCommentNode('# @return [Address]');
    const node = makeAccessorCallNode([makeSimpleSymbol('address', 20)], [comment]);
    const result = routeRubyCall('attr_accessor', node);

    expect(result).toMatchObject({
      kind: 'properties',
      items: [{ propName: 'address', declaredType: 'Address' }],
    });
  });

  it('extracts only the leading type name from compound YARD type (Array<User> → "Array")', () => {
    // The regex captures "Array<User>"; the simple match grabs the first uppercase word "Array"
    const comment = makeCommentNode('# @return [Array<User>]');
    const node = makeAccessorCallNode([makeSimpleSymbol('users', 15)], [comment]);
    const result = routeRubyCall('attr_accessor', node);

    expect(result).toMatchObject({
      kind: 'properties',
      items: [{ declaredType: 'Array' }],
    });
  });

  it('extracts type from YARD comment with extra whitespace inside brackets', () => {
    const comment = makeCommentNode('#  @return [  Integer  ]');
    const node = makeAccessorCallNode([makeSimpleSymbol('count', 8)], [comment]);
    const result = routeRubyCall('attr_accessor', node);

    expect(result).toMatchObject({
      kind: 'properties',
      items: [{ declaredType: 'Integer' }],
    });
  });

  it('does not set declaredType when no YARD comment precedes the call', () => {
    const node = makeAccessorCallNode([makeSimpleSymbol('score', 12)]);
    const result = routeRubyCall('attr_accessor', node);

    expect(result).toMatchObject({ kind: 'properties', items: [{ propName: 'score' }] });
    const item = (result as any).items[0];
    expect(item.declaredType).toBeUndefined();
  });

  it('does not set declaredType when comment has no @return annotation', () => {
    const comment = makeCommentNode('# This accessor stores the user name');
    const node = makeAccessorCallNode([makeSimpleSymbol('user_name', 9)], [comment]);
    const result = routeRubyCall('attr_accessor', node);

    const item = (result as any).items[0];
    expect(item.declaredType).toBeUndefined();
  });

  it('does not set declaredType when YARD type starts with lowercase (not ^[A-Z])', () => {
    // e.g. "@return [string]" — lowercase first char fails the simple = raw.match(/^([A-Z]\w*)/)
    const comment = makeCommentNode('# @return [string]');
    const node = makeAccessorCallNode([makeSimpleSymbol('label', 4)], [comment]);
    const result = routeRubyCall('attr_accessor', node);

    const item = (result as any).items[0];
    expect(item.declaredType).toBeUndefined();
  });

  it('stops sibling scan at a non-comment named sibling before reaching a comment', () => {
    // Ordered as [comment, namedSibling] — namedSibling is the direct previousSibling,
    // so the scan hits it first and stops before reading the comment
    const yardComment = makeCommentNode('# @return [User]');
    const named = makeNamedSibling();
    const node = makeAccessorCallNode([makeSimpleSymbol('owner', 6)], [yardComment, named]);
    // named is last in the array → becomes direct previousSibling
    const result = routeRubyCall('attr_accessor', node);

    const item = (result as any).items[0];
    expect(item.declaredType).toBeUndefined();
  });

  it('continues past unnamed (non-named) siblings to find a YARD comment', () => {
    // An unnamed whitespace/punctuation node between the comment and the call
    const unnamedNode: MockNode = { type: 'newline', text: '\n', isNamed: false };
    const comment = makeCommentNode('# @return [Order]');
    // siblings in order oldest→newest; the last becomes the direct previousSibling
    const node = makeAccessorCallNode([makeSimpleSymbol('order', 30)], [comment, unnamedNode]);
    const result = routeRubyCall('attr_accessor', node);

    expect(result).toMatchObject({
      kind: 'properties',
      items: [{ declaredType: 'Order' }],
    });
  });

  it('returns skip when arg list contains no simple_symbol nodes', () => {
    // Only an identifier node — not a symbol
    const identArg: MockNode = { type: 'identifier', text: 'some_var' };
    const node = makeAccessorCallNode([identArg]);
    expect(routeRubyCall('attr_accessor', node)).toEqual({ kind: 'skip' });
  });

  it('returns skip when arg list is empty', () => {
    const node = makeAccessorCallNode([]);
    expect(routeRubyCall('attr_accessor', node)).toEqual({ kind: 'skip' });
  });

  it('records correct startLine and endLine from symbol node positions', () => {
    const sym: MockNode = {
      type: 'simple_symbol',
      text: ':created_at',
      startPosition: { row: 42 },
      endPosition: { row: 42 },
    };
    const node = makeAccessorCallNode([sym]);
    const result = routeRubyCall('attr_accessor', node);

    expect(result).toMatchObject({
      kind: 'properties',
      items: [{ startLine: 42, endLine: 42 }],
    });
  });
});

// ── default case ─────────────────────────────────────────────────────────────

describe('routeRubyCall — default (unknown method name)', () => {
  it('returns {kind: "call"} for an arbitrary method name', () => {
    const node: MockNode = { type: 'call', text: '' };
    expect(routeRubyCall('some_method', node)).toEqual({ kind: 'call' });
  });

  it('returns {kind: "call"} for an empty method name string', () => {
    const node: MockNode = { type: 'call', text: '' };
    expect(routeRubyCall('', node)).toEqual({ kind: 'call' });
  });

  it('returns {kind: "call"} for a realistic method name (save, render, etc.)', () => {
    const node: MockNode = { type: 'call', text: '' };
    expect(routeRubyCall('render', node)).toEqual({ kind: 'call' });
    expect(routeRubyCall('save', node)).toEqual({ kind: 'call' });
    expect(routeRubyCall('destroy', node)).toEqual({ kind: 'call' });
  });
});

// ── routeRubyCall passthrough ────────────────────────────────────────────────

describe('routeRubyCall passthrough', () => {
  it('routeRubyCall delegates correctly for require', () => {
    const node = makeRequireCallNode('json');
    const result = routeRubyCall('require', node);
    expect(result).toEqual({ kind: 'import', importPath: 'json', isRelative: false });
  });

  it('routeRubyCall returns {kind: "call"} for an unknown method name', () => {
    const node: MockNode = { type: 'call', text: '' };
    const result = routeRubyCall('render', node);
    expect(result).toEqual({ kind: 'call' });
  });
});
