export interface ScopeExtractionFailureSummary {
  /** Exact number of unique files whose scope extraction failed. */
  readonly total: number;
  /** Deterministic sample of repo-relative paths for diagnostics. */
  readonly paths: readonly string[];
  /** True when `paths` is a capped sample rather than the full set. */
  readonly truncated?: boolean;
}

export const SCOPE_EXTRACTION_FAILURE_PATH_LIMIT = 25;

/** Read a persisted summary without trusting its runtime JSON shape. */
export function scopeExtractionFailureTotal(summary: unknown): number | undefined {
  if (summary === undefined) return 0;
  if (typeof summary !== 'object' || summary === null) return undefined;
  const total = (summary as { total?: unknown }).total;
  if (total === 0) return 0;
  return typeof total === 'number' && Number.isInteger(total) && total > 0 ? total : undefined;
}

/** Replace provisional worker failures with the final fallback outcome. */
export function reconcileScopeExtractionFailures(
  failures: Set<string>,
  attemptedPaths: readonly string[],
  failedPaths: readonly string[],
): void {
  const stillFailed = new Set(failedPaths);
  for (const filePath of attemptedPaths) {
    if (stillFailed.has(filePath)) failures.add(filePath);
    else failures.delete(filePath);
  }
}

export function summarizeScopeExtractionFailures(
  paths: readonly string[] = [],
  limit: number = SCOPE_EXTRACTION_FAILURE_PATH_LIMIT,
): ScopeExtractionFailureSummary | undefined {
  const unique = [
    ...new Set(paths.filter((path): path is string => typeof path === 'string' && path.length > 0)),
  ].sort();
  if (unique.length === 0) return undefined;
  const boundedLimit =
    Number.isInteger(limit) && limit >= 0 ? limit : SCOPE_EXTRACTION_FAILURE_PATH_LIMIT;
  return {
    total: unique.length,
    paths: unique.slice(0, boundedLimit),
    ...(unique.length > boundedLimit ? { truncated: true } : {}),
  };
}
