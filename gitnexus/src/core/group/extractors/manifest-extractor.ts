import type { ContractType, CrossLink, GroupManifestLink, StoredContract } from '../types.js';
import type { CypherExecutor } from '../contract-extractor.js';

export interface ManifestExtractResult {
  contracts: StoredContract[];
  crossLinks: CrossLink[];
}

/**
 * Canonicalize an HTTP path for matching against Route.name in the graph.
 * Mirrors core/ingestion/pipeline.ts ensureSlash semantics:
 * - Ensures a leading slash.
 * - Strips trailing slashes (except the root "/").
 * - Normalizes consecutive slashes.
 * - Does NOT lowercase (route matching is case-sensitive).
 */
function normalizeRoutePath(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return '/';
  const withLeading = trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
  const collapsed = withLeading.replace(/\/+/g, '/');
  if (collapsed === '/') return '/';
  return collapsed.replace(/\/+$/, '');
}

/**
 * Stable synthetic symbolUid for a manifest-declared contract whose target
 * symbol could not be resolved against the per-repo graph (resolveSymbol
 * returned null). Two reasons we don't leave the uid empty:
 *
 *  1. The bridge stores Contract nodes keyed in part by symbolUid; an empty
 *     uid means downstream Cypher queries that anchor on `provider.symbolUid`
 *     can't tell two different unresolved manifest contracts apart.
 *  2. The cross-impact bridge query in cross-impact.ts joins local impact
 *     results to bridge contracts via `WHERE provider.symbolUid IN $localUids`.
 *     If the local impact engine produces a deterministic identifier for the
 *     unresolved target, it must agree with the value the bridge stored. A
 *     synthetic uid keyed off (repo, contractId) is the only thing both sides
 *     can derive without knowing about each other.
 *
 * Format: `manifest::<repo>::<contractId>`. Stable across syncs, scoped to a
 * single repo within a group, and never collides with real indexer uids
 * (which never start with `manifest::`).
 */
export function manifestSymbolUid(repo: string, contractId: string): string {
  return `manifest::${repo}::${contractId}`;
}

export class ManifestExtractor {
  async extractFromManifest(
    links: GroupManifestLink[],
    dbExecutors?: Map<string, CypherExecutor>,
  ): Promise<ManifestExtractResult> {
    const contracts: StoredContract[] = [];
    const crossLinks: CrossLink[] = [];

    for (const link of links) {
      const contractId = this.buildContractId(link.type, link.contract);

      const providerRepo = link.role === 'provider' ? link.from : link.to;
      const consumerRepo = link.role === 'provider' ? link.to : link.from;

      const providerSymbol = await this.resolveSymbol(providerRepo, link, dbExecutors);
      const consumerSymbol = await this.resolveSymbol(consumerRepo, link, dbExecutors);
      const providerRef = providerSymbol || { filePath: '', name: link.contract };
      const consumerRef = consumerSymbol || { filePath: '', name: link.contract };
      // When the resolver finds a real graph symbol we keep its uid, otherwise
      // fall back to the deterministic synthetic uid (see manifestSymbolUid).
      const providerUid = providerSymbol?.uid || manifestSymbolUid(providerRepo, contractId);
      const consumerUid = consumerSymbol?.uid || manifestSymbolUid(consumerRepo, contractId);

      contracts.push({
        contractId,
        type: link.type,
        role: 'provider',
        symbolUid: providerUid,
        symbolRef: providerRef,
        symbolName: link.contract,
        confidence: 1.0,
        meta: { source: 'manifest' },
        repo: providerRepo,
      });

      contracts.push({
        contractId,
        type: link.type,
        role: 'consumer',
        symbolUid: consumerUid,
        symbolRef: consumerRef,
        symbolName: link.contract,
        confidence: 1.0,
        meta: { source: 'manifest' },
        repo: consumerRepo,
      });

      crossLinks.push({
        from: { repo: consumerRepo, symbolUid: consumerUid, symbolRef: consumerRef },
        to: { repo: providerRepo, symbolUid: providerUid, symbolRef: providerRef },
        type: link.type,
        contractId,
        matchType: 'manifest',
        confidence: 1.0,
      });
    }

    return { contracts, crossLinks };
  }

