import type Parser from 'tree-sitter';
import { describe, expect, it } from 'vitest';
import { walkNamedTree } from '../../../../src/core/ingestion/utils/ast-helpers.js';
import { getPythonParser } from '../../../../src/core/ingestion/languages/python/query.js';
import { getTreeSitterBufferSize } from '../../../../src/core/ingestion/constants.js';
import { parseSourceSafe } from '../../../../src/core/tree-sitter/safe-parse.js';

type SyntaxNode = Parser.SyntaxNode;

const parse = (source: string): SyntaxNode =>
  parseSourceSafe(getPythonParser(), source, undefined, {
    bufferSize: getTreeSitterBufferSize(source),
  })!.rootNode;

// The previous recursive algorithm, kept as the order oracle.
const referenceWalk = (node: SyntaxNode, cb: (node: SyntaxNode) => void): void => {
  cb(node);
  for (let i = 0; i < node.namedChildCount; i++) referenceWalk(node.namedChild(i)!, cb);
};

const label = (node: SyntaxNode): string => `${node.type}@${node.startIndex}`;

describe('walkNamedTree', () => {
  const sources: Record<string, string> = {
    'a function with a nested call': 'def f(a, b=1):\n    return g(a, h(b))\n',
    'a class with a comprehension': 'class C:\n    xs = [i * 2 for i in range(3) if i]\n',
    'a syntax error with ERROR nodes': 'def f(:\n    x = (1,\nclass\n',
    'a generator with a MISSING identifier': '(a for in b)\n',
    'a not-in operator split by a comment': 'x = (a not  # c\n in b)\n',
  };

  it.each(Object.entries(sources))('visits %s in the recursive pre-order', (_name, source) => {
    const root = parse(source);
    const expected: string[] = [];
    referenceWalk(root, (node) => expected.push(label(node)));
    const actual: string[] = [];
    walkNamedTree(root, (node) => actual.push(label(node)));
    expect(actual.length).toBeGreaterThan(1);
    expect(actual).toEqual(expected);
  });

  it('walks 20,000 nested lists without overflowing the stack', () => {
    const source = `x = ${'['.repeat(20_000)}a${']'.repeat(20_000)}\n`;
    const root = parse(source);
    let lists = 0;
    walkNamedTree(root, (node) => {
      lists += Number(node.type === 'list');
    });
    expect(lists).toBe(20_000);
  });
});
