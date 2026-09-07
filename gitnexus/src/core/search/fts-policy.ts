import type { RepoMeta } from '../../storage/repo-meta.js';

export type FtsDisabledReason = 'disabled-by-flag' | 'disabled-by-env';
export type FtsSkipReason = FtsDisabledReason | 'extension-unavailable' | 'build-failed';

export function resolveFtsDisableReason(
  skipFts?: boolean,
  envValue = process.env.GITNEXUS_SKIP_FTS,
): FtsDisabledReason | undefined {
  if (skipFts === true) return 'disabled-by-flag';
  if (envValue === '1') return 'disabled-by-env';
  return undefined;
}

export function getFtsDisabledReason(
  capability: NonNullable<RepoMeta['capabilities']>['fts'] | undefined,
): FtsDisabledReason | undefined {
  if (capability?.status !== 'unavailable') return undefined;
  const reason = capability.skipReason;
  return reason === 'disabled-by-flag' || reason === 'disabled-by-env' ? reason : undefined;
}

export const FTS_DISABLED_MESSAGE =
  'FTS disabled for this index. To enable keyword search, run gitnexus analyze ' +
  'without --skip-fts and with GITNEXUS_SKIP_FTS unset.';
