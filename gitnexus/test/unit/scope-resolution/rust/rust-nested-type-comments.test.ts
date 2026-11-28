import { describe, expect, it } from 'vitest';
import { rustProvider } from '../../../../src/core/ingestion/languages/rust.js';
import { typescriptProvider } from '../../../../src/core/ingestion/languages/typescript.js';
import { extractParsedFile } from '../../../../src/core/ingestion/scope-extractor-bridge.js';

describe('comments inside generic type lists', () => {
  it('keeps Rust parameter names and bounds around nested block comments', () => {
    const source = 'struct Pair<T /* 外 /* inner */ , Ghost, */ : Iterator<Item = u8>, U>(T, U);';
    const parsed = extractParsedFile(rustProvider, source, 'pair.rs');
    expect(parsed?.localDefs.find((d) => d.qualifiedName === 'Pair')?.typeParameters).toEqual([
      { name: 'T', bound: 'Iterator<Item = u8>' },
      { name: 'U' },
    ]);
  });

  it('keeps only the written trait arguments outside a nested comment', () => {
    const source = 'struct Pair; impl Trait<u8 /* 外 /* inner */ , Fake, */ , u16> for Pair {}';
    const parsed = extractParsedFile(rustProvider, source, 'pair.rs');
    expect(parsed?.referenceSites.find((site) => site.name === 'Trait')?.typeArguments).toEqual([
      'u8',
      'u16',
    ]);
  });

  it('closes a TypeScript block comment at the first closing delimiter', () => {
    const source = 'interface Pair<T /* outer /* inner */ , U> { first: T; second: U }';
    const parsed = extractParsedFile(typescriptProvider, source, 'pair.ts');
    expect(parsed?.localDefs.find((d) => d.qualifiedName === 'Pair')?.typeParameters).toEqual([
      { name: 'T' },
      { name: 'U' },
    ]);
  });
});
