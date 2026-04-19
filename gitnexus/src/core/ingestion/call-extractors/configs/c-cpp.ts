// gitnexus/src/core/ingestion/call-extractors/configs/c-cpp.ts

import { SupportedLanguages } from 'gitnexus-shared';
import type { CallExtractionConfig } from '../../call-types.js';

export const cCallConfig: CallExtractionConfig = {
  language: SupportedLanguages.C,
};

export const cppCallConfig: CallExtractionConfig = {
  language: SupportedLanguages.CPlusPlus,
};
