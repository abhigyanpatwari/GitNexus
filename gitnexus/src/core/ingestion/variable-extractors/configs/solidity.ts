// gitnexus/src/core/ingestion/variable-extractors/configs/solidity.ts

import { SupportedLanguages } from 'gitnexus-shared';
import type { VariableExtractionConfig } from '../../variable-types.js';

/**
 * Solidity has almost no file-scoped variables outside contracts.
 * Keep a minimal config so the generic extractor is wired; enrichment
 * for state variables happens via the field extractor.
 */
export const solidityVariableConfig: VariableExtractionConfig = {
  language: SupportedLanguages.Solidity,
  constNodeTypes: [],
  staticNodeTypes: [],
  variableNodeTypes: [],
  extractName: () => undefined,
  extractType: () => undefined,
  extractVisibility: () => 'private',
  isConst: () => false,
  isStatic: () => false,
  isMutable: () => true,
};
