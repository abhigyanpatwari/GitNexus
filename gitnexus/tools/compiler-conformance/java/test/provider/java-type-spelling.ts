import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { getJavaParser } from '../../../../../src/core/ingestion/languages/java/query.js';
import { parseSourceSafe } from '../../../../../src/core/tree-sitter/safe-parse.js';
import {
  JAVA_DOTTED_SPELLING,
  JAVA_IDENTIFIER,
  JAVA_QUALIFIED_NAME,
  javaArrayElementType,
  javaTypeText,
  javaTrailingDimensions,
  stripGaps,
} from '../../../../../src/core/ingestion/languages/java/type-spelling.js';

it('removes qualified-name gaps without joining separate Java identifiers', () => {
  assert.equal(stripGaps(' p /* package */ . // qualifier\n Foo . Base '), 'p.Foo.Base');
  for (const gap of [' ', '/* gap */', ' // gap\n ']) {
    const name = stripGaps(`pkg.𐐀Foo${gap}Bar.Baz`);
    assert.equal(name, 'pkg.𐐀Foo Bar.Baz');
    assert.equal(new RegExp('^' + JAVA_QUALIFIED_NAME + '$', 'u').test(name), false);
  }
});

describe('Java written array types', () => {
  it('removes nested type-use annotation arguments without consuming the type', () => {
    const tree = getJavaParser().parse('class C { p.@A(value=@B("[]")) User @D [] field; }');
    const field = tree.rootNode.descendantsOfType('field_declaration')[0]!;
    assert.equal(javaTypeText(field.childForFieldName('type')!), 'p.User[]');
  });

  for (const example of [
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
  ] as const) {
    it(`removes ${example.name} from a written type`, () => {
      const { source, expected } = example;

      const tree = getJavaParser().parse(`class C { void m(${source}) {} }`);
      const parameter = tree.rootNode.descendantsOfType('formal_parameter')[0]!;
      assert.equal(javaTypeText(parameter.childForFieldName('type')!), expected);
    });
  }

  // The Node binding parses JavaScript strings as UTF-16, so node indices are
  // string offsets on both parse paths. Two- and four-byte UTF-8 characters
  // before an omitted annotation or comment would shift a byte-based slice.
  for (const example of [
    { path: 'a direct string parse', prefix: '// ü 𝒳 漢字\n', chunked: false },
    {
      path: 'a chunked callback parse',
      prefix: `${' '.repeat(20_000)}// ü 𝒳 漢字\n`,
      chunked: true,
    },
  ] as const) {
    describe(`after non-ASCII source text, through ${example.path}`, () => {
      const { prefix, chunked } = example;

      for (const example of [
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
      ] as const) {
        it(`keeps the exact spelling around ${example.name}`, () => {
          const { source, expected } = example;

          const text = `${prefix}class Ü { void m(${source}) {} }`;
          const tree = parseSourceSafe(getJavaParser(), text);
          const type = tree.rootNode
            .descendantsOfType('formal_parameter')[0]!
            .childForFieldName('type')!;
          assert.equal(text.length > 16 * 1024, chunked);
          assert.equal(text.slice(type.startIndex, type.endIndex), type.text);
          assert.equal(javaTypeText(type), expected);
        });
      }
    });
  }

  it('counts only declarator brackets, independently of annotation argument strings', () => {
    const tree = getJavaParser().parse('class C { User first, second @A("[]") []; }');
    const [first, second] = tree.rootNode.descendantsOfType('variable_declarator');
    assert.equal(javaTrailingDimensions(first), '');
    assert.equal(javaTrailingDimensions(second), '[]');
  });

  it('peels exactly one array dimension and refuses collection indexing', () => {
    assert.equal(javaArrayElementType('User[][]', { kind: 'index' }), 'User[]');
    assert.equal(javaArrayElementType('java.util.List<User>', { kind: 'index' }), undefined);
    assert.equal(javaArrayElementType('User[]', { kind: 'accessor', name: 'get' }), undefined);
  });
});

// JLS 3.8 / Character.isJavaIdentifierStart and isJavaIdentifierPart.
describe('Java identifier patterns', () => {
  const identifier = new RegExp(`^${JAVA_IDENTIFIER}$`, 'u');
  const qualified = new RegExp(`^${JAVA_QUALIFIED_NAME}$`, 'u');

  for (const example of [
    { name: 'ASCII letters, digits, underscore and dollar', text: '$_user2' },
    { name: 'Latin letters with diacritics', text: 'Ünïcödé' },
    { name: 'CJK and supplementary-plane letters', text: '𝒳漢字' },
    { name: 'a combining mark', text: 'Cafe\u0301' },
    { name: 'a letter number at the start', text: '\u216Btype' },
    { name: 'a currency symbol at the start', text: '£price' },
    { name: 'connector punctuation', text: 'a\u203Fb' },
    { name: 'a non-ASCII digit', text: 'x\u0661' },
    { name: 'a format character', text: 'a\u200Db' },
    { name: 'an identifier-ignorable control character', text: 'a\u0001b' },
    { name: 'the delete character', text: 'a\u007Fb' },
    { name: 'a C1 control character', text: 'a\u009Fb' },
  ] as const) {
    it(`accepts ${example.name}`, () => {
      const { text } = example;

      assert.equal(identifier.test(text), true);
      assert.equal(qualified.test(`p.${text}.Inner`), true);
      assert.equal(JAVA_DOTTED_SPELLING.test(`p.${text}`), true);
    });
  }

  for (const example of [
    { name: 'a leading digit', text: '1user' },
    { name: 'a leading combining mark', text: '\u0301e' },
    { name: 'a superscript digit', text: 'x²' },
    { name: 'a space', text: 'a b' },
    { name: 'a tab', text: 'a\tb' },
    { name: 'a whitespace control character', text: 'a\u001Cb' },
    { name: 'a leading control character', text: '\u0001a' },
    { name: 'a hyphen', text: 'a-b' },
    { name: 'an empty name', text: '' },
  ] as const) {
    it(`rejects ${example.name}`, () => {
      const { text } = example;

      assert.equal(identifier.test(text), false);
    });
  }

  for (const example of [
    { name: 'an empty segment', text: 'a..b' },
    { name: 'a leading dot', text: '.a' },
    { name: 'a trailing dot', text: 'a.' },
    { name: 'type arguments', text: 'List<Ünïcödé>' },
  ] as const) {
    it(`rejects a qualified name with ${example.name}`, () => {
      const { text } = example;

      assert.equal(qualified.test(text), false);
    });
  }

  it('answers a long malformed dotted name without backtracking', () => {
    const text = `${'Ünïcödé.'.repeat(20_000)}!`;
    assert.equal(qualified.test(text), false);
    assert.equal(JAVA_DOTTED_SPELLING.test(text), false);
  });
});