  private async resolveSymbol(
    repoPathKey: string,
    link: GroupManifestLink,
    dbExecutors?: Map<string, CypherExecutor>,
  ): Promise<{ filePath: string; name: string; uid: string } | null> {
    const executor = dbExecutors?.get(repoPathKey);
    if (!executor) return null;

    // NOTE: All lookups use EXACT equality on the relevant name field and
    // deterministic ORDER BY before LIMIT 1. Previous versions used CONTAINS
    // for fuzzy matching (plus an unconditional ".proto" fallback for gRPC)
    // which produced silent false positives: e.g. manifest "/orders" would
    // match "/suborders", and a gRPC manifest entry in a repo with any
    // .proto file would attach to a random proto symbol.
    //
    // If resolveSymbol returns null, the extractor falls back to a
    // deterministic synthetic uid via `manifestSymbolUid(repo, contractId)`
    // (see the function's docstring for why synthetic rather than empty).
    // Cross-impact still works: the bridge query joins on the synthetic
    // uid, and the local impact engine derives the same uid for the
    // unresolved symbol — name-based hints are the additional safety net.
    try {
      let rows: Record<string, unknown>[];
      if (link.type === 'http') {
        // Route.name is the canonicalized URL path (see
        // core/ingestion/pipeline.ts ensureSlash + generateId('Route', ...)).
        // Normalize the manifest contract the same way so a user-written
        // "/api/orders" matches "api/orders" in the graph.
        const normalized = normalizeRoutePath(link.contract);
        rows = await executor(
          `MATCH (handler)-[r:CodeRelation {type: 'HANDLES_ROUTE'}]->(route:Route)
           WHERE route.name = $normalized
           RETURN handler.id AS uid, handler.name AS name, handler.filePath AS filePath
           ORDER BY handler.filePath ASC
           LIMIT 1`,
          { normalized },
        );
      } else if (link.type === 'topic') {
        // Topic names aren't a first-class NodeLabel in the graph —
        // topics are referenced by function/method symbols (Kafka
        // listeners, publishers). Restrict to symbol-like labels to
        // avoid cross-matching Files/Variables/Imports that happen to
        // share the topic name.
        rows = await executor(
          `MATCH (n:Function|Method|Class|Interface) WHERE n.name = $contract
           RETURN n.id AS uid, n.name AS name, n.filePath AS filePath
           ORDER BY n.filePath ASC
           LIMIT 1`,
          { contract: link.contract },
        );
      } else if (link.type === 'grpc') {
        // Contract is "Service/Method" or just "Service" (or package.Service
        // variants). Prefer matching by method name when present, otherwise
        // by service name. NO .proto path fallback — that's guaranteed to
        // return a wrong symbol in any repo with more than one proto file.
        // Label filters scope lookups: methods → Function|Method, services
        // → Class|Interface (no label match = no silent wrong hits on
        // File/Variable nodes that happen to share the name).
        const parts = link.contract.split('/');
        const serviceName = parts[0]?.trim() ?? '';
        const methodName = parts[1]?.trim() ?? '';
        if (methodName) {
          rows = await executor(
            `MATCH (n:Function|Method) WHERE n.name = $methodName
             RETURN n.id AS uid, n.name AS name, n.filePath AS filePath
             ORDER BY n.filePath ASC
             LIMIT 1`,
            { methodName },
          );
        } else if (serviceName) {
          rows = await executor(
            `MATCH (n:Class|Interface) WHERE n.name = $serviceName
             RETURN n.id AS uid, n.name AS name, n.filePath AS filePath
             ORDER BY n.filePath ASC
             LIMIT 1`,
            { serviceName },
          );
        } else {
          rows = [];
        }
      } else if (link.type === 'lib') {
        // Only exact match on the symbol's name. Previous fallback to
        // CONTAINS on n.filePath would promote "react" to "react-native"
        // or "@types/react" — silent wrong attribution. Restrict to
        // package-level labels so we don't return arbitrary symbols
        // named after a library.
        rows = await executor(
          `MATCH (n:Package|Module) WHERE n.name = $contract
           RETURN n.id AS uid, n.name AS name, n.filePath AS filePath
           ORDER BY n.filePath ASC
           LIMIT 1`,
          { contract: link.contract },
        );
      } else {
        return null;
      }
      if (rows.length > 0) {
        return {
          filePath: rows[0].filePath as string,
          name: rows[0].name as string,
          uid: String(rows[0].uid ?? ''),
        };
      }
    } catch (err) {
      // Log but don't throw: a broken graph query in one repo shouldn't
      // fail the whole manifest extraction. Unresolved contracts still
      // get a synthetic symbolUid below, so cross-impact can proceed.
      const message = err instanceof Error ? err.message : String(err);
      console.warn(
        `[manifest-extractor] resolveSymbol failed for ${link.type}:${link.contract} ` +
          `in ${repoPathKey}: ${message}`,
      );
    }
    return null;
  }

  /**
   * Build a canonical contract id for a manifest link.
   *
   * HTTP is the only type with two valid forms:
   *   - Explicit method: `"GET::/api/orders"` → `"http::GET::/api/orders"`
   *     (matches exactly against `HttpRouteExtractor` provider/consumer
   *     contracts, which are also keyed by `http::<METHOD>::<path>`).
   *   - Method-agnostic: `"/api/orders"` → `"http::*::/api/orders"`
   *     — the `*` is a wildcard and is intended to match any concrete
   *     HTTP method on that path. Wildcard-aware matching is the
   *     responsibility of the sync / cross-impact layer (see #793);
   *     downstream code should treat `http::*::<path>` as matching
   *     every `http::<METHOD>::<path>` for the same path.
   *
   * Recommend the explicit-method form in group.yaml whenever the
   * manifest author knows the method — it round-trips through exact
   * equality matching without requiring wildcard logic downstream.
   *
   * NOTE on exhaustiveness: the switch covers every current
   * `ContractType` variant and falls through to a `never` assertion so
   * TypeScript fails the build if a new variant is added without a
   * corresponding case.
   */
  private buildContractId(type: ContractType, contract: string): string {
    switch (type) {
      case 'http': {
        if (/^[A-Za-z]+::/.test(contract)) return `http::${contract}`;
        return `http::*::${contract}`;
      }
      case 'grpc':
        return `grpc::${contract}`;
      case 'topic':
        return `topic::${contract}`;
      case 'lib':
        return `lib::${contract}`;
      case 'custom':
        return `custom::${contract}`;
      default: {
        const _exhaustive: never = type;
        throw new Error(`Unhandled ContractType: ${String(_exhaustive)}`);
      }
    }
  }
}
