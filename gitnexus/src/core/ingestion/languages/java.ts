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
import { createLeadingDocDescriptionExtractor } from '../utils/ast-helpers.js';
import { javaTypeConfig } from '../type-extractors/jvm.js';
import { extractSpringRoutes, extractSpringTypes } from '../route-extractors/spring.js';
import { javaExportChecker } from '../export-detection.js';
import { createImportResolver } from '../import-resolvers/resolver-factory.js';
import { javaImportConfig } from '../import-resolvers/configs/jvm.js';
import { JAVA_QUERIES } from '../tree-sitter-queries.js';
import { createCallExtractor } from '../call-extractors/generic.js';
import { javaCallConfig } from '../call-extractors/configs/jvm.js';
import { createFieldExtractor } from '../field-extractors/generic.js';
import { javaConfig } from '../field-extractors/configs/jvm.js';
import { createMethodExtractor } from '../method-extractors/generic.js';
import { javaMethodConfig } from '../method-extractors/configs/jvm.js';
import { createVariableExtractor } from '../variable-extractors/generic.js';
import { javaVariableConfig } from '../variable-extractors/configs/jvm.js';
import { createJavaCfgVisitor } from '../cfg/visitors/java.js';
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
  const callerDir = splitDirectorySegments(callSiteFilePath);

  const scored = candidates.map((candidate, index) => ({
    candidate,
    index,
    score: sharedPrefixLength(callerDir, splitDirectorySegments(candidate.filePath)),
  }));
  const bestScore = Math.max(...scored.map((entry) => entry.score));
  // When all candidates tie, we have no structural signal to prefer one path.
  // Returning null keeps downstream ambiguity handling conservative.
  if (scored.every((entry) => entry.score === bestScore)) return null;

  const ordered = [...scored]
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .map((entry) => entry.candidate);
  return ordered;
};

const splitDirectorySegments = (filePath: string): string[] => {
  const normalized = filePath.replace(/\\/g, '/');
  // Remove empty segments from leading/trailing/multiple slashes, then drop filename.
  const segments = normalized.split('/').filter(Boolean);
  return segments.slice(0, -1);
};

const sharedPrefixLength = (left: readonly string[], right: readonly string[]): number => {
  const max = Math.min(left.length, right.length);
  let idx = 0;
  while (idx < max && left[idx] === right[idx]) idx += 1;
  return idx;
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
  mroStrategy: 'implements-split',
  callExtractor: createCallExtractor(javaCallConfig),
  fieldExtractor: createFieldExtractor(javaConfig),
  methodExtractor: createMethodExtractor(javaMethodConfig),
  variableExtractor: createVariableExtractor(javaVariableConfig),
  classExtractor: createClassExtractor(javaClassConfig),

  // ── Javadoc → description (issue #2270) ──
  descriptionExtractor: createLeadingDocDescriptionExtractor(),

  // ── RFC #909 Ring 3: scope-based resolution hooks ──
  emitScopeCaptures: emitJavaScopeCaptures,

  // ── PDG: per-function CFG + def/use harvest (#2195 U4) ──
  cfgVisitor: createJavaCfgVisitor(),
  interpretImport: interpretJavaImport,
  interpretTypeBinding: interpretJavaTypeBinding,
  bindingScopeFor: javaBindingScopeFor,
  importOwningScope: javaImportOwningScope,
  mergeBindings: (_scope, bindings) => javaMergeBindings(bindings),
  receiverBinding: javaReceiverBinding,
  arityCompatibility: javaArityCompatibility,
  resolveImportTarget: resolveJavaImportTarget,
  orderSameNameTypeCandidates: orderJavaSameNameTypeCandidates,

  // ── Route extraction ──
  extractDecoratorRoutes: extractSpringRoutes,
  extractRouteInheritanceTypes: extractSpringTypes,
});
