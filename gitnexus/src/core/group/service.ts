/**
 * Group orchestration shared by MCP (LocalBackend) and CLI.
 * DB access is injected via GroupToolPort so this module stays free of LocalBackend private API.
 */

import fsp from 'node:fs/promises';
import path from 'node:path';
import { checkStaleness } from '../git-staleness.js';
import {
  loadMeta,
  readRegistryStrict,
  type RegistryEntry,
  type RepoMeta,
} from '../../storage/repo-manager.js';
import { GroupNotFoundError, loadGroupConfig } from './config-parser.js';
import {
  fileMatchesServicePrefix,
  normalizeServicePrefix,
  repoInSubgroup,
} from './group-path-utils.js';
import { getDefaultGitnexusDir, getGroupDir, listGroups, readContractRegistry } from './storage.js';
// `./sync.js` is imported LAZILY in `groupSync` — see the comment at its call
// site. It statically pulls the six contract extractors and, through them, the
// native tree-sitter binding; a static import here puts all of that on MCP
// server startup, which never syncs.
import { logger } from '../logger.js';
import type {
  ContractRegistry,
  CrossLink,
  GroupConfig,
  GroupContextResult,
  StoredContract,
} from './types.js';

export interface GroupRepoHandle {
  id: string;
  name: string;
  repoPath: string;
  storagePath: string;
  indexedAt?: string;
  lastCommit?: string;
}

export interface GroupToolPort {
  resolveRepo(repoParam?: string): Promise<GroupRepoHandle>;
  impact(
    repo: GroupRepoHandle,
    params: {
      target: string;
      direction: 'upstream' | 'downstream';
      maxDepth?: number;
      relationTypes?: string[];
      includeTests?: boolean;
      minConfidence?: number;
      limit?: number;
    },
  ): Promise<unknown>;
  query(
    repo: GroupRepoHandle,
    params: {
      // GroupService always supplies `query` as a string (it resolves the #2175
      // search_query alias before calling the port), so the port contract keeps it
      // required here even though the LocalBackend implementation accepts the wider
      // `{ query?, search_query? }` shape for the direct MCP callTool path.
      query: string;
      task_context?: string;
      goal?: string;
      limit?: number;
      max_symbols?: number;
      include_content?: boolean;
    },
  ): Promise<unknown>;
  impactByUid(
    repoId: string,
    uid: string,
    direction: string,
    opts: {
      maxDepth: number;
      relationTypes: string[];
      minConfidence: number;
      includeTests: boolean;
      // Optional cancellation signal. Callers (notably the cross-impact
      // Phase-2 fanout) wrap this call in a Promise.race against a
      // setTimeout-driven AbortController so a single hung neighbor
      // cannot exceed the request's clamped timeout budget. Implementors
      // may honor the signal cooperatively or simply let the caller's
      // race resolve the await — the latter is sufficient for the
      // resource-exhaustion mitigation. When the signal is absent or
      // already aborted at call time, behavior is unchanged.
      signal?: AbortSignal;
    },
  ): Promise<unknown | null>;
  context(
    repo: GroupRepoHandle,
    params: {
      name?: string;
      uid?: string;
      file_path?: string;
      include_content?: boolean;
    },
  ): Promise<unknown>;
  // ── Cross-repo trace support (optional on the port) ────────────────
  // These are optional so existing GroupToolPort test mocks (which predate
  // the trace path and only stub impact/query/context/impactByUid) keep
  // type-checking. The real LocalBackend port supplies all three; runGroupTrace
  // guards on their presence and degrades to a clear error/note when absent.
  //
  // Single-repo directed-path trace over CALLS + HAS_METHOD. Returns the same
  // shape as the `trace` MCP tool (`{ status, from, to, hopCount, hops, edges }`).
  trace?(
    repo: GroupRepoHandle,
    params: {
      from?: string;
      to?: string;
      from_uid?: string;
      to_uid?: string;
      from_file?: string;
      to_file?: string;
      maxDepth?: number;
      includeTests?: boolean;
    },
  ): Promise<unknown>;
  // Resolve a symbol within one repo to its node id (== bridge symbolUid) and
  // location, or report ambiguity / absence. Wraps the same resolver the
  // context()/trace() tools use.
  resolveSymbol?(
    repo: GroupRepoHandle,
    query: { name?: string; uid?: string; file_path?: string },
  ): Promise<GroupSymbolResolution>;
  // Intra-procedural REACHING_DEF data-flow from an anchor symbol, used to
  // enrich a boundary-adjacent trace segment. `available:false` signals the
  // repo has no PDG `flows` layer (degraded, not an error).
  pdgFlows?(
    repo: GroupRepoHandle,
    anchor: { name?: string; uid?: string; file_path?: string },
    opts: { limit?: number },
  ): Promise<GroupPdgFlowResult>;
}

