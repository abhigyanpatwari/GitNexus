/**
 * Group orchestration shared by MCP (LocalBackend) and CLI.
 * DB access is injected via GroupToolPort so this module stays free of LocalBackend private API.
 */

import fsp from 'node:fs/promises';
import path from 'node:path';
import { checkStaleness } from '../git-staleness.js';
import {
  canonicalizePath,
  loadMeta,
  readRegistryStrict,
  registryPathEquals,
  type RegistryEntry,
  type RepoMeta,
} from '../../storage/repo-manager.js';
import { crossRepoCompleteness } from './completeness.js';
import { recordedMatchStages, recordedRepoList } from './completeness.js';
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
  // Path equality goes through the registry's own rule rather than a local
  // `resolve` + platform-case compare. `canonicalizePath` also follows symlinks,
  // so a row registered through one and looked up through the other still
  // matches — and there is one definition of registry path identity instead of
  // a third, weaker copy of it living in a group module nobody would grep.
  const wantedPath = canonicalizePath(registryName);
  return entries.some((entry) => {
    if (typeof entry.name === 'string' && entry.name.toLowerCase() === wantedName) return true;
    if (typeof entry.path !== 'string') return false;
    return registryPathEquals(canonicalizePath(entry.path), wantedPath);
  });
}

async function loadContractRegistryResilient(
  groupDir: string,
): Promise<
  | { ok: true; registry: ContractRegistry; skippedCorrupt: number; suppressionUnreadable: boolean }
  | { ok: false; error: string }
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

  // Bound once: the gate is a full array scan and the ternary below used it twice.
  const recordedUnreadable = recordedRepoList(base.unreadableRepos);
  const recordedSuppressed = recordedMatchStages(base.suppressedMatchStages);
  // Present-but-unreadable is NOT the same as absent. `recordedMatchStages` is
  // all-or-nothing, so garbage collapses to `undefined` — and a consumer that
  // reads `undefined` as "nothing was suppressed" would throw that safety away
  // and report a registry it could not parse as complete. Absent stays
  // legitimate (a registry predating the field); only a value that was there
  // and unreadable forces the answer to a floor.
  const suppressionUnreadable =
    base.suppressedMatchStages !== undefined && recordedSuppressed === undefined;
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
    ...(recordedUnreadable ? { unreadableRepos: recordedUnreadable } : {}),
    // Same omit-when-unrecorded rule. This reader rebuilds the envelope field
    // by field with no spread of `base`, so a new on-disk field is dropped
    // unless it is named here.
    ...(recordedSuppressed ? { suppressedMatchStages: recordedSuppressed } : {}),
    contracts,
    crossLinks,
  };

  return { ok: true, registry, skippedCorrupt, suppressionUnreadable };
}

/**
 * Validate a boolean MCP parameter — reject, never coerce.
 *
 * `Boolean(params.x)` is the trap this exists to close: the string `"false"`
 * is truthy, and an LLM caller emitting JSON produces that shape routinely.
 * While `exactOnly` was inert the coercion was harmless; now that it gates a
 * matching stage, a coerced `"false"` suppresses that stage and persists a
 * registry with fewer cross-links than the caller asked for.
 *
 * Absent stays absent-as-false (the unchanged default). Anything that is not
 * a real boolean returns a structured `{ error }`, mirroring
 * `validateImpactMode` — the established shape for this boundary, and the one
 * `groupSync`'s other guards already use.
 */
function validateBooleanParam(name: string, raw: unknown): { value: boolean } | { error: string } {
  if (raw === undefined) return { value: false };
  if (typeof raw === 'boolean') return { value: raw };
  return { error: `Invalid "${name}": expected true or false, got ${describeValue(raw)}.` };
}

/**
 * Render an untrusted value for an error message, without throwing.
 *
 * `JSON.stringify` is the right shape here — it distinguishes the string
 * `"false"` from the boolean, which is the whole point of the message — but it
 * throws on a BigInt and on a cyclic object. A validator whose ERROR path can
 * throw does not return the structured `{ error }` it promises: the caller gets
 * a rejected promise instead of feedback it can act on, and `callTool` is
 * reachable directly, so neither input is hypothetical.
 */
function describeValue(raw: unknown): string {
  try {
    const rendered = JSON.stringify(raw);
    // `undefined`, a function, or a symbol serialize to `undefined`.
    return rendered ?? String(raw);
  } catch {
    return typeof raw === 'bigint' ? `${raw}n` : Object.prototype.toString.call(raw);
  }
}

