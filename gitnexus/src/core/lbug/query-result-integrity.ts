import { SYMBOL_NODE_LABELS } from '../ingestion/utils/symbol-labels.js';

/** Shared integrity boundary for identities returned by graph and search queries. */
export const SYMBOL_IDENTITY_RECOVERY_SUGGESTION =
  'Run gitnexus analyze --force from the affected repository root to rebuild the index.';

export class SymbolIdentityError extends Error {
  constructor() {
    super('The index returned an invalid symbol identity. ' + SYMBOL_IDENTITY_RECOVERY_SUGGESTION);
    this.name = 'SymbolIdentityError';
  }
}

/** Validate database identities before using them as graph traversal anchors. */
export function assertSymbolIdentity(id: unknown, expectedUid?: string): asserts id is string {
  if (
    typeof id !== 'string' ||
    !id.trim() ||
    id.includes('\0') ||
    (expectedUid !== undefined && id !== expectedUid)
  ) {
    throw new SymbolIdentityError();
  }
}

/** Read either native row shape without turning an absent row into a TypeError. */
export function queryRowValue(row: unknown, key: string, index: number): unknown {
  if (typeof row !== 'object' || row === null) return undefined;
  const value = row as Record<string, unknown>;
  return value[key] ?? value[index];
}

/** Optional labels/paths may be empty or NULL; NUL is never a usable identity. */
export function assertIdentityFields(...values: unknown[]): void {
  for (const value of values) {
    if (
      value !== null &&
      value !== undefined &&
      (typeof value !== 'string' || value.includes('\0'))
    ) {
      throw new SymbolIdentityError();
    }
  }
}

/** Reject mixed rows even when both the UID and the unrelated path are printable. */
export function assertSymbolFilePath(id: unknown, filePath: unknown): void {
  // Older indexes may omit paths or use opaque IDs without a source-path component.
  if (typeof id !== 'string' || typeof filePath !== 'string' || !filePath) return;
  const separator = id.indexOf(':');
  if (separator < 0) return;
  const label = id.slice(0, separator);
  const sourceLabels: ReadonlySet<string> = SYMBOL_NODE_LABELS;
  if (label === 'File' || label === 'Folder') {
    if (id !== `${label}:${filePath}`) throw new SymbolIdentityError();
  } else if (sourceLabels.has(label) && id.indexOf(':', separator + 1) >= 0) {
    // Match against the supplied path rather than splitting it: filenames can contain colons.
    if (!id.startsWith(`${label}:${filePath}:`)) throw new SymbolIdentityError();
  }
}

export function assertQueryIdentity(
  row: unknown,
  idKey: string,
  idIndex: number,
  fields: ReadonlyArray<readonly [string, number]> = [],
): void {
  assertSymbolIdentity(queryRowValue(row, idKey, idIndex));
  for (const [key, index] of fields) assertIdentityFields(queryRowValue(row, key, index));
}

/** Ordinary query failures may degrade; corrupt identities must reach the outer error envelope. */
export function rethrowSymbolIdentityError(error: unknown): void {
  if (error instanceof SymbolIdentityError) throw error;
}