export type GroupSymbolResolution =
  | {
      kind: 'ok';
      symbol: {
        id: string;
        name: string;
        type: string;
        filePath: string;
        startLine: number;
        endLine: number;
      };
    }
  | {
      kind: 'ambiguous';
      candidates: Array<{
        id: string;
        name: string;
        type: string;
        filePath: string;
        startLine: number;
      }>;
    }
  | { kind: 'not_found' };

export interface GroupPdgFlowHop {
  line: number;
  text: string;
  variable?: string;
}

export interface GroupPdgFlowResult {
  available: boolean;
  variable?: string;
  hops: GroupPdgFlowHop[];
  truncated?: boolean;
}

function isStoredContract(raw: unknown): raw is StoredContract {
  if (!raw || typeof raw !== 'object') return false;
  const o = raw as Record<string, unknown>;
  return (
    typeof o.contractId === 'string' &&
    typeof o.type === 'string' &&
    typeof o.repo === 'string' &&
    typeof o.role === 'string' &&
    (o.role === 'provider' || o.role === 'consumer') &&
    typeof o.symbolUid === 'string' &&
    typeof o.symbolName === 'string' &&
    typeof o.confidence === 'number' &&
    o.meta !== undefined &&
    typeof o.meta === 'object' &&
    o.meta !== null &&
    o.symbolRef !== undefined &&
    typeof o.symbolRef === 'object' &&
    o.symbolRef !== null &&
    typeof (o.symbolRef as Record<string, unknown>).filePath === 'string' &&
    typeof (o.symbolRef as Record<string, unknown>).name === 'string'
  );
}

function filterQueryByServicePrefix(
  queryResult: {
    processes?: Array<Record<string, unknown>>;
    process_symbols?: Array<Record<string, unknown>>;
  },
  servicePrefix: string,
): { processes: Array<Record<string, unknown>>; process_symbols: Array<Record<string, unknown>> } {
  const symbols = (queryResult.process_symbols || []).filter((s) =>
    fileMatchesServicePrefix(
      typeof s.filePath === 'string' ? s.filePath : undefined,
      servicePrefix,
    ),
  );
  const allowed = new Set(
    symbols.map((s) => String((s as { process_id?: string }).process_id ?? '')).filter(Boolean),
  );
  const processes = (queryResult.processes || []).filter((p) => allowed.has(String(p.id)));
  return { processes, process_symbols: symbols };
}

function isCrossLink(raw: unknown): raw is CrossLink {
  if (!raw || typeof raw !== 'object') return false;
  const o = raw as Record<string, unknown>;
  const from = o.from as Record<string, unknown> | undefined;
  const to = o.to as Record<string, unknown> | undefined;
  if (!from || !to) return false;
  if (typeof from.repo !== 'string' || typeof to.repo !== 'string') return false;
  return typeof o.contractId === 'string' && typeof o.type === 'string';
}

/**
 * A recorded repo list is an array of strings. Anything else — absent, a bare
 * string, an object, an array of objects — is a value we could not read, which
 * is "not recorded", not "none".
 *
 * `Array.isArray` alone is not enough: `['app/backend']` and `[{repo:'x'}]` are
 * both arrays, and only the second reaches `cli/group.ts`'s `.join(', ')` as
 * `[object Object]`. Reporting a shape we do not understand as if we had
 * measured it is the whole failure mode this change exists to remove.
 */
function recordedRepoList(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.every((entry) => typeof entry === 'string') ? (value as string[]) : undefined;
}

