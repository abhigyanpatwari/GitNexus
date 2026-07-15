/**
 * Unit tests for Solidity `this` / `super` receiver synthesis.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import Parser from 'tree-sitter';
import {
  isLanguageAvailable,
  loadParser,
  loadLanguage,
  getLanguageGrammar,
} from '../../../src/core/tree-sitter/parser-loader.js';
import { SupportedLanguages } from '../../../src/config/supported-languages.js';
import { synthesizeSolidityReceiverBinding } from '../../../src/core/ingestion/languages/solidity/receiver-binding.js';

let solidityAvailable = isLanguageAvailable(SupportedLanguages.Solidity);

describe.skipIf(!solidityAvailable)('synthesizeSolidityReceiverBinding', () => {
  let parser: Parser;

  beforeAll(async () => {
    await loadParser();
    await loadLanguage(SupportedLanguages.Solidity);
    parser = new Parser();
    parser.setLanguage(getLanguageGrammar(SupportedLanguages.Solidity) as Parser.Language);
  });

  it('emits this + super for a contract method with inheritance', () => {
    const tree = parser.parse(`
pragma solidity ^0.8.0;
contract Child is Base {
  function f() public { }
}
`);
    const fn = tree.rootNode.descendantsOfType('function_definition')[0]!;
    const matches = synthesizeSolidityReceiverBinding(fn);
    const names = matches.map((m) => m['@type-binding.name']?.text);
    const types = matches.map((m) => m['@type-binding.type']?.text);
    expect(names).toEqual(['this', 'super']);
    expect(types).toEqual(['Child', 'Base']);
  });

  it('emits only this when the contract has no inheritance', () => {
    const tree = parser.parse(`
pragma solidity ^0.8.0;
contract Solo {
  function f() public { }
}
`);
    const fn = tree.rootNode.descendantsOfType('function_definition')[0]!;
    const matches = synthesizeSolidityReceiverBinding(fn);
    expect(matches).toHaveLength(1);
    expect(matches[0]!['@type-binding.name']?.text).toBe('this');
    expect(matches[0]!['@type-binding.type']?.text).toBe('Solo');
  });

  it('emits nothing for free functions', () => {
    const tree = parser.parse(`
pragma solidity ^0.8.0;
function freeFn() pure returns (uint256) { return 1; }
`);
    const fn = tree.rootNode.descendantsOfType('function_definition')[0]!;
    expect(synthesizeSolidityReceiverBinding(fn)).toEqual([]);
  });
});
