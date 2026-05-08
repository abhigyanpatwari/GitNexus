import type { StoredContract, CrossLink, MatchingConfig } from './types.js';

export interface MatchResult {
  matched: CrossLink[];
  unmatched: StoredContract[];
}

export interface WildcardMatchResult {
  matched: CrossLink[];
  remaining: StoredContract[];
}

function isServiceWildcard(cid: string): boolean {
  return (cid.startsWith('grpc::') || cid.startsWith('thrift::')) && cid.endsWith('/*');
}

/**
 * Detect HTTP contracts that are too generic or infrastructure-level to
 * produce meaningful cross-repo links. These are still extracted (useful
 * for documentation / route maps) but excluded from cross-link matching.
 *
 * Two categories:
 * 1. Health-check / readiness endpoints — every service has one, matching
 *    them produces N×M false links.
 * 2. Param-only paths — routes like `/{param}` or `/{param}/{param}` that
 *    collapse to a single catch-all after normalization. These match any
 *    service with a similar shape, producing false positives.
 *
 * Both are configurable via matching.exclude_links_paths and
 * matching.exclude_links_param_only_paths in group.yaml.
 */
function buildNoisyContractFilter(
  matchingConfig?: MatchingConfig,
): (contractId: string) => boolean {
  const excludePaths = matchingConfig?.exclude_links_paths?.length
    ? new Set(matchingConfig.exclude_links_paths.map((p) => p.replace(/\/+$/, '')))
    : new Set<string>();
  const excludeParamOnly = matchingConfig?.exclude_links_param_only_paths === true;

  return function isNoisyHttpContract(contractId: string): boolean {
    if (!contractId.startsWith('http::')) return false;
    const parts = contractId.split('::');
    if (parts.length < 3) return false;
    const pathPart = parts.slice(2).join('::').replace(/\/+$/, '');
    if (excludePaths.has(pathPart)) return true;
    if (excludeParamOnly) {
      const segments = pathPart.split('/').filter(Boolean);
      if (segments.length > 0 && segments.every((s) => s === '{param}')) return true;
    }
    return false;
  };
}

export function normalizeContractId(id: string): string {
  const colonIdx = id.indexOf('::');
  if (colonIdx === -1) return id;

  const type = id.substring(0, colonIdx);
  const rest = id.substring(colonIdx + 2);

  switch (type) {
    case 'http': {
      const parts = rest.split('::');
      if (parts.length >= 2) {
        const method = parts[0].toUpperCase();
        let pathPart = parts.slice(1).join('::');
        pathPart = pathPart.replace(/\/+$/, '');
        return `http::${method}::${pathPart}`;
      }
      return id;
    }
    case 'grpc':
    case 'thrift': {
      // Canonical form: `<type>::<lowercased-package-or-service>[/<method>]`.
      //
      // The package/service segment is lowercased because gRPC package
      // names are effectively case-insensitive across language bindings
      // (`auth.AuthService`, `auth.authservice`, `AUTH.AUTHSERVICE` all
      // describe the same wire protocol service). The RPC method segment
      // is preserved as-is because the HTTP/2 path used on the wire is
      // case-sensitive per the gRPC spec (`/Service/MethodName`), and
      // method names in generated clients match the proto source exactly.
      //
      // A package-only id (no slash) and a package/method id are treated
      // as DISTINCT canonical forms: `grpc::userservice` does not match
      // `grpc::userservice/Login`. That's by design — callers that want
      // service-level manifest matching against method-level providers
      // should use the service wildcard form `grpc::UserService/*` or
      // `thrift::UserService/*` which is
      // handled by runWildcardMatch below.
      const slashIdx = rest.indexOf('/');
      if (slashIdx > 0) {
        const pkg = rest.substring(0, slashIdx).toLowerCase();
        const method = rest.substring(slashIdx);
        return `${type}::${pkg}${method}`;
      }
      if (slashIdx === 0) {
        // Malformed "/method" with leading slash — keep as-is so two
        // equally malformed ids can still match each other.
        return `${type}::${rest}`;
      }
      // No slash: package/service only. Lowercase to match the package
      // segment produced by the pkg/method branch above.
      return `${type}::${rest.toLowerCase()}`;
    }
    case 'topic':
      return `topic::${rest.trim().toLowerCase()}`;
    case 'lib':
      return `lib::${rest.toLowerCase()}`;
    default:
      return id;
  }
}

