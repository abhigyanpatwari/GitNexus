/**
 * Shared qualified-name normalization.
 *
 * One canonical transform from a raw, language-specific qualified name
 * (`Other::Inner`, `pkg\Sub\Type`, `  A . B `) to the `.`-joined form the
 * graph and the `QualifiedNameIndex` are keyed by (`Other.Inner`, `pkg.Sub.Type`,
 * `A.B`). Extracted from `class-extractors/generic.ts` so the structure-phase
 * `buildQualifiedName`, the scope-resolution inheritance resolver, and the
 * per-language capture emitters all key against ONE normalizer — a raw `::`
 * qualifier must normalize to the exact key the index already holds, or the
 * qualified lookup silently misses (issue #1982).
 *
 * Do NOT confuse with `heritage-extractors/supertype-alternation.ts`'s
 * `simplifyRawName`, which collapses a qualified name to its LAST segment
 * (`Other::Inner` → `Inner`) — that is a tail extractor, not a normalizer, and
 * using it as a lookup key guarantees a miss.
 *
 * Pure string functions; no AST or tree-sitter dependency.
 */

/**
 * Normalize a raw qualified name to the `.`-joined canonical form:
 * strips whitespace, converts `::` and `\` separators to `.`, collapses
 * repeated dots, and trims leading/trailing dots.
 */
export const normalizeQualifiedName = (value: string): string =>
  value
    .replace(/\s+/g, '')
    .replace(/^::/, '')
    .replace(/::/g, '.')
    .replace(/\\/g, '.')
    .replace(/\.+/g, '.')
    .replace(/^\.+|\.+$/g, '');

/**
 * Split a raw qualified name into its normalized, non-empty segments
 * (`Other::Inner` → `['Other', 'Inner']`). Returns `[]` for an empty or
 * separator-only input.
 */
export const splitQualifiedName = (value: string): string[] => {
  const normalized = normalizeQualifiedName(value);
  return normalized ? normalized.split('.').filter(Boolean) : [];
};

/**
 * Strip a trailing generic argument list at angle-bracket depth 0
 * (`Models.Box<int>` → `Models.Box`). Constructor and inheritance sites
 * often carry type arguments that are not part of the indexed def key.
 */
export function stripTrailingTypeArguments(value: string): string {
  let depth = 0;
  let ltAt0 = -1;
  for (let i = 0; i < value.length; i++) {
    const c = value[i];
    if (c === '<') {
      if (depth === 0) ltAt0 = i;
      depth++;
    } else if (c === '>') {
      depth = Math.max(0, depth - 1);
      if (depth === 0 && ltAt0 >= 0) {
        const after = value.slice(i + 1).trim();
        if (after.length === 0) return value.slice(0, ltAt0);
        ltAt0 = -1;
      }
    }
  }
  return value;
}
