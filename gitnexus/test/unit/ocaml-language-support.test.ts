import { describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';
import Parser from 'tree-sitter';
import { SupportedLanguages, getLanguageFromFilename } from 'gitnexus-shared';
import {
  isLanguageAvailable,
  loadLanguage,
  loadParser,
} from '../../src/core/tree-sitter/parser-loader.js';
import { getProvider } from '../../src/core/ingestion/languages/index.js';

const fixturesDir = path.resolve(__dirname, '..', 'fixtures', 'sample-code');

function readFixture(filename: string): string {
  return fs.readFileSync(path.join(fixturesDir, filename), 'utf-8');
}

function parseAndQuery(parser: Parser, content: string, queryStr: string) {
  const tree = parser.parse(content);
  const lang = parser.getLanguage();
  const query = new Parser.Query(lang, queryStr);
  return query.matches(tree.rootNode);
}

function captures(matches: Parser.QueryMatch[], captureName: string): string[] {
  const values: string[] = [];
  for (const match of matches) {
    for (const capture of match.captures) {
      if (capture.name === captureName) values.push(capture.node.text);
    }
  }
  return values;
}

describe('OCaml language support', () => {
  it('detects implementation and interface file extensions', () => {
    expect(getLanguageFromFilename('src/user_service.ml')).toBe(SupportedLanguages.OCaml);
    expect(getLanguageFromFilename('src/user_service.mli')).toBe(SupportedLanguages.OCaml);
  });

  it('loads implementation and interface grammars', async () => {
    expect(isLanguageAvailable(SupportedLanguages.OCaml, 'simple.ml')).toBe(true);
    expect(isLanguageAvailable(SupportedLanguages.OCaml, 'simple.mli')).toBe(true);

    await loadLanguage(SupportedLanguages.OCaml, 'simple.ml');
    await loadLanguage(SupportedLanguages.OCaml, 'simple.mli');
  });

  it('captures foundational definitions and imports from implementation files', async () => {
    const parser = await loadParser();
    await loadLanguage(SupportedLanguages.OCaml, 'simple.ml');

    const provider = getProvider(SupportedLanguages.OCaml);
    const matches = parseAndQuery(parser, readFixture('simple.ml'), provider.treeSitterQueries);

    const names = captures(matches, 'name');
    expect(names).toEqual(expect.arrayContaining(['UserService', 'user', 'create_user', 'greet']));
    expect(captures(matches, 'import.source')).toContain('UserService');
    expect(captures(matches, 'call.name')).toEqual(
      expect.arrayContaining(['print_endline', 'create_user', 'greet']),
    );
  });

  it('captures exposed declarations from interface files', async () => {
    const parser = await loadParser();
    await loadLanguage(SupportedLanguages.OCaml, 'simple.mli');

    const provider = getProvider(SupportedLanguages.OCaml);
    const matches = parseAndQuery(parser, readFixture('simple.mli'), provider.treeSitterQueries);

    const names = captures(matches, 'name');
    expect(names).toEqual(expect.arrayContaining(['UserService', 'user', 'create_user', 'greet']));
  });
});
