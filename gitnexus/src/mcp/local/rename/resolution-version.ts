import { isDeepStrictEqual } from 'node:util';
import { serialize } from 'node:v8';
import { RenameFailure } from 'gitnexus-shared';

/** Provider-owned configuration semantics used by the reviewed resolution pass. */
export interface RenameResolutionVersion {
  snapshot: unknown;
  refresh: () => Promise<unknown>;
  bytes: number;
}

export function renameResolutionVersion(
  config: unknown,
  refresh: () => Promise<unknown>,
): RenameResolutionVersion {
  // Provider values may be Maps/Sets or data-only class instances. Clone both
  // sides of comparisons so prototypes never cause a false stale verdict.
  const snapshot: unknown = structuredClone(config);
  // Charge conservatively for in-memory object/Map overhead and UTF-16 strings,
  // rather than counting only the compact serialized representation.
  return { snapshot, refresh, bytes: 512 + serialize(snapshot).byteLength * 4 };
}

export async function validateRenameResolution(version?: RenameResolutionVersion): Promise<void> {
  if (!version || isDeepStrictEqual(version.snapshot, structuredClone(await version.refresh())))
    return;
  throw new RenameFailure(
    'resolution_changed',
    'Provider resolution configuration changed after preview. Review a fresh preview.',
  );
}
