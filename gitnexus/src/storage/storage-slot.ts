/**
 * Leaf naming primitives for external index slots.
 *
 * Kept free of imports from `storage-resolver.ts` and `shared-store.ts` so both
 * can use them without importing each other (#3352). `storage-resolver.ts`
 * re-exports the two env-var names, so existing import sites are unchanged.
 */

import { createHash } from 'node:crypto';
import path from 'path';

export const STORAGE_PATH_ENV = 'GITNEXUS_STORAGE_PATH';
export const STORAGE_ROOT_ENV = 'GITNEXUS_STORAGE_ROOT';

const STORAGE_SLOT_HASH_LENGTH = 12;

/** Exported for tests; production callers use {@link slotNameForCanonicalPath}. */
export const sanitizeSlotBasename = (
  value: string,
  platform: NodeJS.Platform = process.platform,
): string => {
  // Linear: a quantified `/[. ]+$/` on attacker-controlled basenames is
  // js/polynomial-redos (CodeQL #1056). Cap first, then walk the tail once.
  const sanitized = value.replace(/[\u0000-\u001f<>:"/\\|?*]/g, '-').slice(0, 80);
  let end = sanitized.length;
  while (end > 0) {
    const code = sanitized.charCodeAt(end - 1);
    if (code !== 0x20 && code !== 0x2e) break;
    end--;
  }
  const candidate = sanitized.slice(0, end) || 'repository';
  // Exact device names were always prefixed. Windows also reserves them with
  // an extension (`CON.txt`); apply that only there, so existing POSIX slot
  // names stay stable.
  const reserved =
    platform === 'win32'
      ? /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i
      : /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;
  return reserved.test(candidate) ? `repository-${candidate}` : candidate;
};

/**
 * Slot name for an already-canonical absolute path: sanitized basename plus a
 * short hash of the path (case-folded on Windows) so same-basename paths stay
 * isolated.
 */
export const slotNameForCanonicalPath = (canonical: string): string => {
  const identity = process.platform === 'win32' ? canonical.toLowerCase() : canonical;
  const basename = sanitizeSlotBasename(path.basename(canonical));
  const digest = createHash('sha256')
    .update(identity)
    .digest('hex')
    .slice(0, STORAGE_SLOT_HASH_LENGTH);
  return `${basename}-${digest}`;
};
