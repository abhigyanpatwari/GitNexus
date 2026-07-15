/**
 * Unit: Solidity named / aliased / namespace / wildcard import decomposition.
 */
import { describe, expect, it, beforeAll } from 'vitest';
import {
  isLanguageAvailable,
  loadParser,
  loadLanguage,
} from '../../src/core/tree-sitter/parser-loader.js';
import { SupportedLanguages } from '../../src/config/supported-languages.js';
import { emitSolidityScopeCaptures } from '../../src/core/ingestion/languages/solidity/captures.js';
import { interpretSolidityImport } from '../../src/core/ingestion/languages/solidity/interpret.js';
import { extract } from '../../src/core/ingestion/scope-extractor.js';
import { solidityProvider } from '../../src/core/ingestion/languages/solidity.js';

let solidityAvailable = isLanguageAvailable(SupportedLanguages.Solidity);

beforeAll(async () => {
  if (!solidityAvailable) return;
  try {
    await loadParser();
    await loadLanguage(SupportedLanguages.Solidity);
  } catch {
    solidityAvailable = false;
  }
});

function parsedImports(source: string) {
  const captures = emitSolidityScopeCaptures(source, 'Caller.sol');
  const file = extract(captures, 'Caller.sol', solidityProvider);
  return file.parsedImports;
}

describe.skipIf(!solidityAvailable)('Solidity named import decomposition', () => {
  it('path-only import → wildcard', () => {
    const imports = parsedImports('pragma solidity ^0.8.0;\nimport "./Lib.sol";\n');
    expect(imports).toEqual([{ kind: 'wildcard', targetRaw: './Lib.sol' }]);
  });

  it('path alias → namespace', () => {
    const imports = parsedImports('pragma solidity ^0.8.0;\nimport "./Lib.sol" as Lib;\n');
    expect(imports).toEqual([
      {
        kind: 'namespace',
        localName: 'Lib',
        importedName: './Lib.sol',
        targetRaw: './Lib.sol',
      },
    ]);
  });

  it('star-as → namespace', () => {
    const imports = parsedImports(
      'pragma solidity ^0.8.0;\nimport * as Lib from "./Lib.sol";\n',
    );
    expect(imports).toEqual([
      {
        kind: 'namespace',
        localName: 'Lib',
        importedName: './Lib.sol',
        targetRaw: './Lib.sol',
      },
    ]);
  });

  it('single symbol from → named', () => {
    const imports = parsedImports('pragma solidity ^0.8.0;\nimport Foo from "./Lib.sol";\n');
    expect(imports).toEqual([
      {
        kind: 'named',
        localName: 'Foo',
        importedName: 'Foo',
        targetRaw: './Lib.sol',
      },
    ]);
  });

  it('single symbol as alias from → alias', () => {
    const imports = parsedImports(
      'pragma solidity ^0.8.0;\nimport Foo as F from "./Lib.sol";\n',
    );
    expect(imports).toEqual([
      {
        kind: 'alias',
        localName: 'F',
        importedName: 'Foo',
        alias: 'F',
        targetRaw: './Lib.sol',
      },
    ]);
  });

  it('brace named + aliased → two bindings', () => {
    const imports = parsedImports(
      'pragma solidity ^0.8.0;\nimport {Foo, Bar as B} from "./Lib.sol";\n',
    );
    expect(imports).toEqual([
      {
        kind: 'named',
        localName: 'Foo',
        importedName: 'Foo',
        targetRaw: './Lib.sol',
      },
      {
        kind: 'alias',
        localName: 'B',
        importedName: 'Bar',
        alias: 'B',
        targetRaw: './Lib.sol',
      },
    ]);
  });

  it('interpretSolidityImport rejects undecorated captures', () => {
    expect(
      interpretSolidityImport({
        '@import.source': {
          name: '@import.source',
          text: '"./Lib.sol"',
          range: { startLine: 1, startCol: 0, endLine: 1, endCol: 11 },
        },
      }),
    ).toBeNull();
  });
});
