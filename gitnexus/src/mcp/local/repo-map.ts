/**
 * Bounded repository orientation overview (`repo_overview`).
 *
 * This module never executes Cypher itself: the caller injects an executor so
 * the query plan, its row caps and its incompleteness can be unit-tested
 * without a database. Every relationship query is anchored on a bounded seed
 * set (files, communities, processes or symbols). There is deliberately no
 * global unanchored relationship ranking.
 *
 * The result is a SAMPLE. Hubs and integration boundaries are sampled
 * candidates, not globally ranked facts; neighbor selection is performed by
 * the database with no ORDER BY; responsibilities are inferred from sampled
 * CALLS evidence. The response says all of this in both structured metadata
 * and its markdown rendering.
 */

/** Hard limits approved for the overview. These are not tool arguments. */
export const REPO_OVERVIEW_LIMITS = {
  maxFiles: 30,
  maxCommunities: 8,
  maxMembersPerCommunity: 8,
  maxProcesses: 8,
  maxStepsPerProcess: 8,
  initialFileSeedSymbols: 16,
  maxSeedSymbols: 32,
  neighborsPerSeed: 8,
  maxResponsibilities: 8,
} as const;

/**
 * Planned query budget for a cold overview of a non-empty graph. Stats come
 * from the index metadata stamp (zero queries), so the cap is exactly 77.
 * `q3b`, `q4a` and `q4b` are the per-item anchored expansion phases called
 * out in the design review.
 */
export const REPO_OVERVIEW_QUERY_BUDGET = {
  files: 1,
  initialSymbols: 1,
  communities: 1,
  communityMembers: 1,
  processHeaders: 1,
  q3b: REPO_OVERVIEW_LIMITS.maxProcesses,
  q4a: REPO_OVERVIEW_LIMITS.maxSeedSymbols,
  q4b: REPO_OVERVIEW_LIMITS.maxSeedSymbols,
  total: 77,
} as const;

/**
 * The LadybugDB pool exposes eight connections per repo. Independent seed
 * lookups run in batches of that size; larger batches only queue at checkout
 * without reducing wall time.
 */
export const REPO_OVERVIEW_QUERY_CONCURRENCY = 8;

export type RepoOverviewQueryPhase =
  | 'files'
  | 'initialSymbols'
  | 'communities'
  | 'communityMembers'
  | 'processHeaders'
  | 'processSteps'
  | 'outgoingCalls'
  | 'incomingCalls';

export interface RepoOverviewDeps {
  /** One parameterized Cypher query per call; no batch API exists in the pool. */
  executeParameterized: (cypher: string, params: Record<string, unknown>) => Promise<unknown[]>;
}

export interface RepoOverviewRepoInput {
  id?: string;
  name?: string;
  repoPath?: string;
  stats?: {
    files?: number;
    nodes?: number;
    edges?: number;
    communities?: number;
    processes?: number;
  };
}

export type RepoOverviewInput = string | RepoOverviewRepoInput;

export interface ResponsibilityInference {
  kind: 'calls_into' | 'called_from';
  module: string;
  sampledCallCount: number;
  evidence: string[];
  inferred: true;
  basis: 'sampled CALLS edges';
}

export interface ModuleSummary {
  path: string;
  fileCount: number;
  topSymbols: string[];
  language: string;
  /** Distinguishes directory-sample counts from whole-repository counts. */
  sampledFileCount: number;
  languages: string[];
  representativeFiles: string[];
  sampled: true;
}

export interface CommunitySample {
  id: string;
  label: string;
  heuristicLabel: string;
  symbolCount: number;
  cohesion: number;
  sampledMembers: Array<{
    id: string;
    name: string;
    filePath: string;
    label: string;
  }>;
  sampled: true;
}

export interface HubNode {
  id: string;
  name: string;
  filePath: string;
  label: string;
  /** Sampled CALLS degree, never presented as a global centrality ranking. */
  degree: number;
  sampledIncoming: number;
  sampledOutgoing: number;
  module: string;
  ranking: 'sampled-candidates-only';
  responsibilities: ResponsibilityInference[];
}

export interface WorkflowSummary {
  processId: string;
  label: string;
  stepCount: number;
  keySymbols: string[];
  heuristicLabel: string;
  processType: string;
  /** Number of step rows actually read, capped at maxStepsPerProcess. */
  sampledSteps: number;
  stepsTruncated: boolean;
  sampled: true;
}

export interface BoundaryEdge {
  fromModule: string;
  toModule: string;
  callCount: number;
  sampleEvidence: string[];
  inferred: true;
}

interface SampleBound {
  returned: number;
  limit: number;
  total: number | null;
  truncated: boolean | 'unknown';
}

export interface RepoOverviewCompleteness {
  statsSource: 'index-metadata' | 'missing';
  files: SampleBound;
  hubs: SampleBound;
  communities: SampleBound;
  processes: SampleBound;
  seedSymbols: SampleBound;
  communityMembers: SampleBound;
  sampledSteps: SampleBound;
  callNeighbors: SampleBound;
}

