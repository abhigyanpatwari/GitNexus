/**
 * Capture-match → semantic-shape interpreters for TypeScript.
 *
 * Two pure functions, both consumed by the central scope extractor:
 *
 *   - `interpretTsImport`      → `ParsedImport`
 *   - `interpretTsTypeBinding` → `ParsedTypeBinding`  (wired in Unit 6)
 *
 * The import matches arrive pre-decomposed by `emitTsScopeCaptures`
 * (one imported name per match, with synthesized
 * `@import.kind/source/name/alias` markers — see `import-decomposer.ts`).
 * The type-binding matches arrive straight from the raw query captures —
 * each `@type-binding.*` anchor carries `@type-binding.name` +
 * `@type-binding.type`.
 */

import type { CaptureMatch, ParsedImport, ParsedTypeBinding, TypeRef } from 'gitnexus-shared';

// ─── interpretImport ──────────────────────────────────────────────────────

export function interpretTsImport(captures: CaptureMatch): ParsedImport | null {
  // Markers attached by `splitImportStatement` (import-decomposer.ts):
  //   @import.kind   : one of the kinds documented there
  //   @import.name   : imported name from the source module
  //   @import.alias  : local alias name (for default / aliased / namespace forms)
  //   @import.source : module path (always present except dynamic-unresolved)
  const kindCap = captures['@import.kind'];
  const nameCap = captures['@import.name'];
  const aliasCap = captures['@import.alias'];
  const sourceCap = captures['@import.source'];

  const kind = kindCap?.text;
  if (kind === undefined) return null;

  switch (kind) {
    case 'default': {
      // `import D from './m'` — semantically "alias for the module's
      // default export". We map to ParsedImport `alias` with
      // importedName='default' so the finalize algorithm looks up the
      // target module's `default` export for cross-file resolution.
      if (sourceCap === undefined || aliasCap === undefined) return null;
      return {
        kind: 'alias',
        localName: aliasCap.text,
        importedName: 'default',
        alias: aliasCap.text,
        targetRaw: sourceCap.text,
      };
    }
    case 'named': {
      // `import { X } from './m'` (plus type-only forms).
      if (sourceCap === undefined || nameCap === undefined) return null;
      return {
        kind: 'named',
        localName: nameCap.text,
        importedName: nameCap.text,
        targetRaw: sourceCap.text,
      };
    }
    case 'named-alias': {
      // `import { X as Y } from './m'`.
      if (sourceCap === undefined || nameCap === undefined || aliasCap === undefined) {
        return null;
      }
      return {
        kind: 'alias',
        localName: aliasCap.text,
        importedName: nameCap.text,
        alias: aliasCap.text,
        targetRaw: sourceCap.text,
      };
    }
    case 'namespace': {
      // `import * as N from './m'` — `N` binds the whole module.
      if (sourceCap === undefined || aliasCap === undefined) return null;
      return {
        kind: 'namespace',
        localName: aliasCap.text,
        importedName: sourceCap.text,
        targetRaw: sourceCap.text,
      };
    }
    case 'reexport': {
      // `export { X } from './m'`.
      if (sourceCap === undefined || nameCap === undefined) return null;
      return {
        kind: 'reexport',
        localName: nameCap.text,
        importedName: nameCap.text,
        targetRaw: sourceCap.text,
      };
    }
    case 'reexport-alias': {
      // `export { X as Y } from './m'`.
      if (sourceCap === undefined || nameCap === undefined || aliasCap === undefined) {
        return null;
      }
      return {
        kind: 'reexport',
        localName: aliasCap.text,
        importedName: nameCap.text,
        alias: aliasCap.text,
        targetRaw: sourceCap.text,
      };
    }
    case 'reexport-wildcard': {
      // `export * from './m'` — no local name, just a blanket passthrough.
      if (sourceCap === undefined) return null;
      return { kind: 'wildcard', targetRaw: sourceCap.text };
    }
    case 'reexport-namespace': {
      // `export * as ns from './m'` — creates a local binding `ns`
      // that exposes the whole module, while also re-exporting it.
      // Closest ParsedImport fit is `namespace`; the re-export side
      // of this edge is tracked by the export detector downstream.
      if (sourceCap === undefined || aliasCap === undefined) return null;
      return {
        kind: 'namespace',
        localName: aliasCap.text,
        importedName: sourceCap.text,
        targetRaw: sourceCap.text,
      };
    }
    case 'dynamic': {
      // `import('./m')` / `import(x)`. The decomposer marks literal-
      // string arguments with `@import.literal` so we can promote them
      // to `dynamic-resolved` here — that lets the shared finalizer
      // produce a file-level IMPORTS edge for lazy-loaded modules.
      // Non-literal arguments stay `dynamic-unresolved` (target is
      // runtime-computed and unreachable to the static finalizer).
      const isLiteral = captures['@import.literal'] !== undefined;
      if (isLiteral && sourceCap !== undefined) {
        return { kind: 'dynamic-resolved', targetRaw: sourceCap.text };
      }
      return {
        kind: 'dynamic-unresolved',
        localName: '',
        targetRaw: sourceCap?.text ?? null,
      };
    }
    case 'side-effect': {
      // `import './polyfill'` — bare-source, no local binding. The
      // finalize layer resolves to a target file and emits a
      // file-level IMPORTS edge; no `BindingRef` is materialized.
      if (sourceCap === undefined) return null;
      return { kind: 'side-effect', targetRaw: sourceCap.text };
    }
    default:
      return null;
  }
}

