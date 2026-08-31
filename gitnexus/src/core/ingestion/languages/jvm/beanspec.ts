/**
 * JVM JavaBeans accessor names shared by Java Lombok and Kotlin properties.
 *
 * Lombok invents an `is` prefix for a primitive `boolean` named `active`.
 * Kotlin never invents `is`; it only preserves a name that already starts
 * with `is` plus a non-lowercase character (`isReady`, `is1`).
 */

function isPrefixRemainder(name: string, thirdOk: (third: string) => boolean): string | null {
  if (!name.startsWith('is') || name.length < 3) return null;
  const third = name.charAt(2);
  return thirdOk(third) ? name.slice(2) : null;
}

export function capitalizeBeanName(s: string): string {
  return s.length > 0 ? s.charAt(0).toUpperCase() + s.slice(1) : s;
}

/**
 * Primitive-boolean fields whose name already starts with `is` + uppercase
 * keep that name for the getter and drop the `is` prefix for the setter base
 * (`isEnabled` → `isEnabled()` / `setEnabled(...)`).
 */
export function booleanIsPrefixBase(fieldName: string, useIsPrefix: boolean): string | null {
  if (!useIsPrefix) return null;
  return isPrefixRemainder(
    fieldName,
    (third) => third === third.toUpperCase() && third !== third.toLowerCase(),
  );
}

export function jvmGetterName(fieldName: string, useIsPrefix: boolean): string {
  if (booleanIsPrefixBase(fieldName, useIsPrefix) !== null) return fieldName;
  if (useIsPrefix) return `is${capitalizeBeanName(fieldName)}`;
  return `get${capitalizeBeanName(fieldName)}`;
}

export function jvmSetterName(fieldName: string, useIsPrefix: boolean): string {
  const stripped = booleanIsPrefixBase(fieldName, useIsPrefix);
  if (stripped !== null) return `set${stripped}`;
  return `set${capitalizeBeanName(fieldName)}`;
}

/** Java primitive `boolean` (boxed `Boolean` stays get/set). */
export function javaUsesIsPrefix(fieldType: string): boolean {
  return fieldType === 'boolean';
}

/**
 * Kotlin preserves a property name that starts with `is` + a non-lowercase
 * character (JvmAbi `!isLowerCase`, so `is1` counts) and derives its setter
 * by replacing `is` with `set`.
 */
export function kotlinUsesIsPrefix(propertyName: string): boolean {
  return kotlinIsPrefixRemainder(propertyName) !== null;
}

function kotlinIsPrefixRemainder(propertyName: string): string | null {
  return isPrefixRemainder(propertyName, (third) => third === third.toUpperCase());
}

export function kotlinGetterName(propertyName: string): string {
  return kotlinIsPrefixRemainder(propertyName) !== null
    ? propertyName
    : jvmGetterName(propertyName, false);
}

export function kotlinSetterName(propertyName: string): string {
  const remainder = kotlinIsPrefixRemainder(propertyName);
  return remainder !== null ? `set${remainder}` : jvmSetterName(propertyName, false);
}
