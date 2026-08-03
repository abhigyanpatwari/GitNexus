/**
 * Objective-C language provider.
 *
 * Objective-C is intentionally registered only for `.m`. Ambiguous `.h` files
 * are routed by the source-language classifier before provider lookup, while
 * Objective-C++ `.mm` remains unsupported.
 */

import { SupportedLanguages } from 'gitnexus-shared';
import { defineLanguage } from '../language-provider.js';
import type { ExportChecker } from '../export-detection.js';
import { createImportResolver } from '../import-resolvers/resolver-factory.js';
import { createStandardStrategy } from '../import-resolvers/standard.js';
import { OBJECTIVE_C_QUERIES } from '../tree-sitter-queries.js';
import { typeConfig as cFamilyTypeConfig } from '../type-extractors/c-cpp.js';
import {
  objectiveCCallExtractor,
  objectiveCClassExtractor,
  objectiveCFieldExtractor,
  objectiveCMethodExtractor,
  objectiveCVariableExtractor,
} from './objective-c/extractors.js';
import { emitObjectiveCScopeCaptures } from './objective-c/captures.js';
import {
  interpretObjectiveCImport,
  interpretObjectiveCTypeBinding,
} from './objective-c/interpret.js';
import {
  objectiveCBindingScopeFor,
  objectiveCImportOwningScope,
  objectiveCReceiverBinding,
} from './objective-c/simple-hooks.js';
import { collectObjectiveCCaptureSideChannel } from './objective-c/capture-side-channel.js';
import { assertCloneable } from '../workers/clone-safety.js';
import { extractObjectiveCDefinitionMetadata } from './objective-c/metadata.js';

/**
 * Public declarations live in interfaces/protocols. Concrete implementation
 * methods are private to the implementation unless a matching public
 * declaration is present elsewhere in the project graph.
 */
const objectiveCExportChecker: ExportChecker = (node) => {
  let current = node;
  while (current) {
    if (current.type === 'class_implementation') return false;
    if (current.type === 'method_definition') return false;
    if (current.type === 'class_interface') return true;
    if (current.type === 'protocol_declaration') return true;
    if (current.type === 'method_declaration') return true;
    current = current.parent;
  }

  // C-compatible top-level declarations keep C's external-linkage default.
  return true;
};

export const objectiveCProvider = defineLanguage({
  id: SupportedLanguages.ObjectiveC,
  extensions: ['.m'],
  treeSitterQueries: OBJECTIVE_C_QUERIES,
  typeConfig: cFamilyTypeConfig,
  exportChecker: objectiveCExportChecker,
  callExtractor: objectiveCCallExtractor,
  classExtractor: objectiveCClassExtractor,
  fieldExtractor: objectiveCFieldExtractor,
  methodExtractor: objectiveCMethodExtractor,
  variableExtractor: objectiveCVariableExtractor,
  emitScopeCaptures: emitObjectiveCScopeCaptures,
  collectCaptureSideChannel: (filePath) =>
    assertCloneable(collectObjectiveCCaptureSideChannel(filePath)),
  interpretImport: interpretObjectiveCImport,
  interpretTypeBinding: interpretObjectiveCTypeBinding,
  bindingScopeFor: objectiveCBindingScopeFor,
  importOwningScope: objectiveCImportOwningScope,
  receiverBinding: objectiveCReceiverBinding,
  attachDefinitionToEnclosingOwner: (definitionNode) => definitionNode.type !== 'block_literal',
  extractDefinitionMetadata: extractObjectiveCDefinitionMetadata,
  importResolver: createImportResolver({
    language: SupportedLanguages.ObjectiveC,
    strategies: [createStandardStrategy(SupportedLanguages.ObjectiveC)],
  }),
});
