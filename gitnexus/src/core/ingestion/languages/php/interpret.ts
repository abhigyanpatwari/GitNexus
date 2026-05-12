/**
 * Capture-match → semantic-shape interpreters for PHP.
 *
 *   - `interpretPhpImport`       → `ParsedImport`
 *   - `interpretPhpTypeBinding`  → `ParsedTypeBinding`
 *
 * Import matches arrive pre-decomposed by `emitPhpScopeCaptures` (one
 * CaptureMatch per logical import, with synthesized `@import.kind /
 * source / name / alias` markers). Type-binding matches arrive from
 * the raw query captures — each `@type-binding.*` anchor carries
 * `@type-binding.name` + `@type-binding.type`.
 */

import type { CaptureMatch, ParsedImport, ParsedTypeBinding, TypeRef } from 'gitnexus-shared';

// ─── interpretImport ──────────────────────────────────────────────────────

export function interpretPhpImport(captures: CaptureMatch): ParsedImport | null {
  const kindCap = captures['@import.kind'];
  const sourceCap = captures['@import.source'];
  const nameCap = captures['@import.name'];
  const aliasCap = captures['@import.alias'];

  const kind = kindCap?.text;
  if (kind === undefined || sourceCap === undefined) return null;

  const source = sourceCap.text.trim();
  if (source === '') return null;

  switch (kind) {
    case 'namespace': {
      // `use Foo\Bar;` — PHP `use` is a NAMED import (binds the class
      // `Bar`, not the namespace `Foo`). This differs from C# `using`,
      // which is a true namespace import. Producing 'named' here makes
      // `new Bar()` resolve to the imported class def.
      const localName = nameCap?.text.trim() ?? lastSegment(source);
      return {
        kind: 'named',
        localName,
        importedName: localName,
        targetRaw: source,
      };
    }
    case 'alias': {
      // `use Foo\Bar as Baz;`
      if (aliasCap === undefined) return null;
      const alias = aliasCap.text.trim();
      if (alias === '') return null;
      const importedName = lastSegment(source);
      return {
        kind: 'alias',
        localName: alias,
        importedName,
        alias,
        targetRaw: source,
      };
    }
    case 'function': {
      // `use function Foo\bar;` — treat as named import; importedName is
      // the function name (last segment). targetRaw is the full path.
      const localName = nameCap?.text.trim() ?? lastSegment(source);
      return {
        kind: 'named',
        localName,
        importedName: localName,
        targetRaw: source,
      };
    }
    case 'const': {
      // `use const Foo\BAR;` — same shape as function.
      const localName = nameCap?.text.trim() ?? lastSegment(source);
      return {
        kind: 'named',
        localName,
        importedName: localName,
        targetRaw: source,
      };
    }
    default:
      return null;
  }
}

// ─── interpretTypeBinding ─────────────────────────────────────────────────

export function interpretPhpTypeBinding(captures: CaptureMatch): ParsedTypeBinding | null {
  const nameCap = captures['@type-binding.name'];
  const typeCap = captures['@type-binding.type'];
  if (nameCap === undefined || typeCap === undefined) return null;

  // Determine source from anchor captures. Order: most-specific first.
  let source: TypeRef['source'] = 'parameter-annotation';
  if (captures['@type-binding.self'] !== undefined) source = 'self';
  else if (captures['@type-binding.constructor'] !== undefined) source = 'constructor-inferred';
  else if (captures['@type-binding.annotation'] !== undefined) source = 'annotation';
  else if (captures['@type-binding.alias'] !== undefined) source = 'assignment-inferred';
  else if (captures['@type-binding.return'] !== undefined) source = 'return-annotation';

  let rawType: string | null;

  if (source === 'assignment-inferred') {
    // `@type-binding.alias` captures cover several assignment RHS shapes:
    //   - `$alias = $u`               → rawType = '$u'   (variable alias)
    //   - `$u = getUser()`            → rawType = 'getUser' (callable alias)
    //   - `$u = new User()`           → rawType = 'User' (constructor — via @type-binding.constructor; handled below)
    //   - `$role = UserRole::Viewer`  → rawType = 'UserRole' (enum/class constant)
    //
    // For variable aliases (`$u`), `normalizePhpType` returns null because
    // `$` is not a word character. We must preserve the raw `$`-prefixed name
    // so `followChainedRef` can walk the chain `$alias → $u → User`.
    // For callable/class names, `normalizePhpType` strips qualifiers correctly.
    const rawText = typeCap.text.trim();
    if (rawText.startsWith('$')) {
      // Variable alias: keep as-is for chain-following.
      rawType = rawText;
    } else {
      rawType = normalizePhpType(rawText);
    }
  } else {
    // All other sources: strip PHP type decoration to get the simple class name:
    //   ?User → User (nullable prefix)
    //   User|null → User (union with null/false/void)
    //   User&Loggable → User (intersection — take first meaningful)
    //   Collection<User> → User (PHPDoc generic wrapper)
    //   User[] → User (array suffix)
    //   \App\Models\User → User (backslash qualifier)
    rawType = normalizePhpType(typeCap.text.trim());
  }

  if (rawType === null) return null;

  // PHP variable names include the `$` sigil (e.g. `$user`). Most
  // bindings keep it because they are looked up via the variable
  // (`$user->method()` finds binding `$user`). Property field bindings
  // are different: `$user->address` looks up `address` (no sigil) on
  // the User class. Property declarations carry source `'annotation'`,
  // so we strip the leading `$` for that source only.
  let boundName = nameCap.text.trim();
  if (source === 'annotation' && boundName.startsWith('$')) {
    boundName = boundName.slice(1);
  }

  return { boundName, rawTypeName: rawType, source };
}

