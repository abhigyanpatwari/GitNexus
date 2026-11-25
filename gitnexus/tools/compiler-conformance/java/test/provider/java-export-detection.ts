import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { javaExportChecker } from '../../../../../src/core/ingestion/export-detection.js';
import { getJavaParser } from '../../../../../src/core/ingestion/languages/java/query.js';

describe('Java export detection', () => {
  for (const example of [
    ['public class A { void run() {} }', true],
    ['class A { public void run() {} }', true],
    ['class A { /* comment */ @Deprecated public void run() {} }', true],
    ['class A { private void run() {} }', false],
    ['class A { void run() {} }', false],
  ] as const) {
    it(`retains modifier and ancestor visibility: ${example[0]}`, () => {
      const [source, exported] = example;

      const tree = getJavaParser().parse(source);
      const method = tree.rootNode.descendantsOfType('method_declaration')[0]!;
      assert.equal(javaExportChecker(method.childForFieldName('name')!, 'run'), exported);
    });
  }

  it('does not scan sibling methods while checking a declaration', (t) => {
    const methods = Array.from({ length: 128 }, (_, i) => `void method${i}() {}`).join('\n');
    const tree = getJavaParser().parse(`class Wide { ${methods} }`);
    const body = tree.rootNode.namedChildren[0]!.childForFieldName('body')!;
    const name = body.namedChildren[0]!.childForFieldName('name')!;
    const child = t.mock.method(body, 'child');
    const namedChild = t.mock.method(body, 'namedChild');
    assert.equal(javaExportChecker(name, 'method0'), false);
    assert.ok(child.mock.calls.length + namedChild.mock.calls.length <= 1);
  });
});
