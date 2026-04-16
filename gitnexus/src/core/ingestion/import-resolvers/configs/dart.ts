/**
 * Dart import resolution config.
 * SDK/package strategy first, then relative import strategy (with ./ prepending).
 */

import { SupportedLanguages } from 'gitnexus-shared';
import type { ImportResolutionConfig } from '../types.js';
import { dartPackageStrategy, dartRelativeStrategy } from '../dart.js';

export const dartImportConfig: ImportResolutionConfig = {
  language: SupportedLanguages.Dart,
  strategies: [dartPackageStrategy, dartRelativeStrategy],
};
