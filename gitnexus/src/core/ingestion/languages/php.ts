/**
 * PHP language provider.
 *
 * PHP uses named imports (use statements for classes/functions/constants),
 * and standard export/import resolution. PHP files can use a variety of
 * extensions from legacy versions through modern PHP 8.
 */

import { SupportedLanguages } from '../../../config/supported-languages.js';
import { defineLanguage } from '../language-provider.js';
import { typeConfig as phpConfig } from '../type-extractors/php.js';
import { callRouters } from '../call-routing.js';
import { exportCheckers } from '../export-detection.js';
import { importResolvers } from '../import-resolution.js';
import { extractPhpNamedBindings } from '../named-binding-extraction.js';
import { PHP_QUERIES } from '../tree-sitter-queries.js';
import { phpDescriptionExtractor, isPhpRouteFile } from '../helpers/php.js';

export const phpProvider = defineLanguage({
  id: SupportedLanguages.PHP,
  extensions: ['.php', '.phtml', '.php3', '.php4', '.php5', '.php8'],
  treeSitterQueries: PHP_QUERIES,
  typeConfig: phpConfig,
  exportChecker: exportCheckers[SupportedLanguages.PHP],
  importResolver: importResolvers[SupportedLanguages.PHP],
  callRouter: callRouters[SupportedLanguages.PHP],
  namedBindingExtractor: extractPhpNamedBindings,
  descriptionExtractor: phpDescriptionExtractor,
  isRouteFile: isPhpRouteFile,
});
