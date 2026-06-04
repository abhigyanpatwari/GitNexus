/**
 * Dart `CaptureMatch` → semantic-shape interpreters.
 *
 *   - `interpretDartImport`  — `@import.source` → a whole-library
 *     `ParsedImport` (Dart `import`/`export` bring every public top-level
 *     symbol of the target into scope — whole-library / wildcard-leaf semantics).
 *     `@import.heritage` markers (synthesized by `captures.ts` for
 *     `implements`/`with` clauses) become side-effect imports carrying a
 *     `__heritage__:` payload that `emitDartHeritageEdges` consumes; they
 *     never produce a real IMPORTS edge (`resolveDartImportTarget` returns
 *     `null` for them).
 *   - `interpretDartTypeBinding` — `@type-binding.*` → a `ParsedTypeBinding`,
 *     normalizing the Dart type (strip nullable `?`, unwrap single-arg
 *     container generics like `Future<X>`/`List<X>`, drop library prefixes).
 */

import type { CaptureMatch, ParsedImport, ParsedTypeBinding, TypeRef } from 'gitnexus-shared';
import { HERITAGE_MARKER_PREFIX } from '../../utils/heritage-marker.js';

/** Marker prefix carried on a side-effect `ParsedImport.targetRaw` for
 *  `implements`/`with` heritage, consumed by `emitDartHeritageEdges`. Aliased to
 *  the shared codec prefix (#1994) so the Dart wire prefix has a single source of
 *  truth and cannot desync from `encodeMarker`/`decodeMarker`. */
export const DART_HERITAGE_PREFIX = HERITAGE_MARKER_PREFIX;

function stripQuotes(s: string): string {
  return s.replace(/^['"]|['"]$/g, '');
}

export function interpretDartImport(captures: CaptureMatch): ParsedImport | null {
  const heritageCap = captures['@import.heritage'];
  if (heritageCap !== undefined) {
    return { kind: 'side-effect', targetRaw: heritageCap.text };
  }

  const sourceCap = captures['@import.source'];
  if (sourceCap === undefined) return null;
  const raw = stripQuotes(sourceCap.text);
  // Dart `import '...'` brings every PUBLIC top-level symbol of the target
  // library directly into scope (no prefix) — wildcard semantics. The
  // `expandsWildcardTo` hook enumerates those names so cross-file return
  // types propagate (`var u = importedFn(); u.m()`).
  return { kind: 'wildcard', targetRaw: raw };
}

/** Container generics whose single type argument is the runtime element
 *  type a receiver resolves against (`Future<User>` → `User`). */
const SINGLE_ARG_CONTAINERS = /^(?:Future|FutureOr|List|Iterable|Set|Stream|Optional)<(.+)>$/;

/** Bare container names. When a type normalizes to one of these (e.g. the
 *  generic args were stripped upstream so `Future<User>` arrived as `Future`),
 *  binding to it would let a same-named user class capture the receiver — a
 *  wrong edge. We suppress the binding instead (leaving the call unresolved,
 *  matching the legacy DAG) rather than bind to the container name. */
const BARE_CONTAINER_TYPES: ReadonlySet<string> = new Set([
  'Future',
  'FutureOr',
  'List',
  'Iterable',
  'Set',
  'Stream',
  'Optional',
]);

export function normalizeDartType(text: string): string {
  let s = text.trim();
  // Strip nullable suffix (`User?` → `User`).
  s = s.replace(/\?+$/, '');
  // Unwrap a single-arg container generic once (`Future<User>` → `User`).
  const gen = SINGLE_ARG_CONTAINERS.exec(s);
  if (gen !== null && gen[1] !== undefined) s = gen[1].trim().replace(/\?+$/, '');
  // Drop a library/namespace prefix (`prefix.User` → `User`).
  const dot = s.lastIndexOf('.');
  if (dot !== -1) s = s.slice(dot + 1);
  return s;
}

export function interpretDartTypeBinding(captures: CaptureMatch): ParsedTypeBinding | null {
  const nameCap = captures['@type-binding.name'];
  const typeCap = captures['@type-binding.type'];
  if (nameCap === undefined || typeCap === undefined) return null;

  const rawType = normalizeDartType(typeCap.text);
  if (
    rawType === '' ||
    rawType === 'void' ||
    rawType === 'dynamic' ||
    BARE_CONTAINER_TYPES.has(rawType)
  ) {
    return null;
  }

  let source: TypeRef['source'] = 'annotation';
  if (captures['@type-binding.self'] !== undefined) source = 'self';
  else if (captures['@type-binding.constructor'] !== undefined) source = 'constructor-inferred';
  else if (captures['@type-binding.parameter'] !== undefined) source = 'parameter-annotation';
  else if (captures['@type-binding.return'] !== undefined) source = 'return-annotation';
  else if (captures['@type-binding.annotation'] !== undefined) source = 'annotation';

  return { boundName: nameCap.text, rawTypeName: rawType, source };
}
