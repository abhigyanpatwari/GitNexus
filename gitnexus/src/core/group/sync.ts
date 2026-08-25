import fs from 'node:fs/promises';
import path from 'node:path';
import { Buffer } from 'node:buffer';
import {
  initLbug,
  executeParameterized,
  pinRepo,
  getMaxResidentRepos,
} from '../lbug/pool-adapter.js';
import {
  readRegistry,
  readRegistryStrict,
  type RegistryEntry,
} from '../../storage/repo-manager.js';
import type {
  GroupConfig,
  RepoHandle,
  RepoSnapshot,
  StoredContract,
  CrossLink,
  GroupManifestLink,
} from './types.js';
import { HttpRouteExtractor } from './extractors/http-route-extractor.js';
import { GrpcExtractor } from './extractors/grpc-extractor.js';
import { ThriftExtractor } from './extractors/thrift-extractor.js';
import { TopicExtractor } from './extractors/topic-extractor.js';
import { IncludeExtractor } from './extractors/include-extractor.js';
import { ManifestExtractor } from './extractors/manifest-extractor.js';
import { discoverWorkspaceLinks } from './extractors/workspace-extractor.js';
import { buildProviderIndex, runExactMatch, runWildcardMatch } from './matching.js';
import { detectServiceBoundaries, assignService } from './service-boundary-detector.js';
import type { CypherExecutor } from './contract-extractor.js';
import { readContractRegistry, writeContractRegistry } from './storage.js';
import { refreshPreservedBridgeMeta, writeBridge } from './bridge-db.js';
import { withGroupSyncLock } from './group-lock.js';
import type { ContractRegistry } from './types.js';

import { logger } from '../logger.js';
export interface SyncOptions {
  extractorOverride?:
    | ((repo: RepoHandle) => Promise<StoredContract[]>)
    | (() => Promise<StoredContract[]>);
  resolveRepoHandle?: (registryName: string, groupPath: string) => Promise<RepoHandle | null>;
  skipWrite?: boolean;
  groupDir?: string;
  allowStale?: boolean;
  verbose?: boolean;
  exactOnly?: boolean;
  skipEmbeddings?: boolean;
}

/**
 * What happened to `contracts.json` on a given sync.
 *
 * - `written`       — the contracts extracted by this run replaced the file.
 * - `preserved`     — nothing could be read, so the previous run's `contracts`,
 *                     `crossLinks` and `repoSnapshots` were kept verbatim and
 *                     only the diagnostic fields (`missingRepos` /
 *                     `unreadableRepos`) were refreshed to describe this run.
 * - `no-prior-registry` — nothing could be read AND there was no prior
 *                     contracts.json to carry forward (or it would not parse),
 *                     so nothing was written at all. Split out from
 *                     `preserved` because the operator-facing sentence differs:
 *                     telling someone their previous contracts are safe when
 *                     the group has never synced sends them looking for a file
 *                     that does not exist.
 * - `not-attempted` — the caller asked not to write (`skipWrite`, or no
 *                     `groupDir` was supplied).
 */
export type RegistryWriteOutcome = 'written' | 'preserved' | 'no-prior-registry' | 'not-attempted';

export interface SyncResult {
  contracts: StoredContract[];
  crossLinks: CrossLink[];
  unmatched: StoredContract[];
  /** Configured repos with no entry in the registry — index them or drop them. */
  missingRepos: string[];
  /**
   * Configured repos that ARE registered but that this sync could not extract
   * from: the index would not open, or an extractor threw partway. Either way
   * none of that repo's contracts are in `contracts`.
   */
  unreadableRepos: string[];
  repoSnapshots: Record<string, RepoSnapshot>;
  /**
   * What this sync did to `contracts.json`. Callers must not announce a write
   * they did not get: without this, `group sync` printed "Wrote contracts.json
   * (0 contracts, 0 cross-links)" about a file it had deliberately left alone.
   */
  registryOutcome: RegistryWriteOutcome;
}

export function stableRepoPoolId(entry: RegistryEntry, allEntries: RegistryEntry[]): string {
  const base = entry.name.toLowerCase();
  const resolved = path.resolve(entry.path);
  for (const other of allEntries) {
    if (other.name.toLowerCase() === base && path.resolve(other.path) !== resolved) {
      const hash = Buffer.from(entry.path).toString('base64url').slice(0, 6);
      return `${base}-${hash}`;
    }
  }
  return base;
}