function findMatchingKeys(contractId: string, index: Map<string, StoredContract[]>): string[] {
  const normalized = normalizeContractId(contractId);
  if (index.has(normalized)) return [normalized];

  if (normalized.startsWith('http::*::')) {
    const pathPart = normalized.substring('http::*::'.length);
    const matches: string[] = [];
    for (const key of index.keys()) {
      if (key.startsWith('http::') && key.endsWith(`::${pathPart}`)) {
        matches.push(key);
      }
    }
    return matches;
  }

  if (normalized.startsWith('thrift::')) {
    const rest = normalized.substring('thrift::'.length);
    const slashIdx = rest.indexOf('/');
    if (slashIdx > 0) {
      const service = rest.substring(0, slashIdx);
      const method = rest.substring(slashIdx + 1);
      if (!service.includes('.') && method && method !== '*') {
        const matches: string[] = [];
        for (const key of index.keys()) {
          if (!key.startsWith('thrift::') || key.endsWith('/*')) continue;
          const providerRest = key.substring('thrift::'.length);
          const providerSlashIdx = providerRest.indexOf('/');
          if (providerSlashIdx < 0) continue;
          const providerService = providerRest.substring(0, providerSlashIdx);
          const providerMethod = providerRest.substring(providerSlashIdx + 1);
          if (providerMethod !== method) continue;
          if (providerService === service || providerService.endsWith('.' + service)) {
            matches.push(key);
          }
        }
        matches.sort();
        return matches.length === 1 ? matches : [];
      }
    }
  }

  return [];
}

export function buildProviderIndex(
  contracts: StoredContract[],
  matchingConfig?: MatchingConfig,
): Map<string, StoredContract[]> {
  const isNoisy = buildNoisyContractFilter(matchingConfig);
  const providers = contracts.filter((c) => c.role === 'provider' && !isNoisy(c.contractId));
  const index = new Map<string, StoredContract[]>();
  for (const p of providers) {
    const key = normalizeContractId(p.contractId);
    const list = index.get(key) || [];
    list.push(p);
    index.set(key, list);
  }
  return index;
}

export function runExactMatch(
  contracts: StoredContract[],
  providerIndex?: Map<string, StoredContract[]>,
  matchingConfig?: MatchingConfig,
): MatchResult {
  const isNoisy = buildNoisyContractFilter(matchingConfig);
  const index = providerIndex ?? buildProviderIndex(contracts, matchingConfig);

  // Skip service wildcard consumers — they go to wildcard pass only
  const consumers = contracts.filter(
    (c) => c.role === 'consumer' && !isServiceWildcard(c.contractId) && !isNoisy(c.contractId),
  );

  const matched: CrossLink[] = [];
  const matchedConsumerIds = new Set<string>();
  const matchedProviderIds = new Set<string>();

  for (const consumer of consumers) {
    const matchingKeys = findMatchingKeys(consumer.contractId, index);
    if (matchingKeys.length === 0) continue;

    const allMatchingProviders = matchingKeys.flatMap((k) => index.get(k) || []);
    for (const provider of allMatchingProviders) {
      if (provider.repo === consumer.repo) {
        if (!provider.service || !consumer.service || provider.service === consumer.service) {
          continue;
        }
      }

      matched.push({
        from: {
          repo: consumer.repo,
          service: consumer.service,
          symbolUid: consumer.symbolUid,
          symbolRef: consumer.symbolRef,
        },
        to: {
          repo: provider.repo,
          service: provider.service,
          symbolUid: provider.symbolUid,
          symbolRef: provider.symbolRef,
        },
        type: consumer.type,
        contractId: consumer.contractId,
        matchType: 'exact',
        confidence: 1.0,
      });

      matchedConsumerIds.add(`${consumer.repo}::${consumer.contractId}`);
      matchedProviderIds.add(`${provider.repo}::${provider.contractId}`);
    }
  }

  // normalUnmatched: contracts that weren't matched in exact pass
  const normalUnmatched = contracts.filter((c) => {
    if (isServiceWildcard(c.contractId)) return false; // excluded from exact, handled separately
    if (isNoisy(c.contractId)) return false; // excluded from matching — don't surface as unmatched
    const id = `${c.repo}::${c.contractId}`;
    return c.role === 'provider' ? !matchedProviderIds.has(id) : !matchedConsumerIds.has(id);
  });

  // Re-add service wildcard contracts — they were never in exact matching
  const serviceWildcards = contracts.filter((c) => isServiceWildcard(c.contractId));
  const unmatched = [...normalUnmatched, ...serviceWildcards];

  return { matched, unmatched };
}

