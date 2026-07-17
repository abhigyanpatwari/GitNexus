/**
 * Literal-validation gate for `*_CALLABLE_CAPTURE_OPTIONS` blocks (#2522
 * review): the #1920 gate validates tree-sitter QUERY literals and exported
 * config objects, but the callable-flow option Sets are module-private
 * object-literal properties consumed via the shared synthesizer — a typo'd
 * node type there silently captures nothing (PHP shipped a dead
 * 'optional_parameter'). This gate extracts every `<key>NodeTypes: new
 * Set([...])` literal from each language's captures.ts and validates it
 * against that language's grammar.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SupportedLanguages } from '../../src/config/supported-languages.js';
import { loadGrammarModel, validateNodeType } from '../helpers/grammar-introspection.js';

const LANGUAGES_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'src',
  'core',
  'ingestion',
  'languages',
);

interface OptionLiteral {
  readonly language: SupportedLanguages;
  readonly key: string;
  readonly literal: string;
}

function collectOptionLiterals(): OptionLiteral[] {
  const out: OptionLiteral[] = [];
  for (const language of Object.values(SupportedLanguages)) {
    const file = join(LANGUAGES_DIR, language, 'captures.ts');
    if (!existsSync(file)) continue;
    const source = readFileSync(file, 'utf8');
    const block = source.match(/_CALLABLE_CAPTURE_OPTIONS\s*=\s*\{([\s\S]*?)\n\}\s*as const/);
    if (block === null) continue;
    // Only keys whose name says they hold tree-sitter NODE TYPES —
    // callableProtocolMethods (method names) and memberPointerOperators
    // (operator tokens) are deliberately outside this contract.
    const setRegex = /(\w+NodeTypes)\??:\s*new Set(?:<string>)?\(\[([\s\S]*?)\]\)/g;
    for (const match of block[1]!.matchAll(setRegex)) {
      for (const entry of match[2]!.matchAll(/'([^']+)'/g)) {
        out.push({ language, key: match[1]!, literal: entry[1]! });
      }
    }
  }
  return out;
}

describe('callable-capture-options literal gate (#2522)', () => {
  it('collects a plausible literal surface', () => {
    const literals = collectOptionLiterals();
    expect(literals.length).toBeGreaterThan(50);
    expect(literals.map((l) => l.language)).toContain(SupportedLanguages.JavaScript);
  });

  it('every node-type literal in a *_CALLABLE_CAPTURE_OPTIONS Set exists in its grammar', () => {
    const literals = collectOptionLiterals();
    const models = new Map<SupportedLanguages, ReturnType<typeof loadGrammarModel>>();
    const dead: string[] = [];
    for (const { language, key, literal } of literals) {
      if (!models.has(language)) models.set(language, loadGrammarModel(language));
      const verdict = validateNodeType(language, models.get(language) ?? null, literal);
      if (verdict === 'dead') dead.push(`${language}: ${key} → '${literal}'`);
    }
    expect(dead).toEqual([]);
  });
});
