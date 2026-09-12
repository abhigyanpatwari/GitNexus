const DEFAULT_SPRING_VENDOR_PREFIXES = 'Win';

let cachedRawValue: string | undefined;
let cachedPrefixes: ReadonlySet<string> | undefined;

/** Return the configured vendor prefixes as a canonical, duplicate-free set. */
export function springVendorPrefixes(): ReadonlySet<string> {
  const rawValue = process.env.GITNEXUS_SPRING_VENDOR_PREFIXES ?? DEFAULT_SPRING_VENDOR_PREFIXES;
  if (cachedPrefixes && cachedRawValue === rawValue) return cachedPrefixes;

  cachedRawValue = rawValue;
  cachedPrefixes = new Set(
    rawValue
      .split(',')
      .map((prefix) => prefix.trim())
      .filter(Boolean),
  );
  return cachedPrefixes;
}

/**
 * Stable metadata value for the route semantics controlled by the prefix list.
 * Sorting makes equivalent lists independent of declaration order.
 */
export function springVendorPrefixesKey(): string {
  return JSON.stringify([...springVendorPrefixes()].sort());
}
