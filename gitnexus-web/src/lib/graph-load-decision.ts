/**
 * Pure decision logic for the WebUI's chat-only / skip-graph connection mode
 * (issue #2178). Kept free of React and network concerns so it can be unit
 * tested directly and reused at every connect entry point.
 *
 * The WebUI hangs on very large projects because the connect flow downloads the
 * entire knowledge graph into memory. The AI chat does not need that graph (it
 * calls the backend HTTP API directly), so we skip the download when the user
 * asked for chat-only mode or when the project is large enough to auto-detect.
 */

export interface SkipGraphDecisionInput {
  /**
   * Explicit user/URL choice, if any. `true` forces chat-only, `false` forces a
   * full graph download, `undefined` defers to auto-detection by node count.
   */
  explicit: boolean | undefined;
  /** Node count reported by the backend (`repoInfo.stats.nodes`), if known. */
  nodeCount: number | null | undefined;
  /** Auto-detect threshold (LARGE_GRAPH_NODE_THRESHOLD). */
  threshold: number;
}

/**
 * Decide whether to skip the graph download.
 *
 * - An explicit boolean choice always wins (override in both directions).
 * - Otherwise auto-detect: skip when the node count is known AND strictly
 *   greater than the threshold.
 * - A missing/unknown node count fails open to a full download (we never skip
 *   purely because we couldn't read the size).
 */
export function decideSkipGraph({
  explicit,
  nodeCount,
  threshold,
}: SkipGraphDecisionInput): boolean {
  if (typeof explicit === 'boolean') return explicit;
  if (typeof nodeCount !== 'number' || !Number.isFinite(nodeCount)) return false;
  return nodeCount > threshold;
}

/**
 * Whether to prompt for confirmation before loading the full graph from the
 * chat-only escape hatch ("Load graph anyway"). Confirm whenever the node count
 * is large OR unknown — never silently re-load a graph we cannot size, which
 * would risk re-introducing the original browser hang (#2178). Skip the prompt
 * only when the count is known to be at or below the threshold (a small repo
 * that was force-skipped via `?skipGraph=1`).
 */
export function shouldConfirmGraphLoad(
  nodeCount: number | null | undefined,
  threshold: number,
): boolean {
  if (typeof nodeCount !== 'number' || !Number.isFinite(nodeCount)) return true;
  return nodeCount > threshold;
}

/**
 * Parse the `?skipGraph` URL parameter into the tri-state used by
 * {@link decideSkipGraph}. Accepts `1`/`true` (chat-only) and `0`/`false`
 * (full graph), case-insensitively. Anything else — including a missing
 * parameter — yields `undefined` (auto-detect).
 */
export function parseSkipGraphParam(value: string | null | undefined): boolean | undefined {
  if (value == null) return undefined;
  const normalized = value.trim().toLowerCase();
  if (normalized === '1' || normalized === 'true') return true;
  if (normalized === '0' || normalized === 'false') return false;
  return undefined;
}
