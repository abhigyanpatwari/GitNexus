/** The diff scopes accepted by the CLI, MCP schema, and direct tool calls. */
export const DETECT_CHANGES_SCOPES = ['unstaged', 'staged', 'all', 'compare'] as const;
type DetectChangesScope = (typeof DETECT_CHANGES_SCOPES)[number];
export type DetectChangesSelection =
  | { scope: Exclude<DetectChangesScope, 'compare'> }
  | { scope: 'compare'; baseRef: string };

export function resolveDetectChangesScope(
  scope: unknown,
  baseRef: unknown,
): DetectChangesSelection | { error: string } {
  const resolved = DETECT_CHANGES_SCOPES.find(
    (value) => value === (scope === undefined ? 'unstaged' : scope),
  );
  if (!resolved) return { error: 'Invalid scope; expected unstaged, staged, all, or compare' };
  if (resolved !== 'compare' && baseRef !== undefined) {
    return { error: 'base_ref (--base-ref) is only valid for "compare" scope' };
  }
  if (resolved === 'compare') {
    if (baseRef === undefined || baseRef === '') {
      return { error: 'base_ref (--base-ref) is required for "compare" scope' };
    }
    if (typeof baseRef !== 'string' || baseRef.startsWith('-')) {
      return { error: 'base_ref (--base-ref) must be a Git revision for "compare" scope' };
    }
    return { scope: resolved, baseRef };
  }
  return { scope: resolved };
}
