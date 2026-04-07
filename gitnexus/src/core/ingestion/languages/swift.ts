/**
 * Swift Language Provider
 *
 * Assembles all Swift-specific ingestion capabilities into a single
 * LanguageProvider, following the Strategy pattern used by the pipeline.
 *
 * Key Swift traits:
 *   - importSemantics: 'wildcard' (Swift imports entire modules)
 *   - heritageDefaultEdge: 'IMPLEMENTS' (protocols are more common than class inheritance)
 *   - implicitImportWirer: all files in the same SPM target see each other
 */

import { SupportedLanguages } from 'gitnexus-shared';
import type { NodeLabel } from 'gitnexus-shared';
import { defineLanguage } from '../language-provider.js';
import { typeConfig as swiftConfig } from '../type-extractors/swift.js';
import { swiftExportChecker } from '../export-detection.js';
import { resolveSwiftImport } from '../import-resolvers/swift.js';
import { SWIFT_QUERIES } from '../tree-sitter-queries.js';
import type { SwiftPackageConfig } from '../language-config.js';
import type { SyntaxNode } from '../utils/ast-helpers.js';
import { createFieldExtractor } from '../field-extractors/generic.js';
import { swiftConfig as swiftFieldConfig } from '../field-extractors/configs/swift.js';
import { createMethodExtractor } from '../method-extractors/generic.js';
import { swiftMethodConfig } from '../method-extractors/configs/swift.js';

/**
 * Group Swift files by SPM target for implicit module visibility.
 * If SwiftPackageConfig is available, use target -> directory mappings.
 * Otherwise, group all Swift files under a single "default" target
 * (assumes a single-module Xcode project).
 */
function groupSwiftFilesByTarget(
  swiftFiles: string[],
  swiftPackageConfig: SwiftPackageConfig | null,
): Map<string, string[]> {
  // No SPM config -> single target (common for Xcode projects)
  if (!swiftPackageConfig || swiftPackageConfig.targets.size === 0) {
    return new Map([['__default__', swiftFiles]]);
  }

  // Pre-convert target dirs to normalized prefix format once
  const targets = [...swiftPackageConfig.targets.entries()].map(([name, dir]) => ({
    name,
    prefix: dir.replace(/\\/g, '/') + '/',
  }));

  const groups = new Map<string, string[]>();
  const defaultGroup: string[] = [];

  for (const file of swiftFiles) {
    const normalized = file.includes('\\') ? file.replace(/\\/g, '/') : file;
    let assigned = false;
    for (const { name, prefix } of targets) {
      const idx = normalized.indexOf(prefix);
      if (idx === 0 || (idx > 0 && normalized[idx - 1] === '/')) {
        let group = groups.get(name);
        if (!group) {
          group = [];
          groups.set(name, group);
        }
        group.push(file);
        assigned = true;
        break;
      }
    }
    if (!assigned) defaultGroup.push(file);
  }

  if (defaultGroup.length > 0) groups.set('__default__', defaultGroup);
  return groups;
}

/**
 * Wire implicit inter-file imports for Swift.
 * All files in the same SPM target see each other (full module visibility).
 * Two fast paths avoid unnecessary work:
 *   1. No existing imports for src -> emit all (m-1) edges without Set.has checks
 *   2. Existing imports present -> skip already-connected pairs
 */
function wireSwiftImplicitImports(
  swiftFiles: string[],
  importMap: ReadonlyMap<string, ReadonlySet<string>>,
  addImportEdge: (src: string, target: string) => void,
  projectConfig: unknown,
): void {
  const configs = projectConfig as { swiftPackageConfig?: SwiftPackageConfig | null } | null;
  const targetGroups = groupSwiftFilesByTarget(swiftFiles, configs?.swiftPackageConfig ?? null);

  for (const group of targetGroups.values()) {
    const m = group.length;
    if (m <= 1) continue;
    // All-pairs implicit edges: O(m²) is inherent for full module visibility.
    for (let i = 0; i < m; i++) {
      const src = group[i];
      const existing = importMap.get(src);
      if (!existing || existing.size === 0) {
        // Fast path: no prior imports — emit all peers unconditionally
        for (let j = 0; j < m; j++) {
          if (i !== j) addImportEdge(src, group[j]);
        }
      } else {
        // Dedup path: skip already-connected pairs
        for (let j = 0; j < m; j++) {
          if (i !== j && !existing.has(group[j])) {
            addImportEdge(src, group[j]);
          }
        }
      }
    }
  }
}

