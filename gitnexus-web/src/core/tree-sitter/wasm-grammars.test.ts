import { describe, expect, it } from 'vitest';
import { SupportedLanguages } from 'gitnexus-shared';
import {
  WASM_GRAMMAR_FILES,
  hasWasmGrammar,
  listWasmSupportedLanguages,
  resolveWasmUrl,
} from './wasm-grammars';

describe('WASM grammar registry', () => {
  it('registers Solidity → tree-sitter-solidity.wasm', () => {
    expect(WASM_GRAMMAR_FILES[SupportedLanguages.Solidity]).toBe('tree-sitter-solidity.wasm');
    expect(hasWasmGrammar(SupportedLanguages.Solidity)).toBe(true);
    expect(resolveWasmUrl(SupportedLanguages.Solidity)).toBe('/wasm/tree-sitter-solidity.wasm');
  });

  it('marks COBOL as CLI/backend-only (no WASM)', () => {
    expect(WASM_GRAMMAR_FILES[SupportedLanguages.Cobol]).toBeNull();
    expect(hasWasmGrammar(SupportedLanguages.Cobol)).toBe(false);
    expect(resolveWasmUrl(SupportedLanguages.Cobol)).toBeNull();
  });

  it('resolves TSX via options.tsx', () => {
    expect(resolveWasmUrl(SupportedLanguages.TypeScript, { tsx: true })).toBe(
      '/wasm/tree-sitter-tsx.wasm',
    );
  });

  it('lists Solidity among WASM-supported languages', () => {
    expect(listWasmSupportedLanguages()).toContain(SupportedLanguages.Solidity);
  });

  it('covers every SupportedLanguages member', () => {
    for (const lang of Object.values(SupportedLanguages)) {
      expect(lang in WASM_GRAMMAR_FILES).toBe(true);
    }
  });
});
