/**
 * PHP language provider.
 *
 * PHP uses named imports (use statements for classes/functions/constants),
 * and standard export/import resolution. PHP files can use a variety of
 * extensions from legacy versions through modern PHP 8.
 */

import { SupportedLanguages } from 'gitnexus-shared';
import { createClassExtractor } from '../class-extractors/generic.js';
import { phpClassConfig } from '../class-extractors/configs/php.js';
import { defineLanguage } from '../language-provider.js';
import { typeConfig as phpConfig } from '../type-extractors/php.js';
import { phpExportChecker } from '../export-detection.js';
import { resolvePhpImport } from '../import-resolvers/php.js';
import { extractPhpNamedBindings } from '../named-bindings/php.js';
import { PHP_QUERIES } from '../tree-sitter-queries.js';
import { findDescendant, extractStringContent, type SyntaxNode } from '../utils/ast-helpers.js';
import type { NodeLabel } from 'gitnexus-shared';
import { createFieldExtractor } from '../field-extractors/generic.js';
import { phpConfig as phpFieldConfig } from '../field-extractors/configs/php.js';
import { createMethodExtractor } from '../method-extractors/generic.js';
import { phpMethodConfig } from '../method-extractors/configs/php.js';

const BUILT_INS: ReadonlySet<string> = new Set([
  'echo',
  'isset',
  'empty',
  'unset',
  'list',
  'array',
  'compact',
  'extract',
  'count',
  'strlen',
  'strpos',
  'strrpos',
  'substr',
  'strtolower',
  'strtoupper',
  'trim',
  'ltrim',
  'rtrim',
  'str_replace',
  'str_contains',
  'str_starts_with',
  'str_ends_with',
  'sprintf',
  'vsprintf',
  'printf',
  'number_format',
  'array_map',
  'array_filter',
  'array_reduce',
  'array_push',
  'array_pop',
  'array_shift',
  'array_unshift',
  'array_slice',
  'array_splice',
  'array_merge',
  'array_keys',
  'array_values',
  'array_key_exists',
  'in_array',
  'array_search',
  'array_unique',
  'usort',
  'rsort',
  'json_encode',
  'json_decode',
  'serialize',
  'unserialize',
  'intval',
  'floatval',
  'strval',
  'boolval',
  'is_null',
  'is_string',
  'is_int',
  'is_array',
  'is_object',
  'is_numeric',
  'is_bool',
  'is_float',
  'var_dump',
  'print_r',
  'var_export',
  'date',
  'time',
  'strtotime',
  'mktime',
  'microtime',
  'file_exists',
  'file_get_contents',
  'file_put_contents',
  'is_file',
  'is_dir',
  'preg_match',
  'preg_match_all',
  'preg_replace',
  'preg_split',
  'header',
  'session_start',
  'session_destroy',
  'ob_start',
  'ob_end_clean',
  'ob_get_clean',
  'dd',
  'dump',
]);

/** Eloquent model properties whose array values are worth indexing. */
const ELOQUENT_ARRAY_PROPS = new Set(['fillable', 'casts', 'hidden', 'guarded', 'with', 'appends']);

/** Eloquent relationship method names. */
const ELOQUENT_RELATIONS = new Set([
  'hasMany',
  'hasOne',
  'belongsTo',
  'belongsToMany',
  'morphTo',
  'morphMany',
  'morphOne',
  'morphToMany',
  'morphedByMany',
  'hasManyThrough',
  'hasOneThrough',
]);

/**
 * For a PHP property_declaration node, extract array values as a description string.
 * Returns null if not an Eloquent model property or no array values found.
 */
