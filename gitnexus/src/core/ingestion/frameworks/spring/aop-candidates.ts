import type { GraphNode } from 'gitnexus-shared';
import type { SpringAopStaticPointcut } from './aop.js';

export interface SpringAopOwnedMethod {
  readonly method: GraphNode;
  readonly owner: GraphNode;
}

export interface SpringAopCandidateIndex {
  readonly totalCandidates: number;
  candidatesFor(pointcut: SpringAopStaticPointcut): readonly SpringAopOwnedMethod[];
}

interface OwnerBucket {
  readonly id: string;
  readonly qualifiedName: string;
  readonly candidates: SpringAopOwnedMethod[];
}

function ownerPatternLiteralPrefix(pattern: string): string {
  const wildcardIndex = pattern.indexOf('*');
  const descendantIndex = pattern.indexOf('..');
  const firstDynamicIndex = [wildcardIndex, descendantIndex]
    .filter((index) => index >= 0)
    .reduce((first, index) => Math.min(first, index), pattern.length);
  return pattern.slice(0, firstDynamicIndex);
}

function lowerBoundByQualifiedName(buckets: readonly OwnerBucket[], prefix: string): number {
  let low = 0;
  let high = buckets.length;
  while (low < high) {
    const middle = low + Math.floor((high - low) / 2);
    if ((buckets[middle]?.qualifiedName ?? '') < prefix) low = middle + 1;
    else high = middle;
  }
  return low;
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

/**
 * Build immutable candidate lists once per pipeline run. The pointcut matcher
 * remains the final authority; this index only returns safe supersets.
 */
export function createSpringAopCandidateIndex(
  candidates: readonly SpringAopOwnedMethod[],
  methodAnnotations: ReadonlyMap<string, ReadonlySet<string>>,
): SpringAopCandidateIndex {
  const allCandidates = [...candidates];
  const candidatesByAnnotation = new Map<string, SpringAopOwnedMethod[]>();
  const candidatesByExactOwner = new Map<string, SpringAopOwnedMethod[]>();
  const ownerBucketsById = new Map<string, OwnerBucket>();

  for (const candidate of allCandidates) {
    for (const annotation of methodAnnotations.get(candidate.method.id) ?? []) {
      const annotated = candidatesByAnnotation.get(annotation) ?? [];
      annotated.push(candidate);
      candidatesByAnnotation.set(annotation, annotated);
    }

    const qualifiedName = candidate.owner.properties.qualifiedName;
    if (typeof qualifiedName !== 'string' || qualifiedName.length === 0) continue;
    const exactOwnerCandidates = candidatesByExactOwner.get(qualifiedName) ?? [];
    exactOwnerCandidates.push(candidate);
    candidatesByExactOwner.set(qualifiedName, exactOwnerCandidates);

    let bucket = ownerBucketsById.get(candidate.owner.id);
    if (bucket === undefined) {
      bucket = { id: candidate.owner.id, qualifiedName, candidates: [] };
      ownerBucketsById.set(candidate.owner.id, bucket);
    }
    bucket.candidates.push(candidate);
  }

  const ownerBuckets = [...ownerBucketsById.values()].sort(
    (left, right) =>
      compareStrings(left.qualifiedName, right.qualifiedName) || compareStrings(left.id, right.id),
  );
  const candidatesByOwnerPattern = new Map<string, readonly SpringAopOwnedMethod[]>();

  return {
    totalCandidates: allCandidates.length,
    candidatesFor(pointcut) {
      if (pointcut.kind === 'annotation') {
        return candidatesByAnnotation.get(pointcut.annotation) ?? [];
      }
      if (!pointcut.ownerPattern.includes('*') && !pointcut.ownerPattern.includes('..')) {
        return candidatesByExactOwner.get(pointcut.ownerPattern) ?? [];
      }

      // Unqualified wildcard patterns (for example `*Service` or `Order*`)
      // match the owner simple name. The qualified-name prefix index cannot
      // safely narrow those, so preserve the full candidate superset.
      if (!pointcut.ownerPattern.includes('.')) return allCandidates;

      const prefix = ownerPatternLiteralPrefix(pointcut.ownerPattern);
      if (prefix.length === 0) return allCandidates;
      const cached = candidatesByOwnerPattern.get(pointcut.ownerPattern);
      if (cached !== undefined) return cached;

      const selected: SpringAopOwnedMethod[] = [];
      for (
        let index = lowerBoundByQualifiedName(ownerBuckets, prefix);
        index < ownerBuckets.length;
        index += 1
      ) {
        const bucket = ownerBuckets[index];
        if (bucket === undefined || !bucket.qualifiedName.startsWith(prefix)) break;
        selected.push(...bucket.candidates);
      }
      candidatesByOwnerPattern.set(pointcut.ownerPattern, selected);
      return selected;
    },
  };
}
