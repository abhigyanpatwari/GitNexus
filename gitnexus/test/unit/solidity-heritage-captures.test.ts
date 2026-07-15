import { describe, it, expect, beforeAll } from 'vitest';
import {
  isLanguageAvailable,
  loadParser,
  loadLanguage,
} from '../../src/core/tree-sitter/parser-loader.js';
import { SupportedLanguages } from '../../src/config/supported-languages.js';
import { emitSolidityScopeCaptures } from '../../src/core/ingestion/languages/solidity/captures.js';

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

describe.skipIf(!solidityAvailable)('Solidity heritage captures', () => {
  it('emits @reference.inherits for contract is Base', () => {
    const src = `
pragma solidity ^0.8.0;
interface IFoo {}
contract Base {}
contract Child is Base, IFoo {}
`;
    const matches = emitSolidityScopeCaptures(src, 'Child.sol');
    const inherits = matches.filter((m) => m['@reference.inherits'] !== undefined);
    expect(inherits.map((m) => m['@reference.name']?.text).sort()).toEqual(['Base', 'IFoo']);
  });
});
