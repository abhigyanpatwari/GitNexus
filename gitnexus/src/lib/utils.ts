export const generateId = (label: string, name: string): string => {
  return `${label}:${name}`;
};

/**
 * Drop a Windows extended-length (`\\?\`) prefix from a path (#2667).
 *
 * **Comparison domain only.** Never apply this to a string that is about to be
 * handed to `fs`: libuv's `fs__capture_path` only converts WTF-8 to UTF-16 and
 * does *not* re-add the prefix for over-MAX_PATH paths, so stripping an
 * filesystem-facing path would break long-path access on hosts that have not
 * opted into `LongPathsEnabled`. Registry keys, repo-resolution lookups and
 * other pure string comparisons are safe — and are exactly where an
 * un-normalized prefix silently fails to match.
 *
 * The prefix can only ever arrive from caller-supplied input (`path.resolve`
 * preserves it); `realpathSync.native` cannot emit it, because libuv's
 * `fs__realpath_handle` strips it unconditionally.
 *
 * `\\?\Volume{GUID}\…` is deliberately left alone: the remainder of a volume-GUID
 * path is not a usable path, so stripping it would invent a wrong one. The `\\.\`
 * device namespace is left alone for the same reason and one more — most of what
 * it addresses (`\\.\PhysicalDrive0`, `\\.\COM1`, `\\.\pipe\…`) is not a
 * filesystem path at all. Both forms simply fail to match a registry entry, which
 * is the safe direction. `platform` is explicit so the transform is unit-testable
 * off Windows — same shape as `normalizeAnalyzerRootPath` in
 * `src/core/analyzer-identity.ts`.
 *
 * Call this on a `path.resolve`d path. Only the backslash spelling is matched,
 * which is sufficient there because `path.win32.resolve` already folds the
 * forward-slash spelling into it (`//?/D:/a` → `\\?\D:\a`). A raw, unresolved
 * `//?/…` string is returned unchanged rather than half-normalized.
 */
export const stripWindowsLongPathPrefix = (
  p: string,
  platform: NodeJS.Platform = process.platform,
): string => {
  if (platform !== 'win32') return p;
  // Both spellings are case-insensitive: the Windows object namespace that
  // `\\?\` addresses is, so `\\?\unc\…` is as valid as `\\?\UNC\…`.
  //
  // Each pattern requires the component that makes the remainder a usable path —
  // a share name after `UNC\`, a separator after the drive colon. Without those
  // the slice would emit something worse than the input it was handed: `\\?\UNC`
  // would become the bare root `\\`, and the drive-relative `\\?\D:foo` would
  // become `D:foo`, which is not absolute and would resolve against the process
  // cwd if a future caller ever passed it to `fs`. A malformed extended path is
  // left untouched instead, so it simply fails to match a registry entry.
  if (/^\\\\\?\\UNC\\(?=[^\\])/i.test(p)) return `\\\\${p.slice(8)}`;
  if (/^\\\\\?\\[A-Za-z]:\\/.test(p)) return p.slice(4);
  return p;
};
