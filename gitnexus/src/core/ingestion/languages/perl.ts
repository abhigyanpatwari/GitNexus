/**
 * Perl Language Provider
 *
 * Assembles all Perl-specific ingestion capabilities into a single
 * LanguageProvider, following the Strategy pattern used by the pipeline.
 *
 * Key Perl traits:
 *   - importSemantics: 'wildcard' (Perl use/require brings everything into scope)
 *   - Dynamic typing with optional POD documentation and modern type systems
 *   - Package/class system with :: namespace separators
 *   - Sigil-based variable system ($scalar, @array, %hash)
 *   - Constructor patterns (bless, Class->new())
 */

import { SupportedLanguages } from 'gitnexus-shared';
import { createClassExtractor } from '../class-extractors/generic.js';
import { defineLanguage } from '../language-provider.js';
import type { SyntaxNode } from '../utils/ast-helpers.js';
import { typeConfig as perlConfig } from '../type-extractors/perl.js';
import { perlExportChecker } from '../export-detection.js';
import { resolvePerlImport } from '../import-resolvers/perl.js';
import { PERL_QUERIES } from '../tree-sitter-queries.js';
import { createFieldExtractor } from '../field-extractors/generic.js';
import { perlConfig as perlFieldConfig } from '../field-extractors/configs/perl.js';
import { createMethodExtractor } from '../method-extractors/generic.js';
import { perlMethodConfig } from '../method-extractors/configs/perl.js';

/**
 * Extract function/method name from Perl subroutine/method declarations.
 * Handles both traditional subs and modern methods.
 */
const perlExtractFunctionName = (
  node: SyntaxNode,
): { funcName: string | null; label: 'Function' | 'Method' } | null => {
  if (node.type === 'subroutine_declaration_statement') {
    const nameNode = node.childForFieldName?.('name');
    return {
      funcName: nameNode?.text || null,
      label: 'Function',
    };
  }

  if (node.type === 'method_declaration_statement') {
    const nameNode = node.childForFieldName?.('name');
    return {
      funcName: nameNode?.text || null,
      label: 'Method',
    };
  }

  return null;
};

/**
 * Perl built-in functions and commonly used functions.
 * Used to filter out built-ins from call analysis.
 */
const BUILT_INS: ReadonlySet<string> = new Set([
  // Core functions
  'print',
  'printf',
  'say',
  'warn',
  'die',
  'exit',
  'eval',
  'exec',
  'system',
  'fork',
  'wait',
  'waitpid',

  // String functions
  'chomp',
  'chop',
  'substr',
  'index',
  'rindex',
  'split',
  'join',
  'reverse',
  'sort',
  'grep',
  'map',
  'sprintf',

  // Array/List functions
  'push',
  'pop',
  'shift',
  'unshift',
  'splice',
  'slice',
  'reverse',
  'sort',

  // Hash functions
  'keys',
  'values',
  'each',
  'exists',
  'delete',

  // File operations
  'open',
  'close',
  'read',
  'write',
  'seek',
  'tell',
  'eof',
  'fileno',
  'stat',
  'lstat',
  'chmod',
  'chown',
  'link',
  'unlink',
  'rename',
  'mkdir',
  'rmdir',
  'opendir',
  'readdir',
  'closedir',
  'glob',

  // Reference/blessed object functions
  'ref',
  'bless',
  'tied',
  'untie',

  // Module system
  'use',
  'require',
  'import',
  'no',

  // Variable functions
  'defined',
  'undef',
  'exists',
  'delete',
  'local',
  'my',
  'our',
  'state',

  // Control flow
  'return',
  'next',
  'last',
  'redo',
  'goto',
  'caller',
  'wantarray',

  // Regular expressions
  'match',
  'm',
  's',
  'tr',
  'y',
  'qr',
  'quotemeta',

  // Type checking
  'ref',
  'blessed',
  'reftype',

  // Moose/Moo object system
  'has',
  'extends',
  'with',
  'around',
  'before',
  'after',
  'override',
  'augment',
  'inner',

  // Common CPAN modules
  'carp',
  'croak',
  'confess',
  'cluck',
]);

export const perlProvider = defineLanguage({
  id: SupportedLanguages.Perl,
  extensions: ['.pl', '.pm', '.t', '.psgi'],
  treeSitterQueries: PERL_QUERIES,
  typeConfig: perlConfig,
  exportChecker: perlExportChecker,
  importResolver: resolvePerlImport,
  importSemantics: 'wildcard',
  fieldExtractor: createFieldExtractor(perlFieldConfig),
  methodExtractor: createMethodExtractor({
    ...perlMethodConfig,
    extractFunctionName: perlExtractFunctionName,
  }),
  classExtractor: createClassExtractor({
    language: SupportedLanguages.Perl,
    typeDeclarationNodes: ['package_statement', 'class_statement'],
    ancestorScopeNodeTypes: ['package_statement', 'class_statement'],
  }),
  builtInNames: BUILT_INS,
});
