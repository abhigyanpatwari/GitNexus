/**
 * Ruby import resolution config.
 * Require/require_relative suffix matching — no standard fallback.
 */

import { SupportedLanguages } from 'gitnexus-shared';
import type { ImportResolutionConfig } from '../types.js';
import { rubyRequireStrategy } from '../ruby.js';

export const rubyImportConfig: ImportResolutionConfig = {
  language: SupportedLanguages.Ruby,
  strategies: [rubyRequireStrategy],
};
