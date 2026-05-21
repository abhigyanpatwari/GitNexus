import { compile, match } from 'path-to-regexp';
import type { CrossLink, HttpMappingRule, StoredContract } from './types.js';
import { normalizeContractId } from './matching.js';

interface ParsedHttpContract {
  method: string;
  path: string;
}

interface CompiledHttpMappingRule {
  rule: HttpMappingRule;
  matchPath: ReturnType<typeof match<Record<string, string | string[]>>>;
  rewritePath: ReturnType<typeof compile>;
}

export interface HttpMappingMatchResult {
  matched: CrossLink[];
  matchedConsumerIds: Set<string>;
}

function parseHttpContractId(contractId: string): ParsedHttpContract | null {
  if (!contractId.startsWith('http::')) return null;
  const parts = contractId.split('::');
  if (parts.length < 3) return null;
  return {
    method: parts[1].toUpperCase(),
    path: parts.slice(2).join('::'),
  };
}

function getHttpContractParts(contract: StoredContract): ParsedHttpContract | null {
  if (contract.type !== 'http') return null;
  const meta = contract.meta as { method?: unknown; path?: unknown } | undefined;
  if (typeof meta?.method === 'string' && typeof meta?.path === 'string') {
    return {
      method: meta.method.toUpperCase(),
      path: meta.path,
    };
  }
  return parseHttpContractId(contract.contractId);
}

function providerIndexKey(contractId: string): string {
  return normalizeContractId(contractId);
}

function normalizeRewrittenPath(pathValue: string): string {
  const collapsed = pathValue.replace(/\/{2,}/g, '/');
  if (!collapsed.startsWith('/')) return `/${collapsed}`;
  return collapsed;
}

function compileRules(rules: HttpMappingRule[]): CompiledHttpMappingRule[] {
  return rules.map((rule) => ({
    rule,
    matchPath: match<Record<string, string | string[]>>(rule.match, { decode: decodeURIComponent }),
    rewritePath: compile(rule.rewrite, { encode: (value) => String(value) }),
  }));
}

function paramValue(value: string | string[]): string {
  return Array.isArray(value) ? value.join('/') : value;
}

export function applyHttpMappings(
  contracts: StoredContract[],
  rules: HttpMappingRule[],
): HttpMappingMatchResult {
  if (rules.length === 0) {
    return {
      matched: [],
      matchedConsumerIds: new Set<string>(),
    };
  }

  const compiledRules = compileRules(rules);
  const providers = contracts.filter(
    (contract) => contract.role === 'provider' && contract.type === 'http',
  );
  const providerIndex = new Map<string, StoredContract[]>();
  for (const provider of providers) {
    const key = providerIndexKey(provider.contractId);
    const existing = providerIndex.get(key) || [];
    existing.push(provider);
    providerIndex.set(key, existing);
  }

  const matched: CrossLink[] = [];
  const matchedConsumerIds = new Set<string>();

  for (const consumer of contracts) {
    if (consumer.role !== 'consumer' || consumer.type !== 'http') continue;

    const consumerKey = `${consumer.repo}::${consumer.contractId}`;
    const parts = getHttpContractParts(consumer);
    if (!parts) continue;

    for (const compiledRule of compiledRules) {
      const { rule } = compiledRule;
      if (rule.from !== consumer.repo) continue;
      if (rule.methods && !rule.methods.includes(parts.method)) continue;

      const matchResult = compiledRule.matchPath(parts.path);
      if (!matchResult) continue;

      if (
        rule.when &&
        Object.entries(rule.when).some(([key, expected]) => {
          const actual = matchResult.params[key];
          return actual === undefined || paramValue(actual) !== expected;
        })
      ) {
        continue;
      }

      const rewrittenPath = normalizeRewrittenPath(compiledRule.rewritePath(matchResult.params));
      const canonicalContractId = normalizeContractId(`http::${parts.method}::${rewrittenPath}`);
      const candidates = providerIndex
        .get(canonicalContractId)
        ?.filter((provider) => provider.repo === rule.to.repo)
        .filter((provider) => !rule.to.service || provider.service === rule.to.service)
        .filter((provider) => {
          if (provider.repo !== consumer.repo) return true;
          if (!provider.service || !consumer.service) return false;
          return provider.service !== consumer.service;
        });

      if (!candidates || candidates.length === 0) continue;

      matchedConsumerIds.add(consumerKey);
      for (const provider of candidates) {
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
          type: 'http',
          contractId: canonicalContractId,
          fromContractId: consumer.contractId,
          toContractId: provider.contractId,
          matchType: 'manifest',
          confidence: 1.0,
        });
      }

      break;
    }
  }

  return { matched, matchedConsumerIds };
}
