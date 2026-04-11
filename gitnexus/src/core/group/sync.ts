import fs from 'node:fs/promises';
import path from 'node:path';
import { Buffer } from 'node:buffer';
import { initLbug, closeLbug, executeParameterized } from '../lbug/pool-adapter.js';
import { readRegistry, type RegistryEntry } from '../../storage/repo-manager.js';
import type { GroupConfig, RepoHandle, RepoSnapshot, StoredContract, CrossLink } from './types.js';
import { HttpRouteExtractor } from './extractors/http-route-extractor.js';
import { GrpcExtractor } from './extractors/grpc-extractor.js';
import { TopicExtractor } from './extractors/topic-extractor.js';
import { ManifestExtractor } from './extractors/manifest-extractor.js';
import { buildProviderIndex, runExactMatch, runWildcardMatch } from './matching.js';
import { detectServiceBoundaries, assignService } from './service-boundary-detector.js';
import type { CypherExecutor } from './contract-extractor.js';
import { writeBridge } from './bridge-db.js';
import { dedupeContracts, dedupeCrossLinks } from './normalization.js';

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
 * Per-repo failure kind captured during syncGroup. A non-empty array on
 * the result means at least one repo had something fail mid-pipeline; the
 * repo was NOT marked missing (we kept whatever the other steps produced),
 * but the user should see these to debug incomplete coverage.
 *
 * Label meanings:
 *  - `init`         — opening the per-repo LadybugDB pool failed; repo
 *                     gets added to missingRepos and the other steps are
 *                     skipped for that repo.
 *  - `boundaries`   — detectServiceBoundaries() threw; contracts are
 *                     still extracted but without service attribution.
 *  - `http|grpc|topic` — the named extractor threw; the other extractors
 *                     in the same repo still run.
 *  - `manifest`     — ManifestExtractor.extractFromManifest() threw.
 *  - `bridge_write` — a non-fatal error inside writeBridge (individual
 *                     contracts/links/snapshots that failed to insert).
 *                     The bridge is still written; `message` includes a
 *                     summary of the partial-failure counts.
 */
export type ExtractorKind =
  | 'init'
  | 'boundaries'
  | 'http'
  | 'grpc'
  | 'topic'
  | 'manifest'
  | 'bridge_write';

export interface ExtractorFailure {
  repo: string;
  extractor: ExtractorKind;
  message: string;
}

export interface SyncResult {
  contracts: StoredContract[];
  crossLinks: CrossLink[];
  unmatched: StoredContract[];
  missingRepos: string[];
  repoSnapshots: Record<string, RepoSnapshot>;
  /** Populated when individual extractors threw. See ExtractorFailure. */
  extractorFailures?: ExtractorFailure[];
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

function errMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  try {
    return String(err);
  } catch {
    return 'unknown error';
  }
}