/**
 * Does the global registry hold a row for this configured group member?
 *
 * Consulted only once resolution has ALREADY failed, to choose which of the
 * two failures `group status` reports. It mirrors the two tiers
 * `LocalBackend.resolveRepo` matches a bare group-config value on — the
 * registry `name`, case-insensitively, and the repo `path` — and deliberately
 * stops short of its hashed-id and partial-name tiers: those exist to be
 * generous about what an operator typed, while this predicate only decides
 * between two labels, and a looser match here would relabel a genuine registry
 * miss as an unresolvable row. That is the same conflation this reporting
 * exists to remove, pointed the other way.
 */
function registryIdentifies(entries: RegistryEntry[], registryName: string): boolean {
  const wantedName = registryName.toLowerCase();
  const wantedPath = path.resolve(registryName);
  return entries.some((entry) => {
    if (typeof entry.name === 'string' && entry.name.toLowerCase() === wantedName) return true;
    if (typeof entry.path !== 'string') return false;
    const stored = path.resolve(entry.path);
    return process.platform === 'win32'
      ? stored.toLowerCase() === wantedPath.toLowerCase()
      : stored === wantedPath;
  });
}

async function loadContractRegistryResilient(
  groupDir: string,
): Promise<
  { ok: true; registry: ContractRegistry; skippedCorrupt: number } | { ok: false; error: string }
> {
  const filePath = path.join(groupDir, 'contracts.json');
  let raw: string;
  try {
    raw = await fsp.readFile(filePath, 'utf-8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
      return { ok: false, error: `No contracts.json for this group. Run group_sync first.` };
    }
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }

  let root: unknown;
  try {
    root = JSON.parse(raw);
  } catch {
    return { ok: false, error: 'contracts.json is not valid JSON' };
  }

  if (!root || typeof root !== 'object' || Array.isArray(root)) {
    return { ok: false, error: 'contracts.json has an invalid root object' };
  }

  const base = root as Record<string, unknown>;
  const contractsRaw = base.contracts;
  const crossRaw = base.crossLinks;
  let skippedCorrupt = 0;

  const contracts: StoredContract[] = [];
  if (Array.isArray(contractsRaw)) {
    for (const row of contractsRaw) {
      try {
        if (isStoredContract(row)) {
          contracts.push(row);
        } else {
          skippedCorrupt++;
          logger.warn('[group] skipping corrupt contract row in contracts.json');
        }
      } catch {
        skippedCorrupt++;
        logger.warn('[group] skipping corrupt contract row in contracts.json');
      }
    }
  }

  const crossLinks: CrossLink[] = [];
  if (Array.isArray(crossRaw)) {
    for (const row of crossRaw) {
      try {
        if (isCrossLink(row)) {
          crossLinks.push(row);
        } else {
          skippedCorrupt++;
          logger.warn('[group] skipping corrupt crossLinks row in contracts.json');
        }
      } catch {
        skippedCorrupt++;
        logger.warn('[group] skipping corrupt crossLinks row in contracts.json');
      }
    }
  }

  const registry: ContractRegistry = {
    version: typeof base.version === 'number' ? base.version : 0,
    generatedAt: typeof base.generatedAt === 'string' ? base.generatedAt : '',
    repoSnapshots:
      base.repoSnapshots && typeof base.repoSnapshots === 'object' && base.repoSnapshots !== null
        ? (base.repoSnapshots as Record<string, { indexedAt: string; lastCommit: string }>)
        : {},
    // Same gate as `groupStatus` uses on the same field, for the same reason:
    // `Array.isArray` alone waves through `[{repo:'x'}]`, and `groupContracts`
    // now returns this list AND folds it into its completeness answer, so a
    // value we could not read would be reported as a repo name. `missingRepos`
    // has always been required, so — unlike `unreadableRepos` below — there is
    // no "not recorded" state to preserve: an unreadable value degrades to empty.
    missingRepos: recordedRepoList(base.missingRepos) ?? [],
    // Spread, not `?? []`. `ContractRegistry.unreadableRepos` documents absence
    // as "not recorded", and a registry written before the field existed has no
    // opinion about which indexes were readable. Normalizing that to `[]` hands
    // the caller "the last sync found none unreadable" — an unmeasured state
    // rendered as a clean result, which is the same conflation this whole
    // change removes.
    ...(recordedRepoList(base.unreadableRepos)
      ? { unreadableRepos: recordedRepoList(base.unreadableRepos) }
      : {}),
    contracts,
    crossLinks,
  };

  return { ok: true, registry, skippedCorrupt };
}

