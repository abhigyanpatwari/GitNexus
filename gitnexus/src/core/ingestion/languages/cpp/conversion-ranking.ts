/**
 * V1 C++ primitive standard-conversion-sequence ranking for overload
 * narrowing. The resolver's type signals are intentionally coarse
 * normalized names, so this models only the primitive ranks that those
 * signals can represent.
 */

const PROMOTIONS = new Set([
  'char->int',
  'bool->int',
  'short->int',
  'int->long',
  'float->double',
]);

const STANDARD_CONVERSIONS = new Set([
  'char->long',
  'char->double',
  'bool->long',
  'bool->double',
  'short->long',
  'short->double',
  'int->double',
  'double->int',
  'double->long',
  'long->int',
  'long->double',
]);

export function cppPrimitiveConversionRank(argType: string, paramType: string): number | undefined {
  if (argType === '' || paramType === '') return 0;
  if (argType === paramType) return 0;
  const key = `${argType}->${paramType}`;
  if (PROMOTIONS.has(key)) return 1;
  if (STANDARD_CONVERSIONS.has(key)) return 2;
  return undefined;
}
