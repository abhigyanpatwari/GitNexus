/**
 * Go import resolution config.
 * Go-specific package strategy (go.mod), then standard fallback.
 */

import { SupportedLanguages } from 'gitnexus-shared';
import type { ImportResolutionConfig } from '../types.js';
import { createStandardStrategy } from '../standard.js';
import { goPackageStrategy } from '../go.js';

export const goImportConfig: ImportResolutionConfig = {
  language: SupportedLanguages.Go,
  strategies: [goPackageStrategy, createStandardStrategy(SupportedLanguages.Go)],
};
