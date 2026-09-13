import type { RepoMeta } from '../../storage/repo-meta.js';

export type FtsDisabledReason = 'disabled-by-flag' | 'disabled-by-env';

/** Failure-like skip reasons. Must not join `FtsDisabledReason` — that
 *  predicate is a hand-written `string` check the compiler does not verify. */
export type FtsFailureSkipReason =
  | 'extension-unavailable'
  | 'build-failed'
  | 'native-abort'
  | 'tuple-missing';

export type FtsSkipReason = FtsDisabledReason | FtsFailureSkipReason;

/** Runtime list for storage/core parity tests. Order is not significant. */
export const FTS_SKIP_REASONS: readonly FtsSkipReason[] = [
  'disabled-by-flag',
  'disabled-by-env',
  'extension-unavailable',
  'build-failed',
  'native-abort',
  'tuple-missing',
];

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

const FTS_BUILD_FAILED_MESSAGE =
  'Warning: full-text/BM25 search is disabled — the search index build failed this run.\n' +
  '  The FTS extension is available; rerun `gitnexus analyze --repair-fts`. If it persists,\n' +
  '  check the disk for space or corruption. Run `gitnexus doctor` for details.';

const FTS_EXTENSION_UNAVAILABLE_MESSAGE =
  'Warning: full-text/BM25 search is disabled — the LadybugDB FTS extension was unavailable.\n' +
  '  Install it once with network access (GITNEXUS_LBUG_EXTENSION_INSTALL=auto), then run\n' +
  '  `gitnexus analyze --repair-fts` to build the search indexes. Run `gitnexus doctor` for details.';

const FTS_NATIVE_ABORT_MESSAGE =
  'Warning: full-text/BM25 search is disabled — a previous analyze aborted while building the search indexes.\n' +
  '  Rerun `gitnexus analyze` or `gitnexus analyze --repair-fts` to recover. Run `gitnexus doctor` for details.';

const FTS_TUPLE_MISSING_MESSAGE =
  'Warning: full-text/BM25 search is disabled — no packaged FTS artifact is available for this platform.\n' +
  '  Keyword search is unavailable on this host. Run `gitnexus doctor` for details.';

const assertNever = (value: never): never => {
  throw new Error(`unhandled FTS skip reason: ${String(value)}`);
};

/**
 * CLI analyze summary copy for a skipped FTS build. Total switch so a new
 * member cannot silently inherit the network-install remedy.
 */
export const formatAnalyzeFtsSkipSummary = (reason: FtsSkipReason | undefined): string => {
  if (reason === undefined) return FTS_EXTENSION_UNAVAILABLE_MESSAGE;
  switch (reason) {
    case 'disabled-by-flag':
    case 'disabled-by-env':
      return FTS_DISABLED_MESSAGE;
    case 'build-failed':
      return FTS_BUILD_FAILED_MESSAGE;
    case 'native-abort':
      return FTS_NATIVE_ABORT_MESSAGE;
    case 'tuple-missing':
      return FTS_TUPLE_MISSING_MESSAGE;
    case 'extension-unavailable':
      return FTS_EXTENSION_UNAVAILABLE_MESSAGE;
    default:
      return assertNever(reason);
  }
};
