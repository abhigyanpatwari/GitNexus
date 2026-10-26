import { describe, expect, it } from 'vitest';
import Parser from 'tree-sitter';
import Java from 'tree-sitter-java';
import TypeScript from 'tree-sitter-typescript';
import { declarationParameterTypes } from '../../src/core/ingestion/method-extractors/declaration-facts.js';
import { createMethodExtractor } from '../../src/core/ingestion/method-extractors/generic.js';
import { javaMethodConfig } from '../../src/core/ingestion/method-extractors/configs/jvm.js';
import { typescriptMethodConfig } from '../../src/core/ingestion/method-extractors/configs/typescript-javascript.js';
import { computeJavaArityMetadata } from '../../src/core/ingestion/languages/java/arity-metadata.js';
import { computeTsArityMetadata } from '../../src/core/ingestion/languages/typescript/arity-metadata.js';
import { buildMethodProps } from '../../src/core/ingestion/utils/method-props.js';

describe('shared parameter type projection', () => {
  const parameter = (type: string | null) =>
    Object.freeze({ name: 'p', type, isOptional: false, isVariadic: false });

  it('shares a projection without changing immutable parameters or merging declarations', () => {
    const parameters = Object.freeze([parameter('A'), parameter(null), parameter('B')]);
    const types = declarationParameterTypes(parameters);
    expect(types).toEqual(['A', 'B']);
    expect(declarationParameterTypes(parameters)).toBe(types);
    expect(declarationParameterTypes([...parameters])).not.toBe(types);
    expect(parameters.map((p) => p.type)).toEqual(['A', null, 'B']);
    expect(declarationParameterTypes([])).toEqual([]);
    expect(declarationParameterTypes([parameter(null)])).toEqual([]);
  });

  for (const fixture of [
    { java: true, signature: 'int f(int x, String y)', scope: ['int', 'String'], shared: true },
    {
      java: true,
      signature: 'int f(int x, String... y)',
      scope: ['int', 'String', 'varargs'],
      shared: false,
    },
    {
      java: false,
      signature: 'f(x: number, y: string): number',
      scope: ['number', 'string'],
      shared: true,
    },
    { java: false, signature: 'f(x, y: string): number', scope: ['', 'string'], shared: false },
    {
      java: false,
      signature: 'f(x: string, y, z: number): number',
      scope: ['string', '', 'number'],
      shared: false,
    },
    {
      java: false,
      signature: 'f(x: Box<string>[], ...y: string[]): number',
      scope: ['Box', 'string', 'params'],
      shared: false,
    },
  ]) {
    for (const scopeFirst of [true, false]) {
      it(`${fixture.signature}: preserves provider projection, scopeFirst=${scopeFirst}`, () => {
        const parser = new Parser();
        parser.setLanguage(fixture.java ? Java : TypeScript.typescript);
        const tree = parser.parse(`class C { ${fixture.signature} { return 0; } }`);
        expect(tree.rootNode.hasError).toBe(false);
        const node = tree.rootNode.descendantsOfType(
          fixture.java ? 'method_declaration' : 'method_definition',
        )[0]!;
        const config = fixture.java ? javaMethodConfig : typescriptMethodConfig;
        const arity = fixture.java ? computeJavaArityMetadata : computeTsArityMetadata;
        const extractor = createMethodExtractor(config);
        let scope = scopeFirst ? arity(node) : undefined;
        const info = extractor.extractFromNode!(node, {
          language: config.language,
          filePath: 'fixture',
        })!;
        const graph = buildMethodProps(info);
        scope ??= arity(node);
        expect(scope.parameterTypes).toEqual(fixture.scope);
        expect(graph.parameterTypes).toEqual(
          info.parameters.flatMap((p) => (p.type === null ? [] : [p.type])),
        );
        if (fixture.shared) expect(scope.parameterTypes).toBe(graph.parameterTypes);
        else expect(scope.parameterTypes).not.toBe(graph.parameterTypes);
        // A second scope projection must not append a marker to the shared graph array.
        expect(arity(node)).toEqual(scope);
        expect(buildMethodProps(info)).toEqual(graph);
      });
    }
  }
});
