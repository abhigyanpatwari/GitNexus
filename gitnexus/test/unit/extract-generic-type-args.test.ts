import { describe, it, expect } from 'vitest';
import Parser from 'tree-sitter';
import { extractGenericTypeArgs } from '../../src/core/ingestion/type-extractors/shared.js';
import { getLanguageGrammar } from '../../src/core/tree-sitter/parser-loader.js';
import { SupportedLanguages } from '../../src/config/supported-languages.js';
import type { SyntaxNode } from '../../src/core/ingestion/utils/ast-helpers.js';

/**
 * Create a minimal mock SyntaxNode for testing type extraction.
 * Only the properties used by extractSimpleTypeName / extractGenericTypeArgs
 * are populated — everything else is left as stubs.
 */
function mockNode(
  type: string,
  opts: {
    text?: string;
    namedChildren?: SyntaxNode[];
    fields?: Record<string, SyntaxNode>;
  } = {},
): SyntaxNode {
  const children = opts.namedChildren ?? [];
  const fields = opts.fields ?? {};
  const text = opts.text ?? children.map((c) => c.text).join(', ');

  return {
    type,
    text,
    namedChildCount: children.length,
    namedChild: (i: number) => children[i] ?? null,
    firstNamedChild: children[0] ?? null,
    lastNamedChild: children[children.length - 1] ?? null,
    childForFieldName: (name: string) => fields[name] ?? null,
  } as unknown as SyntaxNode;
}

// Helper: build a generic_type node with type_arguments
function genericType(
  baseName: string,
  typeArgNames: string[],
  opts?: { argsNodeType?: string; wrapInProjection?: boolean },
): SyntaxNode {
  const argsNodeType = opts?.argsNodeType ?? 'type_arguments';

  const baseNode = mockNode('type_identifier', { text: baseName });

  let argChildren = typeArgNames.map((name) => mockNode('type_identifier', { text: name }));

  // Kotlin wraps each arg in type_projection > user_type > type_identifier
  if (opts?.wrapInProjection) {
    argChildren = typeArgNames.map((name) => {
      const typeId = mockNode('type_identifier', { text: name });
      const userType = mockNode('user_type', { namedChildren: [typeId] });
      return mockNode('type_projection', { namedChildren: [userType] });
    }) as unknown as SyntaxNode[];
  }

  const typeArgsNode = mockNode(argsNodeType, {
    namedChildren: argChildren,
  });

  return mockNode('generic_type', {
    namedChildren: [baseNode, typeArgsNode],
    fields: { name: baseNode },
  });
}

