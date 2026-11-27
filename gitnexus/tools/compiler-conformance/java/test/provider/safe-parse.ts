import assert from 'node:assert/strict';
import { describe, it, afterEach, after } from 'node:test';
import Parser from 'tree-sitter';
import Java from 'tree-sitter-java';
import Python from 'tree-sitter-python';

import { configureLoggerSink } from '../../../../../src/core/logger.js';
const records: { level: number; file?: string; nullByteCount?: number; msg: string }[] = [];
const restoreSink = configureLoggerSink({
  level: 'debug',
  destination: {
    write(line) {
      records.push(JSON.parse(line));
    },
  },
});
after(restoreSink);
const warnings = () => records.filter((record) => record.level === 40);

import {
  parseSourceSafe,
  resetDegradedParseCounter,
} from '../../../../../src/core/tree-sitter/safe-parse.js';

const makeParser = (): Parser => {
  const p = new Parser();
  p.setLanguage(Python);
  return p;
};

const makeJavaParser = (): Parser => {
  const parser = new Parser();
  parser.setLanguage(Java);
  return parser;
};

const buildNullByteJavaSource = (paddingChars = 0): string => `public interface Demo {
  void before();
  /**${'x'.repeat(paddingChars)} @example paramsMap={"dataStyle":"\0"} */
  String batchGetStructure(java.util.Map<String, Object> paramsMap);
  void after0();
  void after1();
  void after2();
}
`;

describe('parseSourceSafe — embedded NUL recovery (#2426)', () => {
  afterEach(() => {
    records.length = 0;
    resetDegradedParseCounter();
  });

  for (const example of [
    ['direct string', 0],
    ['callback', 17_000],
  ] as const) {
    it(`recovers all Java methods through the ${example[0]} path`, () => {
      const [_path, paddingChars] = example;

      const source = buildNullByteJavaSource(paddingChars);
      const tree = parseSourceSafe(
        makeJavaParser(),
        source,
        undefined,
        undefined,
        'NullByteDemoService.java',
      );
      const methods = tree.rootNode.descendantsOfType('method_declaration');

      assert.equal(tree.rootNode.hasError, false);
      assert.equal(tree.rootNode.endIndex, source.length);
      assert.deepEqual(
        methods.map((method) => method.childForFieldName('name')?.text),
        ['before', 'batchGetStructure', 'after0', 'after1', 'after2'],
      );
      assert.equal(methods[2]?.childForFieldName('name')?.startIndex, source.indexOf('after0'));
      assert.equal(warnings().length, 1);
    });
  }

  it('reports all replacements with the supplied file label', () => {
    const source = buildNullByteJavaSource().replace('after1', '\0after1');

    parseSourceSafe(makeJavaParser(), source, undefined, undefined, 'src/Demo.java');

    assert.equal(warnings().length, 1);
    assert.partialDeepStrictEqual(warnings()[0], {
      file: 'src/Demo.java',
      nullByteCount: 2,
      msg: 'replaced embedded NUL bytes before tree-sitter parsing',
    });
  });

  it('keeps clean input on the existing path without a NUL warning', () => {
    const source = buildNullByteJavaSource().replace('\0', ' ');
    const tree = parseSourceSafe(makeJavaParser(), source, undefined, undefined, 'src/Demo.java');

    assert.equal(tree.rootNode.hasError, false);
    assert.equal(warnings().length, 0);
  });

  it('does not consume the degraded-tree warning allowance', () => {
    parseSourceSafe(makeJavaParser(), buildNullByteJavaSource());
    const parser = makeParser();
    const malformed = 'def broken(:\n    return (1 + \n';

    for (let index = 0; index < 20; index += 1) {
      parseSourceSafe(parser, malformed);
    }

    assert.equal(warnings().length, 1);
    assert.equal(records.filter((record) => record.level === 20).length, 20);
  });
});
