import { logger } from '../../logger.js';
import type { AnalysisFeatureDescriptor } from '../../analysis-features.js';

/**
 * Default: hidden (dot-prefixed) paths are NOT indexed.
 *
 * Kept `false` deliberately. `glob`'s `dot` option is the primary mechanism that
 * keeps `.git/`, `.vscode/`, `.venv/` and friends out of the index; the
 * `DEFAULT_IGNORE_LIST` check in `config/ignore-service.ts` is defense-in-depth
 * behind it, not a replacement. Flipping this default would change the indexed
 * file set for every existing repository.
 */
export const DEFAULT_INDEX_HIDDEN = false;

const warned = new Set<string>();

const warnOnce = (key: string, message: string): void => {
  if (warned.has(key)) return;
  warned.add(key);
  logger.warn(message);
};

/**
 * Resolve whether the walker should enumerate hidden (dot-prefixed) paths.
 * Reads `GITNEXUS_INDEX_HIDDEN`. Invalid values fall back to the default and
 * emit a one-time warning.
 *
 * Why this exists: a repository that keeps first-party source under a
 * dot-directory (for example `.codeops/src/`, or tooling that namespaces its
 * package under a leading dot) is silently ~unindexed — the walker never
 * enumerates those paths, so `.gitnexusignore` negation cannot re-include them
 * either (negation only un-filters `DEFAULT_IGNORE_LIST` entries, which are
 * checked *after* enumeration). Analysis still reports success, so the gap is
 * invisible. This opt-in makes such repositories indexable without changing
 * behavior for anyone else.
 *
 * `DEFAULT_IGNORE_LIST` still applies when enabled, so `.git/` and
 * `node_modules/` stay excluded; narrow the rest with `.gitnexusignore`.
 */
export const isIndexHiddenEnabled = (): boolean => {
  const raw = process.env.GITNEXUS_INDEX_HIDDEN;
  if (raw === undefined || raw === '') return DEFAULT_INDEX_HIDDEN;

  const normalized = raw.trim().toLowerCase();
  if (normalized === '1' || normalized === 'true') return true;
  if (normalized === '0' || normalized === 'false') return false;

  warnOnce(
    `invalid:${raw}`,
    `  GITNEXUS_INDEX_HIDDEN must be one of 1/0/true/false, got "${raw}" — using default ${DEFAULT_INDEX_HIDDEN}`,
  );
  return DEFAULT_INDEX_HIDDEN;
};

/**
 * Build the CLI banner message announcing that hidden-path indexing is active.
 * Returns `null` when the effective setting equals the default — the caller
 * should print nothing in that case.
 */
export const getIndexHiddenBannerMessage = (): string | null => {
  if (isIndexHiddenEnabled() === DEFAULT_INDEX_HIDDEN) return null;
  return '  GITNEXUS_INDEX_HIDDEN: indexing hidden (dot-prefixed) paths — DEFAULT_IGNORE_LIST still applies';
};

/** Test-only: reset the warn-once cache so repeated test runs can re-observe warnings. */
export const _resetIndexHiddenWarnings = (): void => {
  warned.clear();
};

/**
 * Hidden-path indexing changes *which files the walker enumerates*, so an index
 * built with it enabled is not interchangeable with one built without it.
 *
 * Declaring it as an analysis feature makes the toggle part of the index
 * identity, so flipping it forces the full rebuild the new scope requires.
 * Both directions are covered because `findAnalysisFeatureMismatches` treats a
 * missing key and an extra key as mismatches: enabling it reports
 * `missing:walker.index-hidden` against an index built without it, and
 * disabling it leaves a recorded key this build no longer promises.
 *
 * Without this, `GITNEXUS_INDEX_HIDDEN=1` silently no-ops on an existing index —
 * the walker is never re-run, so the newly in-scope files are never picked up
 * and analyze still reports success.
 */
export const INDEX_HIDDEN_SCOPE_FEATURE: AnalysisFeatureDescriptor = {
  id: 'walker.index-hidden',
  version: 1,
  appliesTo: () => isIndexHiddenEnabled(),
};
