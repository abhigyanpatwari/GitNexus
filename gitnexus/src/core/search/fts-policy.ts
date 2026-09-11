import type { RepoMeta } from '../../storage/repo-meta.js';

export type FtsDisabledReason = 'disabled-by-flag' | 'disabled-by-env';
export type FtsSkipReason = FtsDisabledReason | 'extension-unavailable' | 'build-failed';

type RepoCapabilities = NonNullable<RepoMeta['capabilities']>;

export const DEFAULT_GRAPH_CAPABILITY: RepoCapabilities['graph'] = {
  provider: 'ladybugdb',
  status: 'available',
};

export const DEFAULT_VECTOR_SEARCH_CAPABILITY: RepoCapabilities['vectorSearch'] = {
  provider: 'exact-scan',
  status: 'unavailable',
  exactScanLimit: 0,
};

export function resolveFtsDisableReason(
  skipFts?: boolean,
  envValue = process.env.GITNEXUS_SKIP_FTS,
): FtsDisabledReason | undefined {
  if (skipFts === true) return 'disabled-by-flag';
  if (envValue === '1') return 'disabled-by-env';
  return undefined;
}

export function isExplicitFtsDisablement(reason: string | undefined): reason is FtsDisabledReason {
  return reason === 'disabled-by-flag' || reason === 'disabled-by-env';
}

export function getFtsDisabledReason(
  capability: RepoCapabilities['fts'] | undefined,
): FtsDisabledReason | undefined {
  if (capability?.status !== 'unavailable') return undefined;
  return isExplicitFtsDisablement(capability.skipReason) ? capability.skipReason : undefined;
}

/**
 * Overlay an explicit FTS opt-out onto an existing meta snapshot without
 * touching freshness (`indexedAt` / `lastCommit`) or sibling capabilities.
 * Flag and env are equivalent disablements; only the discriminator changes.
 * Returns `meta` unchanged when `reason` is absent (re-enable) or already stamped.
 */
export function withExplicitFtsDisablement(
  meta: RepoMeta,
  reason: FtsDisabledReason | undefined,
): RepoMeta {
  if (!reason) return meta;
  const existing = meta.capabilities;
  const existingFts = existing?.fts;
  if (
    existingFts?.status === 'unavailable' &&
    existingFts.skipReason === reason &&
    existing?.graph &&
    existing.vectorSearch
  ) {
    return meta;
  }
  return {
    ...meta,
    capabilities: {
      graph: existing?.graph ?? DEFAULT_GRAPH_CAPABILITY,
      fts: {
        provider: existingFts?.provider ?? 'ladybugdb-fts',
        status: 'unavailable',
        skipReason: reason,
      },
      vectorSearch: existing?.vectorSearch ?? DEFAULT_VECTOR_SEARCH_CAPABILITY,
    },
  };
}

export const FTS_DISABLED_MESSAGE =
  'FTS disabled for this index. To enable keyword search, run gitnexus analyze ' +
  'without --skip-fts and with GITNEXUS_SKIP_FTS unset.';