export interface RepoOverviewSampling {
  hubsAreGloballyRanked: false;
  integrationBoundariesAreGloballyRanked: false;
  neighborSelectionDeterministic: false;
  responsibilitiesInferred: true;
  relationshipEvidence: 'sampled CALLS edges';
  note: string;
}

export interface RepoOverviewQueryBudgetResult {
  plannedMax: number;
  executed: number;
  phases: Record<RepoOverviewQueryPhase, number>;
  q3b: number;
  q4a: number;
  q4b: number;
}

export interface RepoOverview {
  name: string;
  repoPath: string;
  nodeCount: number;
  edgeCount: number;
  modules: ModuleSummary[];
  architecturalHubs: HubNode[];
  workflows: WorkflowSummary[];
  integrationBoundaries: BoundaryEdge[];
  communities: CommunitySample[];
  stats: {
    files: number | null;
    nodes: number;
    edges: number;
    communities: number | null;
    processes: number | null;
    source: 'index-metadata' | 'missing';
  };
  completeness: RepoOverviewCompleteness;
  warnings: string[];
  sampling: RepoOverviewSampling;
  queryBudget: RepoOverviewQueryBudgetResult;
}

export interface RepoOverviewResult extends RepoOverview {
  markdown: string;
}

/** Query texts are exported so tests can pin anchoring, parameters and caps. */
export const REPO_OVERVIEW_QUERIES = {
  files: `
    MATCH (f:File)
    RETURN f.id AS id, f.name AS name, f.filePath AS filePath
    ORDER BY f.filePath ASC, f.id ASC
    LIMIT $limit
  `,
  initialSymbols: `
    MATCH (f:File)-[r:CodeRelation {type: 'DEFINES'}]->(s)
    WHERE f.id IN $fileIds
    RETURN s.id AS id, s.name AS name, s.filePath AS filePath,
           labels(s) AS label, f.id AS fileId
    LIMIT $limit
  `,
  communities: `
    MATCH (c:Community)
    RETURN c.id AS id, c.label AS label, c.heuristicLabel AS heuristicLabel,
           c.symbolCount AS symbolCount, c.cohesion AS cohesion
    ORDER BY c.symbolCount DESC, c.id ASC
    LIMIT $limit
  `,
  communityMembers: `
    MATCH (s)-[:CodeRelation {type: 'MEMBER_OF'}]->(c:Community)
    WHERE c.id IN $communityIds
    RETURN c.id AS communityId, s.id AS id, s.name AS name,
           s.filePath AS filePath, labels(s) AS label
    LIMIT $limit
  `,
  processHeaders: `
    MATCH (p:Process)
    RETURN p.id AS id, p.label AS label, p.heuristicLabel AS heuristicLabel,
           p.stepCount AS stepCount, p.processType AS processType
    ORDER BY p.stepCount DESC, p.id ASC
    LIMIT $limit
  `,
  processSteps: `
    MATCH (s)-[r:CodeRelation {type: 'STEP_IN_PROCESS'}]->(p:Process {id: $processId})
    RETURN s.id AS id, s.name AS name, s.filePath AS filePath, r.step AS step, labels(s) AS label
    ORDER BY step ASC, s.id ASC
    LIMIT $limit
  `,
  outgoingCalls: `
    MATCH (s {id: $seedId})-[r:CodeRelation {type: 'CALLS'}]->(n)
    RETURN n.id AS id, n.name AS name, n.filePath AS filePath, labels(n) AS label
    LIMIT $limit
  `,
  incomingCalls: `
    MATCH (n)-[r:CodeRelation {type: 'CALLS'}]->(s {id: $seedId})
    RETURN n.id AS id, n.name AS name, n.filePath AS filePath, labels(n) AS label
    LIMIT $limit
  `,
} as const;

export type RepoOverviewCallDirection = 'outgoing' | 'incoming';

/**
 * Build a label-anchored CALLS lookup. LadybugDB stores each label as its own
 * node table with `id` as the primary key, so `MATCH (s:\`Function\` {id: …})`
 * takes the primary-key index while the unlabeled form scans every node table.
 * Labels come from `labels(node)` in earlier bounded samples; anything that is
 * not a plain identifier falls back to the original unlabeled query.
 */
export function repoOverviewCallQuery(direction: RepoOverviewCallDirection, label: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(label)) {
    return direction === 'outgoing'
      ? REPO_OVERVIEW_QUERIES.outgoingCalls
      : REPO_OVERVIEW_QUERIES.incomingCalls;
  }
  return direction === 'outgoing'
    ? `MATCH (s:\`${label}\` {id: $seedId})-[r:CodeRelation {type: 'CALLS'}]->(n)
       RETURN n.id AS id, n.name AS name, n.filePath AS filePath, labels(n) AS label
       LIMIT $limit`
    : `MATCH (n)-[r:CodeRelation {type: 'CALLS'}]->(s:\`${label}\` {id: $seedId})
       RETURN n.id AS id, n.name AS name, n.filePath AS filePath, labels(n) AS label
       LIMIT $limit`;
}

