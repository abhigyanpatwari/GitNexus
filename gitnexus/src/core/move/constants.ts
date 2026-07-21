/**
 * Shared Move/Aptos constants and helpers — single source of truth for the
 * magic strings that span the mapper, the ingest phase, the entry-point linker,
 * and the MCP backend. A typo in any duplicated literal silently breaks a query
 * with no compile error, so they live here.
 */

import path from 'node:path';

/** `NodeProperties.language` tag for every Move symbol. */
export const MOVE_LANGUAGE = 'move';

/**
 * Parsed Move attribute names of interest. The mapper persists the full
 * attribute list on every Function node as `attributes: STRING[]`, so the
 * canonical Cypher query is `WHERE '<name>' IN f.attributes`. These constants
 * exist so the mapper, downstream filters, and tests share a typo-resistant
 * single source of truth for the names that matter (compiler attribute names
 * follow the move-flow `facts` payload verbatim).
 */
export const MOVE_ATTR = {
  EVENT: 'event',
  /** `#[persistent]` — vault burn reentrancy guard and similar invariants. */
  PERSISTENT: 'persistent',
  /** `#[randomness]` — randomness-attestation entry function. */
  RANDOMNESS: 'randomness',
  /** `#[deprecated]` — marked obsolete; flagged by Move lints. */
  DEPRECATED: 'deprecated',
  /** `#[lint::skip(...)]` — suppresses one or more Move lints. */
  LINT_SKIP: 'lint::skip',
  /** `#[resource_group(scope = ...)]` - declares a resource group. */
  RESOURCE_GROUP: 'resource_group',
  /** `#[resource_group_member(group = <qualified struct>)]` - group membership. */
  RESOURCE_GROUP_MEMBER: 'resource_group_member',
  /** `#[verify_only]` — visible to the Move Prover only; excluded from runtime. */
  VERIFY_ONLY: 'verify_only',
  /** `#[view]` — read-only view function. */
  VIEW: 'view',
} as const;

/** Move struct abilities of interest. */
export const MOVE_ABILITY = {
  KEY: 'key',
} as const;

/**
 * `reason` strings for Move graph edges.
 *
 * Note on `friend`: move-flow's `friends` array on a module is a *compiler-
 * derived* set that conflates two source-level concepts: explicit
 * `friend X::Y;` declarations and the Move-2 cross-module visibility that
 * `package fun` (and friend-restricted `public(friend)`) implicitly grants.
 * The facts payload does not preserve which of the two produced each entry,
 * so the `move-friend-or-package` reason is intentionally ambiguous; a
 * downstream filter (e.g. re-parsing source) is needed to distinguish them.
 */
export const MOVE_EDGE_REASON = {
  definesFunction: 'move-module-defines-function',
  definesStruct: 'move-module-defines-struct',
  definesEnum: 'move-module-defines-enum',
  definesConst: 'move-module-defines-const',
  containsVariant: 'move-enum-contains-variant',
  friend: 'move-friend-or-package',
  calls: 'move-compiler-call-graph',
  crossModuleDependency: 'move-cross-module-dependency',
  moduleInFile: 'move-module-in-file',
  // Resource-access edges (function → resource struct)
  readsResource: 'move-reads_resource',
  writesResource: 'move-writes_resource',
  acquires: 'move-acquires',
  fnParamType: 'move-fn-param-type',
  fnReturnType: 'move-fn-return-type',
  // Struct -> resource-group struct (from `#[resource_group_member(group = ...)]`)
  resourceGroupMember: 'move-resource-group-member',
  // Field edges (struct → field)
  hasField: 'move-struct-has-field',
  // Lambda → host edges (host fn → __lambda__N__host)
  lambdaHost: 'move-lambda-of-host',
  // Entry-point edge reasons (ENTRY_POINT_OF)
  entryFunction: 'move-entry-function',
  viewFunction: 'move-view-function',
} as const;

/** Error-code constant naming convention (e.g. `E_NOT_REGISTERED`). */
export const ERROR_CODE_PATTERN = /^E[_A-Z]/;

/** True when a file can change compiler facts for an entire Move package. */
export function isMoveCompilerInputPath(filePath: string): boolean {
  const normalized = filePath.replaceAll('\\', '/');
  const basename = normalized.slice(normalized.lastIndexOf('/') + 1);
  return normalized.endsWith('.move') || basename === 'Move.toml' || basename === 'Move.lock';
}

/** An available compiler must backfill indexes created while it was absent. */
export function moveAvailabilityRequiresFullRebuild(
  hasMovePackages: boolean,
  compilerAvailable: boolean,
  indexedWithCompiler: boolean | undefined,
): boolean {
  return hasMovePackages && compilerAvailable && indexedWithCompiler !== true;
}

/**
 * Make an absolute path repo-relative so node IDs and `File:` node links align.
 * Returns the input unchanged when `repoPath` is absent or non-matching.
 */
export function moveRepoRelativePath(absPath: string, repoPath?: string): string {
  if (!repoPath) return absPath;
  const relative = path.relative(repoPath, absPath);
  if (relative === '') return relative;
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    return absPath;
  }
  return relative.replaceAll(path.sep, '/');
}
