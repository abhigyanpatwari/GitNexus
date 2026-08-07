/**
 * Lua capture-time side channel — heritage pairs collected in the parse worker
 * (where the tree-sitter AST is live) and snapshotted onto
 * `ParsedFile.captureSideChannel` so the main-thread `emitLuaHeritageEdges`
 * hook emits EXTENDS + HAS_METHOD edges WITHOUT re-reading or re-parsing the
 * file (the #1983 no-main-thread-re-parse contract).
 *
 * Mirrors `languages/java/capture-side-channel.ts` and the C/CPP equivalents:
 * `emitScopeCaptures` populates this map as a side effect, then
 * `LanguageProvider.collectCaptureSideChannel` snapshots it per file.
 */
export interface LuaExtendsPair {
  /** Child class name (quotes stripped from the `class("Name", ...)` string arg). */
  readonly child: string;
  /** Parent class identifier (bare `variable name:` in the 2nd arg). */
  readonly parent: string;
}

export interface LuaMethodOwnerPair {
  /** Receiver/table identifier — the class that owns the method. */
  readonly owner: string;
  readonly method: string;
  /** 0-based row of the `function_definition_statement` (for Method node lookup). */
  readonly defRow: number;
}

export interface LuaCaptureSideChannel {
  readonly kind: 'lua';
  readonly extendsPairs: readonly LuaExtendsPair[];
  readonly methodOwners: readonly LuaMethodOwnerPair[];
}

const _facts = new Map<string, LuaCaptureSideChannel>();

/** Populate from `emitLuaScopeCaptures` (worker). Overwrites per file per run. */
export function setLuaHeritageFacts(filePath: string, facts: LuaCaptureSideChannel): void {
  _facts.set(filePath, facts);
}

/** Snapshot hook for `LanguageProvider.collectCaptureSideChannel`. Returns
 *  `undefined` when no heritage pairs were collected (no middleclass in the
 *  file), so the field is omitted from the ParsedFile. */
export function collectLuaCaptureSideChannel(filePath: string): LuaCaptureSideChannel | undefined {
  return _facts.get(filePath);
}

/** Clear facts retained by a prior workspace pass in a long-lived process. */
export function clearLuaHeritageFacts(): void {
  _facts.clear();
}

/** Drop this file's facts so a re-capture that produces no heritage (the file
 *  lost its middleclass class between passes) does not leave stale EXTENDS /
 *  HAS_METHOD facts for `collectLuaCaptureSideChannel` to snapshot. */
export function clearLuaHeritageFactsForFile(filePath: string): void {
  _facts.delete(filePath);
}