export class GroupService {
  constructor(private readonly port: GroupToolPort) {}

  async groupList(params: Record<string, unknown>): Promise<unknown> {
    const name = typeof params.name === 'string' ? params.name.trim() : '';
    if (!name) {
      const groups = await listGroups();
      return { groups };
    }
    const groupDir = getGroupDir(getDefaultGitnexusDir(), name);
    let config: GroupConfig;
    try {
      config = await loadGroupConfig(groupDir);
    } catch (err) {
      if (err instanceof GroupNotFoundError)
        return { error: `Group "${name}" not found. Run group_list to see configured groups.` };
      throw err;
    }
    return {
      name: config.name,
      description: config.description,
      repos: config.repos,
      links: config.links,
    };
  }

  async groupSync(params: Record<string, unknown>): Promise<unknown> {
    const name = String(params.name ?? '').trim();
    if (!name) return { error: 'name is required' };
    const groupDir = getGroupDir(getDefaultGitnexusDir(), name);
    let config: GroupConfig;
    try {
      config = await loadGroupConfig(groupDir);
    } catch (err) {
      if (err instanceof GroupNotFoundError)
        return { error: `Group "${name}" not found. Run group_list to see configured groups.` };
      throw err;
    }
    // Lazy: `sync.js` reaches the six contract extractors and the native
    // tree-sitter binding. `groupSync` is the ONLY consumer — the other seven
    // group tools never need it — so deferring it here keeps that closure off
    // MCP server startup entirely and off every non-sync group call. The CLI
    // already does exactly this at `cli/group.ts`'s sync command.
    const { syncGroup } = await import('./sync.js');
    const result = await syncGroup(config, {
      groupDir,
      exactOnly: Boolean(params.exactOnly),
      skipEmbeddings: Boolean(params.skipEmbeddings),
      allowStale: Boolean(params.allowStale),
      verbose: Boolean(params.verbose),
    });
    return {
      contracts: result.contracts.length,
      crossLinks: result.crossLinks.length,
      unmatched: result.unmatched.length,
      missingRepos: result.missingRepos,
      unreadableRepos: result.unreadableRepos,
      // An agent that calls group_sync and then group_contracts a moment later
      // can otherwise see contract counts that disagree with this payload, with
      // nothing here explaining why the write was skipped.
      registryOutcome: result.registryOutcome,
    };
  }

  async groupContracts(params: Record<string, unknown>): Promise<unknown> {
    const name = String(params.name ?? '').trim();
    if (!name) return { error: 'name is required' };
    const groupDir = getGroupDir(getDefaultGitnexusDir(), name);
    const loaded = await loadContractRegistryResilient(groupDir);
    if (loaded.ok === false) {
      if (loaded.error.includes('No contracts.json')) {
        return { error: `No contracts.json for group "${name}". Run group_sync first.` };
      }
      return { error: loaded.error };
    }
    const { registry, skippedCorrupt } = loaded;
    let contracts = registry.contracts;
    if (params.type) contracts = contracts.filter((c) => c.type === params.type);
    if (params.repo) contracts = contracts.filter((c) => c.repo === params.repo);
    if (params.unmatchedOnly) {
      const matchedIds = new Set(
        registry.crossLinks.flatMap((l) => [
          `${l.from.repo}::${l.contractId}`,
          `${l.to.repo}::${l.contractId}`,
        ]),
      );
      contracts = contracts.filter((c) => !matchedIds.has(`${c.repo}::${c.contractId}`));
    }
    // Lazy for the same reason `groupImpact` and `groupTrace` are: `cross-impact.js`
    // statically pulls `bridge-db.js`, and through it the native `@ladybugdb/core`
    // binding. A static import here would put that on every consumer of this
    // module — including `gitnexus group list`, which touches no database at all.
    // Only `crossRepoCompleteness` is used, and it is a pure fold over two lists
    // (it takes no `BridgeMeta` precisely so this path, which never opens a
    // bridge, can share it — KTD10).
    const { crossRepoCompleteness } = await import('./cross-impact.js');
    // `loadContractRegistryResilient` already applied `recordedRepoList` to
    // both: `undefined` here is "the last sync recorded no opinion" (a registry
    // written before the field existed, or a value we could not read), which is
    // NOT the same answer as the measured empty list.
    const { unreadableRepos, missingRepos } = registry;
    // `incompleteRepos` is dropped on this surface only because the two lists it
    // is derived from are returned verbatim right below; the truncation triple is
    // the part that has no other channel here.
    const { incompleteRepos: _incompleteRepos, ...truncation } = crossRepoCompleteness({
      unreadableRepos,
      missingRepos,
      // An unrecorded `unreadableRepos` means this listing cannot say which
      // repos the sync failed to read — so it cannot claim to be complete.
      provenanceUnknown: unreadableRepos === undefined,
      // A contract LISTING declares no scope to intersect with: it is the whole
      // registry, so every configured repo is in scope by construction. The
      // `type`/`repo`/`unmatchedOnly` filters above narrow which rows are shown,
      // not which repos the sync had to read to produce them.
      inScope: () => true,
    });
    const out: Record<string, unknown> = {
      contracts,
      crossLinks: registry.crossLinks,
      missingRepos,
      // Omitted rather than `[]` when the registry never recorded it — the same
      // convention `skippedCorrupt` follows below, and the difference between
      // "the sync measured zero unreadable repos" and "the sync never said".
      ...(unreadableRepos ? { unreadableRepos } : {}),
      // The structured triple, verbatim from the impact surface (KTD10):
      // `truncated` always, `truncationReason` + `riskEpistemic` with it.
      ...truncation,
    };
    if (skippedCorrupt > 0) out.skippedCorrupt = skippedCorrupt;
    return out;
  }

