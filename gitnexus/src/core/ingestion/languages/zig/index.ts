export {
  emitZigScopeCaptures,
  isZigContainerMethod,
  isZigContainerOrImportBinding,
  isZigFileStruct,
  isZigFileThisAlias,
  isZigKeywordDeclaration,
  isZigTypeShadowingBinding,
  zigContainerName,
  zigFileStructName,
  zigImportRootOf,
  zigTypeConstructorOf,
  ZIG_CONTAINER_TYPES,
} from './captures.js';
export { interpretZigImport, interpretZigTypeBinding, normalizeZigTypeName } from './interpret.js';
export {
  expandZigWildcardNames,
  zigArityCompatibility,
  zigBindingScopeFor,
  zigMergeBindings,
  zigReceiverBinding,
} from './simple-hooks.js';
