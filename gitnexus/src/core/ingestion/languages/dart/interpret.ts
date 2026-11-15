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
import type { ElementAccessRoute } from '../../scope-resolution/contract/scope-resolver.js';

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
  const alias = captures['@import.alias'];
  if (alias !== undefined) {
    return {
      kind: 'namespace',
      targetRaw: raw,
      localName: alias.text,
      importedName: raw,
      explicitAlias: true,
    };
  }
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

/**
 * What awaiting a value of this declared type yields — `Future<User>` /
 * `FutureOr<User>` → `User`; `undefined` for anything else, including a
 * `Future<void>` / `Future<dynamic>` (nothing to type) and a non-awaitable
 * container (`List<User>` is NOT unwrapped by an await). The Dart
 * `elementTypeOf` answers the fold's `await` route with this.
 */
export function dartAwaitedType(text: string): string | undefined {
  const m = /^(?:Future|FutureOr)<(.+)>$/.exec(text.trim().replace(/\?+$/, ''));
  if (m === null || m[1] === undefined) return undefined;
  // A library prefix is KEPT (`models.User` stays `models.User`): the
  // qualifier is what rules out a same-named local class, and the receiver
  // lookups read a `.` qualifier as a namespace-import handle — binding the
  // named class through that import or nothing, never the bare tail.
  const inner = m[1].trim().replace(/\?+$/, '');
  return inner === '' || inner === 'void' || inner === 'dynamic' ? undefined : inner;
}

/**
 * `elementTypeOf` for Dart, handed to BOTH the `LanguageProvider` (the scope
 * extractor's chain follow, parse side) and the `ScopeResolver` (the receiver
 * fold and the post-finalize follow): the one container route Dart answers is
 * `await` (DART-04). The index route stays unanswered (DART-01), and no other
 * container is unwrapped — a container and its element can share a method
 * name, and that edge would be a guess.
 */
export function dartElementTypeOf(
  containerType: string,
  via: ElementAccessRoute,
): string | undefined {
  return via.kind === 'await' ? dartAwaitedType(containerType) : undefined;
}

export function interpretDartTypeBinding(captures: CaptureMatch): ParsedTypeBinding | null {
  const nameCap = captures['@type-binding.name'];
  const typeCap = captures['@type-binding.type'];
  if (nameCap === undefined || typeCap === undefined) return null;

  // A call-derived `prefix.member` names a namespace function or a member
  // call, not a library-prefixed type, so it keeps its prefix (#3498).
  //
  // An awaitable RETURN (`Future<User>`, carried whole by
  // `awaitableReturnSpelling`) is kept whole rather than unwrapped: the
  // binding is read for the function's name with or without an await, and
  // `svc.getUserAsync().save()` must not type the Future as a `User`. The
  // fold's await step unwraps it through `dartAwaitedType` (DART-04).
  const rawType =
    captures['@type-binding.constructor'] !== undefined && typeCap.text.includes('.')
      ? typeCap.text
      : captures['@type-binding.return'] !== undefined &&
          dartAwaitedType(typeCap.text) !== undefined
        ? typeCap.text.trim().replace(/\?+$/, '')
        : normalizeDartType(typeCap.text);
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
