import assert from 'node:assert/strict';
import { it } from 'node:test';
import Parser from 'tree-sitter';
import TypeScript from 'tree-sitter-typescript';
import { typescriptProvider } from '../../../../src/core/ingestion/languages/typescript.js';
import { extractParsedFile } from '../../../../src/core/ingestion/scope-extractor-bridge.js';

for (const [source, suffix, expected] of [
  ['module.exports.value = 1;', 'ts', true],
  ['export {}; module.exports.value = 1;', 'ts', false],
  ['import "./dep"; module.exports.value = 1;', 'ts', false],
  ['export {}; module.exports.value = 1;', 'cts', true],
  ['module.exports.value = 1;', 'mts', false],
] as const) {
  it(`preserves CommonJS=${expected} for ${source} in .${suffix} across serialization`, () => {
    const parser = new Parser();
    parser.setLanguage(TypeScript.typescript);
    const file = `module.${suffix}`;
    const parsed = extractParsedFile(
      typescriptProvider,
      source,
      file,
      undefined,
      parser.parse(source),
    );
    assert.ok(parsed);
    const captureSideChannel = typescriptProvider.collectCaptureSideChannel?.(file);
    assert.equal(captureSideChannel, expected);
    assert.equal(
      JSON.parse(JSON.stringify({ ...parsed, captureSideChannel })).captureSideChannel,
      expected,
    );
    assert.equal(typescriptProvider.collectCaptureSideChannel?.(file), undefined);
  });
}
