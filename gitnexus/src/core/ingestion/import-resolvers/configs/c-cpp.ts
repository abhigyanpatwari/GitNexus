/**
 * C / C++ import resolution configs.
 * Both use standard resolution for #include directives.
 */

import { SupportedLanguages } from 'gitnexus-shared';
import type { ImportResolutionConfig } from '../types.js';
import { createStandardStrategy } from '../standard.js';

export const cImportConfig: ImportResolutionConfig = {
  language: SupportedLanguages.C,
  strategies: [createStandardStrategy(SupportedLanguages.C)],
};

export const cppImportConfig: ImportResolutionConfig = {
  language: SupportedLanguages.CPlusPlus,
  strategies: [createStandardStrategy(SupportedLanguages.CPlusPlus)],
};
