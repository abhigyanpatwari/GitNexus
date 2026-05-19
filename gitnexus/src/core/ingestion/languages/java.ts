/**
 * Java language provider.
 *
 * Java uses named imports, JVM wildcard/member import resolution,
 * and a 'public' modifier-based export checker. Heritage uses
 * EXTENDS by default with implements-split MRO for multiple
 * interface implementation.
 */

import { SupportedLanguages } from 'gitnexus-shared';
import { createClassExtractor } from '../class-extractors/generic.js';
import { javaClassConfig } from '../class-extractors/configs/jvm.js';
import { defineLanguage } from '../language-provider.js';
import type { AstFrameworkPatternConfig } from '../language-provider.js';
import { javaTypeConfig } from '../type-extractors/jvm.js';
import { javaExportChecker } from '../export-detection.js';
import { createImportResolver } from '../import-resolvers/resolver-factory.js';
import { javaImportConfig } from '../import-resolvers/configs/jvm.js';
import { extractJavaNamedBindings } from '../named-bindings/java.js';
import { JAVA_QUERIES } from '../tree-sitter-queries.js';
import { createCallExtractor } from '../call-extractors/generic.js';
import { javaCallConfig } from '../call-extractors/configs/jvm.js';
import { createFieldExtractor } from '../field-extractors/generic.js';
import { javaConfig } from '../field-extractors/configs/jvm.js';
import { createMethodExtractor } from '../method-extractors/generic.js';
import { javaMethodConfig } from '../method-extractors/configs/jvm.js';
import { createVariableExtractor } from '../variable-extractors/generic.js';
import { javaVariableConfig } from '../variable-extractors/configs/jvm.js';
import { createHeritageExtractor } from '../heritage-extractors/generic.js';
import type { SymbolDefinition } from 'gitnexus-shared';
import {
  emitJavaScopeCaptures,
  interpretJavaImport,
  interpretJavaTypeBinding,
  javaBindingScopeFor,
  javaImportOwningScope,
  javaMergeBindings,
  javaReceiverBinding,
  javaArityCompatibility,
  resolveJavaImportTarget,
} from './java/index.js';

const orderJavaSameNameTypeCandidates = ({
  callSiteFilePath,
  candidates,
}: {
  readonly typeName: string;
  readonly callSiteFilePath: string;
  readonly candidates: readonly SymbolDefinition[];
}): readonly SymbolDefinition[] | null => {
  if (!callSiteFilePath.endsWith('.java')) return null;
  if (candidates.length <= 1) return null;
  const callerModule = detectJavaModuleKey(callSiteFilePath);
  if (callerModule === undefined) return null;

  const sameModule = candidates.filter((candidate) => {
    const moduleKey = detectJavaModuleKey(candidate.filePath);
    return moduleKey !== undefined && moduleKey === callerModule;
  });
  if (sameModule.length === 0) return null;

  const sameModuleSet = new Set(sameModule.map((candidate) => candidate.nodeId));
  const orderedSameModule = [...sameModule].sort((a, b) => a.filePath.localeCompare(b.filePath));
  const remaining = candidates.filter((candidate) => !sameModuleSet.has(candidate.nodeId));
  return [...orderedSameModule, ...remaining];
};

const detectJavaModuleKey = (filePath: string): string | undefined => {
  const normalized = filePath.replace(/\\/g, '/');
  for (const marker of ['/src/main/', '/src/test/', '/src/']) {
    const idx = normalized.indexOf(marker);
    if (idx > 0) {
      const prefix = normalized.slice(0, idx).split('/').filter(Boolean);
      return prefix[prefix.length - 1];
    }
  }
  return undefined;
};

export const javaProvider = defineLanguage({
  id: SupportedLanguages.Java,
  extensions: ['.java'],
  entryPointPatterns: [/^do[A-Z]/, /^create[A-Z]/, /^build[A-Z]/, /Service$/],
  astFrameworkPatterns: [
    {
      framework: 'spring',
      entryPointMultiplier: 3.2,
      reason: 'spring-annotation',
      patterns: [
        '@RestController',
        '@Controller',
        '@GetMapping',
        '@PostMapping',
        '@RequestMapping',
      ],
    },
    {
      framework: 'jaxrs',
      entryPointMultiplier: 3.0,
      reason: 'jaxrs-annotation',
      patterns: ['@Path', '@GET', '@POST', '@PUT', '@DELETE'],
    },
  ] satisfies AstFrameworkPatternConfig[],
  treeSitterQueries: JAVA_QUERIES,
  typeConfig: javaTypeConfig,
  exportChecker: javaExportChecker,
  importResolver: createImportResolver(javaImportConfig),
  namedBindingExtractor: extractJavaNamedBindings,
  interfaceNamePattern: /^I[A-Z]/,
  mroStrategy: 'implements-split',
  callExtractor: createCallExtractor(javaCallConfig),
  fieldExtractor: createFieldExtractor(javaConfig),
  methodExtractor: createMethodExtractor(javaMethodConfig),
  variableExtractor: createVariableExtractor(javaVariableConfig),
  classExtractor: createClassExtractor(javaClassConfig),
  heritageExtractor: createHeritageExtractor(SupportedLanguages.Java),

  // ── RFC #909 Ring 3: scope-based resolution hooks ──
  emitScopeCaptures: emitJavaScopeCaptures,
  interpretImport: interpretJavaImport,
  interpretTypeBinding: interpretJavaTypeBinding,
  bindingScopeFor: javaBindingScopeFor,
  importOwningScope: javaImportOwningScope,
  mergeBindings: (_scope, bindings) => javaMergeBindings(bindings),
  receiverBinding: javaReceiverBinding,
  arityCompatibility: javaArityCompatibility,
  resolveImportTarget: resolveJavaImportTarget,
  orderSameNameTypeCandidates: orderJavaSameNameTypeCandidates,
});
