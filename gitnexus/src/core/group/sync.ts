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
import { extractRustWorkspaceLinks } from './extractors/rust-workspace-extractor.js';
import { runExactMatch } from './matching.js';
import { detectServiceBoundaries, assignService } from './service-boundary-detector.js';
import type { CypherExecutor } from './contract-extractor.js';
import { writeContractRegistry } from './storage.js';
import type { ContractRegistry } from './types.js';

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

export interface SyncResult {
  contracts: StoredContract[];
  crossLinks: CrossLink[];
  unmatched: StoredContract[];
  missingRepos: string[];
  repoSnapshots: Record<string, RepoSnapshot>;
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

export async function syncGroup(config: GroupConfig, opts?: SyncOptions): Promise<SyncResult> {
  const missingRepos: string[] = [];
  const repoSnapshots: Record<string, RepoSnapshot> = {};
  let autoContracts: StoredContract[] = [];
  let manifestCrossLinks: CrossLink[] = [];
  let dbExecutors: Map<string, CypherExecutor> | undefined;
  let registryEntries: RegistryEntry[] | undefined;

  const eo = opts?.extractorOverride;
  if (eo && eo.length === 0) {
    autoContracts = await (eo as () => Promise<StoredContract[]>)();
  } else {
    registryEntries = await readRegistry();
    const entries = registryEntries;
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
        try {
          await initLbug(poolId, lbugPath);
          openPoolIds.push(poolId);

          const executor: CypherExecutor = (query, params) =>
            executeParameterized(poolId, query, params ?? {});

          dbExecutors.set(groupPath, executor);

          const boundaries = await detectServiceBoundaries(handle.repoPath);

          if (config.detect.http) {
            const extracted = await httpEx.extract(executor, handle.repoPath, handle);
            for (const c of extracted) {
              autoContracts.push({
                ...c,
                repo: groupPath,
                service: assignService(c.symbolRef.filePath, boundaries),
              });
            }
          }

          if (config.detect.grpc) {
            const extracted = await grpcEx.extract(executor, handle.repoPath, handle);
            for (const c of extracted) {
              autoContracts.push({
                ...c,
                repo: groupPath,
                service: assignService(c.symbolRef.filePath, boundaries),
              });
            }
          }

          if (config.detect.topics) {
            const extracted = await topicEx.extract(executor, handle.repoPath, handle);
            for (const c of extracted) {
              autoContracts.push({
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
        } catch {
          missingRepos.push(groupPath);
        }
      }
    } finally {
      for (const id of [...new Set(openPoolIds)]) {
        await closeLbug(id).catch(() => {});
      }
    }
  }

  // Auto-discover workspace dependency contracts (Rust Cargo workspaces, etc.)
  // and merge them with explicit manifest links. Discovered links use the same
  // ManifestExtractor pipeline as hand-written links in group.yaml.
  let allLinks = [...config.links];

  if (config.detect.workspace_deps) {
    const repoPaths = new Map<string, string>();
    if (!registryEntries) registryEntries = await readRegistry();
    for (const [groupPath, regName] of Object.entries(config.repos)) {
      const e = registryEntries.find((en) => en.name === regName);
      if (e) repoPaths.set(groupPath, e.path);
    }

    const wsResult = await extractRustWorkspaceLinks(config.repos, repoPaths, dbExecutors);
    if (wsResult.links.length > 0) {
      allLinks = [...allLinks, ...wsResult.links];
      if (opts?.verbose) {
        console.log(
          `  workspace-deps: discovered ${wsResult.links.length} cross-crate links from ${wsResult.discoveredCrates.size} Rust crates`,
        );
      }
    }
  }

  // Process manifest links declared in group.yaml (plus any auto-discovered).
  // ManifestExtractor is fully implemented but was never wired into this
  // pipeline — config.links were parsed and validated but silently dropped.
  // Placed after the DB try/finally: resolveSymbol falls back to synthetic
  // UIDs when dbExecutors is undefined or a pool is closed, so cross-links
  // are always generated regardless of whether real DB executors are available.
  if (allLinks.length > 0) {
    const knownRepos = new Set(Object.keys(config.repos));
    for (const link of allLinks) {
      const dangling = [link.from, link.to].filter((r) => !knownRepos.has(r));
      if (dangling.length > 0) {
        console.warn(
          `[group/sync] manifest link ${link.type}:${link.contract} references repos not in config.repos: ${dangling.join(', ')} — cross-links will use synthetic UIDs`,
        );
      }
    }

    const manifestEx = new ManifestExtractor();
    const manifestResult = await manifestEx.extractFromManifest(allLinks, dbExecutors);
    autoContracts.push(...manifestResult.contracts);
    manifestCrossLinks = manifestResult.crossLinks;
    if (opts?.verbose) {
      console.log(
        `  manifest: ${manifestCrossLinks.length} cross-links from ${allLinks.length} links (${config.links.length} declared + ${allLinks.length - config.links.length} discovered)`,
      );
    }
  }

  const { matched, unmatched } = runExactMatch(autoContracts, undefined, config.matching);

  // Dedupe cross-links. Manifest contracts participate in runExactMatch, so a
  // manifest-declared link can also emit a matchType:'exact' CrossLink with the
  // same endpoints. Prefer the manifest version — it reflects operator intent
  // and carries matchType:'manifest' which downstream consumers may rely on.
  const crossLinks = dedupeCrossLinks([...manifestCrossLinks, ...matched]);
  const allContracts: StoredContract[] = autoContracts;

  const registry: ContractRegistry = {
    version: 1,
    generatedAt: new Date().toISOString(),
    repoSnapshots,
    missingRepos,
    contracts: allContracts,
    crossLinks,
  };

  if (opts?.groupDir && !opts.skipWrite) {
    await writeContractRegistry(opts.groupDir, registry);
  }

  return {
    contracts: allContracts,
    crossLinks,
    unmatched,
    missingRepos,
    repoSnapshots,
  };
}
