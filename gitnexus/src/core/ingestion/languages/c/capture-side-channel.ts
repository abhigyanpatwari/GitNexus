/**
 * C capture-time side-channel serialization (#1983).
 *
 * `emitCScopeCaptures` populates one MODULE-LEVEL, per-file map as a side
 * effect that is NOT part of the returned `ParsedFile`'s scopes/defs:
 *
 *   - `staticNames`  (static-linkage.ts) — the simple names of functions
 *     declared with `static` storage class (file-local / translation-unit
 *     linkage in C), recorded via `markStaticName` from the
 *     `@declaration.name` capture when the function node has a `static`
 *     storage-class specifier.
 *
 * On the worker path that map is filled in the WORKER process and lost across
 * the worker→main MessageChannel (and the disk-backed parsedfile-store),
 * because scope-resolution reuses the serialized `ParsedFile` and SKIPS the
 * main-thread re-extraction (the #1983 fix that avoids a main-thread
 * tree-sitter re-parse / OOM on huge repos — e.g. the Linux kernel). The main
 * thread then reads the map empty in `isStaticName` (consulted by
 * `isFileLocalDef` in `c/scope-resolver.ts` and by `expandCWildcardNames` in
 * static-linkage.ts) — so file-local `static` functions become eligible for
 * cross-file global free-call resolution (false CALLS edges) and `#include`
 * wildcard imports over-expose them.
 *
 * This module snapshots the per-file slice of that map into a plain,
 * JSON-serializable object (carried on `ParsedFile.captureSideChannel`) and
 * restores it on the main thread WITHOUT any parse. It mirrors the C++ pattern
 * in `cpp/capture-side-channel.ts` and the Kotlin pattern in
 * `kotlin/capture-side-channel.ts`.
 *
 * The single generic `ParsedFile.captureSideChannel` field is shared with C++
 * and Kotlin, which is safe because each file is one language (a `.c` file uses
 * the C provider). The payload is self-describing (`{ kind: 'c', staticNames }`)
 * so `applyCStaticLinkageSideChannel` only restores C state and ignores a
 * foreign-shaped snapshot.
 */

import type { ParsedFile } from 'gitnexus-shared';
import { getStaticNamesForFile, markStaticName } from './static-linkage.js';

/**
 * Plain JSON-serializable snapshot of the per-file C capture-time
 * side-channel. Carried opaquely on `ParsedFile.captureSideChannel`. The
 * `kind` tag makes the payload self-describing so `apply` can distinguish a C
 * snapshot from another language's (C++ and Kotlin share the same field).
 */
export interface CCaptureSideChannel {
  readonly kind: 'c';
  /** Simple names of `static` (file-local linkage) functions in this file. */
  readonly staticNames: readonly string[];
}

/**
 * `LanguageProvider.collectCaptureSideChannel` implementation for C.
 * Returns `undefined` when this file recorded no static names at all, so the
 * produced `ParsedFile` carries the field only when there's data to ship.
 */
export function collectCStaticLinkageSideChannel(
  filePath: string,
): CCaptureSideChannel | undefined {
  const staticNames = getStaticNamesForFile(filePath);
  if (staticNames.length === 0) return undefined;
  return { kind: 'c', staticNames };
}

/**
 * `ScopeResolver.applyCaptureSideChannel` implementation for C. Reads the
 * worker-serialized snapshot from `parsed.captureSideChannel` and re-populates
 * the module-level static-linkage map via `markStaticName`. Tolerant of
 * `undefined` (file carried no data) and of an unexpected / foreign shape
 * (defensive — the `kind` tag guards against restoring a non-C payload).
 * Does NO tree-sitter parse.
 */
export function applyCStaticLinkageSideChannel(parsed: ParsedFile): void {
  const data = parsed.captureSideChannel as CCaptureSideChannel | undefined;
  if (data === undefined || data === null || typeof data !== 'object') return;
  if (data.kind !== 'c' || !Array.isArray(data.staticNames)) return;
  for (const name of data.staticNames) {
    markStaticName(parsed.filePath, name);
  }
}
