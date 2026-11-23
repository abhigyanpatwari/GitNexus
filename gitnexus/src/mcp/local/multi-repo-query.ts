import { QUERY_CONTENT_MAX_CHARS, QUERY_MAX_REPOSITORIES } from '../tools.js';
import { SYMBOL_IDENTITY_RECOVERY_SUGGESTION } from './query-result-integrity.js';

/** Validate the complete selection before resolution or search. */
export function parseQueryRepositories(value: unknown): string[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > QUERY_MAX_REPOSITORIES) {
    throw new Error(
      `query.repo must contain between 1 and ${QUERY_MAX_REPOSITORIES} repositories.`,
    );
  }
  return value.map((repo) => {
    if (typeof repo !== 'string' || !repo.trim() || repo.trim().startsWith('@')) {
      throw new Error(
        'query.repo entries must be non-empty indexed repository names or paths; group entries are not supported.',
      );
    }
    return repo.trim();
  });
}

type QueryRow = { id: string } & Record<string, unknown>;
type TaggedRow = QueryRow & { _repo: string };
export interface RepositoryQueryResult {
  repo: string;
  name: string;
  result: {
    processes?: QueryRow[];
    process_symbols?: (QueryRow & { process_id: string })[];
    definitions?: QueryRow[];
    error?: string;
    recoverySuggestion?: string;
    partial?: boolean;
    [key: string]: unknown;
  };
}

const key = (...parts: string[]): string => JSON.stringify(parts);
const compare = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** Merge local ranks, keeping native IDs usable for scalar context follow-ups. */
export function mergeRepositoryQueries(
  members: readonly RepositoryQueryResult[],
  options: { limit: number; maxSymbols: number; includeContent: boolean },
) {
  const repos = members.map((member) => member.repo).sort(compare);
  const per_repo = members
    .map(({ repo, name, result }) => {
      const { processes = [], process_symbols = [], definitions = [], ...metadata } = result;
      return {
        ...metadata,
        repo,
        name,
        status: result.error !== undefined ? ('error' as const) : ('ok' as const),
        candidates: { processes: processes.length, definitions: definitions.length },
        returned: { processes: 0, process_symbols: 0, definitions: 0 },
      };
    })
    .sort((a, b) => compare(a.repo, b.repo));
  const corrupt = members.find(
    ({ result }) =>
      result.error !== undefined &&
      result.recoverySuggestion === SYMBOL_IDENTITY_RECOVERY_SUGGESTION,
  );
  if (corrupt) {
    return {
      error: corrupt.result.error,
      recoverySuggestion: SYMBOL_IDENTITY_RECOVERY_SUGGESTION,
      repos,
      per_repo,
      partial: true,
    };
  }
  const successful = members.filter(({ result }) => result.error === undefined);
  if (successful.length === 0) {
    return { error: 'Search failed in every selected repository.', repos, per_repo, partial: true };
  }

  const withoutPreview = (row: QueryRow): QueryRow => {
    const { content: _content, content_truncated: _truncated, ...rest } = row;
    return rest;
  };
  const ranked = (section: 'processes' | 'definitions'): TaggedRow[] => {
    const seen = new Set<string>();
    return successful
      .flatMap(({ repo, result }) =>
        (result[section] ?? []).map((row, index) => ({
          ...withoutPreview(row),
          _repo: repo,
          _rrf_score: 1 / (61 + index),
        })),
      )
      .sort(
        (a, b) => b._rrf_score - a._rrf_score || compare(a._repo, b._repo) || compare(a.id, b.id),
      )
      .filter((row) => {
        const id = key(row._repo, row.id);
        if (seen.has(id)) return false;
        seen.add(id);
        return true;
      });
  };
  const processes = ranked('processes').slice(0, options.limit);
  const definitions = ranked('definitions').slice(0, 20);
  const attachments = new Map<
    string,
    NonNullable<RepositoryQueryResult['result']['process_symbols']>
  >();
  const previews = new Map<string, { content: string; truncated: boolean }>();
  for (const { repo, result } of successful) {
    for (const row of result.process_symbols ?? []) {
      const process = key(repo, row.process_id);
      const rows = attachments.get(process) ?? [];
      rows.push(row);
      attachments.set(process, rows);
    }
    for (const row of [...(result.process_symbols ?? []), ...(result.definitions ?? [])]) {
      const id = key(repo, row.id);
      if (typeof row.content === 'string' && !previews.has(id)) {
        previews.set(id, { content: row.content, truncated: row.content_truncated === true });
      }
    }
  }
  const process_symbols: TaggedRow[] = [];
  for (const process of processes) {
    const seen = new Set<string>();
    let count = 0;
    for (const row of attachments.get(key(process._repo, process.id)) ?? []) {
      if (seen.has(row.id)) continue;
      if (count === options.maxSymbols) break;
      seen.add(row.id);
      process_symbols.push({ ...withoutPreview(row), _repo: process._repo });
      count++;
    }
    process.symbol_count = count;
  }

  if (options.includeContent) {
    const firstRows = new Map<string, TaggedRow>();
    for (const row of [...process_symbols, ...definitions]) {
      const id = key(row._repo, row.id);
      if (!firstRows.has(id)) firstRows.set(id, row);
    }
    const budget = Math.floor(QUERY_CONTENT_MAX_CHARS / Math.max(1, firstRows.size));
    for (const [id, row] of firstRows) {
      const preview = previews.get(id);
      if (!preview) continue;
      let content = preview.content.slice(0, budget);
      // A preview boundary must not split a UTF-16 surrogate pair.
      if (/[\uD800-\uDBFF]$/u.test(content)) content = content.slice(0, -1);
      if (content.length > 0) row.content = content;
      if (preview.truncated || content.length < preview.content.length)
        row.content_truncated = true;
    }
  }
  const counts = new Map(per_repo.map((entry) => [entry.repo, entry.returned]));
  for (const row of processes) counts.get(row._repo)!.processes++;
  for (const row of process_symbols) counts.get(row._repo)!.process_symbols++;
  for (const row of definitions) counts.get(row._repo)!.definitions++;
  return {
    repos,
    processes,
    process_symbols,
    definitions,
    per_repo,
    partial: members.some(
      ({ result }) =>
        result.error !== undefined ||
        result.partial === true ||
        (typeof result.warning === 'string' && result.warning.length > 0),
    ),
  };
}
