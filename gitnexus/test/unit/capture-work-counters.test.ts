import { describe, expect, it } from 'vitest';
import Parser from 'tree-sitter';
import TypeScript from 'tree-sitter-typescript';

const moduleUrl = new URL('../../bench/dart-closure-binders/capture-work.mjs', import.meta.url);
const { captureWork } = await import(moduleUrl.href);

describe('capture work map counters', () => {
  it.each(['keys', 'values', 'entries', Symbol.iterator] as const)(
    'excludes native wrapper values consistently for %s',
    (method) => {
      const parser = new Parser();
      parser.setLanguage(TypeScript.typescript);
      const tree = parser.parse('const value = 1;');
      const wrappers = new Map([['wrapper', tree.rootNode]]);
      const metadata = new Map([[tree.rootNode, 'fact']]);
      const iterator = Map.prototype[method];
      const work = captureWork([{ content: '', path: 'test.dart' }], function* () {
        for (const _entry of Map.prototype[method].call(wrappers)) yield {};
        for (const _entry of Map.prototype[method].call(metadata)) yield {};
      });
      expect(work.map_visits).toBe(1);
      expect(Map.prototype[method]).toBe(iterator);
    },
  );
});