export async function syncGroup(config: GroupConfig, opts?: SyncOptions): Promise<SyncResult> {
  const missingRepos: string[] = [];
  const repoSnapshots: Record<string, RepoSnapshot> = {};
  const extractorFailures: ExtractorFailure[] = [];
  let autoContracts: StoredContract[] = [];
  let dbExecutors: Map<string, CypherExecutor> | undefined;
  let manifestResult: Awaited<ReturnType<ManifestExtractor['extractFromManifest']>>;

  const eo = opts?.extractorOverride;
  if (eo && eo.length === 0) {
    autoContracts = await (eo as () => Promise<StoredContract[]>)();
    manifestResult = await new ManifestExtractor().extractFromManifest(config.links);
  } else {
    const entries = await readRegistry();
    const resolve = opts?.resolveRepoHandle ?? defaultResolveHandle(entries);
    const httpEx = new HttpRouteExtractor();
    const grpcEx = new GrpcExtractor();
    const topicEx = new TopicExtractor();
    dbExecutors = new Map<string, CypherExecutor>();
    const openPoolIds: string[] = [];

    try {
      for (const [groupPath, regName] of Object.entries(config.repos)) {
        const handle = await resolve(regName, groupPath);
        if (!handle) {
          missingRepos.push(groupPath);
          continue;
        }

        const poolId = handle.id;
        const lbugPath = path.join(handle.storagePath, 'lbug');

        // Step 1: open the per-repo LadybugDB pool. Failure here means the
        // repo itself is broken/unindexed — mark missing and skip entirely.
        try {
          await initLbug(poolId, lbugPath);
          openPoolIds.push(poolId);
        } catch (err) {
          missingRepos.push(groupPath);
          extractorFailures.push({
            repo: groupPath,
            extractor: 'init',
            message: errMessage(err),
          });
          continue;
        }

        const executor: CypherExecutor = (query, params) =>
          executeParameterized(poolId, query, params ?? {});

        dbExecutors.set(groupPath, executor);

        // Step 2: service boundary detection. Degrade gracefully to empty
        // boundaries on failure — contracts will still be extracted, just
        // without service attribution.
        let boundaries: Awaited<ReturnType<typeof detectServiceBoundaries>> = [];
        try {
          boundaries = await detectServiceBoundaries(handle.repoPath);
        } catch (err) {
          extractorFailures.push({
            repo: groupPath,
            extractor: 'boundaries',
            message: errMessage(err),
          });
        }

        // Step 3: run each extractor in isolation. One failure must not
        // cascade to the others in the same repo.
        if (config.detect.http) {
          try {
            const extracted = await httpEx.extract(executor, handle.repoPath, handle);
            for (const c of extracted) {
              autoContracts.push({
                ...c,
                repo: groupPath,
                service: assignService(c.symbolRef.filePath, boundaries),
              });
            }
          } catch (err) {
            extractorFailures.push({
              repo: groupPath,
              extractor: 'http',
              message: errMessage(err),
            });
          }
        }

        if (config.detect.grpc) {
          try {
            const extracted = await grpcEx.extract(executor, handle.repoPath, handle);
            for (const c of extracted) {
              autoContracts.push({
                ...c,
                repo: groupPath,
                service: assignService(c.symbolRef.filePath, boundaries),
              });
            }
          } catch (err) {
            extractorFailures.push({
              repo: groupPath,
              extractor: 'grpc',
              message: errMessage(err),
            });
          }
        }

        if (config.detect.topics) {
          try {
            const extracted = await topicEx.extract(executor, handle.repoPath, handle);
            for (const c of extracted) {
              autoContracts.push({
                ...c,
                repo: groupPath,
                service: assignService(c.symbolRef.filePath, boundaries),
              });
            }
          } catch (err) {
            extractorFailures.push({
              repo: groupPath,
              extractor: 'topic',
              message: errMessage(err),
            });
          }
        }

        // Step 4: read repo snapshot meta. Pre-existing fallback is fine.
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
      }

      try {
        manifestResult = await new ManifestExtractor().extractFromManifest(
          config.links,
          dbExecutors,
        );
      } catch (err) {
        extractorFailures.push({
          repo: '*',
          extractor: 'manifest',
          message: errMessage(err),
        });
        manifestResult = { contracts: [], crossLinks: [] };
      }
    } finally {
      for (const id of [...new Set(openPoolIds)]) {
        await closeLbug(id).catch(() => {});
      }
    }
  }

  autoContracts = dedupeContracts(autoContracts);
  manifestResult = {
    contracts: dedupeContracts(manifestResult.contracts),
    crossLinks: dedupeCrossLinks(manifestResult.crossLinks),
  };

  const providerIndex = buildProviderIndex(autoContracts);
  const { matched: exactLinks, unmatched } = runExactMatch(autoContracts, providerIndex);
  const { matched: wildcardLinks, remaining } = runWildcardMatch(unmatched, providerIndex);
  const crossLinks: CrossLink[] = dedupeCrossLinks([
    ...manifestResult.crossLinks,
    ...exactLinks,
    ...wildcardLinks,
  ]);
  const allContracts: StoredContract[] = dedupeContracts([
    ...manifestResult.contracts,
    ...autoContracts,
  ]);

  if (opts?.groupDir && !opts.skipWrite) {
    const writeReport = await writeBridge(opts.groupDir, {
      contracts: allContracts,
      crossLinks,
      repoSnapshots,
      missingRepos,
    });
    // Surface per-item write failures as sync-level extractorFailures so the
    // user sees them alongside extractor errors. Repo='*' because the error
    // is at the bridge layer, not tied to a single source repo.
    if (
      writeReport.contractsFailed > 0 ||
      writeReport.linksFailed > 0 ||
      writeReport.snapshotsFailed > 0
    ) {
      const summary =
        `bridge write: ${writeReport.contractsFailed} contracts, ` +
        `${writeReport.snapshotsFailed} snapshots, ` +
        `${writeReport.linksFailed} links failed to insert` +
        (writeReport.sampleErrors.length > 0
          ? `; first error: ${writeReport.sampleErrors[0].kind}[${writeReport.sampleErrors[0].id}]: ${writeReport.sampleErrors[0].message}`
          : '');
      extractorFailures.push({ repo: '*', extractor: 'bridge_write', message: summary });
    }
  }

  return {
    contracts: allContracts,
    crossLinks,
    unmatched: remaining,
    missingRepos,
    repoSnapshots,
    ...(extractorFailures.length > 0 ? { extractorFailures } : {}),
  };
}
