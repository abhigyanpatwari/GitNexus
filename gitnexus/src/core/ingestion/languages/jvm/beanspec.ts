/**
 * JVM JavaBeans accessor names shared by Java Lombok and Kotlin properties.
 *
 * Lombok HandlerUtil and kotlinc use the same `is`+uppercase primitive-boolean
 * rule. Callers pass `useIsPrefix` rather than a language-specific type string:
 * Java primitive `boolean` and Kotlin non-null `Boolean` are true; boxed
 * `Boolean` / `Boolean?` are false.
 */

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
  if (fieldName.length < 3) return null;
  if (!fieldName.startsWith('is')) return null;
  const third = fieldName.charAt(2);
  if (third !== third.toUpperCase() || third === third.toLowerCase()) return null;
  return fieldName.slice(2);
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

/** Kotlin non-null `Boolean` (nullable `Boolean?` stays get/set). */
export function kotlinUsesIsPrefix(fieldType: string): boolean {
  const t = fieldType.trim();
  return t === 'Boolean' || t === 'kotlin.Boolean';
}

/** Lombok: case-insensitive name + arity. */
export function hasExistingAccessor(
  existing: Map<string, Set<number>>,
  name: string,
  arity: number,
): boolean {
  return existing.get(name.toLowerCase())?.has(arity) === true;
}

export function rememberExistingAccessor(
  existing: Map<string, Set<number>>,
  name: string,
  arity: number,
): void {
  const key = name.toLowerCase();
  let set = existing.get(key);
  if (!set) {
    set = new Set();
    existing.set(key, set);
  }
  set.add(arity);
}