type Row = Record<string, unknown> | unknown[];

interface FileSeed {
  id: string;
  name: string;
  filePath: string;
  module: string;
  language: string;
}

interface SymbolSeed {
  id: string;
  name: string;
  filePath: string;
  label: string;
  module: string;
}

interface CallEdge {
  fromId: string;
  fromName: string;
  fromModule: string;
  toId: string;
  toName: string;
  toModule: string;
}

interface PhaseCounts {
  files: number;
  initialSymbols: number;
  communities: number;
  communityMembers: number;
  processHeaders: number;
  processSteps: number;
  outgoingCalls: number;
  incomingCalls: number;
}

const LANGUAGE_BY_EXTENSION: Record<string, string> = {
  ts: 'TypeScript',
  tsx: 'TypeScript',
  js: 'JavaScript',
  jsx: 'JavaScript',
  mjs: 'JavaScript',
  cjs: 'JavaScript',
  py: 'Python',
  go: 'Go',
  rs: 'Rust',
  java: 'Java',
  kt: 'Kotlin',
  kts: 'Kotlin',
  swift: 'Swift',
  c: 'C',
  h: 'C',
  cc: 'C++',
  cpp: 'C++',
  cxx: 'C++',
  hpp: 'C++',
  cs: 'C#',
  rb: 'Ruby',
  php: 'PHP',
  dart: 'Dart',
  proto: 'Proto',
  zig: 'Zig',
  sh: 'Shell',
  vue: 'Vue',
  svelte: 'Svelte',
};

function cell(row: Row, key: string, index: number): unknown {
  if (!Array.isArray(row)) {
    const value = (row as Record<string, unknown>)[key];
    if (value !== undefined) return value;
    return undefined;
  }
  return row[index];
}

function str(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return '';
}

function num(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

function labelOf(value: unknown): string {
  if (Array.isArray(value)) return str(value[0]);
  return str(value);
}

function normalizePath(filePath: string): string {
  return filePath.replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\/+/, '');
}

/** First meaningful directory prefix, used only as a sampling bucket. */
export function moduleFromPath(filePath: string): string {
  let parts = normalizePath(filePath).split('/').filter(Boolean);
  if (parts.length === 0) return '(root)';
  // The final segment is a file name, not a module directory.
  if (parts[parts.length - 1].includes('.')) parts = parts.slice(0, -1);
  if (parts.length === 0) return '(root)';
  if (parts.length === 1) return parts[0];
  return parts.slice(0, 2).join('/');
}

function languageOf(filePath: string): string {
  const name = normalizePath(filePath).split('/').pop() ?? '';
  const ext = name.includes('.') ? name.split('.').pop()!.toLowerCase() : '';
  return LANGUAGE_BY_EXTENSION[ext] ?? (ext ? ext.toUpperCase() : 'Unknown');
}

function compareNames(a: string, b: string): number {
  return a.localeCompare(b, 'en');
}

function escapeCell(value: string): string {
  return value.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
}

function pushWarning(warnings: string[], warning: string): void {
  if (!warnings.includes(warning)) warnings.push(warning);
}

function sampleBound(returned: number, limit: number, total: number | null): SampleBound {
  return {
    returned,
    limit,
    total,
    truncated: total !== null && total > returned ? true : total === null ? 'unknown' : false,
  };
}

/**
 * Run independent seed lookups with a fixed number of workers. Results are
 * written back by input index, so downstream edge insertion order stays the
 * same as the sequential implementation.
 */
async function mapWithConcurrency<T, R>(
  items: readonly T[],
  concurrency: number,
  work: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (true) {
      const index = next++;
      if (index >= items.length) return;
      results[index] = await work(items[index]);
    }
  });
  await Promise.all(workers);
  return results;
}

function normalizeInput(input: RepoOverviewInput): RepoOverviewRepoInput {
  return typeof input === 'string' ? { id: input, name: input } : input;
}

/**
 * Build a bounded orientation overview from indexed graph samples.
 *
 * Query count for a cold call with full seeds is 77: 1 files + 1 initial
 * symbols + 1 communities + 1 community members + 1 process headers + 8
 * process-step queries + 32 outgoing + 32 incoming. No count queries are
 * issued: node/edge/community/process totals come from the index metadata.
 */
