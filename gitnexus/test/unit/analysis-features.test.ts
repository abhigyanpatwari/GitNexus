import { describe, expect, it } from 'vitest';
import {
  CLASS_FRAMEWORK_ANNOTATIONS_FEATURE,
  findAnalysisFeatureMismatches,
  resolveAnalysisFeatureVersions,
  type AnalysisFeatureDescriptor,
} from '../../src/core/analysis-features.js';
import { SPRING_BEAN_INVENTORY_FEATURE } from '../../src/core/ingestion/frameworks/spring/analysis-features.js';

const FEATURES = [CLASS_FRAMEWORK_ANNOTATIONS_FEATURE, SPRING_BEAN_INVENTORY_FEATURE] as const;

describe('analysis feature versions', () => {
  it('separates the global Class schema capability from JVM-only Bean evidence', () => {
    expect(resolveAnalysisFeatureVersions(FEATURES, ['src/app.ts'])).toEqual({
      'graph.class-framework-annotations': 1,
    });
    expect(resolveAnalysisFeatureVersions(FEATURES, ['src/App.java'])).toEqual({
      'graph.class-framework-annotations': 1,
      'spring.bean-inventory': 1,
    });
    expect(resolveAnalysisFeatureVersions(FEATURES, ['BUILD.GRADLE.KTS'])).toEqual({
      'graph.class-framework-annotations': 1,
      'spring.bean-inventory': 1,
    });
  });

  it('requires an exact, well-formed feature set', () => {
    const expected = {
      'graph.class-framework-annotations': 1,
      'spring.bean-inventory': 1,
    };

    expect(findAnalysisFeatureMismatches(expected, expected)).toEqual([]);
    expect(findAnalysisFeatureMismatches(undefined, expected)).toEqual([
      'missing:graph.class-framework-annotations',
      'missing:spring.bean-inventory',
    ]);
    expect(
      findAnalysisFeatureMismatches(
        { 'graph.class-framework-annotations': 1, 'spring.bean-inventory': 2 },
        expected,
      ),
    ).toEqual(['version:spring.bean-inventory']);
    expect(findAnalysisFeatureMismatches({ feature: 1 }, { feature: 2 })).toEqual([
      'version:feature',
    ]);
    expect(
      findAnalysisFeatureMismatches({ ...expected, 'spring.future-feature': 1 }, expected),
    ).toEqual(['unexpected:spring.future-feature']);
    expect(findAnalysisFeatureMismatches([], expected)).toEqual(['invalid:analysisFeatures']);
    expect(findAnalysisFeatureMismatches({ ...expected, toString: 1 }, expected)).toEqual([
      'unexpected:toString',
    ]);
  });

  it('rejects invalid or duplicate descriptors', () => {
    const invalid: AnalysisFeatureDescriptor = {
      id: 'invalid',
      version: 0,
      appliesTo: () => true,
    };
    expect(() => resolveAnalysisFeatureVersions([invalid], [])).toThrow('invalid version');
    expect(() =>
      resolveAnalysisFeatureVersions(
        [CLASS_FRAMEWORK_ANNOTATIONS_FEATURE, CLASS_FRAMEWORK_ANNOTATIONS_FEATURE],
        [],
      ),
    ).toThrow('Duplicate analysis feature descriptor');
    expect(() =>
      resolveAnalysisFeatureVersions(
        [
          CLASS_FRAMEWORK_ANNOTATIONS_FEATURE,
          { ...CLASS_FRAMEWORK_ANNOTATIONS_FEATURE, appliesTo: () => false },
        ],
        [],
      ),
    ).toThrow('Duplicate analysis feature descriptor');
  });
});
