/**
 * Pure derivation of the embedding-mode flags for `runFullAnalysis`.
 *
 * Lives in its own module (no native imports) so the branching contract can
 * be unit-tested without spinning up LadybugDB, tree-sitter, or any of the
 * other side-effecting dependencies pulled in by `run-analyze.ts`.
 *
 * Semantics:
 *   --drop-embeddings         -> wipe (skip cache load entirely)
 *   --embeddings              -> load cache, restore, then generate
 *   --force + existing>0      -> load cache, restore, then generate (regenerate top-up)
 *   (default) + existing>0    -> preserve only (load + restore, no generation)
 *   any path with existing=0  -> no cache work, no preservation
 */

export interface EmbeddingModeInput {
  force?: boolean;
  embeddings?: boolean;
  dropEmbeddings?: boolean;
}

export interface EmbeddingMode {
  /** True when phase 4 should run the embedding generation pipeline. */
  shouldGenerateEmbeddings: boolean;
  /** True when we should load the cache to re-insert vectors after rebuild without generating new ones. */
  preserveExistingEmbeddings: boolean;
  /** True when `--force` upgraded a default analyze into a regeneration because the repo was already embedded. */
  forceRegenerateEmbeddings: boolean;
  /** True when we need to load cached embeddings from the existing DB before the rebuild. */
  shouldLoadCache: boolean;
}

export function deriveEmbeddingMode(
  options: EmbeddingModeInput,
  existingEmbeddingCount: number,
): EmbeddingMode {
  const hasExisting = existingEmbeddingCount > 0;
  const drop = !!options.dropEmbeddings;
  const explicit = !!options.embeddings;
  const force = !!options.force;

  const forceRegenerateEmbeddings = force && !explicit && !drop && hasExisting;
  const preserveExistingEmbeddings =
    !explicit && !drop && !forceRegenerateEmbeddings && hasExisting;
  const shouldGenerateEmbeddings = explicit || forceRegenerateEmbeddings;
  const shouldLoadCache = !drop && (shouldGenerateEmbeddings || preserveExistingEmbeddings);

  return {
    shouldGenerateEmbeddings,
    preserveExistingEmbeddings,
    forceRegenerateEmbeddings,
    shouldLoadCache,
  };
}
