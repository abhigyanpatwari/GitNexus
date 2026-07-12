/**
 * Solidity structure-query + parser smoke.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'fs';
import path from 'path';
import Parser from 'tree-sitter';
import {
  isLanguageAvailable,
  loadParser,
  loadLanguage,
} from '../../src/core/tree-sitter/parser-loader.js';
import { SupportedLanguages } from '../../src/config/supported-languages.js';
import { SOLIDITY_QUERIES } from '../../src/core/ingestion/tree-sitter-queries.js';
import { solidityExportChecker } from '../../src/core/ingestion/export-detection.js';

let solidityAvailable = isLanguageAvailable(SupportedLanguages.Solidity);
let parser: Parser;

beforeAll(async () => {
  if (!solidityAvailable) return;
  try {
    parser = await loadParser();
    await loadLanguage(SupportedLanguages.Solidity);
  } catch {
    solidityAvailable = false;
  }
});

describe.skipIf(!solidityAvailable)('Solidity structure queries', () => {
  const fixture = fs.readFileSync(
    path.resolve(__dirname, '../fixtures/sample-code/simple.sol'),
    'utf8',
  );

  it('parses simple.sol without errors', () => {
    const tree = parser.parse(fixture);
    expect(tree.rootNode.type).toBe('source_file');
    expect(tree.rootNode.hasError).toBe(false);
  });

  it('captures contracts, interfaces, libraries, methods, and calls', () => {
    const tree = parser.parse(fixture);
    const query = new Parser.Query(parser.getLanguage(), SOLIDITY_QUERIES);
    const captures = query.captures(tree.rootNode);
    const byName = new Map<string, string[]>();
    for (const c of captures) {
      const list = byName.get(c.name) ?? [];
      list.push(c.node.text);
      byName.set(c.name, list);
    }

    expect(byName.get('definition.class')?.join('\n')).toMatch(/Ownable|MathLib|OwnershipTransferred|Unauthorized/);
    expect(byName.get('definition.interface')?.some((t) => t.includes('IOwnable'))).toBe(true);
    expect(byName.get('definition.method')?.join('\n')).toMatch(/setOwner|onlyOwner|owner|add/);
    expect(byName.get('definition.constructor')?.length).toBeGreaterThanOrEqual(1);
    expect(byName.get('definition.property')?.some((t) => t.includes('owner'))).toBe(true);
    expect(byName.get('call.name')).toEqual(expect.arrayContaining(['require', 'add']));
    expect(byName.get('import.source')?.some((t) => t.includes('Base.sol'))).toBe(true);
  });

  it('marks public/external functions as exported', () => {
    const tree = parser.parse(fixture);
    const query = new Parser.Query(
      parser.getLanguage(),
      '(function_definition function_name: (identifier) @name) @fn',
    );
    const matches = query.matches(tree.rootNode);
    const setOwner = matches.find((m) =>
      m.captures.some((c) => c.name === 'name' && c.node.text === 'setOwner'),
    );
    expect(setOwner).toBeDefined();
    const fnNode = setOwner!.captures.find((c) => c.name === 'fn')!.node;
    expect(solidityExportChecker(fnNode as any, 'setOwner')).toBe(true);
  });
});
