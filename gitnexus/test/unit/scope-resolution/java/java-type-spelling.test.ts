import { describe, expect, it } from 'vitest';
import { getJavaParser } from '../../../../src/core/ingestion/languages/java/query.js';
import { parseSourceSafe } from '../../../../src/core/tree-sitter/safe-parse.js';
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

  // The Node binding parses JavaScript strings as UTF-16, so node indices are
  // string offsets on both parse paths. Two- and four-byte UTF-8 characters
  // before an omitted annotation or comment would shift a byte-based slice.
  describe.each([
    { path: 'a direct string parse', prefix: '// ü 𝒳 漢字\n', chunked: false },
    {
      path: 'a chunked callback parse',
      prefix: `${' '.repeat(20_000)}// ü 𝒳 漢字\n`,
      chunked: true,
    },
  ])('after non-ASCII source text, through $path', ({ prefix, chunked }) => {
    it.each([
      {
        name: 'an annotation after a non-ASCII qualifier',
        source: 'Äußer.@Ann("ü") Ünïcödé value',
        expected: 'Äußer.Ünïcödé',
      },
      {
        name: 'a block comment after a non-ASCII type argument',
        source: 'java.util.List<@Ann Ü.Item /* c */ > values',
        expected: 'java.util.List<Ü.Item>',
      },
      {
        name: 'a line comment after a supplementary-plane type',
        source: '𝒳<@A 漢字.Item // x\n> values',
        expected: '𝒳<漢字.Item>',
      },
      {
        name: 'a comment, an annotation and a comment before the dimensions',
        source: 'Äußer./* 𝒳 */ @Ann 𝒳漢字 /* ü */ [] values',
        expected: 'Äußer.𝒳漢字[]',
      },
    ])('keeps the exact spelling around $name', ({ source, expected }) => {
      const text = `${prefix}class Ü { void m(${source}) {} }`;
      const tree = parseSourceSafe(getJavaParser(), text);
      const type = tree.rootNode
        .descendantsOfType('formal_parameter')[0]!
        .childForFieldName('type')!;
      expect(text.length > 16 * 1024).toBe(chunked);
      expect(text.slice(type.startIndex, type.endIndex)).toBe(type.text);
      expect(javaTypeText(type)).toBe(expected);
    });
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
