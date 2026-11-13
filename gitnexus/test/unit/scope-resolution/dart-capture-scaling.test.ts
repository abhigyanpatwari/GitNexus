import { describe, expect, it, vi } from 'vitest';
import type Parser from 'tree-sitter';
import { emitDartScopeCaptures } from '../../../src/core/ingestion/languages/dart/captures.js';
import { getDartParser } from '../../../src/core/ingestion/languages/dart/query.js';
import { isLanguageAvailable } from '../../../src/core/tree-sitter/parser-loader.js';
import { SupportedLanguages } from '../../../src/config/supported-languages.js';

/** Count real AST navigation, independent of scheduler and native-call latency. */
function captureWork(depth: number) {
  const source =
    'void f(Address cs, List<int> items) {\n' +
    'items.forEach((x) { cs.run();\n'.repeat(depth) +
    '});\n'.repeat(depth) +
    '}\n';
  const tree = getDartParser().parse(source);
  if (tree === null) throw new Error('Dart parse failed');
  let prototype = Object.getPrototypeOf(tree.rootNode) as Parser.SyntaxNode;
  while (!Object.hasOwn(prototype, 'parent')) prototype = Object.getPrototypeOf(prototype);
  const parent = vi.spyOn(prototype, 'parent', 'get');
  const child = vi.spyOn(prototype, 'namedChild');
  const children = vi.spyOn(prototype, 'namedChildren', 'get');
  const mapGet = vi.spyOn(Map.prototype, 'get');
  try {
    const matches = emitDartScopeCaptures(source, 'nested.dart', tree);
    expect(matches.filter((match) => match['@scope.function'])).toHaveLength(depth + 1);
    return {
      parents: parent.mock.calls.length,
      children: child.mock.calls.length + children.mock.calls.length,
      mapReads: mapGet.mock.calls.length,
    };
  } finally {
    vi.restoreAllMocks();
  }
}

describe.skipIf(!isLanguageAvailable(SupportedLanguages.Dart))('Dart nested capture work', () => {
  it('keeps ancestor and subtree visits linear as nesting grows', () => {
    const small = captureWork(6);
    const large = captureWork(24);
    // 4x more closures, with a little headroom for fixed grammar scaffolding.
    expect(large.parents).toBeLessThanOrEqual(small.parents * 5);
    expect(large.children).toBeLessThanOrEqual(small.children * 5);
    expect(large.mapReads).toBeLessThanOrEqual(small.mapReads * 4.5);
  });
});