export async function generateRepoOverview(
  input: RepoOverviewInput,
  deps: RepoOverviewDeps,
): Promise<RepoOverview> {
  const repo = normalizeInput(input);
  const warnings: string[] = [];
  const phases: PhaseCounts = {
    files: 0,
    initialSymbols: 0,
    communities: 0,
    communityMembers: 0,
    processHeaders: 0,
    processSteps: 0,
    outgoingCalls: 0,
    incomingCalls: 0,
  };

  const run = async (
    phase: RepoOverviewQueryPhase,
    cypher: string,
    params: Record<string, unknown>,
  ): Promise<Row[]> => {
    phases[phase] += 1;
    try {
      const rows = await deps.executeParameterized(cypher, params);
      return Array.isArray(rows) ? (rows as Row[]) : [];
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      pushWarning(warnings, `${phase} query failed; its sample is incomplete: ${message}`);
      return [];
    }
  };

  const stats = repo.stats;
  const statsSource: 'index-metadata' | 'missing' = stats ? 'index-metadata' : 'missing';
  if (!stats) {
    pushWarning(
      warnings,
      'Index metadata statistics are unavailable; totals are reported as 0/unknown, not inferred from the bounded sample.',
    );
  }

  // Q1 — path-ordered file sample. This is a bounded node sample, not a global
  // relationship scan; its purpose is directory/module bucket detection.
  const fileRows = await run('files', REPO_OVERVIEW_QUERIES.files, {
    limit: REPO_OVERVIEW_LIMITS.maxFiles,
  });
  const files: FileSeed[] = [];
  const seenFiles = new Set<string>();
  for (const row of fileRows) {
    const filePath = str(cell(row, 'filePath', 2));
    const id = str(cell(row, 'id', 0)) || filePath;
    if (!filePath || seenFiles.has(id || filePath)) continue;
    seenFiles.add(id || filePath);
    files.push({
      id,
      filePath,
      name: str(cell(row, 'name', 1)) || normalizePath(filePath).split('/').pop() || filePath,
      module: moduleFromPath(filePath),
      language: languageOf(filePath),
    });
  }
  const fileIds = files.map((f) => f.id).filter(Boolean);

  // Q2 — symbols defined by the sampled files. Anchored on explicit file ids.
  let initialSymbolRows: Row[] = [];
  if (fileIds.length > 0) {
    initialSymbolRows = await run('initialSymbols', REPO_OVERVIEW_QUERIES.initialSymbols, {
      fileIds,
      limit: REPO_OVERVIEW_LIMITS.initialFileSeedSymbols,
    });
  }

  // Q3a — precomputed community sample. Community nodes are cheap metadata;
  // the expensive per-member relationship expansion is separate and bounded.
  const communityRows = await run('communities', REPO_OVERVIEW_QUERIES.communities, {
    limit: REPO_OVERVIEW_LIMITS.maxCommunities,
  });
  const communityHeaders = communityRows.map((row) => ({
    id: str(cell(row, 'id', 0)),
    label: str(cell(row, 'label', 1)),
    heuristicLabel: str(cell(row, 'heuristicLabel', 2)),
    symbolCount: num(cell(row, 'symbolCount', 3)),
    cohesion: num(cell(row, 'cohesion', 4)),
  }));
  const communityIds = communityHeaders.map((c) => c.id).filter(Boolean);

  let memberRows: Row[] = [];
  if (communityIds.length > 0) {
    memberRows = await run('communityMembers', REPO_OVERVIEW_QUERIES.communityMembers, {
      communityIds,
      limit: REPO_OVERVIEW_LIMITS.maxCommunities * REPO_OVERVIEW_LIMITS.maxMembersPerCommunity,
    });
  }
  const membersByCommunity = new Map<string, SymbolSeed[]>();
  for (const row of memberRows) {
    const communityId = str(cell(row, 'communityId', 0));
    const id = str(cell(row, 'id', 1));
    if (!communityId || !id) continue;
    const list = membersByCommunity.get(communityId) ?? [];
    if (list.some((m) => m.id === id)) continue;
    const filePath = str(cell(row, 'filePath', 3));
    list.push({
      id,
      name: str(cell(row, 'name', 2)) || id,
      filePath,
      label: labelOf(cell(row, 'label', 4)),
      module: moduleFromPath(filePath),
    });
    membersByCommunity.set(communityId, list);
  }
  const communities: CommunitySample[] = communityHeaders.map((c) => {
    const sampledMembers = (membersByCommunity.get(c.id) ?? [])
      .slice(0, REPO_OVERVIEW_LIMITS.maxMembersPerCommunity)
      .map((m) => ({
        id: m.id,
        name: m.name,
        filePath: m.filePath,
        label: m.label,
      }));
    return {
      id: c.id,
      label: c.label || c.heuristicLabel,
      heuristicLabel: c.heuristicLabel,
      symbolCount: c.symbolCount,
      cohesion: c.cohesion,
      sampledMembers,
      sampled: true,
    };
  });

  // Q3b — process headers, then one anchored step query per sampled process.
  const processRows = await run('processHeaders', REPO_OVERVIEW_QUERIES.processHeaders, {
    limit: REPO_OVERVIEW_LIMITS.maxProcesses,
  });
  const processHeaders = processRows.map((row) => ({
    id: str(cell(row, 'id', 0)),
    label: str(cell(row, 'label', 1)),
    heuristicLabel: str(cell(row, 'heuristicLabel', 2)),
    stepCount: num(cell(row, 'stepCount', 3)),
    processType: str(cell(row, 'processType', 4)),
  }));
  const stepsByProcess = new Map<string, SymbolSeed[]>();
  for (const process of processHeaders) {
    if (!process.id) continue;
    const stepRows = await run('processSteps', REPO_OVERVIEW_QUERIES.processSteps, {
      processId: process.id,
      limit: REPO_OVERVIEW_LIMITS.maxStepsPerProcess,
    });
    const steps: SymbolSeed[] = [];
    const seen = new Set<string>();
    for (const row of stepRows) {
      const id = str(cell(row, 'id', 0));
      if (!id || seen.has(id)) continue;
      seen.add(id);
      const filePath = str(cell(row, 'filePath', 2));
      steps.push({
        id,
        name: str(cell(row, 'name', 1)) || id,
        filePath,
        label: labelOf(cell(row, 'label', 4)) || 'ProcessStep',
        module: moduleFromPath(filePath),
      });
    }
    stepsByProcess.set(process.id, steps);
  }

  const symbolSeeds: SymbolSeed[] = [];
  const seenSymbols = new Set<string>();
  const addSeed = (seed: SymbolSeed): void => {
    if (!seed.id || seenSymbols.has(seed.id)) return;
    if (symbolSeeds.length >= REPO_OVERVIEW_LIMITS.maxSeedSymbols) return;
    seenSymbols.add(seed.id);
    symbolSeeds.push(seed);
  };
  for (const row of initialSymbolRows) {
    const id = str(cell(row, 'id', 0));
    const filePath = str(cell(row, 'filePath', 2));
    addSeed({
      id,
      name: str(cell(row, 'name', 1)) || id,
      filePath,
      label: labelOf(cell(row, 'label', 3)),
      module: moduleFromPath(filePath),
    });
  }
  for (const list of membersByCommunity.values()) {
    for (const seed of list.slice(0, REPO_OVERVIEW_LIMITS.maxMembersPerCommunity)) addSeed(seed);
  }
  for (const list of stepsByProcess.values()) {
    for (const seed of list) addSeed(seed);
  }

  // Q4a/Q4b — two label-anchored CALLS queries per seed, bounded by the DB
  // pool's connection count. No ORDER BY here: the neighbor subset is
  // intentionally nondeterministic and reported as such.
  const callEdges: CallEdge[] = [];
  const seenEdges = new Set<string>();
  const addCallEdge = (from: SymbolSeed, row: Row, direction: 'outgoing' | 'incoming'): void => {
    const id = str(cell(row, 'id', 0));
    if (!id || id === from.id) return;
    const filePath = str(cell(row, 'filePath', 2));
    const to: SymbolSeed = {
      id,
      name: str(cell(row, 'name', 1)) || id,
      filePath,
      label: labelOf(cell(row, 'label', 3)),
      module: moduleFromPath(filePath),
    };
    const fromSymbol = direction === 'outgoing' ? from : to;
    const toSymbol = direction === 'outgoing' ? to : from;
    const key = `${fromSymbol.id}\u0000${toSymbol.id}`;
    if (seenEdges.has(key)) return;
    seenEdges.add(key);
    callEdges.push({
      fromId: fromSymbol.id,
      fromName: fromSymbol.name,
      fromModule: fromSymbol.module,
      toId: toSymbol.id,
      toName: toSymbol.name,
      toModule: toSymbol.module,
    });
    addSeed(to);
  };

  const seeds = [...symbolSeeds];
  const callResults = await mapWithConcurrency(
    seeds,
    REPO_OVERVIEW_QUERY_CONCURRENCY,
    async (seed) => {
      const outgoing = await run('outgoingCalls', repoOverviewCallQuery('outgoing', seed.label), {
        seedId: seed.id,
        limit: REPO_OVERVIEW_LIMITS.neighborsPerSeed,
      });
      const incoming = await run('incomingCalls', repoOverviewCallQuery('incoming', seed.label), {
        seedId: seed.id,
        limit: REPO_OVERVIEW_LIMITS.neighborsPerSeed,
      });
      return { outgoing, incoming };
    },
  );
  // Process in seed order so edge insertion and all downstream sampling stay
  // identical to the sequential query plan.
  callResults.forEach(({ outgoing, incoming }, index) => {
    const seed = seeds[index];
    for (const row of outgoing) addCallEdge(seed, row, 'outgoing');
    for (const row of incoming) addCallEdge(seed, row, 'incoming');
  });

  // Derive hubs from the sampled edge set. Sorting here is presentation only —
  // it does not make the underlying neighbor selection deterministic or global.
  const outgoingCount = new Map<string, number>();
  const incomingCount = new Map<string, number>();
  const boundaryMap = new Map<string, { count: number; evidence: Set<string> }>();
  for (const edge of callEdges) {
    outgoingCount.set(edge.fromId, (outgoingCount.get(edge.fromId) ?? 0) + 1);
    incomingCount.set(edge.toId, (incomingCount.get(edge.toId) ?? 0) + 1);
    if (edge.fromModule === edge.toModule) continue;
    const key = `${edge.fromModule}\u0000${edge.toModule}`;
    const bucket = boundaryMap.get(key) ?? { count: 0, evidence: new Set<string>() };
    bucket.count += 1;
    if (bucket.evidence.size < 5) bucket.evidence.add(`${edge.fromName} → ${edge.toName}`);
    boundaryMap.set(key, bucket);
  }

  const allSymbols = new Map<string, SymbolSeed>();
  for (const seed of symbolSeeds) allSymbols.set(seed.id, seed);
  for (const edge of callEdges) {
    allSymbols.set(edge.fromId, {
      id: edge.fromId,
      name: edge.fromName,
      filePath: '',
      label: '',
      module: edge.fromModule,
    });
    allSymbols.set(edge.toId, {
      id: edge.toId,
      name: edge.toName,
      filePath: '',
      label: '',
      module: edge.toModule,
    });
  }

  const rankedHubs: HubNode[] = Array.from(allSymbols.values())
    .map((symbol) => {
      const sampledOutgoing = outgoingCount.get(symbol.id) ?? 0;
      const sampledIncoming = incomingCount.get(symbol.id) ?? 0;
      const responsibilities: ResponsibilityInference[] = [];
      for (const edge of callEdges) {
        if (edge.fromId !== symbol.id && edge.toId !== symbol.id) continue;
        const isOutgoing = edge.fromId === symbol.id;
        const module = isOutgoing ? edge.toModule : edge.fromModule;
        const evidenceName = isOutgoing ? edge.toName : edge.fromName;
        const kind = isOutgoing ? 'calls_into' : 'called_from';
        const existing = responsibilities.find((r) => r.kind === kind && r.module === module);
        if (existing) {
          existing.sampledCallCount += 1;
          if (existing.evidence.length < 5 && !existing.evidence.includes(evidenceName)) {
            existing.evidence.push(evidenceName);
          }
        } else {
          responsibilities.push({
            kind,
            module,
            sampledCallCount: 1,
            evidence: [evidenceName],
            inferred: true,
            basis: 'sampled CALLS edges',
          });
        }
      }
      responsibilities.sort(
        (a, b) =>
          b.sampledCallCount - a.sampledCallCount ||
          compareNames(a.module, b.module) ||
          compareNames(a.kind, b.kind),
      );
      return {
        id: symbol.id,
        name: symbol.name,
        filePath: symbol.filePath,
        label: symbol.label,
        degree: sampledOutgoing + sampledIncoming,
        sampledIncoming,
        sampledOutgoing,
        module: symbol.module,
        ranking: 'sampled-candidates-only' as const,
        responsibilities: responsibilities.slice(0, REPO_OVERVIEW_LIMITS.maxResponsibilities),
      };
    })
    .filter((hub) => hub.degree > 0)
    .sort(
      (a, b) => b.degree - a.degree || compareNames(a.name, b.name) || compareNames(a.id, b.id),
    );
  const architecturalHubs = rankedHubs.slice(0, REPO_OVERVIEW_LIMITS.maxSeedSymbols);
  if (rankedHubs.length > architecturalHubs.length) {
    pushWarning(
      warnings,
      `Only ${architecturalHubs.length} of ${rankedHubs.length} sampled hub candidates are shown; this is presentation truncation, not a global ranking.`,
    );
  }

  const integrationBoundaries: BoundaryEdge[] = Array.from(boundaryMap.entries())
    .map(([key, bucket]) => {
      const [fromModule, toModule] = key.split('\u0000');
      return {
        fromModule,
        toModule,
        callCount: bucket.count,
        sampleEvidence: Array.from(bucket.evidence).sort(compareNames),
        inferred: true as const,
      };
    })
    .sort(
      (a, b) =>
        b.callCount - a.callCount ||
        compareNames(a.fromModule, b.fromModule) ||
        compareNames(a.toModule, b.toModule),
    )
    .slice(0, REPO_OVERVIEW_LIMITS.maxCommunities);

  // Directory modules use the bounded file sample and sampled symbol evidence.
  const byModule = new Map<string, FileSeed[]>();
  for (const file of files) {
    const list = byModule.get(file.module) ?? [];
    list.push(file);
    byModule.set(file.module, list);
  }
  const modules: ModuleSummary[] = Array.from(byModule.entries())
    .map(([path, moduleFiles]) => {
      const languageCounts = new Map<string, number>();
      for (const file of moduleFiles) {
        languageCounts.set(file.language, (languageCounts.get(file.language) ?? 0) + 1);
      }
      const language =
        Array.from(languageCounts.entries()).sort(
          (a, b) => b[1] - a[1] || compareNames(a[0], b[0]),
        )[0]?.[0] ?? 'Unknown';
      const candidates = Array.from(allSymbols.values()).filter((symbol) => {
        const base = normalizePath(symbol.filePath);
        return base.startsWith(`${path}/`) || moduleFiles.some((f) => f.filePath === base);
      });
      candidates.sort(
        (a, b) =>
          (outgoingCount.get(b.id) ?? 0) +
            (incomingCount.get(b.id) ?? 0) -
            ((outgoingCount.get(a.id) ?? 0) + (incomingCount.get(a.id) ?? 0)) ||
          compareNames(a.name, b.name) ||
          compareNames(a.id, b.id),
      );
      return {
        path,
        fileCount: moduleFiles.length,
        topSymbols: candidates.slice(0, 5).map((s) => s.name),
        language,
        sampledFileCount: moduleFiles.length,
        languages: Array.from(languageCounts.keys()).sort(compareNames),
        representativeFiles: moduleFiles
          .map((f) => f.filePath)
          .sort(compareNames)
          .slice(0, 5),
        sampled: true as const,
      };
    })
    .sort((a, b) => b.fileCount - a.fileCount || compareNames(a.path, b.path));

  const workflows: WorkflowSummary[] = processHeaders.map((process) => {
    const steps = stepsByProcess.get(process.id) ?? [];
    const keySymbols = steps
      .slice(0, REPO_OVERVIEW_LIMITS.maxStepsPerProcess)
      .map((s) => s.name)
      .slice(0, 5);
    return {
      processId: process.id,
      label: process.heuristicLabel || process.label || process.id,
      stepCount: process.stepCount,
      keySymbols,
      heuristicLabel: process.heuristicLabel,
      processType: process.processType,
      sampledSteps: steps.length,
      stepsTruncated: process.stepCount > steps.length,
      sampled: true as const,
    };
  });

  const totalQueries = Object.values(phases).reduce((sum, count) => sum + count, 0);
  if (totalQueries > REPO_OVERVIEW_QUERY_BUDGET.total) {
    pushWarning(
      warnings,
      `Overview issued ${totalQueries} queries, above the ${REPO_OVERVIEW_QUERY_BUDGET.total}-query budget.`,
    );
  }
  if (fileRows.length >= REPO_OVERVIEW_LIMITS.maxFiles) {
    pushWarning(
      warnings,
      `Only the first ${REPO_OVERVIEW_LIMITS.maxFiles} path-ordered files were sampled; other modules may be absent.`,
    );
  }
  if (initialSymbolRows.length === 0 && fileIds.length > 0) {
    pushWarning(
      warnings,
      'No File-DEFINES symbol edges were found in the sampled files; hubs rely on community/process seeds only.',
    );
  }
  if (symbolSeeds.length === 0) {
    pushWarning(
      warnings,
      'No symbol seeds were available; hubs and integration boundaries are empty, which does not prove none exist.',
    );
  }
  if (communities.length >= REPO_OVERVIEW_LIMITS.maxCommunities) {
    pushWarning(
      warnings,
      `Only ${REPO_OVERVIEW_LIMITS.maxCommunities} communities were sampled; absent communities are not evidence of absence.`,
    );
  }
  if (workflows.length >= REPO_OVERVIEW_LIMITS.maxProcesses) {
    pushWarning(
      warnings,
      `Only ${REPO_OVERVIEW_LIMITS.maxProcesses} processes were sampled; absent workflows are not evidence of absence.`,
    );
  }
  if (workflows.some((w) => w.stepsTruncated)) {
    pushWarning(
      warnings,
      `Workflow steps are capped at ${REPO_OVERVIEW_LIMITS.maxStepsPerProcess}; keySymbols are a partial trace, not the full process.`,
    );
  }
  pushWarning(
    warnings,
    `Hubs and integration boundaries are sampled candidates, not globally ranked results. Neighbor selection is nondeterministic (no ORDER BY); responsibilities are inferred from sampled CALLS edges.`,
  );

  const completeness: RepoOverviewCompleteness = {
    statsSource,
    files: sampleBound(files.length, REPO_OVERVIEW_LIMITS.maxFiles, stats?.files ?? null),
    hubs: sampleBound(
      architecturalHubs.length,
      REPO_OVERVIEW_LIMITS.maxSeedSymbols,
      rankedHubs.length,
    ),
    communities: sampleBound(
      communities.length,
      REPO_OVERVIEW_LIMITS.maxCommunities,
      stats?.communities ?? null,
    ),
    processes: sampleBound(
      workflows.length,
      REPO_OVERVIEW_LIMITS.maxProcesses,
      stats?.processes ?? null,
    ),
    seedSymbols: sampleBound(symbolSeeds.length, REPO_OVERVIEW_LIMITS.maxSeedSymbols, null),
    communityMembers: sampleBound(
      Array.from(membersByCommunity.values()).reduce((sum, list) => sum + list.length, 0),
      REPO_OVERVIEW_LIMITS.maxCommunities * REPO_OVERVIEW_LIMITS.maxMembersPerCommunity,
      null,
    ),
    sampledSteps: sampleBound(
      Array.from(stepsByProcess.values()).reduce((sum, list) => sum + list.length, 0),
      REPO_OVERVIEW_LIMITS.maxProcesses * REPO_OVERVIEW_LIMITS.maxStepsPerProcess,
      null,
    ),
    callNeighbors: sampleBound(
      callEdges.length,
      REPO_OVERVIEW_LIMITS.maxSeedSymbols * 2 * REPO_OVERVIEW_LIMITS.neighborsPerSeed,
      null,
    ),
  };

  const overview: RepoOverview = {
    name: repo.name || repo.id || '(repository)',
    repoPath: repo.repoPath || '',
    nodeCount: stats?.nodes ?? 0,
    edgeCount: stats?.edges ?? 0,
    modules,
    architecturalHubs,
    workflows,
    integrationBoundaries,
    communities,
    stats: {
      files: stats?.files ?? null,
      nodes: stats?.nodes ?? 0,
      edges: stats?.edges ?? 0,
      communities: stats?.communities ?? null,
      processes: stats?.processes ?? null,
      source: statsSource,
    },
    completeness,
    warnings,
    sampling: {
      hubsAreGloballyRanked: false,
      integrationBoundariesAreGloballyRanked: false,
      neighborSelectionDeterministic: false,
      responsibilitiesInferred: true,
      relationshipEvidence: 'sampled CALLS edges',
      note: 'Orientation sample only: absence from any section is not evidence of absence.',
    },
    queryBudget: {
      plannedMax: REPO_OVERVIEW_QUERY_BUDGET.total,
      executed: totalQueries,
      phases: { ...phases },
      q3b: phases.processSteps,
      q4a: phases.outgoingCalls,
      q4b: phases.incomingCalls,
    },
  };

  return overview;
}

