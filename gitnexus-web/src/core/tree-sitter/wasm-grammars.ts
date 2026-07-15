/**
 * Browser WASM grammar assets (`tree-sitter-wasms`).
 *
 * **Indexing path today:** `gitnexus-web` is a thin client — analyze runs on
 * `gitnexus serve` with native/vendored Node grammars (including Solidity).
 * `.sol` files uploaded or analyzed via the backend are fully supported when
 * the server has the Solidity grammar.
 *
 * **This module** is the WASM *load path* for browser-side Tree-sitter (future
 * in-browser parse, or tools that need a browser-compatible binary). Assets
 * are copied to `/wasm/` at Vite build/dev time — see `vite.config.ts`.
 *
 * Load sketch (requires adding `web-tree-sitter`):
 * ```ts
 * import Parser from 'web-tree-sitter';
 * await Parser.init({ locateFile: (f) => `/wasm/${f}` });
 * const lang = await Parser.Language.load(resolveWasmUrl(SupportedLanguages.Solidity));
 * ```
 */

import { SupportedLanguages } from 'gitnexus-shared';

/** Filename under `tree-sitter-wasms/out/` and served at `/wasm/<file>`. */
export type WasmGrammarFile = `tree-sitter-${string}.wasm`;

/**
 * Map of supported languages → WASM grammar file.
 * `null` = no browser WASM binary in `tree-sitter-wasms` (CLI/backend only).
 */
export const WASM_GRAMMAR_FILES: Readonly<
  Record<SupportedLanguages, WasmGrammarFile | null>
> = {
  [SupportedLanguages.JavaScript]: 'tree-sitter-javascript.wasm',
  [SupportedLanguages.TypeScript]: 'tree-sitter-typescript.wasm',
  // TSX is a sibling binary; resolve via resolveWasmUrl(..., { tsx: true }).
  [SupportedLanguages.Python]: 'tree-sitter-python.wasm',
  [SupportedLanguages.Java]: 'tree-sitter-java.wasm',
  [SupportedLanguages.C]: 'tree-sitter-c.wasm',
  [SupportedLanguages.CPlusPlus]: 'tree-sitter-cpp.wasm',
  [SupportedLanguages.CSharp]: 'tree-sitter-c_sharp.wasm',
  [SupportedLanguages.Go]: 'tree-sitter-go.wasm',
  [SupportedLanguages.Ruby]: 'tree-sitter-ruby.wasm',
  [SupportedLanguages.Rust]: 'tree-sitter-rust.wasm',
  [SupportedLanguages.PHP]: 'tree-sitter-php.wasm',
  [SupportedLanguages.Kotlin]: 'tree-sitter-kotlin.wasm',
  [SupportedLanguages.Swift]: 'tree-sitter-swift.wasm',
  [SupportedLanguages.Dart]: 'tree-sitter-dart.wasm',
  [SupportedLanguages.Vue]: 'tree-sitter-vue.wasm',
  [SupportedLanguages.Solidity]: 'tree-sitter-solidity.wasm',
  // COBOL is regex-based on the CLI — no tree-sitter WASM.
  [SupportedLanguages.Cobol]: null,
};

const TSX_WASM: WasmGrammarFile = 'tree-sitter-tsx.wasm';

/** Public URL prefix where Vite copies WASM binaries. */
export const WASM_PUBLIC_PREFIX = '/wasm';

export type ResolveWasmOptions = {
  /** Prefer the TSX grammar binary for TypeScript. */
  readonly tsx?: boolean;
};

/**
 * Resolve the browser URL for a language's WASM grammar, or `null` when
 * the language has no WASM asset (CLI/backend-only).
 */
export function resolveWasmUrl(
  language: SupportedLanguages,
  options: ResolveWasmOptions = {},
): string | null {
  if (language === SupportedLanguages.TypeScript && options.tsx === true) {
    return `${WASM_PUBLIC_PREFIX}/${TSX_WASM}`;
  }
  const file = WASM_GRAMMAR_FILES[language];
  if (file === null) return null;
  return `${WASM_PUBLIC_PREFIX}/${file}`;
}

/** Languages that have a browser WASM grammar available. */
export function listWasmSupportedLanguages(): SupportedLanguages[] {
  return (Object.keys(WASM_GRAMMAR_FILES) as SupportedLanguages[]).filter(
    (lang) => WASM_GRAMMAR_FILES[lang] !== null,
  );
}

/** True when a browser WASM binary is registered for this language. */
export function hasWasmGrammar(language: SupportedLanguages): boolean {
  return WASM_GRAMMAR_FILES[language] !== null;
}
