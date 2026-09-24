/**
 * Symbol listing line — the one rendering of `Type name → path` shared by every
 * formatter that lists symbols. Kept in its own tool-neutral module so a new
 * consumer does not have to import it from another tool's formatter.
 */

/**
 * One indented `Type name → path` listing line for a symbol. Shared by the
 * `detect_changes` CLI formatter and the eval-server `query` formatter so the
 * two renderings cannot drift apart.
 *
 * `||`, not `??`: a node whose label came back as an EMPTY STRING (several node
 * types do — see enrichCandidateLabels) still needs the placeholder, and `??`
 * would print the empty string instead.
 */
export function formatSymbolLine(
  type: string | undefined,
  name: string | undefined,
  filePath: string | undefined,
): string {
  return `  ${type || 'Symbol'} ${name || '?'} → ${filePath || '?'}`;
}
