import type { KnowledgeGraph } from './graph/types.js';
import type { ContentRetention, FtsProfile, RepoMeta } from '../storage/repo-meta.js';

export const CONTENT_RETENTION_ENV = 'GITNEXUS_CONTENT_RETENTION';

export const contentRetentionFromEnvironment = (): ContentRetention => {
  const raw = process.env[CONTENT_RETENTION_ENV];
  if (raw === undefined || raw.trim() === '') return 'full';
  const value = raw.trim();
  if (value === 'full' || value === 'symbol' || value === 'none') return value;
  throw new Error(
    `Invalid ${CONTENT_RETENTION_ENV} "${raw}". Expected one of: full, symbol, none.`,
  );
};

export const contentRetentionFromMeta = (
  meta: Pick<RepoMeta, 'contentRetention'> | null | undefined,
): ContentRetention => {
  const retention = meta?.contentRetention;
  if (retention === undefined || retention === 'full') return 'full';
  if (retention === 'symbol' || retention === 'none') return retention;
  // Legacy metadata has no field; an explicit unknown value is corrupt and must not expose text.
  return 'none';
};

export const ftsProfileForContentRetention = (retention: ContentRetention): FtsProfile => {
  switch (retention) {
    case 'symbol':
      return 'symbol-no-file-content';
    case 'none':
      return 'name-only';
    default:
      return 'full';
  }
};

/**
 * Legacy metadata predates retention fields and is therefore semantically full.
 * It remains incrementally readable under the default profile; explicit newer
 * stamps must match exactly because an FTS/layout change requires a fresh DB.
 */
export const contentRetentionMismatch = (
  meta: Pick<RepoMeta, 'contentRetention' | 'contentRetentionSchemaVersion' | 'ftsProfile'>,
  requested: ContentRetention,
): boolean => {
  if (meta.contentRetention === undefined) return requested !== 'full';
  return (
    meta.contentRetention !== requested ||
    meta.contentRetentionSchemaVersion !== 1 ||
    meta.ftsProfile !== ftsProfileForContentRetention(requested)
  );
};

/** Remove text that the active index profile is not allowed to persist. */
export const applyContentRetention = (graph: KnowledgeGraph, retention: ContentRetention): void => {
  if (retention === 'full') return;

  graph.forEachNode((node) => {
    if (retention === 'symbol') {
      if (node.label === 'File') delete node.properties.content;
      // BasicBlocks hold statement source, not a symbol snippet.
      if (node.label === 'BasicBlock') delete node.properties.text;
      return;
    }

    delete node.properties.content;

    delete node.properties.description;
    if (node.label === 'BasicBlock') delete node.properties.text;
  });
};
