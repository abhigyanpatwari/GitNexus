/**
 * Scala language provider.
 *
 * Scala uses named imports with JVM wildcard/member resolution and
 * Java-interop fallback. Default visibility is public (no modifier needed).
 * Heritage uses EXTENDS by default with implements-split MRO for
 * multiple trait implementation. Scala traits map to interfaces for
 * EXTENDS vs IMPLEMENTS edge classification.
 *
 * Supports: classes, traits, objects (singletons/companions), case classes,
 * sealed traits/classes, Scala 3 enums, def/val/var definitions,
 * pattern matching, for-comprehensions, infix operators, package objects.
 */

import { SupportedLanguages } from 'gitnexus-shared';
import { defineLanguage } from '../language-provider.js';
import { scalaTypeConfig } from '../type-extractors/jvm.js';
import { scalaExportChecker } from '../export-detection.js';
import { resolveScalaImport } from '../import-resolvers/jvm.js';
import { extractScalaNamedBindings } from '../named-bindings/scala.js';
import { SCALA_QUERIES } from '../tree-sitter-queries.js';
import { createFieldExtractor } from '../field-extractors/generic.js';
import { scalaConfig } from '../field-extractors/configs/scala.js';
import { createMethodExtractor } from '../method-extractors/generic.js';
import { scalaMethodConfig } from '../method-extractors/configs/scala.js';
import type { SyntaxNode } from '../utils/ast-helpers.js';
import type { NodeLabel } from 'gitnexus-shared';

const BUILT_INS: ReadonlySet<string> = new Set([
  // I/O and assertions
  'println', 'print', 'printf', 'require', 'assert', 'assume', 'sys',
  // Standard types
  'Some', 'None', 'Option', 'Left', 'Right', 'Nil',
  'List', 'Map', 'Set', 'Seq', 'Vector', 'Array',
  'Iterator', 'LazyList', 'Stream', 'Try', 'Success', 'Failure',
  'Future', 'Promise',
  // Language keywords / universal methods
  'throw', 'classOf', 'isInstanceOf', 'asInstanceOf',
  'toString', 'hashCode', 'equals', 'copy', 'apply', 'unapply',
  // Collection higher-order methods
  'map', 'flatMap', 'filter', 'foreach', 'collect',
  'foldLeft', 'foldRight', 'reduce', 'reduceLeft', 'reduceRight',
  'head', 'tail', 'last', 'init', 'isEmpty', 'nonEmpty',
  'size', 'length', 'contains', 'exists', 'forall', 'find',
  'zip', 'zipWithIndex', 'groupBy', 'sortBy', 'sorted', 'sortWith',
  'reverse', 'distinct', 'take', 'drop', 'takeWhile', 'dropWhile',
  'mkString', 'toList', 'toSeq', 'toSet', 'toMap', 'toVector', 'toArray',
  'getOrElse', 'orElse', 'fold', 'match',
  'recover', 'recoverWith', 'onComplete', 'andThen', 'compose',
  'sliding', 'grouped', 'patch', 'updated', 'diff', 'intersect', 'union',
  'sum', 'product', 'min', 'max', 'count', 'span', 'partition',
  'flatten', 'unzip', 'transpose', 'combinations', 'permutations',
  'to', 'until', 'by',
  // Symbolic operators (infix noise)
  '+', '-', '*', '/', '%',
  '==', '!=', '<', '>', '<=', '>=',
  '&&', '||',
  '::', ':::', '++', '+:', ':+',
  '->', '<-',
  '+=', '-=', '*=', '/=', '%=',
  '|=', '&=', '^=', '<<=', '>>=',
]);

/** Traverse up from a function_definition to check if it's inside a class/trait/object body. */
function isScalaMemberFunction(node: SyntaxNode): boolean {
  let ancestor: SyntaxNode | null = node.parent;
  while (ancestor) {
    if (
      ancestor.type === 'class_definition' ||
      ancestor.type === 'object_definition' ||
      ancestor.type === 'trait_definition' ||
      ancestor.type === 'enum_definition' ||
      ancestor.type === 'package_object'
    ) {
      return true;
    }
    ancestor = ancestor.parent;
  }
  return false;
}

/** Classify Scala object definitions: Module (default) or Enum (extends Enumeration). */
function getScalaObjectLabel(node: SyntaxNode): NodeLabel {
  if (node.type !== 'object_definition') return 'Class';
  const extendNode = node.childForFieldName?.('extend');
  const extendsText = extendNode?.text ?? '';
  if (extendsText.includes('Enumeration')) return 'Enum';
  return 'Module';
}

export const scalaProvider = defineLanguage({
  id: SupportedLanguages.Scala,
  extensions: ['.scala', '.sc'],
  treeSitterQueries: SCALA_QUERIES,
  typeConfig: scalaTypeConfig,
  exportChecker: scalaExportChecker,
  importResolver: resolveScalaImport,
  namedBindingExtractor: extractScalaNamedBindings,
  mroStrategy: 'implements-split',
  fieldExtractor: createFieldExtractor(scalaConfig),
  methodExtractor: createMethodExtractor(scalaMethodConfig),
  builtInNames: BUILT_INS,

  importPathPreprocessor: (cleaned, _importNode) => {
    let path = cleaned
      .replace(/^\s*import\s+/, '')
      .replace(/^_root_\./, '')
      .replace(/`/g, '');
    if (path.endsWith('._')) path = path.slice(0, -2) + '.*';
    return path;
  },

  labelOverride: (definitionNode, defaultLabel) => {
    // Classify object definitions as Module or Enum
    if (defaultLabel === 'Class' && definitionNode.type === 'object_definition') {
      return getScalaObjectLabel(definitionNode);
    }
    if (defaultLabel !== 'Function') return defaultLabel;
    if (isScalaMemberFunction(definitionNode)) return 'Method';
    return defaultLabel;
  },
});