describe('extractGenericTypeArgs', () => {
  describe('single type argument', () => {
    it('extracts from TypeScript Array<User>', () => {
      const node = genericType('Array', ['User']);
      expect(extractGenericTypeArgs(node)).toEqual(['User']);
    });

    it('extracts from Java List<User>', () => {
      const node = genericType('List', ['User']);
      expect(extractGenericTypeArgs(node)).toEqual(['User']);
    });

    it('extracts from Rust Vec<User>', () => {
      const node = genericType('Vec', ['User']);
      expect(extractGenericTypeArgs(node)).toEqual(['User']);
    });

    it('extracts from C# List<User> (type_argument_list)', () => {
      const node = genericType('List', ['User'], {
        argsNodeType: 'type_argument_list',
      });
      expect(extractGenericTypeArgs(node)).toEqual(['User']);
    });
  });

  describe('multiple type arguments', () => {
    it('extracts from Java Map<String, User>', () => {
      const node = genericType('Map', ['String', 'User']);
      expect(extractGenericTypeArgs(node)).toEqual(['String', 'User']);
    });

    it('extracts from TS Map<string, number>', () => {
      const node = genericType('Map', ['string', 'number']);
      expect(extractGenericTypeArgs(node)).toEqual(['string', 'number']);
    });
  });

  describe('Kotlin type_projection wrapping', () => {
    it('extracts from Kotlin List<User> through type_projection', () => {
      const node = genericType('List', ['User'], { wrapInProjection: true });
      expect(extractGenericTypeArgs(node)).toEqual(['User']);
    });

    it('extracts from Kotlin Map<String, User> through type_projection', () => {
      const node = genericType('Map', ['String', 'User'], {
        wrapInProjection: true,
      });
      expect(extractGenericTypeArgs(node)).toEqual(['String', 'User']);
    });
  });

  // Ground the extractor against the REAL node types each shipped grammar emits
  // for a generic — no mocks. This is what catches grammar drift / wrong guesses
  // (e.g. the never-emitted `parameterized_type` the extractor used to special-
  // case): Java/TypeScript/Rust → generic_type, C# → generic_name, Kotlin →
  // user_type (List<User> → user_type > [type_identifier, type_arguments]). #1920
  describe('real grammar generic types (parsed, not mocked)', () => {
    // Return the smallest parsed node whose text is exactly `typeText`.
    function parseTypeNode(
      lang: SupportedLanguages,
      file: string,
      code: string,
      typeText: string,
    ): SyntaxNode {
      const parser = new Parser();
      parser.setLanguage(getLanguageGrammar(lang, file) as Parameters<Parser['setLanguage']>[0]);
      const tree = parser.parse(code);
      let best: SyntaxNode | null = null;
      const walk = (n: SyntaxNode): void => {
        if (n.text === typeText && (best === null || n.text.length <= best.text.length)) best = n;
        for (let i = 0; i < n.childCount; i++) {
          const c = n.child(i);
          if (c) walk(c as unknown as SyntaxNode);
        }
      };
      walk(tree.rootNode as unknown as SyntaxNode);
      if (best === null) throw new Error(`no node with text "${typeText}" parsed for ${lang}`);
      return best;
    }

    const cases: Array<{
      lang: SupportedLanguages;
      file: string;
      code: string;
      typeText: string;
      expected: string[];
    }> = [
      {
        lang: SupportedLanguages.Java,
        file: 'C.java',
        code: 'class C { List<User> f; }',
        typeText: 'List<User>',
        expected: ['User'],
      },
      {
        lang: SupportedLanguages.TypeScript,
        file: 'c.ts',
        code: 'let f: Array<User>;',
        typeText: 'Array<User>',
        expected: ['User'],
      },
      {
        lang: SupportedLanguages.CSharp,
        file: 'C.cs',
        code: 'class C { List<User> f; }',
        typeText: 'List<User>',
        expected: ['User'],
      },
      {
        lang: SupportedLanguages.Rust,
        file: 'c.rs',
        code: 'struct C { f: Vec<User> }',
        typeText: 'Vec<User>',
        expected: ['User'],
      },
      {
        lang: SupportedLanguages.Kotlin,
        file: 'C.kt',
        code: 'class C { val f: List<User> = x }',
        typeText: 'List<User>',
        expected: ['User'],
      },
      {
        lang: SupportedLanguages.Java,
        file: 'C.java',
        code: 'class C { Map<String, User> f; }',
        typeText: 'Map<String, User>',
        expected: ['String', 'User'],
      },
      {
        // Kotlin multi-arg through user_type > type_arguments > type_projection.
        lang: SupportedLanguages.Kotlin,
        file: 'C.kt',
        code: 'class C { val f: Map<String, User> = x }',
        typeText: 'Map<String, User>',
        expected: ['String', 'User'],
      },
      {
        // C# multi-arg through generic_name > type_argument_list.
        lang: SupportedLanguages.CSharp,
        file: 'C.cs',
        code: 'class C { Dictionary<string, User> f; }',
        typeText: 'Dictionary<string, User>',
        expected: ['string', 'User'],
      },
    ];

    for (const { lang, file, code, typeText, expected } of cases) {
      it(`captures [${expected.join(', ')}] from a real ${lang} \`${typeText}\``, () => {
        const node = parseTypeNode(lang, file, code, typeText);
        expect(extractGenericTypeArgs(node)).toEqual(expected);
      });
    }
  });

  describe('wrapper node unwrapping', () => {
    it('unwraps type_annotation before extracting', () => {
      const inner = genericType('Array', ['User']);
      const wrapper = mockNode('type_annotation', { namedChildren: [inner] });
      expect(extractGenericTypeArgs(wrapper)).toEqual(['User']);
    });

    it('unwraps nullable_type before extracting', () => {
      const inner = genericType('List', ['User']);
      const wrapper = mockNode('nullable_type', { namedChildren: [inner] });
      expect(extractGenericTypeArgs(wrapper)).toEqual(['User']);
    });

    it('unwraps user_type before extracting (Kotlin)', () => {
      const inner = genericType('MutableList', ['String']);
      const wrapper = mockNode('user_type', { namedChildren: [inner] });
      expect(extractGenericTypeArgs(wrapper)).toEqual(['String']);
    });
  });

  describe('non-generic types return empty array', () => {
    it('returns [] for plain type_identifier', () => {
      const node = mockNode('type_identifier', { text: 'User' });
      expect(extractGenericTypeArgs(node)).toEqual([]);
    });

    it('returns [] for identifier', () => {
      const node = mockNode('identifier', { text: 'foo' });
      expect(extractGenericTypeArgs(node)).toEqual([]);
    });

    it('returns [] for union_type', () => {
      const node = mockNode('union_type', {
        namedChildren: [
          mockNode('type_identifier', { text: 'string' }),
          mockNode('type_identifier', { text: 'number' }),
        ],
      });
      expect(extractGenericTypeArgs(node)).toEqual([]);
    });
  });

  describe('nested generic types as arguments', () => {
    it('extracts outer type arg names for nested generics', () => {
      // Map<String, List<User>> — the second arg is itself a generic_type
      // extractGenericTypeArgs should extract 'List' (via extractSimpleTypeName)
      const innerGeneric = genericType('List', ['User']);
      const stringNode = mockNode('type_identifier', { text: 'String' });
      const typeArgsNode = mockNode('type_arguments', {
        namedChildren: [stringNode, innerGeneric],
      });
      const baseNode = mockNode('type_identifier', { text: 'Map' });
      const node = mockNode('generic_type', {
        namedChildren: [baseNode, typeArgsNode],
        fields: { name: baseNode },
      });

      // extractSimpleTypeName on a generic_type returns the base name
      expect(extractGenericTypeArgs(node)).toEqual(['String', 'List']);
    });
  });

  describe('edge cases', () => {
    it('returns [] for generic_type with no type_arguments child', () => {
      const baseNode = mockNode('type_identifier', { text: 'List' });
      const node = mockNode('generic_type', {
        namedChildren: [baseNode],
        fields: { name: baseNode },
      });
      expect(extractGenericTypeArgs(node)).toEqual([]);
    });

    it('skips unresolvable type arguments', () => {
      // If a child can't be resolved by extractSimpleTypeName, it is omitted
      const baseNode = mockNode('type_identifier', { text: 'Fn' });
      const unresolvedArg = mockNode('function_type', { text: '() => void' });
      const resolvedArg = mockNode('type_identifier', { text: 'User' });
      const typeArgsNode = mockNode('type_arguments', {
        namedChildren: [unresolvedArg, resolvedArg],
      });
      const node = mockNode('generic_type', {
        namedChildren: [baseNode, typeArgsNode],
        fields: { name: baseNode },
      });
      expect(extractGenericTypeArgs(node)).toEqual(['User']);
    });
  });
});
