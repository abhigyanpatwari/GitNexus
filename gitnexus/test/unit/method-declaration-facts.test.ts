import { describe, expect, it, vi } from 'vitest';
import Parser from 'tree-sitter';
import Java from 'tree-sitter-java';
import TypeScript from 'tree-sitter-typescript';
import { createMethodExtractor } from '../../src/core/ingestion/method-extractors/generic.js';
import {
  javaMethodConfig,
  kotlinMethodConfig,
} from '../../src/core/ingestion/method-extractors/configs/jvm.js';
import {
  typescriptMethodConfig,
  javascriptMethodConfig,
} from '../../src/core/ingestion/method-extractors/configs/typescript-javascript.js';
import { csharpMethodConfig } from '../../src/core/ingestion/method-extractors/configs/csharp.js';
import { pythonMethodConfig } from '../../src/core/ingestion/method-extractors/configs/python.js';
import { phpMethodConfig } from '../../src/core/ingestion/method-extractors/configs/php.js';
import { swiftMethodConfig } from '../../src/core/ingestion/method-extractors/configs/swift.js';
import { dartMethodConfig } from '../../src/core/ingestion/method-extractors/configs/dart.js';
import { computeJavaArityMetadata } from '../../src/core/ingestion/languages/java/arity-metadata.js';
import { computeTsArityMetadata } from '../../src/core/ingestion/languages/typescript/arity-metadata.js';
import { memoizeDeclarationFact } from '../../src/core/ingestion/method-extractors/declaration-facts.js';
import { computeKotlinArityMetadata } from '../../src/core/ingestion/languages/kotlin/arity-metadata.js';
import { computeCsharpArityMetadata } from '../../src/core/ingestion/languages/csharp/arity-metadata.js';
import { computePythonArityMetadata } from '../../src/core/ingestion/languages/python/arity-metadata.js';
import { computePhpArityMetadata } from '../../src/core/ingestion/languages/php/arity-metadata.js';
import { computeSwiftArityMetadata } from '../../src/core/ingestion/languages/swift/arity-metadata.js';
import { computeDartArityMetadata } from '../../src/core/ingestion/languages/dart/arity-metadata.js';
import {
  getLanguageGrammar,
  isLanguageAvailable,
} from '../../src/core/tree-sitter/parser-loader.js';
import { synthesizeSwiftSignatureBindings } from '../../src/core/ingestion/languages/swift/signature-bindings.js';
import { synthesizeDartSignatureBindings } from '../../src/core/ingestion/languages/dart/signature-bindings.js';

