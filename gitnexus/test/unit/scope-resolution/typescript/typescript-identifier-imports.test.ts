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

  it('forwards imported bindings with the original module and per-specifier erasure', () => {
    const parsed = parse(`
      import './init';
      import main, { type Item, run, unused } from './leaf';
      import * as ns from './other';
      export { main as start, Item as Public, type run as Signature, ns as "module object" };
    `);
    const forwarded = parsed.parsedImports.filter((entry) => entry.exportsOnly);
    expect(forwarded).toMatchObject([
      { kind: 'reexport', localName: 'start', importedName: 'default', targetRaw: './leaf' },
      {
        kind: 'reexport',
        localName: 'Public',
        importedName: 'Item',
        targetRaw: './leaf',
        typeOnly: true,
      },
      {
        kind: 'reexport',
        localName: 'Signature',
        importedName: 'run',
        targetRaw: './leaf',
        typeOnly: true,
      },
      { kind: 'namespace', localName: 'module object', targetRaw: './other' },
    ]);
    expect(forwarded[0]).not.toHaveProperty('typeOnly');
    expect(forwarded[3]).not.toHaveProperty('typeOnly');
  });

  it('marks every public spelling of a type declaration as erased', () => {
    const exports = typescriptModuleExports(
      parse(`
      export interface Shape {}
      export type Size = number;
      export { Size as Dimension };
      export default interface DefaultShape {}
      export { DefaultShape as Other };
      export type Dual = number;
      export function Dual() {}
    `),
    );
    for (const name of ['Shape', 'Size', 'Dimension', 'default', 'Other']) {
      expect(exports.get(name)?.typeOnlyExports).toContain(name);
    }
    expect(exports.get('Dual')).toMatchObject({ type: 'Function' });
    expect(exports.get('Dual')?.typeOnlyExports).toBeUndefined();
  });

  it('keeps erased aliases out of the value names and preserves a separately exported value', () => {
    const exports = typescriptModuleExports(
      parse(String.raw`
      class Impl {}
      export type { Impl as "P\u0075blic" };
      export function live() {}
      export { type live as Erased };
    `),
    );
    expect([...exports.keys()].sort()).toEqual(['Erased', 'Public', 'live']);
    expect(exports.get('Public')).toMatchObject({
      qualifiedName: 'Impl',
      namedExports: [],
      typeOnlyExports: ['Public'],
    });
    expect(exports.get('live')).toBe(exports.get('Erased'));
    expect(exports.get('live')).toMatchObject({
      namedExports: ['live'],
      typeOnlyExports: ['Erased'],
    });
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

describe('default export key (#3956)', () => {
  it('publishes a default-exported declaration under `default`', () => {
    const parsed = parse('export default function Child() {}');
    const exports = typescriptModuleExports(parsed);
    expect(exports.get('default')?.type).toBe('Function');
    expect(exports.get('default')).toBe(parsed.localDefs.find((def) => def.type === 'Function'));
    expect(exports.has('Child')).toBe(false);
  });

  it('maps `default` to the callable winner of a `const` arrow default', () => {
    const parsed = parse('const X = () => 1;\nexport default X;');
    const exports = typescriptModuleExports(parsed);
    expect(exports.get('default')?.type).toBe('Function');
    expect(exports.get('default')).toBe(parsed.localDefs.find((def) => def.type === 'Function'));
    expect(exports.has('X')).toBe(false);
  });

  it('maps an overloaded default to the same def as its explicitly published name', () => {
    const exports = typescriptModuleExports(
      parse(
        'export default function f(a: string): void;\nexport default function f(a: number): void;\nexport default function f(a: unknown) {}\nexport { f };',
      ),
    );
    expect(exports.get('default')).toBeDefined();
    expect(exports.get('default')).toBe(exports.get('f'));
  });

  it('publishes no `default` for two differently named defaults or for a file without one', () => {
    expect(
      typescriptModuleExports(
        parse('export default function A() {}\nexport default function B() {}'),
      ).has('default'),
    ).toBe(false);
    expect(typescriptModuleExports(parse('export function Named() {}')).has('default')).toBe(false);
  });
});
