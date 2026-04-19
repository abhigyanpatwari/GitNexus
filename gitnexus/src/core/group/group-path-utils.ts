/**
 * Shared service-path normalization for group tools (`service` monorepo filter)
 * and subgroup membership checks.
 *
 * Inputs may originate from tree-sitter, the OS file API, or user-supplied
 * MCP arguments, so both `\` and `/` separators are accepted. Internally we
 * normalize to POSIX-style `/` for case-sensitive segment comparisons.
 */

function toPosix(p: string): string {
  return p.replace(/\\/g, '/');
}

export function normalizeServicePrefix(service: unknown): string | undefined {
  if (service === undefined || service === null) return undefined;
  const s = toPosix(String(service)).trim().replace(/\/+$/, '');
  return s.length > 0 ? s : undefined;
}

export function fileMatchesServicePrefix(
  filePath: string | undefined,
  prefix: string | undefined,
): boolean {
  if (!prefix) return true;
  if (!filePath) return false;
  const normalized = toPosix(filePath);
  return normalized === prefix || normalized.startsWith(`${prefix}/`);
}

/**
 * True if `repoPath` is at or beneath `subgroup` (member-path prefix in
 * `group.yaml`). Empty / missing `subgroup` matches every repo.
 *
 * @param exact When set, requires an exact equality match (no descendant repos).
 */
export function repoInSubgroup(repoPath: string, subgroup?: string, exact?: boolean): boolean {
  if (!subgroup?.trim()) return true;
  const s = toPosix(subgroup).replace(/\/+$/, '');
  const r = toPosix(repoPath);
  if (exact) return r === s;
  return r === s || r.startsWith(`${s}/`);
}
