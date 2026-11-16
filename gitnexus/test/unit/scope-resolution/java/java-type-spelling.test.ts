import { describe, expect, it } from 'vitest';
import { getJavaParser } from '../../../../src/core/ingestion/languages/java/query.js';
import {
  javaArrayElementType,
  javaTypeText,
  javaTrailingDimensions,
} from '../../../../src/core/ingestion/languages/java/type-spelling.js';

describe('Java written array types', () => {
  it('removes nested type-use annotation arguments without consuming the type', () => {
    const tree = getJavaParser().parse('class C { p.@A(value=@B("[]")) User @D [] field; }');
    const field = tree.rootNode.descendantsOfType('field_declaration')[0]!;
    expect(javaTypeText(field.childForFieldName('type')!)).toBe('p.User[]');
  });

  it.each([
    {
      name: 'a line comment before the dimensions',
      source: 'User // element type continues\n [] values',
      expected: 'User[]',
    },
    {
      name: 'a line comment inside type arguments',
      source: 'java.util.List<User // element\n> values',
      expected: 'java.util.List<User>',
    },
    {
      name: 'a line comment holding a block comment opener',
      source: 'User // see /* below\n [] /* trailing */ values',
      expected: 'User[]',
    },
    {
      name: 'a block comment holding a line comment marker',
      source: 'User /* a // b */ [] values',
      expected: 'User[]',
    },
  ])('removes $name from a written type', ({ source, expected }) => {
    const tree = getJavaParser().parse(`class C { void m(${source}) {} }`);
    const parameter = tree.rootNode.descendantsOfType('formal_parameter')[0]!;
    expect(javaTypeText(parameter.childForFieldName('type')!)).toBe(expected);
  });

  it('counts only declarator brackets, independently of annotation argument strings', () => {
    const tree = getJavaParser().parse('class C { User first, second @A("[]") []; }');
    const [first, second] = tree.rootNode.descendantsOfType('variable_declarator');
    expect(javaTrailingDimensions(first)).toBe('');
    expect(javaTrailingDimensions(second)).toBe('[]');
  });

  it('peels exactly one array dimension and refuses collection indexing', () => {
    expect(javaArrayElementType('User[][]', { kind: 'index' })).toBe('User[]');
    expect(javaArrayElementType('java.util.List<User>', { kind: 'index' })).toBeUndefined();
    expect(javaArrayElementType('User[]', { kind: 'accessor', name: 'get' })).toBeUndefined();
  });
});
