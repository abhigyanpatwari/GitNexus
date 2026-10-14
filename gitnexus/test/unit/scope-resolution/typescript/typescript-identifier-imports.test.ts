import { describe, expect, it } from 'vitest';
import { typescriptProvider } from '../../../../src/core/ingestion/languages/typescript.js';
import { extractParsedFile } from '../../../../src/core/ingestion/scope-extractor-bridge.js';
import { typescriptModuleExports } from '../../../../src/core/ingestion/languages/typescript/module-exports.js';

function parse(source: string) {
  const parsed = extractParsedFile(typescriptProvider, source, 'source.ts');
  expect(parsed).toBeDefined();
  return parsed!;
}

describe('ECMAScript identifier spellings at module boundaries', () => {
  it('canonicalizes requested exports while retaining written local import bindings', () => {
    const parsed = parse(
      String.raw`import { calc\u0075late, calcu\u006cate as loc\u0061l } from './source';`,
    );
    expect(parsed.parsedImports).toMatchObject([
      {
        kind: 'named',
        localName: String.raw`calc\u0075late`,
        importedName: 'calculate',
        targetRaw: './source',
      },
      {
        kind: 'alias',
        localName: String.raw`loc\u0061l`,
        importedName: 'calculate',
        alias: String.raw`loc\u0061l`,
        targetRaw: './source',
      },
    ]);
  });

  it('canonicalizes both sides of a re-export, including braced Unicode escapes', () => {
    const parsed = parse(
      String.raw`export { calc\u0075late, calcu\u{6c}ate as publ\u0069c } from './source';`,
    );
    expect(parsed.parsedImports).toMatchObject([
      {
        kind: 'reexport',
        localName: 'calculate',
        importedName: 'calculate',
        targetRaw: './source',
      },
      {
        kind: 'reexport',
        localName: 'public',
        importedName: 'calculate',
        alias: 'public',
        targetRaw: './source',
      },
    ]);
  });

  it('preserves written declaration identities behind canonical export names', () => {
    const parsed = parse(String.raw`export function calc\u0075late() { return 7; }`);
    const definition = parsed.localDefs.find((definition) => definition.type === 'Function')!;
    expect(definition.qualifiedName).toContain(String.raw`calc\u0075late`);
    expect([...typescriptModuleExports(parsed)]).toEqual([['calculate', definition]]);
  });

  it('does not publish an ambiguous canonical name under any escaped spelling', () => {
    const parsed = parse(String.raw`
export function calculate() { return 1; }
export function calc\u0075late() { return 2; }
export function calcu\u{6c}ate() { return 3; }
export function unique() { return 4; }
`);
    expect(parsed.localDefs.filter((definition) => definition.type === 'Function')).toHaveLength(4);
    expect([...typescriptModuleExports(parsed).keys()]).toEqual(['unique']);
  });
});
