/**
 * PHP language provider.
 *
 * PHP uses named imports (use statements for classes/functions/constants),
 * and standard export/import resolution. PHP files can use a variety of
 * extensions from legacy versions through modern PHP 8.
 */

import { SupportedLanguages } from '../../../config/supported-languages.js';
import { defineLanguage } from '../language-provider.js';
import { typeConfigs } from '../type-extractors/index.js';
import { callRouters } from '../call-routing.js';
import { exportCheckers } from '../export-detection.js';
import { importResolvers, namedBindingExtractors } from '../import-resolution.js';
import { LANGUAGE_QUERIES } from '../tree-sitter-queries.js';
import { phpDescriptionExtractor, isPhpRouteFile } from '../helpers/php.js';

export const phpProvider = defineLanguage({
  id: SupportedLanguages.PHP,
  extensions: ['.php', '.phtml', '.php3', '.php4', '.php5', '.php8'],
  treeSitterQueries: LANGUAGE_QUERIES[SupportedLanguages.PHP],
  typeConfig: typeConfigs[SupportedLanguages.PHP],
  exportChecker: exportCheckers[SupportedLanguages.PHP],
  importResolver: importResolvers[SupportedLanguages.PHP],
  callRouter: callRouters[SupportedLanguages.PHP],
  namedBindingExtractor: namedBindingExtractors[SupportedLanguages.PHP],
  descriptionExtractor: phpDescriptionExtractor,
  isRouteFile: isPhpRouteFile,
});