/** Compact markdown rendering for MCP clients; structured fields remain intact. */
export function formatRepoOverview(overview: RepoOverview): string {
  const lines: string[] = [];
  lines.push(`# Repository: ${overview.name}`);
  lines.push(
    `**${overview.nodeCount.toLocaleString('en-US')} nodes, ${overview.edgeCount.toLocaleString('en-US')} edges**`,
  );
  lines.push('');
  lines.push(
    '> Sampled orientation only. Hubs and boundaries are candidates, not globally ranked; neighbor selection is nondeterministic; responsibilities are inferred from sampled CALLS edges.',
  );
  lines.push('');

  lines.push('## Modules (bounded file sample)');
  if (overview.modules.length === 0) {
    lines.push('_No File nodes in the bounded sample._');
  } else {
    lines.push('| Module | Files | Language | Top sampled symbols |');
    lines.push('| --- | ---: | --- | --- |');
    for (const module of overview.modules) {
      lines.push(
        `| ${escapeCell(module.path)} | ${module.fileCount} | ${escapeCell(module.language)} | ${escapeCell(module.topSymbols.join(', ') || '—')} |`,
      );
    }
  }
  lines.push('');

  lines.push('## Architectural Hubs (sampled candidates; not globally ranked)');
  if (overview.architecturalHubs.length === 0) {
    lines.push('_No sampled CALLS evidence in this seed set._');
  } else {
    lines.push('| Symbol | Type | Sampled degree | Module | Inferred responsibility |');
    lines.push('| --- | --- | ---: | --- | --- |');
    for (const hub of overview.architecturalHubs) {
      const responsibility = hub.responsibilities[0];
      const text = responsibility
        ? `${responsibility.kind} ${responsibility.module} (${responsibility.sampledCallCount})`
        : '—';
      lines.push(
        `| ${escapeCell(hub.name)} | ${escapeCell(hub.label || 'Symbol')} | ${hub.degree} | ${escapeCell(hub.module)} | ${escapeCell(text)} |`,
      );
    }
  }
  lines.push('');

  lines.push('## Workflows (sampled processes)');
  if (overview.workflows.length === 0) {
    lines.push('_No Process nodes in the bounded sample._');
  } else {
    lines.push('| Workflow | Steps | Sampled key symbols |');
    lines.push('| --- | ---: | --- |');
    for (const workflow of overview.workflows) {
      lines.push(
        `| ${escapeCell(workflow.label)} | ${workflow.stepCount} | ${escapeCell(workflow.keySymbols.join(', ') || '—')} |`,
      );
    }
  }
  lines.push('');

  lines.push('## Integration Boundaries (sampled cross-module CALLS)');
  if (overview.integrationBoundaries.length === 0) {
    lines.push('_No cross-module CALLS in the bounded seed set._');
  } else {
    lines.push('| From → To | Sampled calls |');
    lines.push('| --- | ---: |');
    for (const boundary of overview.integrationBoundaries) {
      lines.push(
        `| ${escapeCell(boundary.fromModule)} → ${escapeCell(boundary.toModule)} | ${boundary.callCount} |`,
      );
    }
  }
  lines.push('');

  lines.push('## Completeness & warnings');
  for (const warning of overview.warnings) lines.push(`- ${escapeCell(warning)}`);
  lines.push(
    `- Query budget: ${overview.queryBudget.executed}/${overview.queryBudget.plannedMax} (q3b=${overview.queryBudget.q3b}, q4a=${overview.queryBudget.q4a}, q4b=${overview.queryBudget.q4b}).`,
  );
  lines.push(
    `- Files ${overview.completeness.files.returned}/${overview.completeness.files.limit}, communities ${overview.completeness.communities.returned}/${overview.completeness.communities.limit}, processes ${overview.completeness.processes.returned}/${overview.completeness.processes.limit}.`,
  );
  return lines.join('\n');
}
