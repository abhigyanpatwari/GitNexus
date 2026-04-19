/**
 * Bounded query expansion and lightweight reranking for code search.
 *
 * This intentionally avoids project-specific synonym lists. The expansion is
 * based on stable code-search signals: identifier splitting, route/path tokens,
 * short context terms, and a small generic programming vocabulary.
 */

const MAX_QUERY_LENGTH = 260;
const DEFAULT_MAX_BM25_QUERIES = 4;
const DEFAULT_MAX_SEMANTIC_QUERIES = 2;

const STOP_WORDS = new Set([
  'a',
  'an',
  'and',
  'are',
  'as',
  'at',
  'be',
  'by',
  'for',
  'from',
  'how',
  'in',
  'into',
  'is',
  'it',
  'of',
  'on',
  'or',
  'that',
  'the',
  'this',
  'to',
  'with',
  'where',
  'why',
]);

const SHORT_CODE_TERMS = new Set(['ai', 'api', 'db', 'fk', 'id', 'ui']);

const GENERIC_CODE_EXPANSIONS = new Map<string, string[]>([
  ['admin', ['auth', 'middleware', 'protected']],
  ['api', ['route', 'endpoint', 'handler']],
  ['auth', ['authentication', 'authorization', 'middleware', 'guard']],
  ['config', ['configuration', 'env', 'environment', 'validate']],
  ['database', ['db', 'schema', 'migration', 'table']],
  ['dispatch', ['job', 'queue', 'worker', 'schedule']],
  ['embedding', ['vector', 'semantic', 'search']],
  ['env', ['environment', 'config', 'configuration']],
  ['event', ['analytics', 'envelope', 'telemetry']],
  ['job', ['queue', 'worker', 'schedule']],
  ['migration', ['schema', 'database', 'drizzle']],
  ['queue', ['job', 'worker', 'schedule']],
  ['redirect', ['link', 'token', 'hmac']],
  ['route', ['api', 'endpoint', 'handler']],
  ['schema', ['database', 'migration', 'table']],
  ['session', ['anonymous', 'cookie', 'identity']],
  ['test', ['spec', 'mock', 'fixture']],
  ['worker', ['job', 'queue', 'dispatch']],
]);

export interface QueryVariant {
  query: string;
  kind: string;
  weight: number;
  semanticEligible: boolean;
}

export interface QueryPlan {
  primary: string;
  tokens: string[];
  bm25Queries: QueryVariant[];
  semanticQueries: QueryVariant[];
}

export interface RankedResultSet<T> {
  source: string;
  weight?: number;
  results: T[];
}

export interface CombinedRankedResult<T> {
  key: string;
  score: number;
  data: T;
  sources: string[];
}

const normalizeWhitespace = (value: string): string => value.trim().replace(/\s+/g, ' ');

const splitIdentifiers = (value: string): string =>
  normalizeWhitespace(
    value
      .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
      .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
      .replace(/[._:/\\-]+/g, ' ')
      .replace(/[^A-Za-z0-9\s]/g, ' '),
  );

const tokenize = (value: string): string[] => {
  const tokens = splitIdentifiers(value)
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .filter((token) => (token.length >= 3 || SHORT_CODE_TERMS.has(token)) && !STOP_WORDS.has(token));

  return [...new Set(tokens)];
};

const weightedTerms = (...texts: Array<string | undefined>): string[] => {
  const counts = new Map<string, number>();
  for (const text of texts.filter(Boolean) as string[]) {
    for (const token of tokenize(text)) {
      counts.set(token, (counts.get(token) ?? 0) + 1);
    }
  }

  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([token]) => token);
};

const clipQuery = (value: string): string =>
  normalizeWhitespace(value).slice(0, MAX_QUERY_LENGTH).trim();

const addVariant = (
  variants: QueryVariant[],
  seen: Set<string>,
  query: string,
  kind: string,
  weight: number,
  semanticEligible = false,
): void => {
  const clipped = clipQuery(query);
  if (!clipped) return;

  const key = clipped.toLowerCase();
  if (seen.has(key)) return;

  seen.add(key);
  variants.push({ query: clipped, kind, weight, semanticEligible });
};