describe('shared callable declaration facts', () => {
  for (const fixture of [
    {
      config: pythonMethodConfig,
      code: 'class C:\n @staticmethod\n def f(x: int) -> int:\n  return x\n',
      owner: 'class_definition',
      declaration: 'function_definition',
      arity: computePythonArityMetadata,
    },
    {
      config: dartMethodConfig,
      code: 'class C { C(int x) {} }',
      owner: 'class_definition',
      declaration: 'constructor_signature',
      arity: computeDartArityMetadata,
    },
  ]) {
    for (const scopeFirst of [true, false]) {
      it.skipIf(!isLanguageAvailable(fixture.config.language))(
        `${fixture.config.language}: shares facts across declaration wrappers, scopeFirst=${scopeFirst}`,
        () => {
          const parser = new Parser();
          parser.setLanguage(getLanguageGrammar(fixture.config.language)!);
          const tree = parser.parse(fixture.code);
          expect(tree.rootNode.hasError).toBe(false);
          const owner = tree.rootNode.descendantsOfType(fixture.owner)[0]!;
          const declaration = owner.descendantsOfType(fixture.declaration)[0]!;
          const spy = vi.spyOn(fixture.config, 'extractParameters');
          try {
            if (scopeFirst) fixture.arity(declaration);
            const result = createMethodExtractor(fixture.config).extract(owner, {
              language: fixture.config.language,
              filePath: 'fixture',
            })!;
            if (!scopeFirst) fixture.arity(declaration);
            expect(result.methods).toHaveLength(1);
            expect(result.methods[0]!.parameters.map((p) => p.type)).toEqual(['int']);
            expect(spy).toHaveBeenCalledTimes(2);
            expect(spy.mock.results[0]!.value).toBe(spy.mock.results[1]!.value);
          } finally {
            spy.mockRestore();
          }
        },
      );
    }
  }
  for (const fixture of [
    {
      language: Java,
      config: javaMethodConfig,
      code: 'class C { int f(int x, String... rest) { return x; } }',
      nodeType: 'method_declaration',
      arity: computeJavaArityMetadata,
      expectedTypes: ['int', 'String'],
    },
    {
      language: TypeScript.typescript,
      config: typescriptMethodConfig,
      code: 'class C { f(x: number, ...rest: string[]): number { return x; } }',
      nodeType: 'method_definition',
      arity: computeTsArityMetadata,
      expectedTypes: ['number', 'string[]'],
    },
  ]) {
    for (const scopeFirst of [true, false]) {
      it(`${fixture.config.language}: traverses parameters once, scopeFirst=${scopeFirst}`, () => {
        const parser = new Parser();
        parser.setLanguage(fixture.language);
        const tree = parser.parse(fixture.code);
        const node = tree.rootNode.descendantsOfType(fixture.nodeType)[0]!;
        const read = vi.spyOn(node, 'childForFieldName');
        const extractor = createMethodExtractor(fixture.config);
        const structure = () =>
          extractor.extractFromNode!(node, {
            filePath: 'fixture',
            language: fixture.config.language,
          });
        if (scopeFirst) fixture.arity(node);
        const info = structure()!;
        if (!scopeFirst) fixture.arity(node);
        expect(info.name).toBe('f');
        expect(info.parameters.map((p) => p.rawType ?? p.type)).toEqual(fixture.expectedTypes);
        expect(info.parameters.map((p) => p.isVariadic)).toEqual([false, true]);
        // Count the native parameter-list access, not calls to the config wrapper.
        expect(read.mock.calls.filter(([field]) => field === 'parameters')).toHaveLength(1);
        read.mockRestore();
      });
    }
  }

  for (const fixture of [
    {
      config: kotlinMethodConfig,
      code: 'class C {\n fun f(x: Int, y: String): Int { return x }\n}',
      nodeType: 'function_declaration',
      arity: computeKotlinArityMetadata,
      types: ['Int', 'String'],
    },
    {
      config: csharpMethodConfig,
      code: 'class C { public int F(int x, string y = "") { return x; } }',
      nodeType: 'method_declaration',
      arity: computeCsharpArityMetadata,
      types: ['int', 'string'],
    },
    {
      config: pythonMethodConfig,
      code: 'class C:\n    def f(self, x: int, y: str = "") -> int:\n        return x\n',
      nodeType: 'function_definition',
      arity: computePythonArityMetadata,
      types: ['int', 'str'],
    },
    {
      config: phpMethodConfig,
      code: '<?php class C { function f(int $x, string ...$rest): int { return $x; } }',
      nodeType: 'method_declaration',
      arity: computePhpArityMetadata,
      types: ['int', 'string'],
    },
    {
      config: swiftMethodConfig,
      code: 'class C { func f(_ x: Int, y: String) -> Int { return x } }',
      nodeType: 'function_declaration',
      arity: computeSwiftArityMetadata,
      types: ['Int', 'String'],
    },
    {
      config: dartMethodConfig,
      code: "class C { int f(int x, [String y = '']) { return x; } }",
      nodeType: 'method_signature',
      arity: computeDartArityMetadata,
      types: ['int', 'String'],
    },
  ]) {
    it.skipIf(!isLanguageAvailable(fixture.config.language))(
      `${fixture.config.language}: scope and structure reuse parameter facts`,
      () => {
        const parser = new Parser();
        parser.setLanguage(getLanguageGrammar(fixture.config.language)!);
        const tree = parser.parse(fixture.code);
        expect(tree.rootNode.hasError).toBe(false);
        const node = tree.rootNode.descendantsOfType(fixture.nodeType)[0]!;
        const spy = vi.spyOn(fixture.config, 'extractParameters');
        try {
          const scope = fixture.arity(node);
          const info = createMethodExtractor(fixture.config).extractFromNode!(node, {
            language: fixture.config.language,
            filePath: 'fixture',
          })!;
          expect(info.parameters.map((p) => p.type)).toEqual(fixture.types);
          expect(scope.parameterTypes?.slice(0, 2)).toEqual(fixture.types);
          expect(spy).toHaveBeenCalledTimes(2);
          // Both real consumers must receive the same facts, including through config copies.
          expect(info.parameters).toBe(spy.mock.results[0]!.value);
        } finally {
          spy.mockRestore();
        }
      },
    );
  }

  it('shares the parameter callback through the JavaScript config copy', () => {
    const parser = new Parser();
    parser.setLanguage(getLanguageGrammar(javascriptMethodConfig.language)!);
    const node = parser
      .parse('class C { f(x, ...rest) {} }')
      .rootNode.descendantsOfType('method_definition')[0]!;
    expect(javascriptMethodConfig.extractParameters).toBe(typescriptMethodConfig.extractParameters);
    expect(javascriptMethodConfig.extractParameters(node)).toBe(
      typescriptMethodConfig.extractParameters(node),
    );
  });

  for (const fixture of [
    {
      config: swiftMethodConfig,
      code: 'class C { func f(_ x: Int) -> Int { return x } }',
      nodeType: 'function_declaration',
      bindings: synthesizeSwiftSignatureBindings,
    },
    {
      config: dartMethodConfig,
      code: 'class C { int f(int x) { return x; } }',
      nodeType: 'method_signature',
      bindings: (node: Parser.SyntaxNode) =>
        synthesizeDartSignatureBindings(node, node.nextNamedSibling),
    },
  ]) {
    it.skipIf(!isLanguageAvailable(fixture.config.language))(
      `${fixture.config.language}: signature bindings share name and return facts`,
      () => {
        const parser = new Parser();
        parser.setLanguage(getLanguageGrammar(fixture.config.language)!);
        const node = parser.parse(fixture.code).rootNode.descendantsOfType(fixture.nodeType)[0]!;
        let reads = 0;
        const counted = new Proxy(node, {
          get(target, property) {
            if (property !== 'tree' && property !== 'id') reads++;
            const value = Reflect.get(target, property, target);
            return typeof value === 'function' ? value.bind(target) : value;
          },
        });
        expect(fixture.bindings(counted).length).toBeGreaterThan(0);
        const before = reads;
        expect(before).toBeGreaterThan(0);
        expect(fixture.config.extractName(counted)).toBe('f');
        expect(fixture.config.extractReturnType(counted)).toMatch(/^[Ii]nt$/);
        expect(reads).toBe(before);
      },
    );
  }

  it('separates same-line declarations and reparsed trees', () => {
    const parser = new Parser();
    parser.setLanguage(Java);
    const first = parser.parse('class C { void f(int x) {} void f(String s) {} }');
    const second = parser.parse('class C { void f(long x) {} }');
    const [intNode, stringNode] = first.rootNode.descendantsOfType('method_declaration');
    const longNode = second.rootNode.descendantsOfType('method_declaration')[0]!;
    expect(javaMethodConfig.extractParameters(intNode!)[0]!.type).toBe('int');
    expect(javaMethodConfig.extractParameters(stringNode!)[0]!.type).toBe('String');
    expect(javaMethodConfig.extractParameters(longNode)[0]!.type).toBe('long');
  });

  it('reuses empty and absent facts across wrappers with the same native identity', () => {
    const parser = new Parser();
    parser.setLanguage(Java);
    const tree = parser.parse('class C { void f() {} }');
    const node = tree.rootNode.descendantsOfType('method_declaration')[0]!;
    // A fresh traversal may already reuse a JS wrapper. This wrapper deliberately
    // differs while preserving the actual native tree/node identity.
    const wrapper = new Proxy(node, {});
    expect(wrapper).not.toBe(node);
    const absent = vi.fn(() => undefined);
    const empty = vi.fn(() => []);
    for (const extract of [absent, empty]) {
      const shared = memoizeDeclarationFact(extract);
      const first = shared(node);
      expect(shared(wrapper)).toBe(first);
      expect(extract).toHaveBeenCalledTimes(1);
    }
  });

  it('retries failures and bypasses sharing when tree identity is unavailable', () => {
    const parser = new Parser();
    parser.setLanguage(Java);
    const node = parser.parse('class C {}').rootNode;
    const extract = vi
      .fn<() => string>()
      .mockImplementationOnce(() => {
        throw new Error('incomplete');
      })
      .mockReturnValue('complete');
    const shared = memoizeDeclarationFact(extract);
    expect(() => shared(node)).toThrow('incomplete');
    expect(shared(node)).toBe('complete');
    expect(shared(node)).toBe('complete');
    expect(extract).toHaveBeenCalledTimes(2);
    const partial = {} as Parser.SyntaxNode;
    shared(partial);
    shared(partial);
    expect(extract).toHaveBeenCalledTimes(4);
  });
});
