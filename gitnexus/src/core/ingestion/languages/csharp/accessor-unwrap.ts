/**
 * C# collection-accessor unwrapping.
 *
 * When the compound-receiver resolver encounters a trailing
 * `.Values` / `.Keys` on a dotted member-access chain, it calls the
 * provider's `unwrapCollectionAccessor` hook to find the element
 * type. This module supplies the C# implementation — recognizing
 * Dictionary-family generics and returning the value or key type.
 *
 * Other languages (Python, Java, TypeScript) use method-call syntax
 * for the same access (`.values()` / `.keys()`), which the compound-
 * receiver's call-expression branch already handles; they leave this
 * hook undefined.
 */

/** Extract (K, V) from `Dictionary<K, V>` / `IDictionary<K, V>` /
 *  `IReadOnlyDictionary<K, V>` / `SortedDictionary<K, V>` /
 *  `ConcurrentDictionary<K, V>` / `ImmutableDictionary<K, V>`.
 *  Returns undefined if the type name doesn't match or the argument
 *  list isn't exactly two top-level args. */
function extractDictionaryArgs(rawName: string): { key: string; value: string } | undefined {
  const match = rawName.match(
    /^(?:[A-Za-z_][A-Za-z0-9_.]*\.)?(?:Dictionary|IDictionary|IReadOnlyDictionary|SortedDictionary|ConcurrentDictionary|ImmutableDictionary)<(.+)>$/,
  );
  if (match === null) return undefined;
  const inner = match[1]!;
  // Split on the top-level comma (tolerate nested `<...>`).
  let depth = 0;
  let commaIdx = -1;
  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i];
    if (ch === '<') depth++;
    else if (ch === '>') depth--;
    else if (ch === ',' && depth === 0) {
      commaIdx = i;
      break;
    }
  }
  if (commaIdx === -1) return undefined;
  return { key: inner.slice(0, commaIdx).trim(), value: inner.slice(commaIdx + 1).trim() };
}

/**
 * Resolve `data.Values` / `data.Keys` on a Dictionary-like receiver
 * to its element-type simple name. Returns `undefined` for any
 * receiver / accessor combination we don't recognize, letting the
 * compound-receiver pass fall through to the regular field walk.
 */
export function unwrapCsharpCollectionAccessor(
  receiverType: string,
  accessor: string,
): string | undefined {
  if (accessor !== 'Values' && accessor !== 'Keys') return undefined;
  const args = extractDictionaryArgs(receiverType);
  if (args === undefined) return undefined;
  return accessor === 'Values' ? args.value : args.key;
}
