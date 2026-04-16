/**
 * PHP import resolution config.
 * PSR-4 strategy via composer.json — no standard fallback (PSR-4 includes its own suffix matching).
 */

import { SupportedLanguages } from 'gitnexus-shared';
import type { ImportResolutionConfig } from '../types.js';
import { phpPsr4Strategy } from '../php.js';

export const phpImportConfig: ImportResolutionConfig = {
  language: SupportedLanguages.PHP,
  strategies: [phpPsr4Strategy],
};
