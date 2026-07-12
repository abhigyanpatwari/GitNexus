/**
 * Solidity Language Provider
 *
 * Optional vendored grammar (tree-sitter-solidity@1.1.0, ABI 13).
 * Contracts/interfaces/libraries map to class-like scopes; inheritance uses
 * implements-split so interface parents become IMPLEMENTS edges.
 */

import { createLeadingDocDescriptionExtractor } from '../utils/ast-helpers.js';
import type { NodeLabel } from 'gitnexus-shared';
import { SupportedLanguages } from 'gitnexus-shared';
import { createClassExtractor } from '../class-extractors/generic.js';
import { solidityClassConfig } from '../class-extractors/configs/solidity.js';
import { defineLanguage } from '../language-provider.js';
import type { AstFrameworkPatternConfig } from '../language-provider.js';
import { typeConfig as solidityTypeConfig } from '../type-extractors/solidity.js';
import { solidityExportChecker } from '../export-detection.js';
import { createImportResolver } from '../import-resolvers/resolver-factory.js';
import { solidityImportConfig } from '../import-resolvers/configs/solidity.js';
import { SOLIDITY_QUERIES } from '../tree-sitter-queries.js';
import { createFieldExtractor } from '../field-extractors/generic.js';
import { solidityFieldConfig } from '../field-extractors/configs/solidity.js';
import { createMethodExtractor } from '../method-extractors/generic.js';
import { solidityMethodConfig } from '../method-extractors/configs/solidity.js';
import { createVariableExtractor } from '../variable-extractors/generic.js';
import { solidityVariableConfig } from '../variable-extractors/configs/solidity.js';
import { createCallExtractor } from '../call-extractors/generic.js';
import { solidityCallConfig } from '../call-extractors/configs/solidity.js';
import type { SyntaxNode } from '../utils/ast-helpers.js';
import {
  emitSolidityScopeCaptures,
  interpretSolidityImport,
  interpretSolidityTypeBinding,
  solidityBindingScopeFor,
  solidityImportOwningScope,
  solidityReceiverBinding,
  solidityMergeBindings,
  solidityArityCompatibility,
  SOLIDITY_BUILT_INS,
} from './solidity/index.js';

const solidityLabelOverride = (
  functionNode: SyntaxNode,
  defaultLabel: NodeLabel,
): NodeLabel | null => {
  if (functionNode.type === 'constructor_definition') return 'Constructor';
  if (functionNode.type === 'fallback_receive_definition') return 'Method';
  if (functionNode.type === 'modifier_definition') return 'Method';
  return defaultLabel;
};

export const solidityProvider = defineLanguage({
  id: SupportedLanguages.Solidity,
  extensions: ['.sol'],
  entryPointPatterns: [
    /^initialize$/,
    /^setUp$/,
    /^run$/,
    /^constructor$/,
    /^receive$/,
    /^fallback$/,
  ],
  astFrameworkPatterns: [
    {
      framework: 'foundry',
      entryPointMultiplier: 2.5,
      reason: 'foundry-test',
      patterns: ['forge-std/Test.sol', 'function setUp', 'vm.', 'Test.sol'],
    },
    {
      framework: 'openzeppelin-upgradeable',
      entryPointMultiplier: 2.8,
      reason: 'uups-upgradeable',
      patterns: ['UUPSUpgradeable', '_authorizeUpgrade', 'Initializable'],
    },
  ] satisfies AstFrameworkPatternConfig[],
  treeSitterQueries: SOLIDITY_QUERIES,
  typeConfig: solidityTypeConfig,
  exportChecker: solidityExportChecker,
  importResolver: createImportResolver(solidityImportConfig),
  callExtractor: createCallExtractor(solidityCallConfig),
  fieldExtractor: createFieldExtractor(solidityFieldConfig),
  methodExtractor: createMethodExtractor(solidityMethodConfig),
  variableExtractor: createVariableExtractor(solidityVariableConfig),
  classExtractor: createClassExtractor(solidityClassConfig),
  descriptionExtractor: createLeadingDocDescriptionExtractor({
    lineCommentPrefixes: ['///', '//'],
  }),
  labelOverride: solidityLabelOverride,
  builtInNames: SOLIDITY_BUILT_INS,
  mroStrategy: 'implements-split',

  emitScopeCaptures: emitSolidityScopeCaptures,
  interpretImport: interpretSolidityImport,
  interpretTypeBinding: interpretSolidityTypeBinding,
  bindingScopeFor: solidityBindingScopeFor,
  importOwningScope: solidityImportOwningScope,
  receiverBinding: solidityReceiverBinding,
  mergeBindings: (_scope, bindings) => solidityMergeBindings(bindings),
  arityCompatibility: solidityArityCompatibility,
});
