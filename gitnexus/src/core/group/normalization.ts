import type { CrossLink, CrossLinkEndpoint, StoredContract } from './types.js';

function contractKey(contract: StoredContract): string {
  return [contract.repo, contract.contractId, contract.role, contract.symbolRef.filePath].join(
    '\0',
  );
}

function endpointKey(endpoint: CrossLinkEndpoint): string {
  return [
    endpoint.repo,
    endpoint.service ?? '',
    endpoint.symbolRef.filePath,
    endpoint.symbolRef.name,
  ].join('\0');
}

/**
 * Score a contract by how much information it carries, so `dedupeContracts`
 * can prefer the "richer" record when two contracts collide on the same
 * `(repo, contractId, role, filePath)` key.
 *
 * Weights express a priority ordering, not calibrated probabilities:
 *   +3 — `symbolUid` resolved (tier 1 of the downstream lookup — highest
 *        signal because it's the strongest anchor for cross-impact traversal
 *        and the only one that's robust to renames)
 *   +2 — any of `filePath`, `symbolRef.name`, or `symbolName` that's more
 *        specific than the contractId itself (tier 2 signal — resolves
 *        uniquely in most cases and survives across syncs)
 *   +1 — `service` tag (monorepo attribution — useful but not sufficient
 *        on its own) or non-manifest origin (auto-extracted contracts are
 *        preferred over manifest-declared synthetic ones because the former
 *        are grounded in real source code)
 *
 * The absolute numbers don't matter, only their relative ordering.
 */
function contractRichness(contract: StoredContract): number {
  let score = 0;
  if (contract.symbolUid) score += 3;
  if (contract.symbolRef.filePath) score += 2;
  if (contract.symbolRef.name && contract.symbolRef.name !== contract.contractId) score += 2;
  if (contract.symbolName && contract.symbolName !== contract.contractId) score += 2;
  if (contract.service) score += 1;
  if (contract.meta.source !== 'manifest') score += 1;
  return score;
}

function mergeContracts(existing: StoredContract, incoming: StoredContract): StoredContract {
  const [primary, secondary] =
    contractRichness(incoming) > contractRichness(existing)
      ? [incoming, existing]
      : [existing, incoming];
  const symbolRefName = primary.symbolRef.name || secondary.symbolRef.name;
  return {
    ...secondary,
    ...primary,
    symbolUid: primary.symbolUid || secondary.symbolUid,
    symbolRef: {
      filePath: primary.symbolRef.filePath || secondary.symbolRef.filePath,
      name: symbolRefName,
    },
    symbolName: primary.symbolName || secondary.symbolName || symbolRefName,
    confidence: Math.max(existing.confidence, incoming.confidence),
    service: primary.service ?? secondary.service,
    meta: { ...secondary.meta, ...primary.meta },
  };
}

function mergeEndpoints(
  existing: CrossLinkEndpoint,
  incoming: CrossLinkEndpoint,
): CrossLinkEndpoint {
  return {
    repo: existing.repo,
    service: existing.service ?? incoming.service,
    symbolUid: existing.symbolUid || incoming.symbolUid,
    symbolRef: {
      filePath: existing.symbolRef.filePath || incoming.symbolRef.filePath,
      name: existing.symbolRef.name || incoming.symbolRef.name,
    },
  };
}

function crossLinkKey(link: CrossLink): string {
  return [
    link.type,
    link.contractId,
    link.matchType,
    endpointKey(link.from),
    endpointKey(link.to),
  ].join('\0');
}

export function dedupeContracts(items: StoredContract[]): StoredContract[] {
  const deduped = new Map<string, StoredContract>();
  for (const contract of items) {
    const key = contractKey(contract);
    const existing = deduped.get(key);
    deduped.set(key, existing ? mergeContracts(existing, contract) : contract);
  }
  return [...deduped.values()];
}

export function dedupeCrossLinks(items: CrossLink[]): CrossLink[] {
  const deduped = new Map<string, CrossLink>();
  for (const link of items) {
    const key = crossLinkKey(link);
    const existing = deduped.get(key);
    if (!existing) {
      deduped.set(key, link);
      continue;
    }
    const keepIncoming = link.confidence > existing.confidence;
    const primary = keepIncoming ? link : existing;
    const secondary = keepIncoming ? existing : link;
    deduped.set(key, {
      ...primary,
      confidence: Math.max(existing.confidence, link.confidence),
      from: mergeEndpoints(primary.from, secondary.from),
      to: mergeEndpoints(primary.to, secondary.to),
    });
  }
  return [...deduped.values()];
}
