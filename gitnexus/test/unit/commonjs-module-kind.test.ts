import { describe, expect, it } from 'vitest';
import Parser from 'tree-sitter';
import TypeScript from 'tree-sitter-typescript';
import JavaScript from 'tree-sitter-javascript';
import {
  javascriptProvider,
  typescriptProvider,
} from '../../src/core/ingestion/languages/typescript.js';
import { extractParsedFile } from '../../src/core/ingestion/scope-extractor-bridge.js';
import { isCommonJsModule } from '../../src/core/ingestion/languages/typescript/cjs-export-assignment.js';
import type { SyntaxNode } from '../../src/core/ingestion/utils/ast-helpers.js';

describe('deep CommonJS classification', () => {
  it.each([false, true])('handles a deep expression with trailing ESM=%s', (esm) => {
    const node = (type: string, namedChildren: SyntaxNode[], text = '') =>
      ({ type, namedChildren, text, childForFieldName: () => null }) as unknown as SyntaxNode;
    let expression = node('identifier', [], 'module');
    for (let i = 0; i < 20000; i++) expression = node('binary_expression', [expression]);
    const root = node('program', esm ? [expression, node('export_statement', [])] : [expression]);
    expect(isCommonJsModule(root, 'deep.ts')).toBe(!esm);
  });
});

describe.each([
  ['JavaScript', javascriptProvider, JavaScript, 'js', 'cjs', 'mjs'],
  ['TypeScript', typescriptProvider, TypeScript.typescript, 'ts', 'cts', 'mts'],
] as const)(
  '%s module-kind capture',
  (_, provider, grammar, extension, commonJsExtension, esmExtension) => {
    it.each([
      ['module.exports.value = 1;', extension, true],
      ['export {}; module.exports.value = 1;', extension, false],
      ['import "./dep"; module.exports.value = 1;', extension, false],
      ['export {}; module.exports.value = 1;', commonJsExtension, true],
      ['module.exports.value = 1;', esmExtension, false],
    ] as const)('carries %j in .%s as %s through serialization', (source, suffix, expected) => {
      const parser = new Parser();
      parser.setLanguage(grammar);
      const tree = parser.parse(source);
      const filePath = `module.${suffix}`;
      const parsed = extractParsedFile(provider, source, filePath, undefined, tree);
      expect(parsed).toBeDefined();
      const channel = provider.collectCaptureSideChannel?.(filePath);
      expect(channel).toBe(expected);
      expect(
        JSON.parse(JSON.stringify({ ...parsed, captureSideChannel: channel })).captureSideChannel,
      ).toBe(expected);
      expect(provider.collectCaptureSideChannel?.(filePath)).toBeUndefined();
    });
  },
);
