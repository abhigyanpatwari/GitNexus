/**
 * Swift Language Provider
 *
 * Assembles all Swift-specific ingestion capabilities into a single
 * LanguageProvider, following the Strategy pattern used by the pipeline.
 */

import { SupportedLanguages } from 'gitnexus-shared';
import type { NodeLabel, SymbolDefinition } from 'gitnexus-shared';
import { createClassExtractor } from '../class-extractors/generic.js';
import { swiftClassConfig } from '../class-extractors/configs/swift.js';
import { defineLanguage } from '../language-provider.js';
import type { AstFrameworkPatternConfig } from '../language-provider.js';
import { typeConfig as swiftConfig } from '../type-extractors/swift.js';
import { swiftExportChecker } from '../export-detection.js';
import { createImportResolver } from '../import-resolvers/resolver-factory.js';
import { swiftImportConfig } from '../import-resolvers/configs/swift.js';
import { SWIFT_QUERIES } from '../tree-sitter-queries.js';
import type { SyntaxNode } from '../utils/ast-helpers.js';
import { createFieldExtractor } from '../field-extractors/generic.js';
import { swiftConfig as swiftFieldConfig } from '../field-extractors/configs/swift.js';
import { createMethodExtractor } from '../method-extractors/generic.js';
import { swiftMethodConfig } from '../method-extractors/configs/swift.js';
import { createVariableExtractor } from '../variable-extractors/generic.js';
import { swiftVariableConfig } from '../variable-extractors/configs/swift.js';
import { createCallExtractor } from '../call-extractors/generic.js';
import { swiftCallConfig } from '../call-extractors/configs/swift.js';
import {
  emitSwiftScopeCaptures,
  interpretSwiftImport,
  interpretSwiftTypeBinding,
  swiftBindingScopeFor,
  swiftImportOwningScope,
  swiftReceiverBinding,
  swiftMergeBindings,
  swiftArityCompatibility,
} from './swift/index.js';

/** Swift init/deinit declarations have special names and Constructor label. */
const swiftExtractFunctionName = (
  node: SyntaxNode,
): { funcName: string | null; label: NodeLabel } | null => {
  if (node.type === 'init_declaration') return { funcName: 'init', label: 'Constructor' };
  if (node.type === 'deinit_declaration') return { funcName: 'deinit', label: 'Constructor' };
  return null; // fall through to generic
};

const orderSwiftSameNameTypeCandidates = ({
  callSiteFilePath,
  candidates,
}: {
  readonly typeName: string;
  readonly callSiteFilePath: string;
  readonly candidates: readonly SymbolDefinition[];
}): readonly SymbolDefinition[] | null => {
  if (!callSiteFilePath.endsWith('.swift')) return null;
  if (candidates.length <= 1) return null;
  if (!candidates.every((c) => c.type === candidates[0].type)) return null;
  if (candidates[0].type !== 'Class' && candidates[0].type !== 'Struct') return null;
  if (!candidates.every((c) => c.filePath.endsWith('.swift'))) return null;
  return [...candidates].sort(
    (a, b) => a.filePath.length - b.filePath.length || a.filePath.localeCompare(b.filePath),
  );
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
  entryPointPatterns: [
    /^viewDidLoad$/,
    /^viewWillAppear$/,
    /^viewDidAppear$/,
    /^viewWillDisappear$/,
    /^viewDidDisappear$/,
    /^application\(/,
    /^scene\(/,
    /^body$/,
    /Coordinator$/,
    /^sceneDidBecomeActive$/,
    /^sceneWillResignActive$/,
    /^didFinishLaunchingWithOptions$/,
    /ViewController$/,
    /^configure[A-Z]/,
    /^setup[A-Z]/,
    /^makeBody$/,
  ],
  astFrameworkPatterns: [
    {
      framework: 'uikit',
      entryPointMultiplier: 2.5,
      reason: 'uikit-lifecycle',
      patterns: [
        'viewDidLoad',
        'viewWillAppear',
        'viewDidAppear',
        'UIViewController',
        '@IBOutlet',
        '@IBAction',
        '@objc',
      ],
    },
    {
      framework: 'swiftui',
      entryPointMultiplier: 2.8,
      reason: 'swiftui-pattern',
      patterns: [
        '@main',
        'WindowGroup',
        'ContentView',
        '@StateObject',
        '@ObservedObject',
        '@EnvironmentObject',
        '@Published',
      ],
    },
    {
      framework: 'vapor',
      entryPointMultiplier: 3.0,
      reason: 'vapor-routing',
      patterns: ['app.get', 'app.post', 'req.content.decode', 'Vapor'],
    },
  ] satisfies AstFrameworkPatternConfig[],
  treeSitterQueries: SWIFT_QUERIES,
  typeConfig: swiftConfig,
  exportChecker: swiftExportChecker,
  importResolver: createImportResolver(swiftImportConfig),
  callExtractor: createCallExtractor(swiftCallConfig),
  fieldExtractor: createFieldExtractor(swiftFieldConfig),
  methodExtractor: createMethodExtractor({
    ...swiftMethodConfig,
    extractFunctionName: swiftExtractFunctionName,
  }),
  variableExtractor: createVariableExtractor(swiftVariableConfig),
  classExtractor: createClassExtractor(swiftClassConfig),
  orderSameNameTypeCandidates: orderSwiftSameNameTypeCandidates,
  builtInNames: BUILT_INS,
  // ── Scope-based resolution hooks (RFC #909 Ring 3, issue #937). See
  //    languages/swift/ for the implementations. ──────────────────────
  emitScopeCaptures: emitSwiftScopeCaptures,
  interpretImport: interpretSwiftImport,
  interpretTypeBinding: interpretSwiftTypeBinding,
  bindingScopeFor: swiftBindingScopeFor,
  importOwningScope: swiftImportOwningScope,
  receiverBinding: swiftReceiverBinding,
  mergeBindings: (_scope, bindings) => swiftMergeBindings(bindings),
  arityCompatibility: swiftArityCompatibility,
});
