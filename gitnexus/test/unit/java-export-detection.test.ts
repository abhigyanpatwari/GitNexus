import { describe, expect, it, vi } from 'vitest';
import { javaExportChecker } from '../../src/core/ingestion/export-detection.js';
import { getJavaParser } from '../../src/core/ingestion/languages/java/query.js';

describe('Java export detection', () => {
  it.each([
    ['public class A { void run() {} }', true],
    ['class A { public void run() {} }', true],
    ['class A { /* comment */ @Deprecated public void run() {} }', true],
    ['class A { private void run() {} }', false],
    ['class A { void run() {} }', false],
  ])('retains modifier and ancestor visibility: %s', (source, exported) => {
    const tree = getJavaParser().parse(source);
    const method = tree.rootNode.descendantsOfType('method_declaration')[0]!;
    expect(javaExportChecker(method.childForFieldName('name')!, 'run')).toBe(exported);
  });

  it('does not scan sibling methods while checking a declaration', () => {
    const tree = getJavaParser().parse(
      `class Wide { ${Array.from({ length: 128 }, (_, i) => `void method${i}() {}`).join('\n')} }`,
    );
    const body = tree.rootNode.namedChildren[0]!.childForFieldName('body')!;
    const name = body.namedChildren[0]!.childForFieldName('name')!;
    const child = vi.spyOn(body, 'child');
    const namedChild = vi.spyOn(body, 'namedChild');
    expect(javaExportChecker(name, 'method0')).toBe(false);
    expect(child.mock.calls.length + namedChild.mock.calls.length).toBeLessThanOrEqual(1);
  });
});