export const buildQueryPlan = (
  input: { query: string; goal?: string; taskContext?: string },
  options: { maxBm25Queries?: number; maxSemanticQueries?: number } = {},
): QueryPlan => {
  const primary = clipQuery(input.query);
  const maxBm25Queries = options.maxBm25Queries ?? DEFAULT_MAX_BM25_QUERIES;
  const maxSemanticQueries = options.maxSemanticQueries ?? DEFAULT_MAX_SEMANTIC_QUERIES;
  const variants: QueryVariant[] = [];
  const seen = new Set<string>();

  addVariant(variants, seen, primary, 'primary', 1, true);

  const identifierText = splitIdentifiers(primary);
  if (identifierText.toLowerCase() !== primary.toLowerCase()) {
    addVariant(variants, seen, identifierText, 'identifier', 0.9, true);
  }

  const primaryTerms = tokenize(primary);
  const expansionTerms: string[] = [];
  for (const term of primaryTerms) {
    const expansions = GENERIC_CODE_EXPANSIONS.get(term);
    if (expansions) expansionTerms.push(...expansions);
  }

  if (expansionTerms.length > 0) {
    const bounded = [...new Set([...primaryTerms, ...expansionTerms])].slice(0, 14);
    addVariant(variants, seen, `${primary} ${bounded.join(' ')}`, 'generic-code', 0.7, false);
  }

  const contextTerms = weightedTerms(input.goal, input.taskContext).filter(
    (term) => !primaryTerms.includes(term),
  );
  if (contextTerms.length > 0) {
    addVariant(variants, seen, `${primary} ${contextTerms.slice(0, 8).join(' ')}`, 'context', 0.55);
  }

  const bm25Queries = variants.slice(0, maxBm25Queries);
  const semanticQueries = variants
    .filter((variant) => variant.semanticEligible)
    .slice(0, maxSemanticQueries);

  return {
    primary,
    tokens: weightedTerms(primary, input.goal, input.taskContext).slice(0, 24),
    bm25Queries,
    semanticQueries: semanticQueries.length > 0 ? semanticQueries : bm25Queries.slice(0, 1),
  };
};

const mergeResultData = <T extends Record<string, any>>(existing: T, incoming: T): T => {
  const merged = { ...existing };
  for (const [key, value] of Object.entries(incoming)) {
    if (value !== undefined && value !== null && value !== '') {
      (merged as any)[key] = (merged as any)[key] ?? value;
    }
  }
  return merged;
};

const textForResult = (result: Record<string, any>): Record<string, string> => ({
  name: splitIdentifiers(String(result.name ?? '')),
  filePath: splitIdentifiers(String(result.filePath ?? '')),
  type: splitIdentifiers(String(result.type ?? result.label ?? '')),
  nodeId: splitIdentifiers(String(result.nodeId ?? result.id ?? '')),
});

const countMatches = (text: string, tokens: string[]): number => {
  if (!text) return 0;
  const tokenSet = new Set(tokenize(text));
  return tokens.reduce((count, token) => count + (tokenSet.has(token) ? 1 : 0), 0);
};

const relevanceBoost = (result: Record<string, any>, queryPlan: QueryPlan): number => {
  const tokens = queryPlan.tokens.slice(0, 14);
  if (tokens.length === 0) return 0;

  const text = textForResult(result);
  const nameHits = countMatches(text.name, tokens);
  const pathHits = countMatches(text.filePath, tokens);
  const typeHits = countMatches(text.type, tokens);
  const idHits = countMatches(text.nodeId, tokens);
  const normalizedPrimary = splitIdentifiers(queryPlan.primary).toLowerCase();
  const combined = `${text.name} ${text.filePath} ${text.nodeId}`.toLowerCase();
  const phraseBoost =
    normalizedPrimary.length >= 8 && combined.includes(normalizedPrimary) ? 0.025 : 0;

  return (
    Math.min(nameHits * 0.012, 0.06) +
    Math.min(pathHits * 0.006, 0.04) +
    Math.min(typeHits * 0.004, 0.012) +
    Math.min(idHits * 0.003, 0.018) +
    phraseBoost
  );
};

export const combineRankedResults = <T extends Record<string, any>>(
  resultSets: Array<RankedResultSet<T>>,
  limit: number,
  queryPlan: QueryPlan,
  options: {
    rrfK?: number;
    keyFn?: (result: T) => string | undefined;
  } = {},
): Array<CombinedRankedResult<T>> => {
  const rrfK = options.rrfK ?? 60;
  const keyFn =
    options.keyFn ?? ((result: T) => result.nodeId ?? result.id ?? result.filePath ?? result.name);
  const merged = new Map<string, { score: number; data: T; sources: Set<string> }>();

  for (const resultSet of resultSets) {
    const source = resultSet.source;
    const weight = resultSet.weight ?? 1;
    const results = resultSet.results ?? [];

    for (let i = 0; i < results.length; i++) {
      const result = results[i];
      const key = keyFn(result);
      if (!key) continue;

      const rrfScore = weight / (rrfK + i + 1);
      const existing = merged.get(key);
      if (existing) {
        existing.score += rrfScore;
        existing.data = mergeResultData(existing.data, result);
        existing.sources.add(source);
      } else {
        merged.set(key, {
          score: rrfScore,
          data: { ...result },
          sources: new Set([source]),
        });
      }
    }
  }

  return [...merged.entries()]
    .map(([key, item]) => ({
      key,
      score: item.score + relevanceBoost(item.data, queryPlan),
      data: item.data,
      sources: [...item.sources],
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
};