// ─── interpretTypeBinding ─────────────────────────────────────────────────

/**
 * Interpret a `@type-binding.*` capture-match into a `ParsedTypeBinding`.
 *
 * TypeScript-specific strips:
 *
 *   - Trailing `?` on optional parameters: `(u?: User)` → `User`
 *   - `Promise<User>` / `Array<User>` / `ReadonlyArray<User>` / `Readonly<User>`
 *     → `User`  (wrappers that are transparent to chain propagation)
 *   - Single-arg `List<User>` / `Iterable<User>` / `Iterator<User>` —
 *     mirrors Python/C#'s generic-collection strip for for-of loops
 *   - Trailing `[]` on array types: `User[]` → `User`
 *   - Nullable unions: `User | null` / `User | undefined` / `null | User`
 *     → `User`
 *   - Dotted qualifiers: `models.User` → `User`  (unless the suffix is
 *     a known collection accessor we'd want to preserve — none apply
 *     to TS today, since TS uses `.values()` / `.keys()` call syntax)
 */
export function interpretTsTypeBinding(captures: CaptureMatch): ParsedTypeBinding | null {
  const nameCap = captures['@type-binding.name'];
  const typeCap = captures['@type-binding.type'];
  if (nameCap === undefined || typeCap === undefined) return null;

  // Readonly/array/nullable wrappers can stack; apply passes until a
  // fixed point (bounded by the text length since every strip monotonically
  // shrinks the string).
  let prev = '';
  let rawType = typeCap.text.trim();
  while (prev !== rawType) {
    prev = rawType;
    rawType = stripReadonly(rawType);
    rawType = stripNullableUnion(rawType);
    rawType = stripGeneric(rawType);
    rawType = stripArraySuffix(rawType);
  }
  // Destructuring / member-alias / map-tuple / dotted-call-alias bindings
  // carry receiver paths or sentinel strings that must survive verbatim.
  // Also preserve dotted member-call callee text (`svc.getUser`) for
  // `@type-binding.alias` — stripQualifier would reduce it to `getUser`,
  // breaking compound-receiver's `obj.method()` split.
  const isDestructured = captures['@type-binding.destructured'] !== undefined;
  const isMemberAlias = captures['@type-binding.member-alias'] !== undefined;
  const isMapTupleEntry = captures['@type-binding.map-tuple-entry'] !== undefined;
  const isInstanceofNarrow = captures['@type-binding.instanceof-narrow'] !== undefined;
  const isAlias = captures['@type-binding.alias'] !== undefined;
  const preserveRawTypeName =
    isDestructured ||
    isMemberAlias ||
    isMapTupleEntry ||
    isInstanceofNarrow ||
    (isAlias && rawType.includes('.'));
  if (!preserveRawTypeName) {
    rawType = stripQualifier(rawType);
  }

  // Drop non-discriminating / wildcard types — `as any` / `as unknown`
  // should not block a more-informative sibling binding (typically the
  // constructor-inferred capture from the inner `new_expression`). By
  // returning null here we let the scope-extractor's tie-break select
  // the next-best binding for the same name.
  if (UNINFORMATIVE_TYPES.has(rawType)) return null;

  // Anchor captures distinguish the source of the binding. Order
  // matters: more-specific anchors take precedence. `this` is a
  // TypeScript-specific receiver synthesized in `receiver-binding.ts`
  // (Unit 3); treat it as `self` for Registry.lookup parity with
  // Python/C#.
  let source: TypeRef['source'] = 'parameter-annotation';
  if (captures['@type-binding.this'] !== undefined) source = 'self';
  else if (captures['@type-binding.constructor'] !== undefined) source = 'constructor-inferred';
  else if (captures['@type-binding.assertion'] !== undefined) source = 'annotation';
  else if (captures['@type-binding.annotation'] !== undefined) source = 'annotation';
  else if (captures['@type-binding.member-alias'] !== undefined) source = 'assignment-inferred';
  else if (captures['@type-binding.alias'] !== undefined) source = 'assignment-inferred';
  else if (captures['@type-binding.return'] !== undefined) source = 'return-annotation';
  else if (captures['@type-binding.parameter-property'] !== undefined) source = 'annotation';
  else if (captures['@type-binding.destructured'] !== undefined) source = 'assignment-inferred';
  else if (captures['@type-binding.map-tuple-entry'] !== undefined) source = 'assignment-inferred';
  else if (captures['@type-binding.instanceof-narrow'] !== undefined) source = 'annotation';

  return { boundName: nameCap.text, rawTypeName: rawType, source };
}

