/**
 * Kotlin capture-time side-channel serialization (#1983).
 *
 * `emitKotlinScopeCaptures` populates one MODULE-LEVEL, per-file map as a side
 * effect that is NOT part of the returned `ParsedFile`'s scopes/defs:
 *
 *   - `companionScopesByFile`  (companion-scopes.ts) — the `ScopeId`s that came
 *     from a `companion_object` AST node, recorded via `markCompanionScope`
 *     from the `@scope.companion` marker capture.
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
 * (`{ kind: 'kotlin', companionScopes }`) so `applyKotlinCaptureSideChannel`
 * only restores kotlin state and ignores a foreign-shaped snapshot.
 */

import type { ParsedFile, ScopeId } from 'gitnexus-shared';
import { getCompanionScopesForFile, markCompanionScope } from './companion-scopes.js';

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
}

/**
 * `LanguageProvider.collectCaptureSideChannel` implementation for Kotlin.
 * Returns `undefined` when this file recorded no companion scopes at all, so
 * the produced `ParsedFile` carries the field only when there's data to ship.
 */
export function collectKotlinCaptureSideChannel(
  filePath: string,
): KotlinCaptureSideChannel | undefined {
  const companionScopes = getCompanionScopesForFile(filePath);
  if (companionScopes.length === 0) return undefined;
  return { kind: 'kotlin', companionScopes };
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
  if (data === undefined || data === null || typeof data !== 'object') return;
  if (data.kind !== 'kotlin' || !Array.isArray(data.companionScopes)) return;
  for (const scopeId of data.companionScopes) {
    markCompanionScope(parsed.filePath, scopeId);
  }
}
