/**
 * Convert a 0-based GraphNode `startLine`/`endLine` to the 1-based line number
 * shown to humans and LLMs in MCP tool output.
 *
 * Storage is 0-based (tree-sitter `startPosition.row`; see
 * `ingestion/utils/line-base.ts`), which matches editors/`sed`/`less -N` only
 * after `+ 1`. The `context`, `query`, and `impact` tools present line numbers a
 * user cross-references against source, so they convert here at the response
 * boundary (#2377).
 *
 * Apply ONLY to a symbol node's 0-based `startLine`/`endLine`. Do NOT apply to:
 *   - BasicBlock / CFG `functionStartLine` and PDG statement lines — already
 *     1-based (they use `startPosition.row + 1`);
 *   - the internal `sym.startLine + 1` join params that target the 1-based
 *     BasicBlock id space;
 *   - raw `cypher` results, which pass LadybugDB columns through verbatim and
 *     stay 0-based (documented).
 *
 * `undefined`/`null` pass through so optional line fields stay absent.
 */
export function toDisplayLine(zeroBasedLine: number): number;
export function toDisplayLine(zeroBasedLine: number | null | undefined): number | undefined;
export function toDisplayLine(zeroBasedLine: number | null | undefined): number | undefined {
  return typeof zeroBasedLine === 'number' ? zeroBasedLine + 1 : undefined;
}