/** Swift init/deinit declarations have special names and Constructor label. */
const swiftExtractFunctionName = (
  node: SyntaxNode,
): { funcName: string | null; label: NodeLabel } | null => {
  if (node.type === 'init_declaration') return { funcName: 'init', label: 'Constructor' };
  if (node.type === 'deinit_declaration') return { funcName: 'deinit', label: 'Constructor' };
  return null; // fall through to generic
};

const BUILT_INS: ReadonlySet<string> = new Set([
  'print',
  'debugPrint',
  'dump',
  'fatalError',
  'precondition',
  'preconditionFailure',
  'assert',
  'assertionFailure',
  'NSLog',
  'abs',
  'min',
  'max',
  'zip',
  'stride',
  'sequence',
  'repeatElement',
  'swap',
  'withUnsafePointer',
  'withUnsafeMutablePointer',
  'withUnsafeBytes',
  'autoreleasepool',
  'unsafeBitCast',
  'unsafeDowncast',
  'numericCast',
  'type',
  'MemoryLayout',
  'map',
  'flatMap',
  'compactMap',
  'filter',
  'reduce',
  'forEach',
  'contains',
  'first',
  'last',
  'prefix',
  'suffix',
  'dropFirst',
  'dropLast',
  'sorted',
  'reversed',
  'enumerated',
  'joined',
  'split',
  'append',
  'insert',
  'remove',
  'removeAll',
  'removeFirst',
  'removeLast',
  'isEmpty',
  'count',
  'index',
  'startIndex',
  'endIndex',
  'addSubview',
  'removeFromSuperview',
  'layoutSubviews',
  'setNeedsLayout',
  'layoutIfNeeded',
  'setNeedsDisplay',
  'invalidateIntrinsicContentSize',
  'addTarget',
  'removeTarget',
  'addGestureRecognizer',
  'addConstraint',
  'addConstraints',
  'removeConstraint',
  'removeConstraints',
  'NSLocalizedString',
  'Bundle',
  'reloadData',
  'reloadSections',
  'reloadRows',
  'performBatchUpdates',
  'register',
  'dequeueReusableCell',
  'dequeueReusableSupplementaryView',
  'beginUpdates',
  'endUpdates',
  'insertRows',
  'deleteRows',
  'insertSections',
  'deleteSections',
  'present',
  'dismiss',
  'pushViewController',
  'popViewController',
  'popToRootViewController',
  'performSegue',
  'prepare',
  'DispatchQueue',
  'async',
  'sync',
  'asyncAfter',
  'Task',
  'withCheckedContinuation',
  'withCheckedThrowingContinuation',
  'sink',
  'store',
  'assign',
  'receive',
  'subscribe',
  'addObserver',
  'removeObserver',
  'post',
  'NotificationCenter',
]);

export const swiftProvider = defineLanguage({
  id: SupportedLanguages.Swift,
  extensions: ['.swift'],
  treeSitterQueries: SWIFT_QUERIES,
  typeConfig: swiftConfig,
  exportChecker: swiftExportChecker,
  importResolver: resolveSwiftImport,
  importSemantics: 'wildcard',
  heritageDefaultEdge: 'IMPLEMENTS',
  fieldExtractor: createFieldExtractor(swiftFieldConfig),
  methodExtractor: createMethodExtractor({
    ...swiftMethodConfig,
    extractFunctionName: swiftExtractFunctionName,
  }),
  implicitImportWirer: wireSwiftImplicitImports,
  builtInNames: BUILT_INS,
});