function extractPhpPropertyDescription(propName: string, propDeclNode: SyntaxNode): string | null {
  if (!ELOQUENT_ARRAY_PROPS.has(propName)) return null;

  const arrayNode = findDescendant(propDeclNode, 'array_creation_expression');
  if (!arrayNode) return null;

  const items: string[] = [];
  for (const child of arrayNode.children ?? []) {
    if (child.type !== 'array_element_initializer') continue;
    const children = child.children ?? [];
    const arrowIdx = children.findIndex((c: SyntaxNode) => c.type === '=>');
    if (arrowIdx !== -1) {
      const key = extractStringContent(children[arrowIdx - 1]);
      const val = extractStringContent(children[arrowIdx + 1]);
      if (key && val) items.push(`${key}:${val}`);
    } else {
      const val = extractStringContent(children[0]);
      if (val) items.push(val);
    }
  }

  return items.length > 0 ? items.join(', ') : null;
}

/**
 * For a PHP method_declaration node, detect if it defines an Eloquent relationship.
 * Returns description like "hasMany(Post)" or null.
 */
function extractEloquentRelationDescription(methodNode: SyntaxNode): string | null {
  function findRelationCall(root: SyntaxNode): SyntaxNode | null {
    const stack: SyntaxNode[] = [root];
    while (stack.length > 0) {
      const node = stack.pop()!;
      if (node.type === 'member_call_expression') {
        const children = node.children ?? [];
        const objectNode = children.find(
          (c: SyntaxNode) => c.type === 'variable_name' && c.text === '$this',
        );
        const nameNode = children.find((c: SyntaxNode) => c.type === 'name');
        if (objectNode && nameNode && ELOQUENT_RELATIONS.has(nameNode.text)) return node;
      }
      const children = node.children ?? [];
      for (let i = children.length - 1; i >= 0; i--) {
        stack.push(children[i]);
      }
    }
    return null;
  }

  const callNode = findRelationCall(methodNode);
  if (!callNode) return null;

  const relType = callNode.children?.find((c: SyntaxNode) => c.type === 'name')?.text;
  const argsNode = callNode.children?.find((c: SyntaxNode) => c.type === 'arguments');
  let targetModel: string | null = null;
  if (argsNode) {
    const firstArg = argsNode.children?.find((c: SyntaxNode) => c.type === 'argument');
    if (firstArg) {
      const classConstant = firstArg.children?.find(
        (c: SyntaxNode) => c.type === 'class_constant_access_expression',
      );
      if (classConstant) {
        targetModel =
          classConstant.children?.find((c: SyntaxNode) => c.type === 'name')?.text ?? null;
      }
    }
  }

  if (relType && targetModel) return `${relType}(${targetModel})`;
  if (relType) return relType;
  return null;
}

/**
 * LanguageProvider.descriptionExtractor implementation for PHP.
 * Extracts Eloquent model property metadata and relationship descriptions.
 */
function phpDescriptionExtractor(
  nodeLabel: NodeLabel,
  nodeName: string,
  captureMap: Record<string, SyntaxNode>,
): string | undefined {
  if (nodeLabel === 'Property' && captureMap['definition.property']) {
    return extractPhpPropertyDescription(nodeName, captureMap['definition.property']) ?? undefined;
  }
  if (nodeLabel === 'Method' && captureMap['definition.method']) {
    return extractEloquentRelationDescription(captureMap['definition.method']) ?? undefined;
  }
  return undefined;
}

/** Detect Laravel route files by path convention. */
function isPhpRouteFile(filePath: string): boolean {
  return (
    filePath.endsWith('.php') && (filePath.includes('/routes/') || filePath.startsWith('routes/'))
  );
}

export const phpProvider = defineLanguage({
  id: SupportedLanguages.PHP,
  extensions: ['.php', '.phtml', '.php3', '.php4', '.php5', '.php8'],
  treeSitterQueries: PHP_QUERIES,
  typeConfig: phpConfig,
  exportChecker: phpExportChecker,
  importResolver: resolvePhpImport,
  namedBindingExtractor: extractPhpNamedBindings,
  fieldExtractor: createFieldExtractor(phpFieldConfig),
  methodExtractor: createMethodExtractor(phpMethodConfig),
  classExtractor: createClassExtractor(phpClassConfig),
  descriptionExtractor: phpDescriptionExtractor,
  isRouteFile: isPhpRouteFile,
  builtInNames: BUILT_INS,
});
