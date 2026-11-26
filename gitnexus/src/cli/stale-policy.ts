/**
 * `--stale-policy` for the index-reading tool commands (#3127).
 *
 * The backend attaches a `staleness` field to hot-read tool results (#2655),
 * naming the index ref it answered from (#3291). This decides what the CLI does
 * with that field once `callTool` has returned:
 *
 * - `warn` (default): nothing. The result is printed byte-for-byte as before.
 * - `ignore`: a stale payload loses its `hint`; `status` and the ref fields
 *   stay, so a script can still read which index answered.
 * - `error`: the result is printed unchanged, then a one-line reason goes to
 *   stderr and the exit code is 1, the same way `output()` fails on `error` and
 *   `partial` payloads.
 *
 * Only `behind` and `diverged` count as stale. `current` and `unknown` (e.g. an
 * index built with `--skip-git`, or a git probe that failed) pass through under
 * every policy: a freshness check that could not answer must not fail the
 * command (fail-open, as in #2655).
 *
 * Some results carry no `staleness` field: `check`, `detect_changes` and
 * `trace` never get one from the backend, and neither does a raw-row `cypher`
 * result. Under `error` only, {@link applyStalePolicyProbed} then runs the same
 * git check the backend uses for the hot read tools, without changing what is
 * printed. `warn` and `ignore` spawn nothing.
 *
 * Nothing here re-indexes, and the MCP tools never see this policy.
 */
import { checkStalenessAsync } from '../core/git-staleness.js';
import { stalenessPayload } from '../core/staleness-status.js';
import { t } from './i18n/index.js';
import { DEFAULT_STALE_POLICY, type StalePolicy } from './stale-policy-choices.js';

interface StalenessField {
  status?: unknown;
  commitsBehind?: unknown;
  hint?: unknown;
  [key: string]: unknown;
}

function stalenessOf(result: unknown): StalenessField | undefined {
  if (result === null || typeof result !== 'object' || Array.isArray(result)) return undefined;
  const staleness = (result as { staleness?: unknown }).staleness;
  if (staleness === null || typeof staleness !== 'object' || Array.isArray(staleness)) {
    return undefined;
  }
  return staleness as StalenessField;
}

function isStale(staleness: StalenessField): boolean {
  return staleness.status === 'behind' || staleness.status === 'diverged';
}

/** The verdict of {@link applyStalePolicy}: the result to print, and why to fail if it should. */
export interface StalePolicyOutcome<T> {
  result: T;
  /** Set only under `error` for a stale index. */
  failure?: { commitsBehind?: number };
}

export function applyStalePolicy<T>(
  result: T,
  policy: StalePolicy = DEFAULT_STALE_POLICY,
): StalePolicyOutcome<T> {
  if (policy === 'warn') return { result };
  if (
    result &&
    typeof result === 'object' &&
    'per_repo' in result &&
    Array.isArray(result.per_repo)
  ) {
    const { per_repo: members, ...envelope } = result;
    const top = applyStalePolicy(envelope, policy);
    const outcomes = members.map((member: unknown) => applyStalePolicy(member, policy));
    if (policy === 'error') {
      const failure = top.failure ?? outcomes.find((entry) => entry.failure)?.failure;
      return failure ? { result, failure } : { result };
    }
    return { result: { ...top.result, per_repo: outcomes.map((entry) => entry.result) } as T };
  }
  const staleness = stalenessOf(result);
  if (!staleness || !isStale(staleness)) return { result };

  if (policy === 'ignore') {
    if (!('hint' in staleness)) return { result };
    const { hint: _hint, ...rest } = staleness;
    return { result: { ...(result as object), staleness: rest } as T };
  }

  const behind =
    staleness.status === 'behind' &&
    typeof staleness.commitsBehind === 'number' &&
    staleness.commitsBehind > 0
      ? staleness.commitsBehind
      : undefined;
  return { result, failure: behind === undefined ? {} : { commitsBehind: behind } };
}

/** The index a tool result came from, as the backend resolves it. */
export interface IndexedRepo {
  repoPath: string;
  lastCommit: string;
}

function needsProbe(result: unknown): boolean {
  if (result === null || typeof result !== 'object') return false;
  if (Array.isArray(result)) return true;
  const fields = result as {
    staleness?: unknown;
    error?: unknown;
    partial?: unknown;
    per_repo?: unknown;
  };
  // An error payload already fails the command; a payload that states its
  // freshness was judged by `applyStalePolicy`.
  return (
    !Array.isArray(fields.per_repo) &&
    fields.staleness === undefined &&
    fields.error === undefined &&
    fields.partial !== true
  );
}

/**
 * {@link applyStalePolicy}, plus a git check under `error` for a result that
 * does not say how fresh its index is. `locate` resolves the repository the
 * same way the tool call did. Any failure to locate or measure leaves the
 * outcome as it was (fail-open).
 */
export async function applyStalePolicyProbed<T>(
  result: T,
  policy: StalePolicy = DEFAULT_STALE_POLICY,
  locate: () => Promise<IndexedRepo>,
): Promise<StalePolicyOutcome<T>> {
  const outcome = applyStalePolicy(result, policy);
  if (policy !== 'error' || !needsProbe(result)) return outcome;
  try {
    const repo = await locate();
    if (!repo.lastCommit) return outcome;
    const staleness = stalenessPayload(await checkStalenessAsync(repo.repoPath, repo.lastCommit));
    const { failure } = applyStalePolicy({ staleness }, 'error');
    return failure ? { result, failure } : outcome;
  } catch {
    return outcome;
  }
}

/**
 * Call after the result is printed: under `error`, write the reason to stderr
 * and fail the command. A no-op for every other outcome.
 *
 * A plain write, not `cliError`: that also tees a structured logger record onto
 * stderr, and a script reading the reason expects exactly one line.
 */
export function reportStalePolicy(outcome: StalePolicyOutcome<unknown>): void {
  if (!outcome.failure) return;
  const { commitsBehind } = outcome.failure;
  const reason =
    commitsBehind !== undefined
      ? t('tool.stalePolicy.behind', { commits: commitsBehind })
      : t('tool.stalePolicy.diverged');
  process.stderr.write(reason + '\n');
  process.exitCode = 1;
}
