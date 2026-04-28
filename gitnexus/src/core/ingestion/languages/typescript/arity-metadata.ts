/**
 * Extract TypeScript arity metadata from a method-like tree-sitter node —
 * `method_definition`, `method_signature`, `abstract_method_signature`,
 * `function_declaration`, `generator_function_declaration`, or
 * `function_signature` (overload signature).
 *
 * Reuses `typescriptMethodConfig.extractParameters` so scope-extracted defs
 * carry the same arity semantics as the legacy parse-worker path:
 *   - Rest parameters (`...args: T[]`) collapse `parameterCount` to
 *     `undefined`, which `typescriptArityCompatibility` treats as
 *     "max unknown" — the candidate stays eligible at
 *     `argCount >= required` (mirrors Python `*args` / C# `params`).
 *   - Optional (`p?: T`) and defaulted (`p: T = …`) parameters both
 *     contribute to `optionalCount`;
 *     `requiredParameterCount = total − optionalCount`.
 *   - `parameterTypes` collects declared type-annotation text for
 *     overload narrowing; TypeScript supports function overloading
 *     (`function f(x: string); function f(x: number); function f(x) {}`),
 *     so populated types let the registry disambiguate same-arity
 *     siblings by declared types.
 *   - A literal `'params'` marker is appended for variadic methods so
 *     `typescriptArityCompatibility` can detect rest params without
 *     re-reading the AST.
 *
 * ## Generics stripping
 *
 * TypeScript parameter types frequently contain generic instantiations
 * (`User<string>`, `Array<User>`, `Promise<User[]>`). For overload
 * narrowing by declared type, we want the "head" name — `User`,
 * `Array`, `Promise` — so `arity-metadata` applies a light strip to
 * each `parameterTypes[i]`:
 *
 *   - `Foo<Bar>`          → `Foo`
 *   - `Foo<Bar, Baz>`     → `Foo`
 *   - `Foo[]`             → `Foo`
 *   - `Foo<Bar>[]`        → `Foo`
 *   - `Foo<Bar<Baz>>`     → `Foo`   (greedy — strip the outermost once)
 *   - plain `Foo`         → `Foo`
 *
 * We do NOT strip unions / intersections at this layer — those stay
 * intact because the registry's overload narrowing is a string
 * equality check; union types shouldn't match anything and we prefer
 * "unknown" to "accidental match". `undefined` / `null` in unions
 * (TS strict mode) is handled by `interpret.ts`'s `stripNullableUnion`
 * when the name would be consumed as a receiver type — that path is
 * separate from this arity-metadata path.
 *
 * Generic type parameters on the function itself (`function f<T>(x: T)`)
 * do NOT enter here — the method extractor reads the `parameters`
 * field only, which contains value parameters, not type parameters.
 */

import type { SyntaxNode } from '../../utils/ast-helpers.js';
import { typescriptMethodConfig } from '../../method-extractors/configs/typescript-javascript.js';

interface TsArityMetadata {
  readonly parameterCount: number | undefined;
  readonly requiredParameterCount: number | undefined;
  readonly parameterTypes: readonly string[] | undefined;
}

export function computeTsArityMetadata(fnNode: SyntaxNode): TsArityMetadata {
  const params = typescriptMethodConfig.extractParameters?.(fnNode) ?? [];

  let hasRest = false;
  let optionalCount = 0;
  const types: string[] = [];
  for (const p of params) {
    if (p.isVariadic) hasRest = true;
    else if (p.isOptional) optionalCount++;
    const t = p.type !== null && p.type !== undefined ? stripGenericsAndArraySuffix(p.type) : '';
    types.push(t);
  }
  if (hasRest) types.push('params');

  const total = params.length;
  const parameterCount = hasRest ? undefined : total;
  const requiredParameterCount = hasRest ? undefined : total - optionalCount;

  // Only emit parameterTypes when at least one param carries a non-
  // empty type name. An array of all empty strings adds noise to the
  // registry without aiding narrowing — callers treat absence as
  // "types unknown".
  const hasAnyType = types.some((t) => t !== '' && t !== 'params');
  const parameterTypes = hasAnyType || hasRest ? (types.length > 0 ? types : undefined) : undefined;

  return {
    parameterCount,
    requiredParameterCount,
    parameterTypes,
  };
}

/**
 * Light generic + array-suffix strip used only for registry overload
 * narrowing. See file-level JSDoc for the exact transformation table.
 *
 * Handles nesting greedily at the outermost level:
 *   `Foo<Bar<Baz>>[]` — strip `[]` → `Foo<Bar<Baz>>`, then strip
 *   outermost `<>` → `Foo`.
 */
function stripGenericsAndArraySuffix(raw: string): string {
  let t = raw.trim();
  // Repeatedly peel trailing `[]` pairs, then peel the outermost `<…>`
  // block once. We don't loop the `<>` peel since nesting is rare and
  // the head name is already reached after one peel.
  while (t.endsWith('[]')) t = t.slice(0, -2).trim();
  const lt = t.indexOf('<');
  if (lt > 0 && t.endsWith('>')) {
    t = t.slice(0, lt).trim();
  }
  return t;
}
