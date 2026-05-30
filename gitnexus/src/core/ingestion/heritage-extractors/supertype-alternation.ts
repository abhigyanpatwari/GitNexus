// gitnexus/src/core/ingestion/heritage-extractors/supertype-alternation.ts

/**
 * Shared, language-agnostic heritage supertype handling.
 *
 * Two halves of the same contract live here:
 *
 *  1. {@link buildSupertypeAlternation} — given a per-language shape descriptor
 *     (the set of tree-sitter node-type shapes a supertype can take), returns
 *     the tree-sitter S-expression alternation fragment that captures any of
 *     them under a single tag, e.g.
 *       `[(type_identifier) (generic_type) (scoped_type_identifier)] @heritage.extends`
 *     Idiomatic tree-sitter alternation is `[(a) (b) (c)]` (one-of), which the
 *     heritage query blocks in tree-sitter-queries.ts interpolate inline.
 *
 *  2. {@link normalizeSupertypeName} — given the supertype node that actually
 *     matched, reduces it to the INNERMOST simple identifier. Generics
 *     (`Base<T>`), qualified/scoped names (`pkg.Base`, `ns::Base`), and
 *     delegation wrappers (`Bar by baz`) all collapse to the bare name
 *     (`Base` / `Bar`). This mirrors the C++ registry path
 *     (languages/cpp/captures.ts `extractBaseLookupName`) so that the V1
 *     simple-name `ctx.resolve(name)` contract keeps holding for every
 *     language — no `pkg.Base` or `Base<T>` ever reaches resolution.
 *
 * No language names appear in this file. Both functions are parameterized by
 * node-type data (the descriptor and the matched node's own `.type`), per the
 * shared-ingestion rule in AGENTS.md.
 */

import type { SupertypeShapeDescriptor } from '../heritage-types.js';
import type { SyntaxNode } from '../utils/ast-helpers.js';

/**
 * Build a tree-sitter alternation fragment capturing any of the descriptor's
 * supertype shapes under `tag`.
 *
 * A single shape produces `(shape) @tag`; multiple shapes produce the
 * bracketed one-of `[(a) (b) …] @tag`. Duplicate shapes are de-duplicated so
 * callers can compose shape lists freely. The returned string is a fragment
 * meant to be embedded inside a larger container pattern.
 */
export function buildSupertypeAlternation(
  descriptor: SupertypeShapeDescriptor,
  tag: string,
): string {
  const seen = new Set<string>();
  const unique: string[] = [];
  for (const shape of descriptor.shapes) {
    if (!seen.has(shape)) {
      seen.add(shape);
      unique.push(shape);
    }
  }
  if (unique.length === 0) {
    throw new Error('buildSupertypeAlternation: descriptor has no shapes');
  }
  const exprs = unique.map((shape) => `(${shape})`);
  const oneOf = exprs.length === 1 ? exprs[0] : `[${exprs.join(' ')}]`;
  return `${oneOf} @${tag}`;
}

/**
 * Field names that, when present, point at the meaningful inner part of a
 * qualified / generic / scoped / attribute / delegation supertype node. Tried
 * in order; the first that resolves to a child wins. Mirrors the cpp
 * `getBaseClassName`/`extractBaseLookupName` field preferences but covers the
 * union of fields used across grammars:
 *   - name      : generic_type, generic_name, scoped_type_identifier,
 *                 qualified_name, qualified_identifier, qualified_type,
 *                 template_type, nested_type_identifier
 *   - type      : Go generic_type, C# primary_constructor_base_type, Rust generic_type
 *   - property  : TS/JS member_expression (qualified `ns.Base`)
 *   - attribute : Python attribute (`models.Model`)
 *   - value     : Python subscript (`Generic[T]`)
 */
const INNER_NAME_FIELDS = ['name', 'type', 'property', 'attribute', 'value'] as const;

/** Node types whose own `.text` is already the simple identifier. */
const LEAF_TYPES: ReadonlySet<string> = new Set([
  'type_identifier',
  'identifier',
  'constant',
  'field_identifier',
  'namespace_identifier',
  'package_identifier',
  'simple_identifier',
  'property_identifier',
]);

/**
 * Child node types to skip during the children-walk fallback: generic
 * argument lists (hold type params, not the name) and delegate/call subtrees
 * (Kotlin `constructor_invocation` → value_arguments, `explicit_delegation` →
 * call_expression hold the delegate, not the supertype name).
 */
const SKIPPED_INNER_TYPES: ReadonlySet<string> = new Set([
  'type_arguments',
  'type_argument_list',
  'template_argument_list',
  'argument_list',
  'value_arguments',
  'call_expression',
  'call_suffix',
  'annotated_lambda',
]);

/** Guard against pathological/cyclic ASTs while descending into a supertype. */
const MAX_NORMALIZE_DEPTH = 24;

/**
 * Reduce a matched supertype node to its innermost simple name.
 *
 * Strategy (node-type-driven, matching the cpp reference):
 *  1. Leaf identifier types return `.text` directly.
 *  2. Try field-based access (name/type/property/attribute/value) and recurse
 *     into the first field that resolves. Some grammars expose the parts only
 *     via fields (Java generic_type→name, Go qualified_type→name, etc.).
 *  3. Fall back to a children walk when fields are empty (e.g. C++
 *     qualified_identifier in 0.23.x can carry the name only as a child, and
 *     Kotlin explicit_delegation wraps the user_type as a child). The LAST
 *     named child is preferred because qualified/scoped shapes put the
 *     qualifier first and the actual name last.
 */
export function normalizeSupertypeName(node: SyntaxNode | null | undefined): string {
  return normalize(node, 0);
}

function normalize(node: SyntaxNode | null | undefined, depth: number): string {
  if (!node || depth > MAX_NORMALIZE_DEPTH) return '';

  if (LEAF_TYPES.has(node.type)) {
    return node.text;
  }

  // Field-based access first — most grammars expose the inner name via a field.
  for (const field of INNER_NAME_FIELDS) {
    const child = node.childForFieldName?.(field);
    if (child) {
      const inner = normalize(child, depth + 1);
      if (inner.length > 0) return inner;
    }
  }

  // Children fallback: walk named children right-to-left so qualified/scoped
  // shapes (qualifier first, name last) resolve to the trailing name.
  for (let i = node.namedChildCount - 1; i >= 0; i--) {
    const child = node.namedChild(i);
    if (!child) continue;
    // Skip generic-argument lists and delegate/call subtrees — they hold
    // type arguments or the delegate expression, not the supertype name.
    // (Kotlin `constructor_invocation`/`explicit_delegation` wrap the
    //  user_type first and a value_arguments / call_expression second.)
    if (SKIPPED_INNER_TYPES.has(child.type)) continue;
    const inner = normalize(child, depth + 1);
    if (inner.length > 0) return inner;
  }

  // Last resort: trim obvious generic/qualifier syntax from the raw text so we
  // never leak `Base<T>` / `pkg.Base` / `ns::Base` to downstream resolution.
  return simplifyRawName(node.text);
}

/**
 * Best-effort textual fallback when the AST shape is unrecognized: drop any
 * generic argument list and keep the final qualified segment.
 */
function simplifyRawName(text: string): string {
  const withoutGenerics = text.replace(/[<\[].*$/s, '').trim();
  const segments = withoutGenerics.split(/::|\./);
  return segments[segments.length - 1]?.trim() ?? '';
}
