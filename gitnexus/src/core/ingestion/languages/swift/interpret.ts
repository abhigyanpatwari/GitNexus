/**
 * Capture-match → semantic-shape interpreters for Swift.
 *
 *   - `interpretSwiftImport`      → `ParsedImport`
 *   - `interpretSwiftTypeBinding`  → `ParsedTypeBinding`
 *
 * Import matches arrive pre-decomposed by `emitSwiftScopeCaptures` (one
 * import per match, with synthesized `@import.kind/source/name` markers
 * and an optional `@import.testable` flag). Type-binding matches arrive
 * from the raw query captures — each `@type-binding.*` anchor carries
 * `@type-binding.name` + `@type-binding.type`.
 */

import type { CaptureMatch, ParsedImport, ParsedTypeBinding, TypeRef } from 'gitnexus-shared';

// ─── interpretImport ──────────────────────────────────────────────────────

export function interpretSwiftImport(captures: CaptureMatch): ParsedImport | null {
  const sourceCap = captures['@import.source'];
  if (sourceCap === undefined) return null;

  const source = sourceCap.text;
  const name = captures['@import.name']?.text ?? source;
  const kindText = captures['@import.kind']?.text;

  if (kindText === 'reexport' || kindText === 'named') {
    return {
      kind: kindText,
      localName: name,
      importedName: name,
      targetRaw: source,
    };
  }

  return {
    kind: 'namespace',
    localName: source,
    importedName: name,
    targetRaw: source,
  };
}

// ─── interpretTypeBinding ─────────────────────────────────────────────────

export function interpretSwiftTypeBinding(captures: CaptureMatch): ParsedTypeBinding | null {
  const nameCap = captures['@type-binding.name'];
  const typeCap = captures['@type-binding.type'];
  if (nameCap === undefined || typeCap === undefined) return null;

  // Normalize so receiver-typed resolution treats these identically:
  //   `User?` / `User!`           → User   (optional / IUO)
  //   `[User]`                    → User   (array sugar)
  //   `Array<User>` / `Optional<User>` → User (single-arg generic)
  //   `Foundation.URL`            → URL    (qualifier)
  const rawType = normalizeSwiftTypeName(typeCap.text);

  let source: TypeRef['source'] = 'parameter-annotation';
  if (captures['@type-binding.self'] !== undefined) source = 'self';
  else if (captures['@type-binding.constructor'] !== undefined) source = 'constructor-inferred';
  else if (captures['@type-binding.annotation'] !== undefined) source = 'annotation';
  else if (captures['@type-binding.alias'] !== undefined) source = 'assignment-inferred';
  else if (captures['@type-binding.return'] !== undefined) source = 'return-annotation';

  return { boundName: nameCap.text, rawTypeName: rawType, source };
}

export function normalizeSwiftTypeName(text: string): string {
  return stripQualifier(stripGeneric(stripArraySugar(stripOptional(text.trim()))));
}

/**
 * Type-preserving decoration only — used by `stripTypePreservingDecoration`
 * for class lookup and declared-return replay. `User?` / `User!` → `User`.
 * Arrays, generics, and nested `Foo.Bar` are left intact so a binding used
 * for member lookup does not follow the element type or the trailing ident.
 */
export function stripSwiftTypePreservingDecoration(typeName: string): string | undefined {
  const trimmed = typeName.trim();
  if (trimmed.endsWith('?') || trimmed.endsWith('!')) return trimmed.slice(0, -1).trim();
  return undefined;
}

/** `User?` / `User!` → `User`. */
function stripOptional(text: string): string {
  if (text.endsWith('?') || text.endsWith('!')) return text.slice(0, -1).trim();
  return text;
}

/** `[User]` → `User` (array sugar). `[K: V]` (dictionary) is left alone —
 *  element semantics aren't unambiguous. */
function stripArraySugar(text: string): string {
  if (text.startsWith('[') && text.endsWith(']') && !text.includes(':')) {
    return text.slice(1, -1).trim();
  }
  return text;
}

/**
 * Unwrap a single-arg generic collection wrapper — `Array<User>`,
 * `Optional<User>`, `Set<User>` — to its element type. Mirrors C#'s
 * `stripGeneric`. Multi-arg generics (`Dictionary<K, V>`,
 * `Result<T, E>`) are left alone.
 */
function stripGeneric(text: string): string {
  const single = text.match(
    /^(?:[A-Za-z_][A-Za-z0-9_.]*\.)?(?:Array|Optional|Set|ContiguousArray|ArraySlice)<([^,<>]+)>$/,
  );
  if (single !== null) return single[1].trim();
  return text;
}

/** `Foundation.URL` → `URL`. */
function stripQualifier(text: string): string {
  const lastDot = text.lastIndexOf('.');
  if (lastDot === -1) return text;
  return text.slice(lastDot + 1);
}