  async groupImpact(params: Record<string, unknown>): Promise<unknown> {
    const { runGroupImpact } = await import('./cross-impact.js');
    return runGroupImpact({ port: this.port, gitnexusDir: getDefaultGitnexusDir() }, params);
  }

  async groupTrace(params: Record<string, unknown>): Promise<unknown> {
    const { runGroupTrace } = await import('./cross-trace.js');
    return runGroupTrace({ port: this.port, gitnexusDir: getDefaultGitnexusDir() }, params);
  }

  async groupContext(params: Record<string, unknown>): Promise<GroupContextResult> {
    const name = String(params.name ?? '').trim();
    const target = typeof params.target === 'string' ? params.target.trim() : '';
    const uid = typeof params.uid === 'string' ? params.uid.trim() : undefined;
    const file_path = typeof params.file_path === 'string' ? params.file_path : undefined;
    const include_content = Boolean(params.include_content);
    if (
      params.service !== undefined &&
      params.service !== null &&
      String(params.service).trim() === ''
    ) {
      return { group: name || '', error: 'service must not be an empty string', results: [] };
    }
    const servicePrefix = normalizeServicePrefix(params.service);
    const subgroup = typeof params.subgroup === 'string' ? params.subgroup : undefined;
    const subgroupExact = params.subgroupExact === true;

    if (!name) {
      return { group: '', error: 'name is required', results: [] };
    }
    if (!uid && !target) {
      return { group: name, error: 'target or uid is required', results: [] };
    }

    const groupDir = getGroupDir(getDefaultGitnexusDir(), name);
    let config: GroupConfig;
    try {
      config = await loadGroupConfig(groupDir);
    } catch (e) {
      if (e instanceof GroupNotFoundError)
        return {
          group: name,
          target: target || uid,
          service: servicePrefix,
          error: `Group "${name}" not found. Run group_list to see configured groups.`,
          results: [],
        };
      return {
        group: name,
        target: target || uid,
        service: servicePrefix,
        error: e instanceof Error ? e.message : String(e),
        results: [],
      };
    }

    const memberEntries = Object.entries(config.repos).filter(([repoPath]) =>
      repoInSubgroup(repoPath, subgroup, subgroupExact),
    );

    const results: GroupContextResult['results'] = await Promise.all(
      memberEntries.map(async ([repoPath, registryName]) => {
        try {
          const repoObj = await this.port.resolveRepo(registryName);
          const payload = await this.port.context(repoObj, {
            name: target || undefined,
            uid,
            file_path,
            include_content,
          });

          if (servicePrefix) {
            const st = (payload as { status?: string })?.status;
            const sym = (payload as { symbol?: { filePath?: string } })?.symbol;
            if (st === 'found' && !fileMatchesServicePrefix(sym?.filePath, servicePrefix)) {
              return { repoPath, registryName, payload: {} };
            }
          }

          return { repoPath, registryName, payload };
        } catch (e) {
          return {
            repoPath,
            registryName,
            payload: { error: e instanceof Error ? e.message : String(e) },
          };
        }
      }),
    );

    return {
      group: name,
      target: target || uid,
      service: servicePrefix,
      results,
    };
  }

