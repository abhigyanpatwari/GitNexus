export const CODE_ELEMENT_COLUMNS = [
  'id',
  'name',
  'filePath',
  'startLine',
  'endLine',
  'isExported',
  'content',
  'description',
] as const;

export const MULTI_LANG_BASE_COLUMNS = [
  'id',
  'name',
  'filePath',
  'startLine',
  'endLine',
  'content',
  'description',
] as const;

export const MOVE_FUNCTION_COLUMNS = [
  ...CODE_ELEMENT_COLUMNS,
  'language',
  'qualifiedName',
  'moduleQualifiedName',
  'visibility',
  'visibilityModifier',
  'isEntry',
  'isView',
  'isInline',
  'isNative',
  'parameterCount',
  'returnType',
  'acquires',
  'usedTypes',
  'attributes',
  'attributesJson',
  'typeParamsJson',
  'locationFidelity',
] as const;

export const MOVE_STRUCT_LIKE_COLUMNS = [
  ...MULTI_LANG_BASE_COLUMNS,
  'language',
  'qualifiedName',
  'moduleQualifiedName',
  'moduleAddress',
  'abilities',
  'isResource',
  'isEvent',
  'fieldList',
  'attributes',
  'attributesJson',
  'typeParamsJson',
  'moveDeclarationKind',
  'locationFidelity',
] as const;

export const MOVE_ENUM_VARIANT_COLUMNS = [
  ...MULTI_LANG_BASE_COLUMNS,
  'language',
  'qualifiedName',
  'parentEnum',
  'moduleQualifiedName',
  'variantKind',
  'fieldsJson',
  'attributes',
  'attributesJson',
  'locationFidelity',
] as const;

export const MOVE_CONST_COLUMNS = [
  ...MULTI_LANG_BASE_COLUMNS,
  'language',
  'qualifiedName',
  'moduleQualifiedName',
  'constType',
  'constValue',
  'isErrorCode',
  'locationFidelity',
] as const;

export const MOVE_MODULE_COLUMNS = [
  ...MULTI_LANG_BASE_COLUMNS,
  'language',
  'qualifiedName',
  'moduleAddress',
  'attributes',
  'attributesJson',
  'locationFidelity',
] as const;
