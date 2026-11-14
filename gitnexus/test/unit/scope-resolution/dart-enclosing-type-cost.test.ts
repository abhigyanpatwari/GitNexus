import { isDeepStrictEqual } from 'node:util';
import { describe, expect, it, vi } from 'vitest';
import type Parser from 'tree-sitter';
import type { CaptureMatch } from 'gitnexus-shared';
import { emitDartScopeCaptures } from '../../../src/core/ingestion/languages/dart/captures.js';
import { getDartParser } from '../../../src/core/ingestion/languages/dart/query.js';
import { synthesizeDartReceiverBinding } from '../../../src/core/ingestion/languages/dart/receiver-binding.js';
import { isLanguageAvailable } from '../../../src/core/tree-sitter/parser-loader.js';
import { SupportedLanguages } from '../../../src/config/supported-languages.js';

function inlineNest(depth: number, host: string, close: string): string {
  let body = '';
  for (let j = 0; j < depth; j++) body += `  items.forEach((x${j}) { x${j}.save();\n`;
  return `${host}\n${body}${'  });\n'.repeat(depth)}${close}`;
}

function namedNest(depth: number): string {
  let body = '';
  for (let j = 0; j < depth; j++) body += `  var h${j} = (x${j}) { x${j}.save();\n`;
  return `void f(List<int> items) {\n${body}${'  };\n'.repeat(depth)}}\n`;
}

const thisTypes = (matches: readonly CaptureMatch[]): string[] =>
  matches
    .filter((m) => m['@type-binding.self'] && m['@type-binding.name']?.text === 'this')
    .map((m) => m['@type-binding.type']!.text);

/** Count native navigation, including helper calls outside the capture walk. */
function cost(source: string) {
  const tree = getDartParser().parse(source);
  if (tree === null) throw new Error('Dart parse failed');
  expect(tree.rootNode.hasError).toBe(false);
  let prototype = Object.getPrototypeOf(tree.rootNode) as Parser.SyntaxNode;
  while (!Object.hasOwn(prototype, 'parent')) prototype = Object.getPrototypeOf(prototype);
  const parent = vi.spyOn(prototype, 'parent', 'get');
  const previous = vi.spyOn(prototype, 'previousSibling', 'get');
  const previousNamed = vi.spyOn(prototype, 'previousNamedSibling', 'get');
  try {
    const matches = emitDartScopeCaptures(source, 'lib/nest.dart', tree);
    return {
      parents: parent.mock.calls.length,
      siblings: previous.mock.calls.length + previousNamed.mock.calls.length,
      scopes: matches.filter((m) => m['@scope.function']).length,
      matches,
    };
  } finally {
    parent.mockRestore();
    previous.mockRestore();
    previousNamed.mockRestore();
  }
}

describe.skipIf(!isLanguageAvailable(SupportedLanguages.Dart))('Dart enclosing-type cost', () => {
  it('keeps parent reads flat for inline closures without an enclosing type', () => {
    const shallow = cost(inlineNest(8, 'void f(List<int> items) {', '}\n'));
    const deep = cost(inlineNest(64, 'void f(List<int> items) {', '}\n'));
    expect(isDeepStrictEqual([shallow.scopes, deep.scopes], [9, 65])).toBe(true);
    expect(isDeepStrictEqual(thisTypes(deep.matches), [])).toBe(true);
    expect(deep.parents).toBe(shallow.parents);
    expect(deep.siblings).toBe(0);
  });

  it('keeps parent reads linear for closures bound to nested locals', () => {
    const [d8, d16, d64] = [8, 16, 64].map((depth) => cost(namedNest(depth)));
    expect(isDeepStrictEqual([d8.scopes, d16.scopes, d64.scopes], [9, 17, 65])).toBe(true);
    expect(isDeepStrictEqual(thisTypes(d64.matches), [])).toBe(true);
    for (const cost of [d8, d16, d64]) expect(cost.parents).toBe(3);
    expect(d64.siblings).toBe(0);
  });

  it('binds the operator receiver once without parent or sibling climbs', () => {
    const nested = (depth: number) =>
      cost(inlineNest(depth, 'class Svc { int operator +(List<int> items) {', 'return 0; } }\n'));
    const shallow = nested(8);
    const deep = nested(64);
    expect(isDeepStrictEqual([shallow.scopes, deep.scopes], [8, 64])).toBe(true);
    expect(isDeepStrictEqual(thisTypes(deep.matches), ['Svc'])).toBe(true);
    expect(deep.parents).toBe(shallow.parents);
    expect(deep.siblings).toBe(0);
  });

  it('preserves the legacy static check for annotated members, fields and closures', () => {
    const tree = getDartParser().parse(`
      class Svc extends Base {
        @deprecated static void staticMethod() { var named = () {}; }
        @deprecated void instanceMethod() { var named = () {}; }
        static int get count => 0;
        int get size => 1;
        static final action = () {};
        final instanceAction = () {};
        int operator +(Svc other) { return 0; }
      }
    `);
    if (tree === null) throw new Error('Dart parse failed');
    expect(tree.rootNode.hasError).toBe(false);
    const enclosingType = tree.rootNode.namedChildren[0]!;
    const staticBefore = new Map<number, boolean>();
    const stack = [enclosingType];
    while (stack.length > 0) {
      const parent = stack.pop()!;
      for (const node of parent.children) {
        const legacy = synthesizeDartReceiverBinding(node, node, enclosingType);
        expect(
          isDeepStrictEqual(
            synthesizeDartReceiverBinding(node, node, enclosingType, { parent, staticBefore }),
            legacy,
          ),
        ).toBe(true);
        if (node.isNamed) stack.push(node);
      }
    }
  });
});
