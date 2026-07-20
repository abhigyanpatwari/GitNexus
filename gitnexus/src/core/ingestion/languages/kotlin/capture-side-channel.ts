/**
 * Kotlin capture-time side-channel serialization (#1983).
 *
 * `emitKotlinScopeCaptures` populates one MODULE-LEVEL, per-file map as a side
 * effect that is NOT part of the returned `ParsedFile`'s scopes/defs:
 *
 *   - `companionScopesByFile`  (companion-scopes.ts) — the `ScopeId`s that came
 *     from a `companion_object` AST node, recorded via `markCompanionScope`
 *     from the `@scope.companion` marker capture.
 *   - Spring Bean class-annotation facts collected during the same scope-query
 *     traversal, consumed only after imports and package visibility finalize.
 *   - A JVM package fact read from the already-parsed root, so package-sibling
 *     visibility never re-parses Kotlin source on the main thread.
 *
 * On the worker path that map is filled in the WORKER process and lost across
 * the worker→main MessageChannel (and the disk-backed parsedfile-store),
 * because scope-resolution reuses the serialized `ParsedFile` and SKIPS the
 * main-thread re-extraction (the #1983 fix that avoids a main-thread
 * tree-sitter re-parse / OOM on huge repos). The main thread then reads the map
 * empty in `isKotlinStaticOnly` / `populateCompanionMembersOnEnclosingClass`
 * (owners.ts) — so companion methods aren't identified as static and
 * companion/static dispatch emits no CALLS edges.
 *
 * This module snapshots the per-file slice of that map into a plain,
 * JSON-serializable object (carried on `ParsedFile.captureSideChannel`) and
 * restores it on the main thread WITHOUT any parse. It mirrors the C++ pattern
 * in `cpp/capture-side-channel.ts`.
 *
 * The single generic `ParsedFile.captureSideChannel` field is shared with C++,
 * which is safe because each file is one language (a `.kt` file uses the kotlin
 * provider, a `.cpp` file the cpp provider). The payload is self-describing
 * (`{ kind: 'kotlin', companionScopes, packageFact, classAnnotations }`) so
 * `applyKotlinCaptureSideChannel` only restores kotlin state and ignores a
 * foreign-shaped snapshot.
 */

import type { ParsedFile, ScopeId } from 'gitnexus-shared';
import {
  createClassAnnotationFactStore,
  type ClassAnnotationFact,
} from '../../frameworks/spring/bean-candidates.js';
import {
  isJvmPackageFact,
  UNKNOWN_JVM_PACKAGE_FACT,
  type JvmPackageFact,
} from '../jvm/package-facts.js';
import { getCompanionScopesForFile, markCompanionScope } from './companion-scopes.js';
import { getKotlinPackageFact, setKotlinPackageFact } from './package-facts.js';

const classAnnotations = createClassAnnotationFactStore();

/**
 * Plain JSON-serializable snapshot of the per-file Kotlin capture-time
 * side-channel. Carried opaquely on `ParsedFile.captureSideChannel`. The
 * `kind` tag makes the payload self-describing so `apply` can distinguish a
 * kotlin snapshot from another language's (C++ shares the same field).
 */
export interface KotlinCaptureSideChannel {
  readonly kind: 'kotlin';
  /** Companion-object scope ids recorded for this file. */
  readonly companionScopes: readonly ScopeId[];
  /** Package visibility captured from the existing Kotlin AST. */
  readonly packageFact: JvmPackageFact;
  /** Class annotation syntax collected by the existing scope traversal. */
  readonly classAnnotations: readonly ClassAnnotationFact[];
}

export function clearKotlinClassAnnotationFacts(): void {
  classAnnotations.clear();
}

export function setKotlinClassAnnotationFacts(
  filePath: string,
  facts: readonly ClassAnnotationFact[],
): void {
  classAnnotations.set(filePath, facts);
}

export function getKotlinClassAnnotationFacts(filePath: string): readonly ClassAnnotationFact[] {
  return classAnnotations.get(filePath);
}

/**
 * `LanguageProvider.collectCaptureSideChannel` implementation for Kotlin.
 * Returns `undefined` when this file recorded no side-channel state at all, so
 * the produced `ParsedFile` carries the field only when there's data to ship.
 */
export function collectKotlinCaptureSideChannel(
  filePath: string,
): KotlinCaptureSideChannel | undefined {
  const companionScopes = getCompanionScopesForFile(filePath);
  const annotationFacts = classAnnotations.get(filePath);
  const packageFact = getKotlinPackageFact(filePath);
  if (companionScopes.length === 0 && annotationFacts.length === 0 && packageFact === undefined) {
    return undefined;
  }
  return {
    kind: 'kotlin',
    companionScopes,
    packageFact: packageFact ?? UNKNOWN_JVM_PACKAGE_FACT,
    classAnnotations: annotationFacts,
  };
}

/**
 * `ScopeResolver.applyCaptureSideChannel` implementation for Kotlin. Reads the
 * worker-serialized snapshot from `parsed.captureSideChannel` and re-populates
 * the module-level companion-scope map via `markCompanionScope`. Tolerant of
 * `undefined` (file carried no data) and of an unexpected / foreign shape
 * (defensive — the `kind` tag guards against restoring a non-kotlin payload).
 * Does NO tree-sitter parse.
 */
export function applyKotlinCaptureSideChannel(parsed: ParsedFile): void {
  const data = parsed.captureSideChannel as KotlinCaptureSideChannel | undefined;
  if (
    data === undefined ||
    data === null ||
    typeof data !== 'object' ||
    data.kind !== 'kotlin' ||
    !Array.isArray(data.companionScopes) ||
    !Array.isArray(data.classAnnotations)
  ) {
    classAnnotations.set(parsed.filePath, []);
    setKotlinPackageFact(parsed.filePath, UNKNOWN_JVM_PACKAGE_FACT);
    return;
  }
  for (const scopeId of data.companionScopes) {
    markCompanionScope(parsed.filePath, scopeId);
  }
  classAnnotations.set(parsed.filePath, data.classAnnotations);
  setKotlinPackageFact(
    parsed.filePath,
    isJvmPackageFact(data.packageFact) ? data.packageFact : UNKNOWN_JVM_PACKAGE_FACT,
  );
}
