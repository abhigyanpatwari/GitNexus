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

import { SupportedLanguages } from 'gitnexus-shared';
import type { NodeLabel } from 'gitnexus-shared';
import { createClassExtractor } from '../class-extractors/generic.js';
import { defineLanguage } from '../language-provider.js';
import type { SyntaxNode } from '../utils/ast-helpers.js';
import { typeConfig as rustConfig } from '../type-extractors/rust.js';
import { rustExportChecker } from '../export-detection.js';
import { resolveRustImport } from '../import-resolvers/rust.js';
import { extractRustNamedBindings } from '../named-bindings/rust.js';
import { RUST_QUERIES } from '../tree-sitter-queries.js';
import { createFieldExtractor } from '../field-extractors/generic.js';
import { rustConfig as rustFieldConfig } from '../field-extractors/configs/rust.js';
import { createMethodExtractor } from '../method-extractors/generic.js';
import { rustMethodConfig } from '../method-extractors/configs/rust.js';

/** Rust impl_item: find the function_item child and extract its name as a Method. */
const rustExtractFunctionName = (
  node: SyntaxNode,
): { funcName: string | null; label: NodeLabel } | null => {
  if (node.type !== 'impl_item') return null;

  let funcItem: SyntaxNode | null = null;
  for (let i = 0; i < node.childCount; i++) {
    const c = node.child(i);
    if (c?.type === 'function_item') {
      funcItem = c;
      break;
    }
  }
  if (!funcItem) return null;

  let nameNode = funcItem.childForFieldName?.('name');
  if (!nameNode) {
    for (let i = 0; i < funcItem.childCount; i++) {
      const c = funcItem.child(i);
      if (c?.type === 'identifier') {
        nameNode = c;
        break;
      }
    }
  }
  return { funcName: nameNode?.text ?? null, label: 'Method' };
};

const BUILT_INS: ReadonlySet<string> = new Set([
  'unwrap',
  'expect',
  'unwrap_or',
  'unwrap_or_else',
  'unwrap_or_default',
  'ok',
  'err',
  'is_ok',
  'is_err',
  'map',
  'map_err',
  'and_then',
  'or_else',
  'clone',
  'to_string',
  'to_owned',
  'into',
  'from',
  'as_ref',
  'as_mut',
  'iter',
  'into_iter',
  'collect',
  'filter',
  'fold',
  'for_each',
  'len',
  'is_empty',
  'push',
  'pop',
  'insert',
  'remove',
  'contains',
  'format',
  'write',
  'writeln',
  'panic',
  'unreachable',
  'todo',
  'unimplemented',
  'vec',
  'println',
  'eprintln',
  'dbg',
  'lock',
  'read',
  'try_lock',
  'spawn',
  'join',
  'sleep',
  'Some',
  'None',
  'Ok',
  'Err',
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
  fieldExtractor: createFieldExtractor(rustFieldConfig),
  methodExtractor: createMethodExtractor({
    ...rustMethodConfig,
    extractFunctionName: rustExtractFunctionName,
  }),
  classExtractor: createClassExtractor({
    language: SupportedLanguages.Rust,
    typeDeclarationNodes: ['struct_item', 'enum_item'],
    ancestorScopeNodeTypes: ['mod_item', 'struct_item', 'enum_item'],
  }),
  builtInNames: BUILT_INS,
});
