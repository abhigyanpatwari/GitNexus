export {
  emitZigScopeCaptures,
  isZigContainerMethod,
  isZigContainerOrImportBinding,
  isZigFileStruct,
  isZigFileThisAlias,
  isZigKeywordDeclaration,
  isZigRedundantContainerCapture,
  isZigTypeShadowingBinding,
  zigCallableQualifiedName,
  zigContainerAnchor,
  zigContainerBindingName,
  zigContainerLabel,
  zigContainerName,
  zigFileStructName,
  zigImportRootOf,
  zigCallReturnTypeOf,
  zigReturnTypeIsNominal,
  zigTypeConstructorOf,
  zigUnwrapValue,
  ZIG_CONTAINER_TYPES,
} from './captures.js';
export {
  populateZigRangeBindings,
  zigElementSpelling,
  zigOptionalPayloadSpelling,
  zigPointeeSpelling,
} from './range-binding.js';
export { interpretZigImport, interpretZigTypeBinding, normalizeZigTypeName } from './interpret.js';
export {
  expandZigWildcardNames,
  zigArityCompatibility,
  zigBindingScopeFor,
  zigMergeBindings,
  zigReceiverBinding,
} from './simple-hooks.js';
