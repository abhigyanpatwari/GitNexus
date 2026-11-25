import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { javaExportChecker } from '../../../../../src/core/ingestion/languages/java/export-visibility.js';
import { getJavaParser } from '../../../../../src/core/ingestion/languages/java/query.js';

describe('Java export detection', () => {
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
