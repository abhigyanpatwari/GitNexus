import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import Parser from 'tree-sitter';
import Java from 'tree-sitter-java';
import { createMethodExtractor } from '../../../../../src/core/ingestion/method-extractors/generic.js';
import { javaMethodConfig } from '../../../../../src/core/ingestion/method-extractors/configs/jvm.js';
import { computeJavaArityMetadata } from '../../../../../src/core/ingestion/languages/java/arity-metadata.js';
import { buildMethodProps } from '../../../../../src/core/ingestion/utils/method-props.js';

describe('shared parameter type projection', () => {
  for (const fixture of [
    { signature: 'int f(int x, String y)', scope: ['int', 'String'], shared: true },
    {
      signature: 'int f(int x, String... y)',
      scope: ['int', 'String', 'varargs'],
      shared: false,
    },
  ]) {
    for (const scopeFirst of [true, false]) {
      it(`${fixture.signature}: preserves provider projection, scopeFirst=${scopeFirst}`, () => {
        const parser = new Parser();
        parser.setLanguage(Java);
        const tree = parser.parse(`class C { ${fixture.signature} { return 0; } }`);
        assert.equal(tree.rootNode.hasError, false);
        const node = tree.rootNode.descendantsOfType('method_declaration')[0]!;
        const config = javaMethodConfig;
        const extractor = createMethodExtractor(config);
        let scope = scopeFirst ? computeJavaArityMetadata(node) : undefined;
        const info = extractor.extractFromNode!(node, {
          language: config.language,
          filePath: 'fixture',
        })!;
        const graph = buildMethodProps(info);
        scope ??= computeJavaArityMetadata(node);
        assert.deepEqual(scope.parameterTypes, fixture.scope);
        assert.deepEqual(
          graph.parameterTypes,
          info.parameters.flatMap((p) => (p.type === null ? [] : [p.type])),
        );
        if (fixture.shared) assert.equal(scope.parameterTypes, graph.parameterTypes);
        else assert.notEqual(scope.parameterTypes, graph.parameterTypes);
        assert.deepEqual(computeJavaArityMetadata(node), scope);
        assert.deepEqual(buildMethodProps(info), graph);
      });
    }
  }
});