/**
 * Refuse parameters this tool used to accept and no longer does.
 *
 * The CLI rejects a removed flag outright because commander errors on an
 * unknown option. The MCP path had no equivalent, so an agent working from a
 * cached tool schema kept sending a retired key and was told nothing — the
 * removal took away discoverability, not acceptance. Naming the parameter is
 * what lets the caller correct itself on the next call.
 */
function rejectRetiredSyncParams(params: Record<string, unknown>): { error: string } | null {
  for (const retired of ['skipEmbeddings', 'allowStale']) {
    if (params[retired] !== undefined) {
      return {
        error: `"${retired}" was removed and is no longer accepted. Drop it from the call.`,
      };
    }
  }
  return null;
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
    // Before anything reads the group off disk: the MCP SDK does not enforce a
    // tool's advertised `inputSchema` and `callTool` is reachable directly, so
    // this method is the real validation boundary.
    const exactOnly = validateBooleanParam('exactOnly', params.exactOnly);
    if ('error' in exactOnly) return exactOnly;
    const retired = rejectRetiredSyncParams(params);
    if (retired) return retired;
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
    const { GroupSyncLockError } = await import('./group-lock.js');
    let result: Awaited<ReturnType<typeof syncGroup>>;
    try {
      result = await syncGroup(config, {
        groupDir,
        exactOnly: exactOnly.value,
        // `verbose` is deliberately NOT accepted here. It gates diagnostics on
        // the server's logger, which an MCP caller cannot observe — advertising
        // it would be exactly the kind of knob that does not do what the caller
        // expects. `SyncOptions.verbose` stays for the CLI, which can see them.
      });
    } catch (err) {
      // Fails closed (R9): this sync could not be protected against a concurrent
      // one, so it did not run and wrote nothing. Return it through the same
      // error channel a missing group uses — NEVER as a success payload of zeroes,
      // which an agent would read as "the group genuinely has no contracts".
      if (!(err instanceof GroupSyncLockError)) throw err;
      return { error: err.message };
    }
    return {
      contracts: result.contracts.length,
      crossLinks: result.crossLinks.length,
      unmatched: result.unmatched.length,
      missingRepos: result.missingRepos,
      unreadableRepos: result.unreadableRepos,
      // The agent-facing half of the skipped-stage signal. A human sees it in
      // the CLI summary; without this an agent would have to issue a second
      // `group_contracts` call to discover its own sync was narrowed.
      suppressedMatchStages: result.suppressedMatchStages,
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
      suppressedMatchStages: registry.suppressedMatchStages,
      // An unrecorded `unreadableRepos` means this listing cannot say which
      // repos the sync failed to read — so it cannot claim to be complete.
      // Either kind of unreadable provenance forces the floor: a sync that
      // could not say which repos it read, or a suppression record that was
      // present and could not be parsed. Reading the second as "nothing was
      // suppressed" would report an unparseable registry as complete.
      provenanceUnknown: unreadableRepos === undefined || loaded.suppressionUnreadable,
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
      // Same omit-when-unrecorded rule, and deliberately NOT folded into the
      // truncation triple below: that triple reports limits a run hit by
      // accident, whose remedy is to fix the repo. A suppressed stage was
      // asked for, and its remedy is to re-sync without that flag.
      ...(registry.suppressedMatchStages
        ? { suppressedMatchStages: registry.suppressedMatchStages }
        : {}),
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
      // Only `resolveRepo` is inside the try that produces the
      // "did not resolve" label, so the label is earned rather than assumed.
      // `loadMeta` and `checkStaleness` cannot throw — the first returns null on
      // every error, the second catches everything — but the reading below them
      // can, and did: `registry.repoSnapshots` is read off a bare
      // `JSON.parse(...) as ContractRegistry` with no shape check, so a
      // contracts.json missing that field threw a TypeError into this catch and
      // reported every repo as an unresolvable GLOBAL-registry entry. That sent
      // the operator to repair the wrong file. The optional chain below closes
      // the crash; this split stops the next one being mislabelled the same way.
      try {
        const repoObj = await this.port.resolveRepo(registryName);
        const meta: Partial<Pick<RepoMeta, 'lastCommit' | 'indexedAt'>> =
          (await loadMeta(repoObj.storagePath)) ?? {};

        const staleness = meta.lastCommit
          ? checkStaleness(repoObj.repoPath, meta.lastCommit)
          : { isStale: true, commitsBehind: -1 };

        const snapshot = registry?.repoSnapshots?.[repoPath];
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
      // Same tri-state, same reason: `group status` is where an operator goes
      // to ask "is this group's answer trustworthy right now", and a registry
      // narrowed on purpose is a different answer from a complete one.
      suppressedMatchStages: recordedMatchStages(registry?.suppressedMatchStages),
      repos: repoStatuses,
    };
  }
}