  async groupQuery(params: Record<string, unknown>): Promise<unknown> {
    const name = String(params.name ?? '').trim();
    const queryText = String(params.query ?? '').trim();
    if (!name || !queryText) return { error: 'name and query are required' };
    if (
      params.service !== undefined &&
      params.service !== null &&
      String(params.service).trim() === ''
    ) {
      return { error: 'service must not be an empty string' };
    }
    const servicePrefix = normalizeServicePrefix(params.service);

    const limit = typeof params.limit === 'number' && params.limit > 0 ? params.limit : 5;
    const subgroup = typeof params.subgroup === 'string' ? params.subgroup : undefined;
    const subgroupExact = params.subgroupExact === true;
    const groupDir = getGroupDir(getDefaultGitnexusDir(), name);
    let config: GroupConfig;
    try {
      config = await loadGroupConfig(groupDir);
    } catch (err) {
      if (err instanceof GroupNotFoundError)
        return { error: `Group "${name}" not found. Run group_list to see configured groups.` };
      throw err;
    }

    const memberEntries = Object.entries(config.repos).filter(([repoPath]) =>
      repoInSubgroup(repoPath, subgroup, subgroupExact),
    );

    const perRepo = await Promise.all(
      memberEntries.map(async ([repoPath, registryName]) => {
        try {
          const repoObj = await this.port.resolveRepo(registryName);
          const queryResult = (await this.port.query(repoObj, {
            query: queryText,
            limit,
            max_symbols: 10,
            include_content: false,
          })) as {
            processes?: Array<Record<string, unknown>>;
            process_symbols?: Array<Record<string, unknown>>;
          };
          const processes = servicePrefix
            ? filterQueryByServicePrefix(queryResult, servicePrefix).processes
            : queryResult.processes || [];
          const scored = processes.map((p, idx) => ({
            ...p,
            _rrf_score: 1 / (idx + 1 + 60),
            _repo: repoPath,
          }));
          return { repo: repoPath, score: 0, processes: scored as unknown[] };
        } catch {
          return { repo: repoPath, score: 0, processes: [] as unknown[] };
        }
      }),
    );

    const allProcesses = perRepo.flatMap((r) => r.processes as Array<Record<string, unknown>>);
    allProcesses.sort((a, b) => (b._rrf_score as number) - (a._rrf_score as number));
    const topN = allProcesses.slice(0, limit);

    return {
      group: name,
      query: queryText,
      results: topN,
      per_repo: perRepo.map((r) => ({ repo: r.repo, count: r.processes.length })),
    };
  }

