/**
 * Canonical Move symbol identity helpers.
 *
 * Move symbols need the fully-qualified address/module path in their graph IDs.
 * File path + local name is not unique when a file contains multiple modules or
 * two named-address packages expose the same local names.
 */

export interface ParsedMoveModuleName {
  address: string;
  moduleName: string;
}

export function parseMoveModuleQualifiedName(qualifiedName: string): ParsedMoveModuleName {
  const sep = qualifiedName.indexOf('::');
  if (sep === -1) return { address: '', moduleName: qualifiedName };
  return { address: qualifiedName.slice(0, sep), moduleName: qualifiedName.slice(sep + 2) };
}

export function moveModuleQualifiedName(symbolQualifiedName: string): string {
  const sep = symbolQualifiedName.lastIndexOf('::');
  return sep === -1 ? symbolQualifiedName : symbolQualifiedName.slice(0, sep);
}

export function moveLocalName(qualifiedName: string): string {
  const sep = qualifiedName.lastIndexOf('::');
  return sep === -1 ? qualifiedName : qualifiedName.slice(sep + 2);
}

export function moveShortSymbol(qualifiedName: string): string {
  const moduleQualified = moveModuleQualifiedName(qualifiedName);
  const { moduleName } = parseMoveModuleQualifiedName(moduleQualified);
  return `${moduleName}::${moveLocalName(qualifiedName)}`;
}

/**
 * Deterministic relationship id: re-analysis is reproducible and edges dedup
 * by id. `reason` is part of the key so edges differing only by reason
 * (e.g. USES_TYPE param vs return) stay distinct.
 */
export function moveRelId(
  sourceId: string,
  type: string,
  targetId: string,
  reason: string,
): string {
  return `rel:${type}:${sourceId}->${targetId}:${reason}`;
}

export function moveModuleNodeId(moduleQualifiedName: string, filePath: string): string {
  return `Module:${filePath}:${moduleQualifiedName}`;
}

export function moveFunctionNodeId(functionQualifiedName: string, filePath: string): string {
  return `Function:${filePath}:${functionQualifiedName}`;
}

export function moveStructNodeId(structQualifiedName: string, filePath: string): string {
  return `Struct:${filePath}:${structQualifiedName}`;
}

export function moveEnumNodeId(enumQualifiedName: string, filePath: string): string {
  return `Enum:${filePath}:${enumQualifiedName}`;
}

export function moveConstNodeId(constQualifiedName: string, filePath: string): string {
  return `Const:${filePath}:${constQualifiedName}`;
}

export function moveEnumVariantNodeId(
  enumQualifiedName: string,
  variantName: string,
  filePath: string,
): string {
  return `EnumVariant:${filePath}:${enumQualifiedName}::${variantName}`;
}

export function moveFieldNodeId(
  structQualifiedName: string,
  fieldName: string,
  filePath: string,
): string {
  return `Property:${filePath}:${structQualifiedName}.${fieldName}`;
}

/**
 * Parse `__lambda__<n>__<host>` into the host function's local name, or null
 * when the input is not a lambda symbol. move-flow synthesises lambdas as
 * Function symbols whose names follow this convention so they can be referenced
 * by the call graph; the host is always in the same module as the lambda.
 */
export function parseMoveLambdaHostName(localName: string): string | null {
  const match = /^__lambda__\d+__(.+)$/.exec(localName);
  return match ? match[1] : null;
}
