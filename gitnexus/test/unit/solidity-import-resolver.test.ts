/**
 * Unit smoke: Solidity import resolver strategies.
 */
import { describe, expect, it } from 'vitest';
import { SupportedLanguages } from '../../src/config/supported-languages.js';
import { getLanguageFromFilename } from 'gitnexus-shared';
import {
  solidityRelativeStrategy,
  solidityRemappingStrategy,
} from '../../src/core/ingestion/import-resolvers/configs/solidity.js';
import type { ResolveCtx } from '../../src/core/ingestion/import-resolvers/types.js';
import { buildSuffixIndex } from '../../src/core/ingestion/import-resolvers/utils.js';

function makeCtx(files: string[]): ResolveCtx {
  const allFileList = files;
  const normalizedFileList = files.map((f) => f.replace(/\\/g, '/'));
  const index = buildSuffixIndex(normalizedFileList, allFileList);
  return {
    allFilePaths: new Set(files),
    allFileList,
    normalizedFileList,
    index,
    resolveCache: new Map(),
    configs: {
      tsconfigPaths: null,
      goModule: null,
      composerConfig: null,
      swiftPackageConfig: null,
      csharpConfigs: [],
    },
  };
}

describe('solidity language detection', () => {
  it('maps .sol to Solidity', () => {
    expect(getLanguageFromFilename('contracts/Foo.sol')).toBe(SupportedLanguages.Solidity);
  });
});

describe('solidity import resolver', () => {
  it('resolves relative imports', () => {
    const result = solidityRelativeStrategy(
      '"./Base.sol"',
      'contracts/Child.sol',
      makeCtx(['contracts/Base.sol', 'contracts/Child.sol']),
    );
    expect(result).toEqual({ kind: 'files', files: ['contracts/Base.sol'] });
  });

  it('suffix-matches remapped paths', () => {
    const result = solidityRemappingStrategy(
      '"@openzeppelin/contracts/access/Ownable.sol"',
      'contracts/Child.sol',
      makeCtx([
        'lib/openzeppelin-contracts/contracts/access/Ownable.sol',
        'contracts/Child.sol',
      ]),
    );
    expect(result).toEqual({
      kind: 'files',
      files: ['lib/openzeppelin-contracts/contracts/access/Ownable.sol'],
    });
  });
});
