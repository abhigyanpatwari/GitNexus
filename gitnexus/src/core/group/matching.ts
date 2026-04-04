import type { StoredContract, CrossLink } from './types.js';

export interface MatchResult {
  matched: CrossLink[];
  unmatched: StoredContract[];
}

export interface WildcardMatchResult {
  matched: CrossLink[];
  remaining: StoredContract[];
}

function isGrpcWildcard(cid: string): boolean {
  return cid.startsWith('grpc::') && cid.endsWith('/*');
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
    case 'grpc': {
      const slashIdx = rest.indexOf('/');
      if (slashIdx > 0) {
        const pkg = rest.substring(0, slashIdx).toLowerCase();
        const method = rest.substring(slashIdx);
        return `grpc::${pkg}${method}`;
      }
      if (slashIdx === 0) {
        // Malformed "package/method" with leading slash — do not lowercase the whole string
        // (method segment is case-sensitive per spec).
        return `grpc::${rest}`;
      }
      // No slash: spec is ambiguous (package-only vs full service.method). MVP: lowercase
      // the whole token; differs from pkg/method split above where RPC method keeps case.
      return `grpc::${rest.toLowerCase()}`;
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

  return [];
}

export function buildProviderIndex(contracts: StoredContract[]): Map<string, StoredContract[]> {
  const providers = contracts.filter((c) => c.role === 'provider');
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
): MatchResult {
  const index = providerIndex ?? buildProviderIndex(contracts);

  // Skip gRPC wildcard consumers — they go to wildcard pass only
  const consumers = contracts.filter((c) => c.role === 'consumer' && !isGrpcWildcard(c.contractId));

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
    if (isGrpcWildcard(c.contractId)) return false; // excluded from exact, handled separately
    const id = `${c.repo}::${c.contractId}`;
    return c.role === 'provider' ? !matchedProviderIds.has(id) : !matchedConsumerIds.has(id);
  });

  // Re-add gRPC wildcard contracts — they were never in exact matching
  const grpcWildcards = contracts.filter((c) => isGrpcWildcard(c.contractId));
  const unmatched = [...normalUnmatched, ...grpcWildcards];

  return { matched, unmatched };
}

export function runWildcardMatch(
  unmatched: StoredContract[],
  providerIndex: Map<string, StoredContract[]>,
): WildcardMatchResult {
  const wildcardConsumers = unmatched.filter(
    (c) => c.role === 'consumer' && isGrpcWildcard(c.contractId),
  );
  const matched: CrossLink[] = [];
  const matchedConsumerIds = new Set<string>();

  for (const consumer of wildcardConsumers) {
    const normalized = normalizeContractId(consumer.contractId);
    // "grpc::com.example.userservice/*" → "com.example.userservice"
    // "grpc::userservice/*" → "userservice"
    const fqService = normalized.slice(normalized.indexOf('::') + 2, -2); // strip "grpc::" and "/*"

    for (const [key, providers] of providerIndex) {
      // Only match against non-wildcard gRPC providers (method-level IDs)
      if (!key.startsWith('grpc::') || key.endsWith('/*')) continue;
      const afterPrefix = key.slice(6); // strip "grpc::"
      const slashIdx = afterPrefix.indexOf('/');
      if (slashIdx < 0) continue;
      const providerFqService = afterPrefix.slice(0, slashIdx);

      // Match: exact FQ service, or bare-name match when consumer has no package
      const isMatch =
        providerFqService === fqService ||
        (!fqService.includes('.') && providerFqService.endsWith('.' + fqService));

      if (!isMatch) continue;

      for (const provider of providers) {
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
  }

  const remaining = unmatched.filter((c) => {
    if (c.role !== 'consumer' || !isGrpcWildcard(c.contractId)) return true;
    return !matchedConsumerIds.has(`${c.repo}::${c.contractId}`);
  });

  return { matched, remaining };
}