  async groupStatus(params: Record<string, unknown>): Promise<unknown> {
    const name = String(params.name ?? '').trim();
    if (!name) return { error: 'name is required' };
    const groupDir = getGroupDir(getDefaultGitnexusDir(), name);
    let config: GroupConfig;
    try {
      config = await loadGroupConfig(groupDir);
    } catch (err) {
      if (err instanceof GroupNotFoundError)
        return { error: `Group "${name}" not found. Run group_list to see configured groups.` };
      throw err;
    }
    const registry = await readContractRegistry(groupDir);

    /**
     * The STRICT global-registry read, deliberately — this is the one caller
     * that has to tell "the registry says nothing about this repo" apart from
     * "the registry could not be read at all", and only the strict mode can.
     * `readRegistry`'s `catch { return [] }` collapses a malformed registry
     * into an empty one, which is indistinguishable from a genuine absence and
     * would report every configured repo as having no entry — the exact
     * conflation the two labels below exist to remove.
     *
     * The consequence is accepted knowingly: the strict read rejects the WHOLE
     * registry when any single row fails to identify a repo, so one malformed
     * row renders every member of the group unresolvable, including members
     * whose own rows are fine. That is the honest verdict — a registry the
     * resolver cannot trust row-wise cannot be trusted about any row — and it
     * is reported as an unresolved state, never as a clean one.
     *
     * ENOENT is not a failure in either mode: no registry file genuinely means
     * nothing has been registered yet, so every repo is legitimately missing.
     */
    let registryEntries: RegistryEntry[] | null = null;
    let registryReadError: string | null = null;
    try {
      registryEntries = await readRegistryStrict();
    } catch (err) {
      registryReadError = err instanceof Error ? err.message : String(err);
    }

    const repoStatuses: Record<
      string,
      {
        indexStale: boolean;
        contractsStale: boolean;
        /**
         * Unchanged meaning: this repo has no usable status. It stays `true`
         * for BOTH failures below, so a consumer written before the split
         * still sees every unusable repo flagged. Reporting an unresolvable
         * repo as `missing: false` would hand that consumer `indexStale:
         * false` for a repo nothing was ever read from — a false all-clear.
         */
        missing: boolean;
        /**
         * Which failure `missing` means: `false` is a genuine registry miss,
         * `true` is an entry the resolver could not turn into a repo. Additive
         * — always present on every row, so an agent can branch on it without
         * having to treat an absent key as either answer.
         */
        unresolvable: boolean;
        /** Set only when `unresolvable`; says what could not be resolved. */
        unresolvableReason?: string;
        commitsBehind?: number;
      }
    > = {};

    for (const [repoPath, registryName] of Object.entries(config.repos)) {
      if (registryEntries === null) {
        repoStatuses[repoPath] = {
          indexStale: false,
          contractsStale: false,
          missing: true,
          unresolvable: true,
          unresolvableReason: `the global registry could not be read: ${registryReadError}`,
        };
        continue;
      }
      try {
        const repoObj = await this.port.resolveRepo(registryName);
        const meta: Partial<Pick<RepoMeta, 'lastCommit' | 'indexedAt'>> =
          (await loadMeta(repoObj.storagePath)) ?? {};

        const staleness = meta.lastCommit
          ? checkStaleness(repoObj.repoPath, meta.lastCommit)
          : { isStale: true, commitsBehind: -1 };

        const snapshot = registry?.repoSnapshots[repoPath];
        const contractsStale =
          snapshot && meta.indexedAt ? snapshot.indexedAt !== meta.indexedAt : !snapshot;

        repoStatuses[repoPath] = {
          indexStale: staleness.isStale,
          contractsStale: Boolean(contractsStale),
          missing: false,
          unresolvable: false,
          commitsBehind: staleness.commitsBehind,
        };
      } catch (err) {
        // The registry read succeeded, so its answer about this row is
        // trustworthy: a row that is there and still would not resolve is a
        // different fact from a row that was never there, and the operator's
        // next move differs (repair the entry vs. index the repo).
        const known = registryIdentifies(registryEntries, registryName);
        const reason = err instanceof Error ? err.message : String(err);
        repoStatuses[repoPath] = {
          indexStale: false,
          contractsStale: false,
          missing: true,
          unresolvable: known,
          ...(known
            ? { unresolvableReason: `registry entry "${registryName}" did not resolve: ${reason}` }
            : {}),
        };
      }
    }

    return {
      group: name,
      lastSync: registry?.generatedAt || null,
      // `readContractRegistry` is a bare `JSON.parse(...) as ContractRegistry`,
      // so both of these are whatever the file happened to hold — the
      // validation in `loadContractRegistryResilient` never runs on this path.
      // A `contracts.json` carrying a string here reached `cli/group.ts` and
      // died in `.join(', ')`, i.e. an unreadable registry crashing the command
      // whose job is to explain unreadable things.
      //
      // `missingRepos` has always been required, so there is no "not recorded"
      // state to preserve for it — an unreadable value degrades to empty.
      missingRepos: recordedRepoList(registry?.missingRepos) ?? [],
      // `unreadableRepos` does have one: absent means "not recorded", not
      // "none" (see ContractRegistry), and a value we could not read is equally
      // unrecorded. Reporting either as an empty list is the same conflation.
      unreadableRepos: recordedRepoList(registry?.unreadableRepos),
      repos: repoStatuses,
    };
  }
}
