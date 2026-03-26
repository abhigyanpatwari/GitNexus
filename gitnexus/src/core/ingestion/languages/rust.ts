/**
 * Rust Language Provider
 *
 * Assembles all Rust-specific ingestion capabilities into a single
 * LanguageProvider, following the Strategy pattern used by the pipeline.
 *
 * Key Rust traits:
 *   - importSemantics: 'named' (Rust has use X::{a, b})
 *   - mroStrategy: 'qualified-syntax' (Rust uses trait qualification, not MRO)
 *   - namedBindingExtractor: present (use X::{a, b} extracts named bindings)
 */

import { SupportedLanguages } from '../../../config/supported-languages.js';
import { defineLanguage } from '../language-provider.js';
import { typeConfig as rustConfig } from '../type-extractors/rust.js';
import { rustExportChecker } from '../export-detection.js';
import { resolveRustImport } from '../import-resolvers/rust.js';
import { extractRustNamedBindings } from '../named-bindings/rust.js';
import { RUST_QUERIES } from '../tree-sitter-queries.js';

const BUILT_INS: ReadonlySet<string> = new Set([
  'unwrap', 'expect', 'unwrap_or', 'unwrap_or_else', 'unwrap_or_default',
  'ok', 'err', 'is_ok', 'is_err', 'map', 'map_err', 'and_then', 'or_else',
  'clone', 'to_string', 'to_owned', 'into', 'from', 'as_ref', 'as_mut',
  'iter', 'into_iter', 'collect', 'filter', 'fold', 'for_each',
  'len', 'is_empty', 'push', 'pop', 'insert', 'remove', 'contains',
  'format', 'write', 'writeln', 'panic', 'unreachable', 'todo', 'unimplemented',
  'vec', 'println', 'eprintln', 'dbg',
  'lock', 'read', 'try_lock',
  'spawn', 'join', 'sleep',
  'Some', 'None', 'Ok', 'Err',
]);

export const rustProvider = defineLanguage({
  id: SupportedLanguages.Rust,
  extensions: ['.rs'],
  treeSitterQueries: RUST_QUERIES,
  typeConfig: rustConfig,
  exportChecker: rustExportChecker,
  importResolver: resolveRustImport,
  namedBindingExtractor: extractRustNamedBindings,
  mroStrategy: 'qualified-syntax',
  builtInNames: BUILT_INS,
});
