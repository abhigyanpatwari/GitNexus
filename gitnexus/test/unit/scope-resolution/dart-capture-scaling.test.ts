import { describe, expect, it, vi } from 'vitest';
import type Parser from 'tree-sitter';
import { emitDartScopeCaptures } from '../../../src/core/ingestion/languages/dart/captures.js';
import { getDartParser } from '../../../src/core/ingestion/languages/dart/query.js';
import { isLanguageAvailable } from '../../../src/core/tree-sitter/parser-loader.js';
import { SupportedLanguages } from '../../../src/config/supported-languages.js';

/** Count real AST navigation, independent of scheduler and native-call latency. */
function captureWork(depth: number, form: 'argument' | 'bound') {
  const source =
    'void f(Address cs, List<int> items) {\n' +
    Array.from({ length: depth }, (_, i) =>
      form === 'bound' ? `var h${i} = (x) { cs.run();\n` : 'items.forEach((x) { cs.run();\n',
    ).join('') +
    (form === 'bound' ? '};\n' : '});\n').repeat(depth) +
    '}\n';
  emitDartScopeCaptures('void warmup() {}', 'warmup.dart');
  const tree = getDartParser().parse(source);
  if (tree === null) throw new Error('Dart parse failed');
  let prototype = Object.getPrototypeOf(tree.rootNode) as Parser.SyntaxNode;
  while (!Object.hasOwn(prototype, 'parent')) prototype = Object.getPrototypeOf(prototype);
  const parent = vi.spyOn(prototype, 'parent', 'get');
  const child = vi.spyOn(prototype, 'namedChild');
  const children = vi.spyOn(prototype, 'namedChildren', 'get');
  const get = Map.prototype.get;
  let mapReads = 0;
  vi.spyOn(Map.prototype, 'get').mockImplementation(function (
    this: Map<unknown, unknown>,
    key: unknown,
  ) {
    // tree-sitter's temporary wrapper cache uses bigint IDs; its reads depend on GC.
    if (typeof key !== 'bigint') mapReads++;
    return get.call(this, key);
  });
  try {
    const matches = emitDartScopeCaptures(source, 'nested.dart', tree);
    const work = {
      parents: parent.mock.calls.length,
      children: child.mock.calls.length + children.mock.calls.length,
      mapReads,
    };
    expect(matches.filter((match) => match['@scope.function']).length).toBe(depth + 1);
    return work;
  } finally {
    vi.restoreAllMocks();
  }
}

describe.skipIf(!isLanguageAvailable(SupportedLanguages.Dart))('Dart nested capture work', () => {
  // Per form: child reads and Map reads as slope * depth + constant.
  it.each([
    ['argument', 120, 58, 53, 31],
    ['bound', 93, 56, 41, 29],
  ] as const)(
    'keeps %s closure work linear as nesting grows',
    (form, childSlope, childBase, mapSlope, mapBase) => {
      for (const depth of [6, 24]) {
        const work = captureWork(depth, form);
        // Native parent reads themselves cost depth, so their count must stay flat.
        expect(work.parents).toBe(3);
        expect(work.children).toBe(childSlope * depth + childBase);
        expect(work.mapReads).toBe(mapSlope * depth + mapBase);
      }
    },
  );
});
