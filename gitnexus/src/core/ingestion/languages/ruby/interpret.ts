import type { CaptureMatch, ParsedImport, ParsedTypeBinding, TypeRef } from 'gitnexus-shared';
import { isHeritageMarker } from '../../utils/heritage-marker.js';

// ─── interpretImport ──────────────────────────────────────────────────────

/**
 * Interpret a pre-decomposed Ruby import capture into a `ParsedImport`.
 *
 * Ruby `require` / `require_relative` / `load` bring everything from the
 * target file into scope (wildcard semantics). The captures layer (U5)
 * pre-decomposes the raw tree-sitter match so that this function receives:
 *   - `@import.kind`   — always `'wildcard'` for Ruby
 *   - `@import.source` — the string argument (e.g. `'./user'`, `'serializable'`)
 *   - `@import.name`   — derived module name (informational)
 */
export function interpretRubyImport(captures: CaptureMatch): ParsedImport | null {
  const kind = captures['@import.kind']?.text;
  if (kind === undefined) return null;

  const source = captures['@import.source']?.text;
  if (source === undefined) return null;

  // Heritage-encoded imports (__heritage__:include:Serializable:User)
  // are stored as namespace imports so emitHeritageEdges can read them.
  if (isHeritageMarker(source)) {
    const name = captures['@import.name']?.text ?? source;
    return { kind: 'namespace', localName: name, importedName: name, targetRaw: source };
  }

  // Ruby imports are always wildcard — everything in the required file
  // becomes visible in the importing scope.
  return { kind: 'wildcard', targetRaw: source };
}

// ─── interpretTypeBinding ─────────────────────────────────────────────────

/**
 * Interpret a Ruby type-binding capture into a `ParsedTypeBinding`.
 *
 * Type information in Ruby comes from YARD/RBS annotations, `.new` calls,
 * and assignment inference. The captures layer tags each match with one of
 * several sub-captures (`@type-binding.self`, `@type-binding.constructor`,
 * etc.) so this function can determine the `source`.
 */
export function interpretRubyTypeBinding(captures: CaptureMatch): ParsedTypeBinding | null {
  const name = captures['@type-binding.name']?.text;
  const type = captures['@type-binding.type']?.text;
  if (name === undefined || type === undefined) return null;

  let source: TypeRef['source'];
  let normalizedType: string;

  if (captures['@type-binding.self'] !== undefined) {
    source = 'self';
    normalizedType = normalizeRubyTypeName(type);
  } else if (captures['@type-binding.constructor'] !== undefined) {
    source = 'constructor-inferred';
    normalizedType = normalizeRubyConstructorType(type);
  } else if (captures['@type-binding.call-return'] !== undefined) {
    source = 'constructor-inferred';
    normalizedType = normalizeRubyTypeName(type);
  } else if (captures['@type-binding.return'] !== undefined) {
    source = 'return-annotation';
    normalizedType = normalizeRubyTypeName(type);
  } else if (captures['@type-binding.parameter'] !== undefined) {
    source = 'parameter-annotation';
    normalizedType = normalizeRubyTypeName(type);
  } else if (captures['@type-binding.alias'] !== undefined) {
    source = 'assignment-inferred';
    normalizedType = normalizeRubyTypeName(type);
  } else {
    source = 'annotation';
    normalizedType = normalizeRubyTypeName(type);
  }

  return { boundName: name, rawTypeName: normalizedType, source };
}

// ─── normalizeRubyTypeName ────────────────────────────────────────────────

/**
 * Normalize a Ruby type name to its simple form:
 *   1. Strip leading `::` (root-qualified)
 *   2. Take last segment of qualified paths (`Foo::Bar::Baz` → `Baz`)
 *   3. Strip generic angle brackets for consistency (`Array<User>` → `Array`)
 *   4. Trim whitespace
 */
export function normalizeRubyTypeName(text: string): string {
  let t = text.trim();

  // Strip leading root-qualifier
  if (t.startsWith('::')) t = t.slice(2);

  // Strip generic angle brackets (e.g. `Array<User>` → `Array`)
  const angleBracket = t.indexOf('<');
  if (angleBracket !== -1) t = t.slice(0, angleBracket);

  // Take last segment of qualified paths (Foo::Bar::Baz → Baz)
  const lastColon = t.lastIndexOf('::');
  if (lastColon !== -1) t = t.slice(lastColon + 2);

  return t.trim();
}

// ─── internal helpers ─────────────────────────────────────────────────────

/**
 * Normalize a constructor-inferred type from a `.new` call.
 * Handles `Foo::Bar.new` → `Bar` and plain `Foo.new` → `Foo`.
 */
function normalizeRubyConstructorType(text: string): string {
  let t = text.trim();

  // Strip `.new` suffix if present (e.g. `Foo::Bar.new` → `Foo::Bar`)
  if (t.endsWith('.new')) t = t.slice(0, -4);

  return normalizeRubyTypeName(t);
}
