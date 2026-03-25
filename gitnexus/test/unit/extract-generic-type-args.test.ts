import { describe, it, expect } from 'vitest';
import { extractGenericTypeArgs } from '../../src/core/ingestion/type-extractors/shared.js';
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

  let argChildren = typeArgNames.map((name) =>
    mockNode('type_identifier', { text: name }),
  );

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

  describe('parameterized_type (Java/Kotlin alternate node type)', () => {
    it('extracts type arguments from parameterized_type', () => {
      const baseNode = mockNode('type_identifier', { text: 'List' });
      const argNode = mockNode('type_identifier', { text: 'User' });
      const typeArgsNode = mockNode('type_arguments', {
        namedChildren: [argNode],
      });
      const node = mockNode('parameterized_type', {
        namedChildren: [baseNode, typeArgsNode],
        fields: { name: baseNode },
      });
      expect(extractGenericTypeArgs(node)).toEqual(['User']);
    });
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
