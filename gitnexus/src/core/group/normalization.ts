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

/**
 * True when a link endpoint carries no resolved graph symbol — empty
 * `symbolUid` or a missing/empty `symbolRef`.
 *
 * Sync marks a cross-link `degraded: true` when this holds for the PROVIDER
 * endpoint (`to`): the contract boundary is proven, but the empty uid can
 * never match a Phase-1 impact symbol id, so cross-repo fan-out across the
 * link silently yields nothing (the classic case is a provider whose handler
 * failed to resolve, leaving `symbolName` degraded to the file name with one
 * pseudo-symbol carrying every route in that file). Consumer-side (`from`)
 * emptiness is deliberately NOT degraded — several extractors (topics, grpc)
 * legitimately emit consumer contracts without a per-call symbol, and the
 * anchor that matters for far-side fan-out is the provider's.
 *
 * Kept next to the endpoint merge logic because `dedupeCrossLinks` must
 * re-derive the flag after a merge: `mergeEndpoints` backfills `symbolUid`
 * from the losing twin, which can invalidate a flag carried in from the winner.
 *
 * NOT unresolved: a deterministic `manifest::<repo>::<contractId>` synthetic
 * uid (see `manifestSymbolUid`). Manifest endpoints fall back to it precisely
 * when the graph has no symbol for them — its empty `symbolRef.filePath` would
 * otherwise trip the check below — yet cross-impact anchors those links by
 * design (#2722: the crossing is preserved with `fanout_status:
 * 'not_attempted'` instead of silently yielding cross=0). The prefix is the
 * canonical discriminator — real indexer uids never start with `manifest::`
 * — and `cross-impact.ts` branches on the same test. Encoding the exemption
 * HERE (not at the sync marking call site) keeps marking and the post-merge
 * re-derivation from drifting apart, and keeps the flag's meaning exactly what
 * `types.ts` documents: "distinct from manifest::… synthetic UIDs".
 */
export function isUnresolvedEndpoint(endpoint: CrossLinkEndpoint): boolean {
  if (endpoint.symbolUid.startsWith('manifest::')) return false;
  return (
    !endpoint.symbolUid ||
    !endpoint.symbolRef ||
    !endpoint.symbolRef.filePath ||
    !endpoint.symbolRef.name
  );
}

/**
 * Derive `degraded` from the provider endpoint. Present (`true`) only when
 * unresolved; deleted otherwise so contracts.json stays "carried only when
 * meaningful" (`'degraded' in link === false` for anchored links).
 */
export function applyDegradedFlag(link: CrossLink): CrossLink {
  const next: CrossLink = { ...link };
  if (isUnresolvedEndpoint(next.to)) {
    next.degraded = true;
  } else {
    delete next.degraded;
  }
  return next;
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
    const merged: CrossLink = {
      ...primary,
      confidence: Math.max(existing.confidence, link.confidence),
      from: mergeEndpoints(primary.from, secondary.from),
      to: mergeEndpoints(primary.to, secondary.to),
    };
    // Re-derive after mergeEndpoints: a richer twin can backfill `to.symbolUid`
    // and must not leave a stale `degraded` flag on an now-anchored link.
    deduped.set(key, applyDegradedFlag(merged));
  }
  return [...deduped.values()].map(applyDegradedFlag);
}
