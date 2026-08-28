/**
 * The paths GitNexus itself writes during `analyze`.
 *
 * `analyze` rewrites the stats blocks in AGENTS.md/CLAUDE.md and refreshes the
 * agent skill mirrors as its final step — after it has recorded the per-file
 * hashes for the run. Counting its own output as a repository change makes
 * every completed run look immediately out of date, which is the regression
 * PR #1233 introduced and #1233's fix excluded these paths to prevent.
 *
 * Two freshness checks depend on this list agreeing: `isWorkingTreeDirty`
 * (analyze's up-to-date fast-path gate) and the per-file comparison behind
 * `status`. They used to hold separate copies of it, so a path added to one
 * silently became a permanent "stale" verdict in the other. One list, imported
 * by both.
 */

/**
 * Repository-root-relative. A directory entry covers everything beneath it;
 * a file entry matches only itself. Prefix collisions are NOT matches —
 * `.agentsrc` is an ordinary file, not part of the `.agents` tree.
 */
export const GITNEXUS_MANAGED_PATHS = [
  '.gitnexus',
  '.claude',
  '.cursor',
  '.agents',
  'AGENTS.md',
  'CLAUDE.md',
] as const;

/**
 * Git pathspecs excluding {@link GITNEXUS_MANAGED_PATHS} from a `git status`
 * run rooted at the repository. Both forms are emitted per entry: the bare
 * name for a file or the directory itself, and `/**` for its contents.
 */
export const GITNEXUS_MANAGED_PATH_EXCLUDES: readonly string[] = GITNEXUS_MANAGED_PATHS.flatMap(
  (managed) => [`:(exclude)${managed}`, `:(exclude)${managed}/**`],
);

/**
 * True when a repository-relative path is GitNexus's own output. Mirrors the
 * pathspec semantics above: root-relative, whole path segments only, so
 * neither `.agentsrc` nor a nested `subdir/.agents/` is treated as managed.
 */
export const isGitNexusManagedPath = (relPath: string): boolean => {
  const normalized = relPath.replace(/\\/g, '/');
  return GITNEXUS_MANAGED_PATHS.some(
    (managed) => normalized === managed || normalized.startsWith(`${managed}/`),
  );
};
