import { describe, expect, it } from 'vitest';
import Parser from 'tree-sitter';
import { requireVendoredGrammar } from '../../src/core/tree-sitter/vendored-grammars.js';

const Kotlin = requireVendoredGrammar('tree-sitter-kotlin');

describe('vendored Kotlin grammar', () => {
  it.each(['\n', '\n// comment\n', '\n/* comment */\n'])(
    'preserves inheritance after trivia %j',
    (trivia) => {
      const parser = new Parser();
      parser.setLanguage(Kotlin);
      const tree = parser.parse(`class Child${trivia}: Parent() {}`);
      expect(tree.rootNode.hasError).toBe(false);
      expect(tree.rootNode.namedChildren.map((node) => node.type)).toEqual(['class_declaration']);
      expect(
        tree.rootNode.descendantsOfType('delegation_specifier').map((node) => node.text),
      ).toEqual(['Parent()']);
    },
  );

  it.each(['\n', '\n// comment\n', '\n/* comment */\n'])(
    'starts a callable reference statement after trivia %j',
    (trivia) => {
      const parser = new Parser();
      parser.setLanguage(Kotlin);
      const tree = parser.parse(`fun f() { foo()${trivia}::bar\n}`);
      expect(tree.rootNode.hasError).toBe(false);
      const statements = tree.rootNode.descendantsOfType('statements')[0];
      expect(
        statements.namedChildren
          .filter((node) => !node.type.endsWith('_comment'))
          .map((node) => [node.type, node.text]),
      ).toEqual([
        ['call_expression', 'foo()'],
        ['callable_reference', '::bar'],
      ]);
    },
  );

  it('attaches a labeled trailing lambda across a newline', () => {
    const parser = new Parser();
    parser.setLanguage(Kotlin);
    const tree = parser.parse('fun f() { foo()\nlabel@ { bar() }\n}');
    expect(tree.rootNode.hasError).toBe(false);
    const statements = tree.rootNode.descendantsOfType('statements')[0];
    expect(statements.namedChildren.map((node) => node.type)).toEqual(['call_expression']);
    expect(statements.namedChildren[0].text).toBe('foo()\nlabel@ { bar() }');
  });

  it('ends a line comment at a bare carriage return without losing the declaration', () => {
    const parser = new Parser();
    parser.setLanguage(Kotlin);
    const tree = parser.parse('fun f() {\n// comment\rval x = 1\n}');
    expect(tree.rootNode.hasError).toBe(false);
    expect(tree.rootNode.descendantsOfType('line_comment').map((node) => node.text)).toEqual([
      '// comment',
    ]);
    expect(
      tree.rootNode.descendantsOfType('property_declaration').map((node) => node.text),
    ).toEqual(['val x = 1']);
  });
});