export function runWildcardMatch(
  unmatched: StoredContract[],
  providerIndex: Map<string, StoredContract[]>,
): WildcardMatchResult {
  const wildcardConsumers = unmatched.filter(
    (c) => c.role === 'consumer' && isServiceWildcard(c.contractId),
  );
  const matched: CrossLink[] = [];
  const matchedConsumerIds = new Set<string>();

  for (const consumer of wildcardConsumers) {
    const normalized = normalizeContractId(consumer.contractId);
    const typeEnd = normalized.indexOf('::');
    const consumerType = normalized.slice(0, typeEnd);
    // "grpc::com.example.userservice/*" → "com.example.userservice"
    // "thrift::userservice/*" → "userservice"
    const fqService = normalized.slice(typeEnd + 2, -2); // strip "<type>::" and "/*"
    const candidateProviders: StoredContract[] = [];
    const matchedProviderServices = new Set<string>();

    for (const [key, providers] of providerIndex) {
      // Only match against non-wildcard same-type providers (method-level IDs).
      const keyTypeEnd = key.indexOf('::');
      if (keyTypeEnd < 0 || key.endsWith('/*')) continue;
      const providerType = key.slice(0, keyTypeEnd);
      if (providerType !== consumerType) continue;
      const afterPrefix = key.slice(keyTypeEnd + 2); // strip "<type>::"
      const slashIdx = afterPrefix.indexOf('/');
      if (slashIdx < 0) continue;
      const providerFqService = afterPrefix.slice(0, slashIdx);

      // Match: exact FQ service, or bare-name match when consumer has no package
      const isMatch =
        providerFqService === fqService ||
        (!fqService.includes('.') && providerFqService.endsWith('.' + fqService));

      if (!isMatch) continue;

      matchedProviderServices.add(providerFqService);
      candidateProviders.push(...providers);
    }

    if (consumerType === 'thrift' && !fqService.includes('.') && matchedProviderServices.size > 1) {
      continue;
    }

    for (const provider of candidateProviders) {
      // Skip same-repo same-service (same logic as runExactMatch)
      if (provider.repo === consumer.repo) {
        if (!provider.service || !consumer.service || provider.service === consumer.service) {
          continue;
        }
      }

      matched.push({
        from: {
          repo: consumer.repo,
          service: consumer.service,
          symbolUid: consumer.symbolUid,
          symbolRef: consumer.symbolRef,
        },
        to: {
          repo: provider.repo,
          service: provider.service,
          symbolUid: provider.symbolUid,
          symbolRef: provider.symbolRef,
        },
        type: consumer.type,
        contractId: consumer.contractId, // consumer's wildcard ID
        matchType: 'wildcard',
        confidence: Math.min(provider.confidence, consumer.confidence),
      });
      matchedConsumerIds.add(`${consumer.repo}::${consumer.contractId}`);
    }
  }

  const remaining = unmatched.filter((c) => {
    if (c.role !== 'consumer' || !isServiceWildcard(c.contractId)) return true;
    return !matchedConsumerIds.has(`${c.repo}::${c.contractId}`);
  });

  return { matched, remaining };
}
