import { describe, expect, it } from 'vitest';
import {
  CLASS_FRAMEWORK_ANNOTATIONS_FEATURE,
  findAnalysisFeatureMismatches,
  resolveAnalysisFeatureVersions,
  type AnalysisFeatureDescriptor,
} from '../../src/core/analysis-features.js';
import { ANALYSIS_FEATURES } from '../../src/core/analysis-feature-registry.js';
import { OBJECTIVE_C_PROVIDER_FEATURE } from '../../src/core/ingestion/languages/objective-c/analysis-features.js';
import {
  OBJECTIVE_C_GRAMMAR_PACKAGE,
  OBJECTIVE_C_GRAMMAR_VERSION,
  OBJECTIVE_C_PROVIDER_VERSION,
} from '../../src/core/ingestion/languages/objective-c/facts.js';


describe('analysis feature versions', () => {
  it('separates the global Class schema capability from JVM-only Bean evidence', () => {
    expect(resolveAnalysisFeatureVersions(ANALYSIS_FEATURES, ['src/app.ts'])).toEqual({
      'graph.class-framework-annotations': 1,
    });
    expect(resolveAnalysisFeatureVersions(ANALYSIS_FEATURES, ['src/App.java'])).toEqual({
      'graph.class-framework-annotations': 1,
      'java.heritage-captures': 1,
      'java.record-component-accessors': 1,
      'spring.aop-advice': 1,
      'spring.bean-inventory': 2,
      'spring.conditionals-auto-configuration': 1,
      'spring.config-bindings': 2,
      'spring.non-http-handlers': 1,
      'spring.route-bindings': 2,
    });
    expect(resolveAnalysisFeatureVersions(ANALYSIS_FEATURES, ['src/App.kt'])).toEqual({
      'graph.class-framework-annotations': 1,
      'spring.aop-advice': 1,
      'spring.bean-inventory': 2,
      'spring.conditionals-auto-configuration': 1,
      'spring.config-bindings': 2,
      'spring.non-http-handlers': 1,
      'spring.route-bindings': 2,
    });
    expect(resolveAnalysisFeatureVersions(ANALYSIS_FEATURES, ['BUILD.GRADLE.KTS'])).toEqual({
      'graph.class-framework-annotations': 1,
      'spring.aop-advice': 1,
      'spring.bean-inventory': 2,
      'spring.conditionals-auto-configuration': 1,
      'spring.non-http-handlers': 1,
      'spring.route-bindings': 2,
    });
    expect(
      resolveAnalysisFeatureVersions(ANALYSIS_FEATURES, [
        'src/main/resources/application-local.yml',
        'README.md',
      ]),
    ).toEqual({
      'graph.class-framework-annotations': 1,
      'spring.config-bindings': 2,
    });
    expect(
      resolveAnalysisFeatureVersions(ANALYSIS_FEATURES, [
        'src/main/resources/META-INF/spring/org.springframework.boot.autoconfigure.AutoConfiguration.imports',
      ]),
    ).toEqual({
      'graph.class-framework-annotations': 1,
      'spring.conditionals-auto-configuration': 1,
    });
  });

  it('requires an exact, well-formed feature set', () => {
    const expected = {
      'graph.class-framework-annotations': 1,
      'spring.bean-inventory': 2,
    };

    expect(findAnalysisFeatureMismatches(expected, expected)).toEqual([]);
    expect(findAnalysisFeatureMismatches(undefined, expected)).toEqual([
      'missing:graph.class-framework-annotations',
      'missing:spring.bean-inventory',
    ]);
    expect(
      findAnalysisFeatureMismatches(
        { 'graph.class-framework-annotations': 1, 'spring.bean-inventory': 1 },
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

  it('stamps Objective-C provider and grammar versions for semantic rebuilds', () => {
    const expectedId =
      `objective-c.provider-${OBJECTIVE_C_PROVIDER_VERSION}.` +
      `${OBJECTIVE_C_GRAMMAR_PACKAGE}-${OBJECTIVE_C_GRAMMAR_VERSION}`;
    expect(OBJECTIVE_C_PROVIDER_FEATURE.id).toBe(expectedId);

    const objcFeatures = resolveAnalysisFeatureVersions(ANALYSIS_FEATURES, [
      'Sources/SYModuleCaller.m',
      'Sources/SYModuleCaller.mm',
      'Headers/SYModuleCaller.h',
    ]);
    expect(objcFeatures).toMatchObject({
      [OBJECTIVE_C_PROVIDER_FEATURE.id]: OBJECTIVE_C_PROVIDER_FEATURE.version,
    });

    expect(resolveAnalysisFeatureVersions(ANALYSIS_FEATURES, ['include/plain.hpp'])).not.toHaveProperty(
      OBJECTIVE_C_PROVIDER_FEATURE.id,
    );
    expect(
      findAnalysisFeatureMismatches(
        { [OBJECTIVE_C_PROVIDER_FEATURE.id]: OBJECTIVE_C_PROVIDER_FEATURE.version - 1 },
        { [OBJECTIVE_C_PROVIDER_FEATURE.id]: OBJECTIVE_C_PROVIDER_FEATURE.version },
      ),
    ).toEqual([`version:${OBJECTIVE_C_PROVIDER_FEATURE.id}`]);
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