function defaultResolveHandle(allEntries: RegistryEntry[]) {
  return async (registryName: string, groupPath: string): Promise<RepoHandle | null> => {
    const e = allEntries.find((en) => en.name === registryName);
    if (!e) return null;
    const poolId = stableRepoPoolId(e, allEntries);
    return {
      id: poolId,
      path: groupPath,
      repoPath: e.path,
      storagePath: e.storagePath,
    };
  };
}

/**
 * Dedupe cross-links that point from the same consumer endpoint to the same
 * provider endpoint for the same contract. Preserves first-seen order so the
 * caller controls precedence (e.g., pass manifest links first).
 */
function dedupeCrossLinks(links: CrossLink[]): CrossLink[] {
  const seen = new Set<string>();
  const out: CrossLink[] = [];
  for (const link of links) {
    const key = `${link.from.repo}::${link.from.symbolUid}|${link.to.repo}::${link.to.symbolUid}|${link.type}|${link.contractId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(link);
  }
  return out;
}

/** A batch of manifest links whose referenced in-group repos fit one resident window. */
export interface ManifestWindow {
  links: GroupManifestLink[];
  /** In-group repos (group paths) this window's links reference; size ≤ maxResident. */
  repos: Set<string>;
}

/**
 * Partition manifest links into windows so each window references at most
 * `maxResident` distinct in-group repos. Manifest resolution then materializes
 * only one window's repos at a time, bounding peak pool residency regardless of
 * group size (PR #2191 review, Finding 3 — windowed deferred resolution).
 *
 * Each link references ≤2 in-group repos, so every link fits a window when
 * `maxResident ≥ 2`. Links are pre-sorted by their referenced-repo key so links
 * sharing a repo land in contiguous windows — combined with release-not-close
 * pooling, a hub repo stays warm across the windows that reference it (its
 * lease is released, not closed, so the next window's initLbug fast-paths it).
 * Every link lands in EXACTLY one window (a true partition): downstream
 * dedupeCrossLinks dedupes cross-links but not contracts, so a link in two
 * windows would emit duplicate contracts nothing absorbs.
 *
 * Repos not in `knownRepos` (dangling / unresolved) add 0 to a window's repo
 * budget — the link is still placed (so it yields synthetic-UID contracts), it
 * just consumes no residency.
 */
export function partitionManifestWindows(
  links: GroupManifestLink[],
  knownRepos: Set<string>,
  maxResident: number,
): ManifestWindow[] {
  const reposOf = (l: GroupManifestLink): string[] =>
    [l.from, l.to].filter((r) => knownRepos.has(r));
  const sortKey = (l: GroupManifestLink): string => reposOf(l).slice().sort().join('\0');
  const sorted = [...links].sort((a, b) => sortKey(a).localeCompare(sortKey(b)));

  const windows: ManifestWindow[] = [];
  let cur: ManifestWindow | null = null;
  for (const link of sorted) {
    const refs = reposOf(link);
    if (cur) {
      const additional = refs.filter((r) => !cur!.repos.has(r)).length;
      if (cur.repos.size + additional > maxResident) {
        windows.push(cur);
        cur = null;
      }
    }
    if (!cur) cur = { links: [], repos: new Set<string>() };
    cur.links.push(link);
    for (const r of refs) cur.repos.add(r);
  }
  if (cur) windows.push(cur);
  return windows;
}

export async function syncGroup(config: GroupConfig, opts?: SyncOptions): Promise<SyncResult> {
  const missingRepos: string[] = [];
  // Repos that ARE registered but that we could not extract from — the index
  // would not open, or an extractor threw partway and the repo's staged
  // contracts were dropped. Kept separate from `missingRepos` because the two
  // need different answers from the operator: a missing repo must be indexed or
  // removed from the group, whereas this one is usually a version skew or a
  // lock and the logged error says which. Collapsing them (as this did) reports
  // a LadybugDB storage-version mismatch as "repo not found".
  const unreadableRepos: string[] = [];
  const repoSnapshots: Record<string, RepoSnapshot> = {};
  let autoContracts: StoredContract[] = [];
  const manifestCrossLinks: CrossLink[] = [];
  let registryEntries: RegistryEntry[] | undefined;

  // Group-path → pool identity for repos that successfully initialized. Drives
  // windowed manifest resolution below (re-init + lease per window). Keyed by
  // group path because manifest links reference repos by group path.
  const repoHandles = new Map<string, { poolId: string; lbugPath: string }>();
  // Every eviction lease this sync holds. Window loops release their own leases
  // (bounding residency); this set is the defensive outer-finally sweep —
  // release disposers are idempotent, so double-release is a safe no-op.
  const activeReleases = new Set<() => void>();

  try {
    const eo = opts?.extractorOverride;
    if (eo && eo.length === 0) {
      autoContracts = await (eo as () => Promise<StoredContract[]>)();
    } else {
      // Strict: an unreadable registry must not present as an empty one here.
      // `missingRepos` is derived from this list, and an all-missing sync is
      // allowed to write — so a lenient `[]` on EACCES/corruption would replace
      // a good contracts.json with an empty one and exit 0 (#3011, one frame up).
      registryEntries = await readRegistryStrict();
      const entries = registryEntries;
      const resolve = opts?.resolveRepoHandle ?? defaultResolveHandle(entries);
      const httpEx = new HttpRouteExtractor();
      const grpcEx = new GrpcExtractor();
      const thriftEx = new ThriftExtractor();
      const topicEx = new TopicExtractor();
      const includeEx = new IncludeExtractor();

      for (const [groupPath, regName] of Object.entries(config.repos)) {
        const handle = await resolve(regName, groupPath);
        if (!handle) {
          missingRepos.push(groupPath);
          continue;
        }

        const poolId = handle.id;
        const lbugPath = path.join(handle.storagePath, 'lbug');
        // Staged per repo, not appended straight to `autoContracts`. Extractors
        // run in sequence and any one of them can throw; appending as we go left
        // a repo whose HTTP extractor succeeded and whose gRPC extractor failed
        // contributing a partial set to the registry while the catch below told
        // the operator its "contracts are omitted from this sync". Per-repo
        // output is now all-or-nothing, which is what that message describes.
        const repoContracts: StoredContract[] = [];
        try {
          await initLbug(poolId, lbugPath);
          // No pin here: contract extraction below uses `executor` while this
          // repo is freshly initialized and live, and completes before the next
          // iteration's initLbug can trigger eviction (an in-flight query is
          // also checkedOut > 0 and thus eviction-immune). Deferred manifest
          // resolution no longer reuses these executors — it re-inits + leases
          // each repo per window (see windowed resolution below, issue #2189).
          // Record the pool identity so windowed resolution can re-init.
          repoHandles.set(groupPath, { poolId, lbugPath });

          const executor: CypherExecutor = (query, params) =>
            executeParameterized(poolId, query, params ?? {});

          const boundaries = await detectServiceBoundaries(handle.repoPath);

          if (config.detect.http) {
            const extracted = await httpEx.extract(executor, handle.repoPath, handle);
            for (const c of extracted) {
              repoContracts.push({
                ...c,
                repo: groupPath,
                service: assignService(c.symbolRef.filePath, boundaries),
              });
            }
          }

          if (config.detect.grpc) {
            const extracted = await grpcEx.extract(executor, handle.repoPath, handle);
            for (const c of extracted) {
              repoContracts.push({
                ...c,
                repo: groupPath,
                service: assignService(c.symbolRef.filePath, boundaries),
              });
            }
          }

          if (config.detect.thrift) {
            const extracted = await thriftEx.extract(executor, handle.repoPath, handle);
            for (const c of extracted) {
              repoContracts.push({
                ...c,
                repo: groupPath,
                service: assignService(c.symbolRef.filePath, boundaries),
              });
            }
          }

          if (config.detect.topics) {
            const extracted = await topicEx.extract(executor, handle.repoPath, handle);
            for (const c of extracted) {
              repoContracts.push({
                ...c,
                repo: groupPath,
                service: assignService(c.symbolRef.filePath, boundaries),
              });
            }
          }

          if (config.detect.includes) {
            const extracted = await includeEx.extract(executor, handle.repoPath, handle);
            for (const c of extracted) {
              repoContracts.push({
                ...c,
                repo: groupPath,
                service: assignService(c.symbolRef.filePath, boundaries),
              });
            }
          }

          const metaPath = path.join(handle.storagePath, 'meta.json');
          try {
            const raw = await fs.readFile(metaPath, 'utf-8');
            const m = JSON.parse(raw) as { indexedAt?: string; lastCommit?: string };
            repoSnapshots[groupPath] = {
              indexedAt: m.indexedAt || '',
              lastCommit: m.lastCommit || '',
            };
          } catch {
            const e = entries.find((en) => en.name === regName);
            repoSnapshots[groupPath] = {
              indexedAt: e?.indexedAt || '',
              lastCommit: e?.lastCommit || '',
            };
          }

          // Every enabled extractor for this repo succeeded — commit its
          // contracts. Reached only on the non-throwing path.
          //
          // Appended one at a time rather than spread. `push(...repoContracts)`
          // passes every staged contract as a separate ARGUMENT, and the engine
          // caps how many arguments one call may take — a cap set by the host's
          // available stack, so it is a different number on every machine.
          // Before staging, this line carried a single extractor's output; the
          // staging above makes it carry the whole repo's, which is enough for
          // a large repo to raise `RangeError: Maximum call stack size exceeded`
          // here. The throw lands in the catch below, so a repo whose contracts
          // all extracted cleanly gets reported as one whose index could not be
          // read. The loop bounds the append by memory instead.
          for (const contract of repoContracts) autoContracts.push(contract);
        } catch (err) {
          // This spans initLbug plus all contract extraction for the repo. The
          // error used to be discarded entirely, so the only trace of (say) a
          // storage-version mismatch was an empty contracts.json and a later
          // `group status` claiming the repo was missing. Surface it.
          // Pass the Error itself, not `err.message`: pino's default `err`
          // serializer captures `.stack` and `.cause` only from a real Error,
          // and nothing else in this catch retains the original — for a change
          // whose entire purpose is surfacing a swallowed error, discarding the
          // stack before logging it defeats the point.
          logger.warn(
            { err, repo: regName, groupPath, lbugPath },
            "⚠️ Could not read this repo's index; its contracts are omitted from this sync.",
          );
          unreadableRepos.push(groupPath);
          // Forget the handle recorded above (present only if the failure came
          // after initLbug). Deferred manifest resolution derives its known-repo
          // set from this map, so leaving the entry here re-opens a repo this
          // sync has just declared unreadable and resolves its symbols against
          // an index the same run says it could not read. Deleting an absent key
          // is a no-op, which is exactly the initLbug-threw case.
          repoHandles.delete(groupPath);
        }
      }
    }

    // Workspace discovery reads manifest files from disk (the per-ecosystem
    // extractors ignore dbExecutors), so it needs no pools resident. Manifest
    // resolution below re-inits + leases repos per window (issue #2189 review).
    let allLinks = [...config.links];

    if (config.detect.workspace_deps) {
      const repoPaths = new Map<string, string>();
      if (!registryEntries) registryEntries = await readRegistry();
      for (const [groupPath, regName] of Object.entries(config.repos)) {
        const e = registryEntries.find((en) => en.name === regName);
        if (e) repoPaths.set(groupPath, e.path);
      }

      const wsResult = await discoverWorkspaceLinks(config.repos, repoPaths, undefined);
      if (wsResult.links.length > 0) {
        allLinks = [...allLinks, ...wsResult.links];
        if (opts?.verbose) {
          for (const s of wsResult.stats) {
            logger.info(
              `  workspace-deps: discovered ${s.linkCount} cross-${s.ecosystem.toLowerCase()} links from ${s.projectCount} ${s.ecosystem} projects`,
            );
          }
        }
      }
    }

    if (allLinks.length > 0) {
      // knownRepos = repos that initialized AND extracted cleanly, NOT every
      // config.repos entry — a missing or failed repo has no handle (the catch
      // above deletes one it recorded), and intersecting against config keys
      // would try to initLbug an undefined path.
      const knownRepos = new Set(repoHandles.keys());
      // Endpoints this sync could not read. Kept separate from `dangling`
      // because the two need different answers from the operator — and because
      // what happens to their contracts differs: a dangling endpoint still
      // yields a synthetic-UID contract, an unreadable one yields nothing.
      const unreadable = new Set(unreadableRepos);
      for (const link of allLinks) {
        const endpoints = [link.from, link.to];
        // "not in config.repos" has to stay literally true. An unreadable repo
        // IS configured; telling the operator it is not sends them to edit
        // group.yaml for a problem that only re-indexing fixes.
        const dangling = endpoints.filter((r) => !knownRepos.has(r) && !unreadable.has(r));
        if (dangling.length > 0) {
          logger.warn(
            `[group/sync] manifest link ${link.type}:${link.contract} references repos not in config.repos: ${dangling.join(', ')} — cross-links will use synthetic UIDs`,
          );
        }
        const unreadableEndpoints = endpoints.filter((r) => unreadable.has(r));
        if (unreadableEndpoints.length > 0) {
          logger.warn(
            `[group/sync] manifest link ${link.type}:${link.contract} references repos this sync could not read: ${unreadableEndpoints.join(', ')} — their contracts and this link's cross-link are omitted from this sync`,
          );
        }
      }

      const manifestEx = new ManifestExtractor();
      const windows = partitionManifestWindows(allLinks, knownRepos, getMaxResidentRepos());

      // Resolve one window at a time: re-init + lease only the window's repos,
      // resolve its links, then RELEASE (not close) the leases. Released repos
      // become evictable and the pool's LRU reclaims them — bounding peak
      // residency to ≤ getMaxResidentRepos() distinct repos per window while
      // avoiding teardown of an entry a concurrent MCP reader may share
      // (PR #2191 review, Findings 1 & 3).
      for (const window of windows) {
        const windowReleases: Array<() => void> = [];
        try {
          const windowExecutors = new Map<string, CypherExecutor>();
          const leasedPoolIds = new Set<string>();
          for (const groupPath of window.repos) {
            const h = repoHandles.get(groupPath);
            if (!h) continue;
            // Lease each distinct poolId once (two group paths can share one
            // poolId); build a per-group-path executor either way.
            if (!leasedPoolIds.has(h.poolId)) {
              await initLbug(h.poolId, h.lbugPath);
              const release = pinRepo(h.poolId);
              windowReleases.push(release);
              activeReleases.add(release);
              leasedPoolIds.add(h.poolId);
            }
            windowExecutors.set(groupPath, (query, params) =>
              executeParameterized(h.poolId, query, params ?? {}),
            );
          }

          const windowResult = await manifestEx.extractFromManifest(window.links, windowExecutors);
          // Drop by ENDPOINT, not by link. `ManifestExtractor` resolves both
          // endpoints of a link and emits a contract for each, so discarding a
          // link whose provider is unreadable would delete the consumer repo's
          // contract as well — a healthy repo losing its own output because a
          // neighbour's index would not open. The repo that could not be read
          // is the only thing that goes.
          //
          // A cross-link is an assertion about a PAIR, so it needs both ends: if
          // either endpoint is unreadable there is nothing left to anchor it to,
          // and a half-anchored link is precisely the confident-about-what-it-
          // could-not-read answer the registry must not give.
          autoContracts.push(...windowResult.contracts.filter((c) => !unreadable.has(c.repo)));
          manifestCrossLinks.push(
            ...windowResult.crossLinks.filter(
              (l) => !unreadable.has(l.from.repo) && !unreadable.has(l.to.repo),
            ),
          );
        } finally {
          for (const release of windowReleases) {
            release();
            activeReleases.delete(release);
          }
        }
      }

      if (opts?.verbose) {
        logger.info(
          `  manifest: ${manifestCrossLinks.length} cross-links from ${allLinks.length} links (${config.links.length} declared + ${allLinks.length - config.links.length} discovered) across ${windows.length} window(s)`,
        );
      }
    }
  } finally {
    // Defensive sweep: a window releases its own leases in its finally, so in
    // normal flow nothing is held here. This catches a lease still held if a
    // window threw before its finally ran. Release disposers are idempotent, so
    // double-release is a no-op. Repos are NOT closed — released repos are
    // evictable and LRU reclaims them (avoids stomping a concurrent reader).
    for (const release of activeReleases) release();
  }

  const providerIndex = buildProviderIndex(autoContracts, config.matching);
  const { matched, unmatched } = runExactMatch(autoContracts, providerIndex, config.matching);
  const wildcard = runWildcardMatch(unmatched, providerIndex);

  // Dedupe cross-links. Manifest contracts participate in runExactMatch, so a
  // manifest-declared link can also emit a matchType:'exact' CrossLink with the
  // same endpoints. Prefer the manifest version — it reflects operator intent
  // and carries matchType:'manifest' which downstream consumers may rely on.
  const crossLinks = dedupeCrossLinks([...manifestCrossLinks, ...matched, ...wildcard.matched]);
  const allContracts: StoredContract[] = autoContracts;

  const registry: ContractRegistry = {
    version: 1,
    generatedAt: new Date().toISOString(),
    repoSnapshots,
    missingRepos,
    // Always recorded, including when empty. The field is optional on the TYPE
    // so a registry written before it existed still parses, and absence there
    // means "not recorded" — but this run DID measure it, and `[]` is that
    // measurement. Omitting the empty case made "measured, none" unreachable:
    // every clean sync produced a registry that `group status` then reported as
    // not recorded, telling the operator to re-run the sync that had just
    // succeeded. The tri-state only works if the writer commits to it.
    unreadableRepos,
    contracts: allContracts,
    crossLinks,
  };

  // Every repo we tried to read failed. There is no basis on which to replace
  // the existing registry — the extraction produced nothing because nothing
  // could be read, not because the repos share no contracts. Writing here
  // destroys a good contracts.json and reports success, so refuse: the prior
  // registry stays on disk and the caller sees `unreadableRepos` populated.
  const configuredRepoCount = Object.keys(config.repos).length;
  const everyRepoFailed =
    unreadableRepos.length > 0 &&
    unreadableRepos.length + missingRepos.length === configuredRepoCount;

  // Both the warning and the guard belong to the persisting path only. Gating
  // just on `everyRepoFailed` told a `skipWrite` caller that an existing
  // contracts.json was being left untouched — about a file the call was never
  // going to touch, and which for most dry-run callers does not exist.
  const groupDir = opts?.groupDir;
  const persisting = Boolean(groupDir) && !opts?.skipWrite;
  let registryOutcome: RegistryWriteOutcome = 'not-attempted';

  // R9: from here to the end of the persist section is the critical section —
  // the re-read of the prior registry, `contracts.json`, and the bridge rebuild.
  // Two syncs of one group that overlap here do not merge; the later write simply
  // replaces the earlier one. Acquired EXACTLY ONCE, here: `acquireIndexLock` is
  // not reentrant, and nothing below this point takes the same lock (a second
  // acquisition would deadlock on the happy path, not on an edge case). A sync
  // that cannot be protected throws instead of running — see group-lock.ts.
  //
  // A non-persisting run (no `groupDir`, or `skipWrite`) writes nothing, so it
  // takes no lock and cannot be blocked by one.
  if (groupDir && persisting) {
    await withGroupSyncLock(groupDir, async () => {
      if (everyRepoFailed) {
        // A targeted skip, not a total one. Refusing to write at all kept the good
        // contracts but also threw away the diagnostic describing the run that just
        // happened: `group status` then read the PREVIOUS sync's file, found no
        // `unreadableRepos`, and reported a healthy group — or, worse, printed the
        // previous run's unreadable list as if it were this one's.
        //
        // So carry `contracts` / `crossLinks` / `repoSnapshots` forward verbatim and
        // refresh only the two diagnostic fields. `generatedAt` is carried forward
        // too: it dates the contracts, which are still the previous run's, and
        // moving it would claim this run produced them.
        //
        // If the prior file is absent (null) or unparseable (throws), write nothing
        // — an unreadable prior registry is not a thing to rewrite from.
        //
        // The warning is emitted from INSIDE this branch, after the prior registry
        // has been resolved, because which of the two sentences is true depends on
        // what was found here. Emitted before the read it could only promise one of
        // them, and it promised the wrong one to every group that has never synced:
        // "keeping the contracts from the previous sync" about a file that does not
        // exist — while the console line for the same run, driven by
        // `registryOutcome`, said the opposite. The two now agree by construction:
        // one message per outcome, chosen where the outcome is decided.
        const prior = await readContractRegistry(groupDir).catch(() => null);
        if (prior) {
          await writeContractRegistry(groupDir, { ...prior, missingRepos, unreadableRepos });
          registryOutcome = 'preserved';
          logger.warn(
            { unreadableRepos, missingRepos },
            '⚠️ No repo in this group could be read; kept the contracts from the previous sync. ' +
              "Only contracts.json's unreadable/missing repo lists were refreshed to describe this run.",
          );
        } else {
          registryOutcome = 'no-prior-registry';
          logger.warn(
            { unreadableRepos, missingRepos },
            '⚠️ No repo in this group could be read, and there is no previous contracts.json ' +
              'to fall back on; nothing was written to it.',
          );
        }
        // The bridge DATABASE is deliberately untouched: it still matches the
        // contracts that were preserved, so rebuilding it here would be the one
        // write that could lose them.
        //
        // Its METADATA is a different file and a different question. `meta.json` —
        // not contracts.json — is where `runGroupImpact` reads completeness from, so
        // refreshing one and not the other left them telling different stories: the
        // registry said "this sync could not read app/backend" while a cross-repo
        // query answered `{ cross: [], truncated: false }`, i.e. fully accounted for.
        //
        // `refreshPreservedBridgeMeta` updates the same two diagnostic fields there,
        // and — because this rewrite moves meta.json's mtime and would otherwise
        // launder a pair the write-order rule had been rejecting — records an
        // explicit `provenanceUnknown` marker whenever the existing pair does not
        // already check out. It re-stamps only a pair that already matched, so no
        // preserve run can ever increase the number of pairs that pass the check.
        //
        // Not wrapped in a catch, unlike `writeBridge` on the success path below:
        // there contracts.json is canonical and already written, so a stale bridge
        // is a recoverable degradation. Here the write IS the guard against a
        // confident wrong answer, and swallowing its failure would reinstate the
        // very fail-open it closes. `writeContractRegistry` above is unguarded for
        // the same reason, into the same directory.
        await refreshPreservedBridgeMeta(groupDir, { missingRepos, unreadableRepos });
      }

      if (!everyRepoFailed) {
        await writeContractRegistry(groupDir, registry);
        registryOutcome = 'written';
        // writeBridge failure (disk full, schema error, permission denied) must
        // not mask the registry — contracts.json was just written successfully
        // and is the canonical source of truth. A stale or absent bridge
        // degrades cross-repo queries to the previous sync's answers (or, with no
        // bridge at all, to an error naming the missing file), which is recoverable
        // on the next sync. Surface the failure as a warning so operators can
        // act, but do not propagate it.
        // (PR #1156 follow-up review: writeBridge error in sync.ts propagates
        // uncaught.)
        try {
          await writeBridge(groupDir, {
            contracts: allContracts,
            crossLinks,
            repoSnapshots,
            missingRepos,
            unreadableRepos,
          });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          // Says what this branch guarantees, and stops at that. The previous
          // wording promised that cross-repo impact would report `truncated` until
          // a sync succeeded — a signal nothing here produces: a failed writeBridge
          // leaves the previous sync's database beside the metadata stamped for it,
          // so the pair still checks out and the completeness fields still describe
          // the run that wrote them. Re-stamping that metadata to make the promise
          // true is the one thing not to do — it would recreate exactly the
          // metadata/database mis-pairing the stamping on the preserve path above
          // exists to prevent.
          logger.warn(
            { err: msg, groupDir },
            '⚠️ writeBridge failed; contracts.json is intact and is the canonical copy, ' +
              'but bridge.lbug was not replaced: cross-repo queries may still answer from ' +
              "the previous sync's contracts, and nothing marks them as superseded. " +
              'Re-run `gitnexus group sync` to retry.',
          );
        }
      }
    });
  }

  return {
    contracts: allContracts,
    crossLinks,
    unmatched: wildcard.remaining,
    missingRepos,
    unreadableRepos,
    repoSnapshots,
    registryOutcome,
  };
}
