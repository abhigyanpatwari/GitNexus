/**
 * Python import resolution config.
 * PEP 328 relative + proximity-based strategy, then standard fallback.
 */

import { SupportedLanguages } from 'gitnexus-shared';
import type { ImportResolutionConfig } from '../types.js';
import { createStandardStrategy } from '../standard.js';
import { pythonImportStrategy } from '../python.js';

export const pythonImportConfig: ImportResolutionConfig = {
  language: SupportedLanguages.Python,
  strategies: [pythonImportStrategy, createStandardStrategy(SupportedLanguages.Python)],
};
