import { describe, expect, it } from 'vitest';
import { CLASS_SCHEMA, NODE_SCHEMA_QUERIES } from '../../src/core/lbug/schema.js';
import { getCopyQuery } from '../../src/core/lbug/lbug-adapter.js';
import { PARSE_CACHE_VERSION } from '../../src/storage/parse-cache.js';
import { isSpringBeanCandidateSourceFile } from '../../src/core/ingestion/frameworks/spring/bean-catalog.js';
import {
  SPRING_AOP_FEATURE,
  SPRING_BEAN_INVENTORY_FEATURE,
  SPRING_CONDITIONALS_FEATURE,
} from '../../src/core/ingestion/frameworks/spring/analysis-features.js';
import { CLASS_FRAMEWORK_ANNOTATIONS_FEATURE } from '../../src/core/analysis-features.js';

describe('Spring Bean Class persistence schema', () => {
  it('keeps the Class DDL and bulk COPY column order aligned', () => {
    expect(CLASS_SCHEMA).toContain('frameworkAnnotations STRING[]');

    expect(getCopyQuery('Class', '/tmp/class.csv')).toContain(
      '(id, name, filePath, startLine, endLine, isExported, content, description, frameworkAnnotations, language, sourceIdentity, sourceRole, declarationKey)',
    );
  });

  it('meets the cache-version baselines required by the merged implementation', () => {
    const parseSchemaVersion = Number.parseInt(PARSE_CACHE_VERSION, 10);
    expect(parseSchemaVersion).toBeGreaterThanOrEqual(31);
    expect(CLASS_FRAMEWORK_ANNOTATIONS_FEATURE.version).toBe(1);
    expect(SPRING_AOP_FEATURE.version).toBe(1);
    expect(SPRING_BEAN_INVENTORY_FEATURE.version).toBe(2);
    expect(SPRING_CONDITIONALS_FEATURE.version).toBe(1);

    // Stands in for the deleted `INCREMENTAL_SCHEMA_VERSION >= 23` floor (#2798).
    // There's no hand-incremented counter to bump anymore — reuse now hinges on
    // a fingerprint over the DDL set, so what needs pinning is CLASS_SCHEMA's
    // membership in that set: an index built before `frameworkAnnotations`
    // existed hashes differently and gets rebuilt.
    expect(NODE_SCHEMA_QUERIES).toContain(CLASS_SCHEMA);
  });

  it('limits incremental drift queries to Java and Kotlin Bean source files', () => {
    expect(isSpringBeanCandidateSourceFile('src/App.java')).toBe(true);
    expect(isSpringBeanCandidateSourceFile('src/App.kt')).toBe(true);
    expect(isSpringBeanCandidateSourceFile('build.gradle.kts')).toBe(true);
    expect(isSpringBeanCandidateSourceFile('src/app.ts')).toBe(false);
  });
});
