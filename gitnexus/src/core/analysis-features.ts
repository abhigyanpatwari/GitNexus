/** A durable statement that one analysis capability was produced by this build. */
export interface AnalysisFeatureDescriptor {
  readonly id: string;
  readonly version: number;
  readonly appliesTo: (filePaths: readonly string[]) => boolean;
}

export type AnalysisFeatureVersions = Readonly<Record<string, number>>;

/**
 * The Class table shape is global even when a repository contains no JVM code.
 * Existing v8 indexes predate the frameworkAnnotations column and therefore
 * need one full rebuild before any incremental Class write can be safe.
 */
export const CLASS_FRAMEWORK_ANNOTATIONS_FEATURE: AnalysisFeatureDescriptor = {
  id: 'graph.class-framework-annotations',
  version: 1,
  appliesTo: () => true,
};

/** Resolve the exact feature set this build promises for the supplied files. */
export function resolveAnalysisFeatureVersions(
  descriptors: readonly AnalysisFeatureDescriptor[],
  filePaths: readonly string[],
): Record<string, number> {
  const resolved = new Map<string, number>();
  const seenIds = new Set<string>();
  for (const descriptor of descriptors) {
    if (descriptor.id.trim().length === 0) {
      throw new Error('Analysis feature descriptor id must not be empty');
    }
    if (!Number.isSafeInteger(descriptor.version) || descriptor.version < 1) {
      throw new Error(
        `Analysis feature "${descriptor.id}" has invalid version ${descriptor.version}`,
      );
    }
    if (seenIds.has(descriptor.id)) {
      throw new Error(`Duplicate analysis feature descriptor: ${descriptor.id}`);
    }
    seenIds.add(descriptor.id);
    if (!descriptor.appliesTo(filePaths)) continue;
    resolved.set(descriptor.id, descriptor.version);
  }

  return Object.fromEntries([...resolved].sort(([left], [right]) => left.localeCompare(right)));
}

/**
 * Compare an untrusted metadata value with the exact capabilities produced by
 * this build. Extra keys also mismatch: a rollback must rebuild instead of
 * certifying graph semantics emitted only by a newer binary.
 */
export function findAnalysisFeatureMismatches(
  actual: unknown,
  expected: AnalysisFeatureVersions,
): readonly string[] {
  const expectedKeys = Object.keys(expected);
  if (actual === undefined) return expectedKeys.map((id) => `missing:${id}`);
  if (actual === null || typeof actual !== 'object' || Array.isArray(actual)) {
    return ['invalid:analysisFeatures'];
  }

  const stamped = actual as Record<string, unknown>;
  const mismatches: string[] = [];
  for (const id of expectedKeys) {
    const value = stamped[id];
    if (value === undefined) mismatches.push(`missing:${id}`);
    else if (value !== expected[id]) mismatches.push(`version:${id}`);
  }
  for (const id of Object.keys(stamped)) {
    if (!Object.prototype.hasOwnProperty.call(expected, id)) {
      mismatches.push(`unexpected:${id}`);
    }
  }
  return mismatches.sort();
}
