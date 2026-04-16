/**
 * Rust import resolution config.
 * Rust module strategy (grouped imports, crate/super/self paths), then standard fallback.
 */

import { SupportedLanguages } from 'gitnexus-shared';
import type { ImportResolutionConfig } from '../types.js';
import { createStandardStrategy } from '../standard.js';
import { rustModuleStrategy } from '../rust.js';

export const rustImportConfig: ImportResolutionConfig = {
  language: SupportedLanguages.Rust,
  strategies: [rustModuleStrategy, createStandardStrategy(SupportedLanguages.Rust)],
};
