/**
 * Shadow-candidate path derivation for incremental indexing.
 *
 * Background — Bugbot review on PR #1479:
 *   queryImporters() on a NEWLY ADDED file returns 0 importers in the
 *   pre-pipeline DB, because the new file's IMPORTS rows haven't been
 *   written yet. But pre-existing files may have IMPORTS edges that
 *   *resolved to a sibling path*, and the newcomer can now steal that
 *   resolution under standard JS/TS module-resolution rules. Without
 *   pulling those pre-existing files into the writable set, their
 *   stale CALLS edges remain pointing at the OLD resolution target.
 *
 * Given an added file path, this helper enumerates the pre-existing
 * file paths whose import-resolution claim the newcomer can steal.
 * Caller filters the candidates against the prior-run `fileHashes`
 * map so we only query importers of paths that actually existed.
 *
 * Shadow patterns covered (resolution-priority-aware):
 *
 *   (a) Same basename, different extension —
 *       added `foo/bar.ts` shadows `foo/bar.{tsx,js,jsx,mjs,cjs,d.ts}`.
 *   (b) Bare-file beats directory-style index —
 *       added `foo/bar.ts` shadows `foo/bar/index.{ts,tsx,...}`.
 *   (c) Directory-index beats bare-file —
 *       added `foo/index.ts` shadows `foo.{ts,tsx,...}` (rare but real,
 *       e.g. converting a single-file module into a directory module).
 *
 * Resolution-order priority is conservatively wide: we enumerate ALL
 * common extensions because we don't know which the importer actually
 * specified, and over-seeding is harmless (extra BFS work, but the
 * subgraph extract still gates write-back by file membership).
 *
 * Cross-platform path separators: candidates are emitted with both `/`
 * and `\` for shadow pattern (b), since the caller's prior fileHashes
 * map may use either depending on the OS that wrote it.
 */

const SHADOW_EXTS = ['.d.ts', '.tsx', '.ts', '.jsx', '.js', '.mjs', '.cjs'];

/**
 * Enumerate pre-existing paths whose import-resolution `added` can steal.
 *
 * @param added — repo-relative path of a newly-added file
 * @returns deduplicated list of candidate paths (NOT filtered against
 *          any known-files set — caller does that)
 */
export const shadowCandidatesFor = (added: string): string[] => {
  const ext = SHADOW_EXTS.find((e) => added.endsWith(e));
  if (!ext) return [];

  const noExt = added.slice(0, -ext.length);
  const out = new Set<string>();

  // (a) Same basename, different extension.
  for (const alt of SHADOW_EXTS) {
    if (alt !== ext) out.add(noExt + alt);
  }

  // (b) Bare file beats sibling directory-style index.
  for (const idx of SHADOW_EXTS) {
    out.add(`${noExt}/index${idx}`);
    out.add(`${noExt}\\index${idx}`);
  }

  // (c) New `foo/index.ext` shadows old `foo.ext`.
  const idxSuffixSlash = '/index';
  const idxSuffixBack = '\\index';
  let dir: string | null = null;
  if (noExt.endsWith(idxSuffixSlash)) dir = noExt.slice(0, -idxSuffixSlash.length);
  else if (noExt.endsWith(idxSuffixBack)) dir = noExt.slice(0, -idxSuffixBack.length);
  if (dir !== null) {
    for (const alt of SHADOW_EXTS) out.add(dir + alt);
  }

  return [...out];
};
