// gitnexus/src/core/ingestion/call-extractors/configs/typescript-javascript.ts

import { SupportedLanguages } from 'gitnexus-shared';
import type { CallExtractionConfig } from '../../call-types.js';

export const typescriptCallConfig: CallExtractionConfig = {
  language: SupportedLanguages.TypeScript,
};

export const javascriptCallConfig: CallExtractionConfig = {
  language: SupportedLanguages.JavaScript,
};
