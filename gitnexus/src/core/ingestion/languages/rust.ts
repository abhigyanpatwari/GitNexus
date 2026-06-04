/**
 * Rust Language Provider
 *
 * Assembles all Rust-specific ingestion capabilities into a single
 * LanguageProvider, following the Strategy pattern used by the pipeline.
 *
 * Key Rust traits:
 *   - mroStrategy: 'qualified-syntax' (Rust uses trait qualification, not MRO)
 */

import { SupportedLanguages } from 'gitnexus-shared';
import type { NodeLabel } from 'gitnexus-shared';
import { createClassExtractor } from '../class-extractors/generic.js';
import { rustClassConfig } from '../class-extractors/configs/rust.js';
import { defineLanguage } from '../language-provider.js';
import type { SyntaxNode } from '../utils/ast-helpers.js';
import { typeConfig as rustConfig } from '../type-extractors/rust.js';
import { rustExportChecker } from '../export-detection.js';
import { createImportResolver } from '../import-resolvers/resolver-factory.js';
import { rustImportConfig } from '../import-resolvers/configs/rust.js';
import { RUST_QUERIES } from '../tree-sitter-queries.js';
import type { AstFrameworkPatternConfig } from '../language-provider.js';
import { createFieldExtractor } from '../field-extractors/generic.js';
import { rustConfig as rustFieldConfig } from '../field-extractors/configs/rust.js';
import { createMethodExtractor } from '../method-extractors/generic.js';
import { rustMethodConfig } from '../method-extractors/configs/rust.js';
import { createVariableExtractor } from '../variable-extractors/generic.js';
import { rustVariableConfig } from '../variable-extractors/configs/rust.js';
import { createCallExtractor } from '../call-extractors/generic.js';
import { rustCallConfig } from '../call-extractors/configs/rust.js';
import {
  emitRustScopeCaptures,
  rustArityCompatibility,
  rustBindingScopeFor,
  rustImportOwningScope,
  rustReceiverBinding,
  interpretRustImport,
  interpretRustTypeBinding,
} from './rust/index.js';

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
  entryPointPatterns: [/^(get|post|put|delete)_handler$/i, /^handle_/, /^new$/, /^run$/, /^spawn/],
  astFrameworkPatterns: [
    {
      framework: 'actix-web',
      entryPointMultiplier: 3.0,
      reason: 'actix-attribute',
      patterns: [
        '#[get',
        '#[post',
        '#[put',
        '#[delete',
        '#[actix_web',
        'HttpRequest',
        'HttpResponse',
      ],
    },
    {
      framework: 'axum',
      entryPointMultiplier: 3.0,
      reason: 'axum-routing',
      patterns: ['Router::new', 'axum::extract', 'axum::routing'],
    },
    {
      framework: 'rocket',
      entryPointMultiplier: 3.0,
      reason: 'rocket-attribute',
      patterns: ['#[get', '#[post', '#[launch', 'rocket::'],
    },
    {
      framework: 'tokio',
      entryPointMultiplier: 2.5,
      reason: 'tokio-runtime',
      patterns: ['#[tokio::main]', '#[tokio::test]'],
    },
  ] satisfies AstFrameworkPatternConfig[],
  treeSitterQueries: RUST_QUERIES,
  typeConfig: rustConfig,
  exportChecker: rustExportChecker,
  importResolver: createImportResolver(rustImportConfig),
  mroStrategy: 'qualified-syntax',
  callExtractor: createCallExtractor(rustCallConfig),
  fieldExtractor: createFieldExtractor(rustFieldConfig),
  methodExtractor: createMethodExtractor({
    ...rustMethodConfig,
    extractFunctionName: rustExtractFunctionName,
  }),
  variableExtractor: createVariableExtractor(rustVariableConfig),
  classExtractor: createClassExtractor(rustClassConfig),
  builtInNames: BUILT_INS,
  // ── RFC #909 Ring 3: scope-based resolution hooks ──────────
  emitScopeCaptures: emitRustScopeCaptures,
  interpretImport: interpretRustImport,
  interpretTypeBinding: interpretRustTypeBinding,
  bindingScopeFor: rustBindingScopeFor,
  importOwningScope: rustImportOwningScope,
  receiverBinding: rustReceiverBinding,
  arityCompatibility: rustArityCompatibility,
});
