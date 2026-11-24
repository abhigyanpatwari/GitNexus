import { mock } from 'node:test';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import Parser from 'tree-sitter';
import Java from 'tree-sitter-java';
import { createMethodExtractor } from '../../../../../src/core/ingestion/method-extractors/generic.js';
import { javaMethodConfig } from '../../../../../src/core/ingestion/method-extractors/configs/jvm.js';
import { computeJavaArityMetadata } from '../../../../../src/core/ingestion/languages/java/arity-metadata.js';
import { memoizeDeclarationFact } from '../../../../../src/core/ingestion/method-extractors/declaration-facts.js';

describe('shared callable declaration facts', () => {
  for (const fixture of [
    {
      language: Java,
      config: javaMethodConfig,
      code: 'class C { int f(int x, String... rest) { return x; } }',
      nodeType: 'method_declaration',
      arity: computeJavaArityMetadata,
      expectedTypes: ['int', 'String'],
    },
  ]) {
    for (const scopeFirst of [true, false]) {
      it(`${fixture.config.language}: traverses parameters once, scopeFirst=${scopeFirst}`, () => {
        const parser = new Parser();
        parser.setLanguage(fixture.language);
        const tree = parser.parse(fixture.code);
        const node = tree.rootNode.descendantsOfType(fixture.nodeType)[0]!;
        const read = mock.method(node, 'childForFieldName');
        const extractor = createMethodExtractor(fixture.config);
        const structure = () =>
          extractor.extractFromNode!(node, {
            filePath: 'fixture',
            language: fixture.config.language,
          });
        if (scopeFirst) fixture.arity(node);
        const info = structure()!;
        if (!scopeFirst) fixture.arity(node);
        assert.equal(info.name, 'f');
        assert.deepEqual(
          info.parameters.map((p) => p.rawType ?? p.type),
          fixture.expectedTypes,
        );
        assert.deepEqual(
          info.parameters.map((p) => p.isVariadic),
          [false, true],
        );
        assert.equal(
          read.mock.calls.filter(({ arguments: [field] }) => field === 'parameters').length,
          1,
        );
        read.mock.restore();
      });
    }
  }

  it('separates same-line declarations and reparsed trees', () => {
    const parser = new Parser();
    parser.setLanguage(Java);
    const first = parser.parse('class C { void f(int x) {} void f(String s) {} }');
    const second = parser.parse('class C { void f(long x) {} }');
    const [intNode, stringNode] = first.rootNode.descendantsOfType('method_declaration');
    const longNode = second.rootNode.descendantsOfType('method_declaration')[0]!;
    assert.equal(javaMethodConfig.extractParameters(intNode!)[0]!.type, 'int');
    assert.equal(javaMethodConfig.extractParameters(stringNode!)[0]!.type, 'String');
    assert.equal(javaMethodConfig.extractParameters(longNode)[0]!.type, 'long');
  });

  it('reuses empty and absent facts across wrappers with the same native identity', () => {
    const parser = new Parser();
    parser.setLanguage(Java);
    const tree = parser.parse('class C { void f() {} }');
    const node = tree.rootNode.descendantsOfType('method_declaration')[0]!;
    // A fresh traversal may already reuse a JS wrapper. This wrapper deliberately
    // differs while preserving the actual native tree/node identity.
    const wrapper = new Proxy(node, {});
    assert.notEqual(wrapper, node);
    const absent = mock.fn(() => undefined);
    const empty = mock.fn(() => []);
    for (const extract of [absent, empty]) {
      const shared = memoizeDeclarationFact(extract);
      const first = shared(node);
      assert.equal(shared(wrapper), first);
      assert.equal(extract.mock.callCount(), 1);
    }
  });

  it('retries failures and bypasses sharing when tree identity is unavailable', () => {
    const parser = new Parser();
    parser.setLanguage(Java);
    const node = parser.parse('class C {}').rootNode;
    const extract = mock.fn(() => 'complete');
    extract.mock.mockImplementationOnce(() => {
      throw new Error('incomplete');
    });
    const shared = memoizeDeclarationFact(extract);
    assert.throws(() => shared(node), /incomplete/);
    assert.equal(shared(node), 'complete');
    assert.equal(shared(node), 'complete');
    assert.equal(extract.mock.callCount(), 2);
    const partial = {} as Parser.SyntaxNode;
    shared(partial);
    shared(partial);
    assert.equal(extract.mock.callCount(), 4);
  });
});
