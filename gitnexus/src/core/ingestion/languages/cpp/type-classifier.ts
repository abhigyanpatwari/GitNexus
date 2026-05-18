/**
 * Coarse-grained type classifier for C++ constraint evaluation
 * (`<https://en.cppreference.com/w/cpp/types/is_integral>`,
 *  `<https://en.cppreference.com/w/cpp/types/is_floating_point>`).
 *
 * Maps a normalized type token (as produced by `normalizeCppParamType` /
 * the call-site inference in `captures.ts`) to one of the categories
 * the `<type_traits>` predicate registry uses for SFINAE filtering.
 *
 * Intentionally coarse: cv / pointer / reference qualifiers are stripped
 * upstream by `normalizeCppParamType`. Tier-A predicates
 * (`is_integral_v`, `is_floating_point_v`, `is_arithmetic_v`, `is_same_v`)
 * are insensitive to those modifiers per ISO `<type_traits>` semantics
 * ("including any cv-qualified variants").
 */

export type TypeClass =
  | 'integral'
  | 'floating'
  | 'bool'
  | 'char'
  | 'string'
  | 'null'
  | 'class'
  | 'unknown';

/**
 * Classify a normalized C++ type token. The mapping mirrors the literal-
 * inference table in `captures.ts:inferCppLiteralType` plus the std::
 * normalization in `arity-metadata.ts:normalizeCppParamType`.
 *
 * Caller note: token must already be normalized (no `const`, no `&` / `*`,
 * no `std::` prefix). Tokens passed via `ConstraintContext.argumentTypes`
 * coming from `inferCppCallArgTypes` satisfy this.
 */
export function classifyType(token: string): TypeClass {
  if (token.length === 0) return 'unknown';
  switch (token) {
    case 'int':
      return 'integral';
    case 'double':
    case 'float':
      return 'floating';
    case 'bool':
      return 'bool';
    case 'char':
      return 'char';
    case 'string':
      return 'string';
    case 'null':
      return 'null';
    default:
      // After normalization, anything that isn't a recognized primitive
      // is assumed to be a class-like type. The Tier-A predicate registry
      // doesn't introspect class types — `is_integral_v` etc. simply
      // returns `false` for `'class'`, matching ISO behavior.
      return 'class';
  }
}