// ─── Type normalization ───────────────────────────────────────────────────

/**
 * Normalize a PHP type string to a simple class identifier, or `null`
 * when the type is uninformative (primitive, void, mixed, self, etc.).
 *
 * Rules applied in order:
 *   1. Strip nullable prefix `?`
 *   2. Split on `|` (union) — keep only if exactly one non-null part
 *   3. Take first part of `&` intersection
 *   4. Strip array suffix `[]`
 *   5. Strip generic wrapper `Collection<User>` → `User`
 *   6. Canonicalize leading backslash off: `\App\Models\User` → `App\Models\User`
 *   7. Reject PHP primitive / pseudo types
 *
 * The qualified form is preserved on `TypeRef.rawName` so downstream PHP
 * receiver resolution can distinguish `\App\Other\User` from a same-simple-name
 * `User` reachable via `use`. Without this, fully-qualified type hints collapse
 * to ambiguous simple names and resolve against the caller's scope chain
 * instead of the explicit target the source named (Codex PR #1497 review,
 * finding 1).
 */
export function normalizePhpType(raw: string): string | null {
  // 1. Strip nullable prefix
  let type = raw.startsWith('?') ? raw.slice(1).trim() : raw;

  // 2. Union type — keep only if one non-null/false/void part remains
  if (type.includes('|')) {
    const parts = type
      .split('|')
      .map((p) => p.trim())
      .filter((p) => p !== 'null' && p !== 'false' && p !== 'void' && p !== 'mixed' && p !== '');
    if (parts.length !== 1) return null;
    type = parts[0];
  }

  // 3. Intersection type — take the first part
  if (type.includes('&')) {
    const first = type.split('&')[0].trim();
    if (first === '') return null;
    type = first;
  }

  // 4. Strip array suffix
  if (type.endsWith('[]')) type = type.slice(0, -2).trim();

  // 5. Strip single-arg generic wrapper: Collection<User> → User
  //    Qualified inner types (Collection<\App\Models\User>) survive — the
  //    capture group preserves whatever the writer named.
  const genericMatch = type.match(/^\w[\w\\]*\s*<([^,<>]+)>$/);
  if (genericMatch) {
    type = genericMatch[1].trim();
  }

  // 6. Canonicalize leading backslash off — keep the qualified path intact.
  //    `\App\Models\User` → `App\Models\User`. `App\Models\User` → unchanged.
  //    Unqualified `User` stays as `User`. The qualified form is the lookup
  //    key into the workspace QualifiedNameIndex (PHP defs are indexed by
  //    namespace-joined qualifiedName); the leading-backslash distinction in
  //    source is only an "absolute path" anchor, not part of the canonical key.
  if (type.startsWith('\\')) type = type.replace(/^\\+/, '');

  // 7. Reject primitives / pseudo-types
  if (isPrimitiveOrPseudo(type)) return null;

  // Must be a (possibly qualified) PHP identifier — segments of word chars
  // separated by single backslashes. Empty segments (consecutive backslashes,
  // trailing backslash) are rejected.
  if (!/^\w+(?:\\\w+)*$/.test(type)) return null;

  return type;
}

const PHP_PRIMITIVE_TYPES = new Set([
  'int',
  'integer',
  'float',
  'double',
  'string',
  'bool',
  'boolean',
  'array',
  'object',
  'callable',
  'iterable',
  'null',
  'void',
  'never',
  'mixed',
  'false',
  'true',
  'self',
  'static',
  'parent',
]);

function isPrimitiveOrPseudo(type: string): boolean {
  return PHP_PRIMITIVE_TYPES.has(type.toLowerCase());
}

/** Last backslash-separated segment: `Foo\Bar\Baz` → `Baz`. */
function lastSegment(path: string): string {
  const parts = path.split('\\').filter(Boolean);
  return parts[parts.length - 1] ?? path;
}
