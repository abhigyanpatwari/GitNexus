/**
 * OCaml Language Provider
 *
 * Experimental V1 support for `.ml` implementation files and `.mli` interface
 * files. The parser-loader chooses the correct tree-sitter-ocaml grammar by
 * file path; this provider keeps graph extraction intentionally foundational.
 */

import { SupportedLanguages } from 'gitnexus-shared';
import { defineLanguage } from '../language-provider.js';
import { OCAML_QUERIES } from '../tree-sitter-queries.js';
import { createCallExtractor } from '../call-extractors/generic.js';

const BUILT_INS: ReadonlySet<string> = new Set([
  'print_endline',
  'print_string',
  'print_int',
  'Printf',
  'List',
  'Array',
  'String',
  'Option',
  'Result',
]);

export const ocamlProvider = defineLanguage({
  id: SupportedLanguages.OCaml,
  extensions: ['.ml', '.mli'],
  entryPointPatterns: [/^main$/],
  astFrameworkPatterns: [],
  treeSitterQueries: OCAML_QUERIES,
  typeConfig: {
    declarationNodeTypes: new Set(['value_definition', 'value_specification']),
    extractDeclaration: () => undefined,
    extractParameter: () => undefined,
  },
  exportChecker: () => true,
  importResolver: () => null,
  importSemantics: 'wildcard-leaf',
  callExtractor: createCallExtractor({ language: SupportedLanguages.OCaml }),
  builtInNames: BUILT_INS,
});
