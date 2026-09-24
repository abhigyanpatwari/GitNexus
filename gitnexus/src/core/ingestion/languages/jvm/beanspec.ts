/**
 * Language-neutral JVM JavaBeans naming primitives.
 *
 * Language adapters choose whether to invent/preserve an `is` prefix and
 * which single-character capitalization policy their compiler uses.
 */

export function capitalizeBeanName(s: string): string {
  if (s.length === 0) return s;
  const first = s.charAt(0);
  const upper = first.toUpperCase();
  // Java Character case conversion is one UTF-16 code unit. JavaScript
  // full-case conversion may expand one unit (`ß` → `SS`), which would invent
  // a method name no JVM compiler emits.
  return (upper.length === 1 ? upper : first) + s.slice(1);
}

/**
 * Primitive-boolean / Kotlin `is`-prefix fields whose name already starts with
 * `is` plus a non-lowercase character keep that name for the getter and drop
 * the `is` prefix for the setter base (`isEnabled` → `isEnabled()` /
 * `setEnabled(...)`, `is1` → `is1()` / `set1(...)`). Digits and punctuation
 * count as non-lowercase, matching Lombok `!Character.isLowerCase` and kotlinc.
 */
export function booleanIsPrefixBase(fieldName: string, useIsPrefix: boolean): string | null {
  if (!useIsPrefix || !fieldName.startsWith('is') || fieldName.length < 3) return null;
  const third = fieldName.charAt(2);
  return third === third.toUpperCase() ? fieldName.slice(2) : null;
}

export function jvmGetterName(
  fieldName: string,
  useIsPrefix: boolean,
  capitalize: (name: string) => string = capitalizeBeanName,
): string {
  if (booleanIsPrefixBase(fieldName, useIsPrefix) !== null) return fieldName;
  if (useIsPrefix) return `is${capitalize(fieldName)}`;
  return `get${capitalize(fieldName)}`;
}

export function jvmSetterName(
  fieldName: string,
  useIsPrefix: boolean,
  capitalize: (name: string) => string = capitalizeBeanName,
): string {
  const stripped = booleanIsPrefixBase(fieldName, useIsPrefix);
  if (stripped !== null) return `set${stripped}`;
  return `set${capitalize(fieldName)}`;
}
