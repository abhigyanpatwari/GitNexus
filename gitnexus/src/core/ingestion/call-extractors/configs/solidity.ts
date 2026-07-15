// gitnexus/src/core/ingestion/call-extractors/configs/solidity.ts

import { SupportedLanguages } from 'gitnexus-shared';
import type { CallExtractionConfig } from '../../call-types.js';

export const solidityCallConfig: CallExtractionConfig = {
  language: SupportedLanguages.Solidity,
  typeAsReceiverHeuristic: true,
};
