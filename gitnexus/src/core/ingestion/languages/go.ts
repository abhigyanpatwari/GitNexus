/**
 * Go Language Provider
 *
 * Assembles all Go-specific ingestion capabilities into a single
 * LanguageProvider, following the Strategy pattern used by the pipeline.
 *
 * Key Go traits:
 *   - importSemantics: 'wildcard-leaf' (Go imports entire packages)
 *   - callRouter: present (Go method calls may need routing)
 */

import { SupportedLanguages } from 'gitnexus-shared';
import { createClassExtractor } from '../class-extractors/generic.js';
import { goClassConfig } from '../class-extractors/configs/go.js';
import { defineLanguage } from '../language-provider.js';
import { typeConfig as goConfig } from '../type-extractors/go.js';
import { goExportChecker } from '../export-detection.js';
import { createImportResolver } from '../import-resolvers/resolver-factory.js';
import { goImportConfig } from '../import-resolvers/configs/go.js';
import { GO_QUERIES } from '../tree-sitter-queries.js';
import type { AstFrameworkPatternConfig } from '../language-provider.js';
import { createFieldExtractor } from '../field-extractors/generic.js';
import { goConfig as goFieldConfig } from '../field-extractors/configs/go.js';
import { createMethodExtractor } from '../method-extractors/generic.js';
import { goMethodConfig } from '../method-extractors/configs/go.js';
import { createVariableExtractor } from '../variable-extractors/generic.js';
import { goVariableConfig } from '../variable-extractors/configs/go.js';
import { createCallExtractor } from '../call-extractors/generic.js';
import { goCallConfig } from '../call-extractors/configs/go.js';
import { createHeritageExtractor } from '../heritage-extractors/generic.js';
import { goHeritageConfig } from '../heritage-extractors/configs/go.js';
import {
  emitGoScopeCaptures,
  goArityCompatibility,
  goBindingScopeFor,
  goImportOwningScope,
  goReceiverBinding,
  interpretGoImport,
  interpretGoTypeBinding,
} from './go/index.js';

export const goProvider = defineLanguage({
  id: SupportedLanguages.Go,
  extensions: ['.go'],
  entryPointPatterns: [/Handler$/, /^Serve/, /^New[A-Z]/, /^Make[A-Z]/],
  astFrameworkPatterns: [
    {
      framework: 'go-http',
      entryPointMultiplier: 2.5,
      reason: 'go-http-handler',
      patterns: [
        'http.Handler',
        'http.HandlerFunc',
        'ServeHTTP',
        'http.ResponseWriter',
        'http.Request',
      ],
    },
    {
      framework: 'gin',
      entryPointMultiplier: 3.0,
      reason: 'gin-handler',
      patterns: ['gin.Context', 'gin.Default', 'gin.New'],
    },
    {
      framework: 'echo',
      entryPointMultiplier: 3.0,
      reason: 'echo-handler',
      patterns: ['echo.Context', 'echo.New'],
    },
    {
      framework: 'fiber',
      entryPointMultiplier: 3.0,
      reason: 'fiber-handler',
      patterns: ['fiber.Ctx', 'fiber.New', 'fiber.App'],
    },
    {
      framework: 'go-grpc',
      entryPointMultiplier: 2.8,
      reason: 'grpc-service',
      patterns: ['grpc.Server', 'RegisterServer', 'pb.Unimplemented'],
    },
  ] satisfies AstFrameworkPatternConfig[],
  treeSitterQueries: GO_QUERIES,
  typeConfig: goConfig,
  exportChecker: goExportChecker,
  importResolver: createImportResolver(goImportConfig),
  importSemantics: 'wildcard-leaf',
  callExtractor: createCallExtractor(goCallConfig),
  fieldExtractor: createFieldExtractor(goFieldConfig),
  methodExtractor: createMethodExtractor(goMethodConfig),
  variableExtractor: createVariableExtractor(goVariableConfig),
  classExtractor: createClassExtractor(goClassConfig),
  heritageExtractor: createHeritageExtractor(goHeritageConfig),

  // ── RFC #909 Ring 3: scope-based resolution hooks ──────────
  emitScopeCaptures: emitGoScopeCaptures,
  interpretImport: interpretGoImport,
  interpretTypeBinding: interpretGoTypeBinding,
  bindingScopeFor: goBindingScopeFor,
  importOwningScope: goImportOwningScope,
  receiverBinding: goReceiverBinding,
  arityCompatibility: goArityCompatibility,
  // resolveImportTarget lives on ScopeResolver (4-param signature),
  // not on LanguageProvider (2-param signature). See go/scope-resolver.ts.
});