/** Types that carry no discriminating information for chain resolution.
 *  `any` / `unknown` / `object` / `never` / `void` match anything, so a
 *  sibling capture (e.g. a constructor-inferred type from `new X() as any`)
 *  is strictly preferable. Empty string emerges from malformed captures
 *  and is also useless. `null` / `undefined` shouldn't survive
 *  stripNullableUnion but are listed here for defense-in-depth. */
const UNINFORMATIVE_TYPES: ReadonlySet<string> = new Set([
  '',
  'any',
  'unknown',
  'object',
  'never',
  'void',
  'null',
  'undefined',
]);

/** `readonly User[]` → `User[]`. Applied before stripArraySuffix so
 *  `readonly User[]` reduces through the same pipeline. */
function stripReadonly(text: string): string {
  if (text.startsWith('readonly ')) return text.slice('readonly '.length).trim();
  return text;
}

/** `User | null` / `User | undefined` / `null | User | undefined` → `User`.
 *  Any number of `null` / `undefined` arms may appear; collapse to the
 *  single remaining discriminating arm. Preserves multi-arm unions
 *  of real types (`User | Admin`) since the concrete receiver type is
 *  ambiguous. */
function stripNullableUnion(text: string): string {
  const parts = text.split('|').map((p) => p.trim());
  if (parts.length < 2) return text;
  const NULLS = new Set(['null', 'undefined']);
  const nonNull = parts.filter((p) => !NULLS.has(p));
  if (nonNull.length === 1) return nonNull[0];
  return text;
}

/** Single-arg generic wrappers transparent to receiver-type chain
 *  propagation: `Promise<X>`, `Array<X>`, `ReadonlyArray<X>`,
 *  `Readonly<X>`, `Iterable<X>`, `Iterator<X>`, `Set<X>`, `List<X>`,
 *  `Map<X>` (single-arg form rare but kept for completeness), etc.
 *  Multi-arg generics (`Map<K, V>`, `Record<K, V>`) are left alone —
 *  element semantics aren't unambiguous. */
function stripGeneric(text: string): string {
  const single = text.match(
    /^(?:[A-Za-z_][A-Za-z0-9_]*\.)?(?:Promise|Array|ReadonlyArray|Readonly|Iterable|Iterator|AsyncIterable|AsyncIterator|AsyncGenerator|Generator|Set|ReadonlySet|List|Awaited)<([^,<>]+)>$/,
  );
  if (single !== null) return single[1].trim();
  return text;
}

/** `User[]` / `(User)[]` → `User`. Chained `User[][]` unwraps one
 *  level at a time per resolve pass. */
function stripArraySuffix(text: string): string {
  if (text.endsWith('[]')) {
    const inner = text.slice(0, -2).trim();
    // Unwrap a single pair of parentheses introduced for precedence
    // disambiguation: `(User | Admin)[]` — we leave the union intact
    // but drop the parens.
    if (inner.startsWith('(') && inner.endsWith(')')) {
      return inner.slice(1, -1).trim();
    }
    return inner;
  }
  return text;
}

/** `models.User` → `User`. TS doesn't carry a qualified-suffix exception
 *  list today — `.values()` / `.keys()` use method-call syntax and are
 *  resolved via the member-call chain, not via a dotted type. */
function stripQualifier(text: string): string {
  const lastDot = text.lastIndexOf('.');
  if (lastDot === -1) return text;
  return text.slice(lastDot + 1);
}
