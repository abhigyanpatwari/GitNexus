import { mock, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type Parser from 'tree-sitter';
import { SupportedLanguages } from '../../../../../src/config/supported-languages.js';
import {
  isLanguageAvailable,
  loadLanguage,
  loadParser,
} from '../../../../../src/core/tree-sitter/parser-loader.js';
import { getJavaParser } from '../../../../../src/core/ingestion/languages/java/query.js';
import { emitJavaScopeCaptures } from '../../../../../src/core/ingestion/languages/java/captures.js';
import { synthesizeLombokAccessorCaptures } from '../../../../../src/core/ingestion/languages/java/lombok-synthesizer.js';

let kotlinAvailable = isLanguageAvailable(SupportedLanguages.Kotlin);
if (kotlinAvailable) {
  try {
    await loadParser();
    await loadLanguage(SupportedLanguages.Kotlin);
  } catch {
    kotlinAvailable = false;
  }
}

function nodePrototype(node: Parser.SyntaxNode): Parser.SyntaxNode {
  let prototype = Object.getPrototypeOf(node) as Parser.SyntaxNode;
  while (!Object.hasOwn(prototype, 'namedChild')) prototype = Object.getPrototypeOf(prototype);
  return prototype;
}

describe('capture traversal work', () => {
  it('finds local Lombok classes without materializing unrelated method bodies', () => {
    const source = `class Outer {
      void work() {
        ${'System.out.println(1);\n'.repeat(200)}
        @lombok.Getter class Inner { private int value; }
      }
    }`;
    const tree = getJavaParser().parse(source);
    assert.equal(tree.rootNode.hasError, false);
    const prototype = nodePrototype(tree.rootNode);
    const descriptor = Object.getOwnPropertyDescriptor(prototype, 'children')!;
    let materialized = 0;
    const children = mock.getter(prototype, 'children', function (this: Parser.SyntaxNode) {
      const result = descriptor.get!.call(this) as Parser.SyntaxNode[];
      materialized += result.length;
      return result;
    });
    try {
      const captures = synthesizeLombokAccessorCaptures(tree.rootNode);
      assert.equal(
        captures.some((match) => match['@declaration.name']?.text === 'getValue'),
        true,
      );
      assert.equal(materialized, 36);
    } finally {
      children.mock.restore();
    }
  });

  // Each operand of a left-deep chain is one level deeper, and a native
  // `parent` read costs that depth: one read per member read is quadratic.
  for (const example of [8, 64] as const) {
    it(`reads no native parent per Java member read (${example} operands)`, () => {
      const operands = example;

      const chain = Array.from({ length: operands }, (_, i) => ` + Label.F${i}`).join('');
      const source = `import models.*; class Chain { int total; int sum(Chain c) { c.total = 1; return 0${chain}; } }`;
      const tree = getJavaParser().parse(source);
      assert.equal(tree.rootNode.hasError, false);
      const parent = mock.getter(nodePrototype(tree.rootNode), 'parent');
      try {
        const captures = emitJavaScopeCaptures(source, 'Chain.java', tree);
        // The write target `c.total` is not a read; every `Label.F<i>` is.
        assert.equal(captures.filter((match) => match['@reference.read.member']).length, operands);
        assert.equal(captures.filter((match) => match['@reference.write.member']).length, 1);
        // Declaration/type-identity and inherited-field bookkeeping add eight
        // fixed reads. Neither operand count may introduce a native parent read
        // per member access.
        assert.equal(parent.mock.calls.length, 40);
      } finally {
        parent.mock.restore();
      }
    });
  }

  // `this` in an anonymous class method and a copy of an enclosing local read
  // through that class reuse the class's one identity walk and the body owner
  // seen on the way down. Every anonymous class costs the same fixed reads
  // (its existing identity synthesis included), however many the file has.
  for (const example of [4, 16] as const) {
    it(`reads a fixed number of native parents per anonymous class (${example})`, () => {
      const classes = example;

      const bodies = Array.from(
        { length: classes },
        () =>
          'new Task() { Other[] own() { return null; } void m() { var copy = value; copy.save(); this.own()[0].save(); } };',
      ).join('\n');
      const source = `class App { Other[] own() { return null; } void run(Factory factory) { var value = factory.make();\n${bodies} } }`;
      const tree = getJavaParser().parse(source);
      assert.equal(tree.rootNode.hasError, false);
      const parent = mock.getter(nodePrototype(tree.rootNode), 'parent');
      try {
        const captures = emitJavaScopeCaptures(source, 'App.java', tree);
        const anonymousThis = captures.filter(
          (match) =>
            match['@type-binding.name']?.text === 'this' &&
            match['@type-binding.type']?.text.startsWith('App$') === true,
        );
        const enclosingCopies = captures.filter(
          (match) =>
            match['@call-result-assignment.element']?.text.startsWith('enclosing-local:') === true,
        );
        assert.equal(anonymousThis.length, 2 * classes);
        assert.equal(enclosingCopies.length, classes);
        assert.equal(parent.mock.calls.length, 90 + 115 * classes);
      } finally {
        parent.mock.restore();
      }
    });
  }
});
