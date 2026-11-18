import { describe, expect, it, vi } from 'vitest';
import type Parser from 'tree-sitter';
import { SupportedLanguages } from '../../../src/config/supported-languages.js';
import {
  isLanguageAvailable,
  loadLanguage,
  loadParser,
} from '../../../src/core/tree-sitter/parser-loader.js';
import { getJavaParser } from '../../../src/core/ingestion/languages/java/query.js';
import { emitJavaScopeCaptures } from '../../../src/core/ingestion/languages/java/captures.js';
import { getKotlinParser } from '../../../src/core/ingestion/languages/kotlin/query.js';
import { emitKotlinScopeCaptures } from '../../../src/core/ingestion/languages/kotlin/captures.js';
import { synthesizeLombokAccessorCaptures } from '../../../src/core/ingestion/languages/java/lombok-synthesizer.js';

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
    expect(tree.rootNode.hasError).toBe(false);
    const prototype = nodePrototype(tree.rootNode);
    const descriptor = Object.getOwnPropertyDescriptor(prototype, 'children')!;
    let materialized = 0;
    const children = vi.spyOn(prototype, 'children', 'get').mockImplementation(function (
      this: Parser.SyntaxNode,
    ) {
      const result = descriptor.get!.call(this) as Parser.SyntaxNode[];
      materialized += result.length;
      return result;
    });
    try {
      const captures = synthesizeLombokAccessorCaptures(tree.rootNode);
      expect(captures.some((match) => match['@declaration.name']?.text === 'getValue')).toBe(true);
      expect(materialized).toBe(36);
    } finally {
      children.mockRestore();
    }
  });

  // Each operand of a left-deep chain is one level deeper, and a native
  // `parent` read costs that depth: one read per member read is quadratic.
  it.each([8, 64])('reads no native parent per Java member read (%i operands)', (operands) => {
    const chain = Array.from({ length: operands }, (_, i) => ` + Label.F${i}`).join('');
    const source = `import models.*; class Chain { int total; int sum(Chain c) { c.total = 1; return 0${chain}; } }`;
    const tree = getJavaParser().parse(source);
    expect(tree.rootNode.hasError).toBe(false);
    const parent = vi.spyOn(nodePrototype(tree.rootNode), 'parent', 'get');
    try {
      const captures = emitJavaScopeCaptures(source, 'Chain.java', tree);
      // The write target `c.total` is not a read; every `Label.F<i>` is.
      expect(captures.filter((match) => match['@reference.read.member']).length).toBe(operands);
      expect(captures.filter((match) => match['@reference.write.member']).length).toBe(1);
      // Declaration/type-identity and inherited-field bookkeeping add eight
      // fixed reads. Neither operand count may introduce a native parent read
      // per member access.
      expect(parent.mock.calls.length).toBe(40);
    } finally {
      parent.mockRestore();
    }
  });

  // `this` in an anonymous class method and a copy of an enclosing local read
  // through that class reuse the class's one identity walk and the body owner
  // seen on the way down. Every anonymous class costs the same fixed reads
  // (its existing identity synthesis included), however many the file has.
  it.each([4, 16])('reads a fixed number of native parents per anonymous class (%i)', (classes) => {
    const bodies = Array.from(
      { length: classes },
      () =>
        'new Task() { Other[] own() { return null; } void m() { var copy = value; copy.save(); this.own()[0].save(); } };',
    ).join('\n');
    const source = `class App { Other[] own() { return null; } void run(Factory factory) { var value = factory.make();\n${bodies} } }`;
    const tree = getJavaParser().parse(source);
    expect(tree.rootNode.hasError).toBe(false);
    const parent = vi.spyOn(nodePrototype(tree.rootNode), 'parent', 'get');
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
      expect(anonymousThis.length).toBe(2 * classes);
      expect(enclosingCopies.length).toBe(classes);
      expect(parent.mock.calls.length).toBe(90 + 115 * classes);
    } finally {
      parent.mockRestore();
    }
  });

  it.skipIf(!kotlinAvailable)(
    'does not enumerate every descendant for each filtered Kotlin search',
    () => {
      const source = Array.from(
        { length: 30 },
        (_, i) => `fun f${i}(value: Int): Int { return value + 1 }`,
      ).join('\n');
      const tree = getKotlinParser().parse(source);
      expect(tree.rootNode.hasError).toBe(false);
      const child = vi.spyOn(nodePrototype(tree.rootNode), 'namedChild');
      try {
        const captures = emitKotlinScopeCaptures(source, 'fixture.kt', tree);
        expect(captures.filter((match) => match['@declaration.function']).length).toBe(30);
        expect(child.mock.calls.length).toBe(10 * 30);
      } finally {
        child.mockRestore();
      }
    },
  );
});
