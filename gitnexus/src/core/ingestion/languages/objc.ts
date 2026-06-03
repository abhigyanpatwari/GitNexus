/**
 * Objective-C Language Provider
 *
 * Assembles all Objective-C-specific ingestion capabilities into a single
 * LanguageProvider, following the Strategy pattern used by the pipeline.
 *
 * Key Objective-C traits:
 *   - importSemantics: 'wildcard' (ObjC imports entire modules via #import)
 *   - heritageDefaultEdge: 'EXTENDS' (single class inheritance, multiple protocol adoption)
 *   - ObjC uses the same type config and export checker as C++ since they share
 *     similar declaration patterns for functions and global state.
 *   - message_expression nodes are captured as CALLS (e.g., [self doSomething])
 *   - class_interface / class_implementation / protocol_declaration captured as definitions.
 */

import { SupportedLanguages } from 'gitnexus-shared';
import { defineLanguage } from '../language-provider.js';
import { typeConfig as cCppConfig } from '../type-extractors/c-cpp.js';
import { cCppExportChecker } from '../export-detection.js';
import { createImportResolver } from '../import-resolvers/resolver-factory.js';
import { createStandardStrategy } from '../import-resolvers/standard.js';
import { OBJ_C_QUERIES } from '../tree-sitter-queries.js';
import { createFieldExtractor } from '../field-extractors/generic.js';
import { cConfig as cFieldConfig } from '../field-extractors/configs/c-cpp.js';
import { createMethodExtractor } from '../method-extractors/generic.js';
import { cMethodConfig } from '../method-extractors/configs/c-cpp.js';
import { createCallExtractor } from '../call-extractors/generic.js';
import { cCallConfig } from '../call-extractors/configs/c-cpp.js';
import { createHeritageExtractor } from '../heritage-extractors/generic.js';

const OBJC_BUILT_INS: ReadonlySet<string> = new Set([
  'NSLog',
  'NSLogv',
  'dispatch_async',
  'dispatch_sync',
  'dispatch_once',
  'dispatch_after',
  'dispatch_group_async',
  'objc_getClass',
  'objc_getMetaClass',
  'objc_msgSend',
  'objc_msgSendSuper',
  'objc_msgSend_stret',
  'objc_msgSendSuper_stret',
  'sel_registerName',
  'protocol_getName',
  'class_getName',
  'class_getSuperclass',
  'object_getClass',
  'object_getInstanceSize',
  'class_addMethod',
  'class_replaceMethod',
  'class_getInstanceMethod',
  'class_getClassMethod',
  'method_exchangeImplementations',
  'imp_implementationWithBlock',
  'imp_getBlock',
  'imp_removeBlock',
  'objc_setAssociatedObject',
  'objc_getAssociatedObject',
  'objc_removeAssociatedObjects',
  'class_copyPropertyList',
  'class_copyMethodList',
  'class_copyIvarList',
  'property_getName',
  'ivar_getName',
  'ivar_getTypeEncoding',
  'method_getName',
  'method_getTypeEncoding',
  'method_getReturnType',
  'method_getNumberOfArguments',
  'method_getArgumentType',
  'class_isMetaClass',
  'object_isClass',
  'class_respondsToSelector',
  'instancesRespondToSelector',
  'conformsToProtocol',
  'CFRetain',
  'CFRelease',
  'CFAutorelease',
]);

const stripObjcNullabilityMacros = (sourceText: string): string =>
  sourceText
    .replace(/NS_ASSUME_NONNULL_BEGIN/g, (m) => ' '.repeat(m.length))
    .replace(/NS_ASSUME_NONNULL_END/g, (m) => ' '.repeat(m.length));

export const objcProvider = defineLanguage({
  id: SupportedLanguages.ObjectiveC,
  extensions: ['.m', '.mm'],
  treeSitterQueries: OBJ_C_QUERIES,
  preprocessSource: stripObjcNullabilityMacros,
  typeConfig: cCppConfig,
  exportChecker: cCppExportChecker,
  importResolver: createImportResolver({
    language: SupportedLanguages.ObjectiveC,
    strategies: [createStandardStrategy(SupportedLanguages.C)],
  }),
  importSemantics: 'wildcard-transitive',
  heritageDefaultEdge: 'EXTENDS',
  callExtractor: createCallExtractor(cCallConfig),
  fieldExtractor: createFieldExtractor(cFieldConfig),
  methodExtractor: createMethodExtractor(cMethodConfig),
  heritageExtractor: createHeritageExtractor(SupportedLanguages.ObjectiveC),
  builtInNames: OBJC_BUILT_INS,
});
