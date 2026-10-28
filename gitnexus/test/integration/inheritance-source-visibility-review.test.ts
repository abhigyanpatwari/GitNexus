import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  getRelationships,
  runPipelineFromRepo,
  writeFixtureRepo,
  type PipelineResult,
} from './resolvers/helpers.js';

describe('review probes for candidate visibility', () => {
  let root: string;
  let result: PipelineResult;
  beforeAll(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'gn-source-visibility-'));
    writeFixtureRepo(root, {
      'alpha/src/main/java/models/User.java':
        'package models; public class User { public void save() {} }',
      'beta/src/test/java/models/User.java':
        'package models; public class User { public void save() {} }',
      'beta/src/main/java/services/Service.java':
        'package services; import models.User; public class Service { void run(User value) { value.save(); } }',
      'alpha/src/main/java/parents/Base.java': 'package parents; public class Base {}',
      'beta/src/test/java/parents/Base.java': 'package parents; public class Base {}',
      'beta/src/main/java/parents/Child.java':
        'package parents; public class Child extends Base {}',
      'gamma/src/main/java/nested/A.java':
        'package nested; public class A { public static class B {} }',
      'gamma/src/main/java/nested/C.java':
        'package nested; public class C extends A { public static class D extends B {} }',
      'gamma/src/main/java/nested/B.java': 'package nested; public class B {}',
      'gamma/src/main/java/other/B.java': 'package other; public class B {}',
    });
    writeFixtureRepo(root, {
      'alias/p/B.kt': 'package aliasp\nopen class B',
      'alias/p/C.kt': 'package aliasp\nimport aliasq.B\nclass AliasChild : B()',
      'alias/q/Types.kt': 'package aliasq\nopen class Real\ntypealias B = Real',
      'claims/p/B.java': 'package claimsp; public class B {}',
      'claims/q/B.java': 'package claimsq; public class B {}',
      'claims/p/C.java':
        'package claimsp; import external.B; public class ExternalChild extends B {}',
      'beta/src/test/java/services/TestService.java':
        'package services; import models.User; public class TestService { void run(User value) { value.save(); } }',
      'beta/src/test/java/parents/TestChild.java':
        'package parents; public class TestChild extends Base {}',
      'alpha/src/main/kotlin/ktparents/Base.kt': 'package ktparents\nopen class Base',
      'beta/src/test/kotlin/ktparents/Base.kt': 'package ktparents\nopen class Base',
      'beta/src/main/kotlin/ktparents/Child.kt': 'package ktparents\nclass Child : Base()',
    });
    result = await runPipelineFromRepo(root, () => {}, {});
  }, 120000);
  afterAll(() => {
    if (root) fs.rmSync(root, { recursive: true, force: true });
  });
  it('does not dispatch production receivers to a test-only duplicate', () => {
    const edges = getRelationships(result, 'CALLS').filter(
      (e) => e.sourceFilePath === 'beta/src/main/java/services/Service.java' && e.target === 'save',
    );
    expect(edges.map((e) => e.targetFilePath)).toEqual(['alpha/src/main/java/models/User.java']);
  });
  it('does not bind a production base to a test-only duplicate', () => {
    const edges = getRelationships(result, 'EXTENDS').filter(
      (e) => e.source === 'Child' && e.sourceFilePath.endsWith('.java'),
    );
    expect(edges.map((e) => e.targetFilePath)).toEqual(['alpha/src/main/java/parents/Base.java']);
  });
  it('does not override a resolved Kotlin typealias import with a package sibling', () => {
    const edges = getRelationships(result, 'EXTENDS').filter((e) => e.source === 'AliasChild');
    expect(edges).not.toContainEqual(expect.objectContaining({ targetFilePath: 'alias/p/B.kt' }));
  });
  it('does not override an unresolved explicit Java import with a package sibling', () => {
    expect(getRelationships(result, 'EXTENDS').filter((e) => e.source === 'ExternalChild')).toEqual(
      [],
    );
  });
  it('preserves the nearer test declaration for a test importer', () => {
    const edges = getRelationships(result, 'CALLS').filter(
      (e) =>
        e.sourceFilePath === 'beta/src/test/java/services/TestService.java' && e.target === 'save',
    );
    expect(edges.map((e) => e.targetFilePath)).toEqual(['beta/src/test/java/models/User.java']);
  });
  it('preserves the nearer test base for a test deriving class', () => {
    const edges = getRelationships(result, 'EXTENDS').filter((e) => e.source === 'TestChild');
    expect(edges.map((e) => e.targetFilePath)).toEqual(['beta/src/test/java/parents/Base.java']);
  });
  it('excludes test-only Kotlin bases from production inheritance', () => {
    const edges = getRelationships(result, 'EXTENDS').filter(
      (e) => e.source === 'Child' && e.sourceFilePath.endsWith('.kt'),
    );
    expect(edges.map((e) => e.targetFilePath)).toEqual(['alpha/src/main/kotlin/ktparents/Base.kt']);
  });
  it('does not replace an inherited nested base with a package-level homonym', () => {
    const edges = getRelationships(result, 'EXTENDS').filter((e) => e.source === 'D');
    expect(edges).not.toContainEqual(
      expect.objectContaining({ targetFilePath: 'gamma/src/main/java/nested/B.java' }),
    );
  });
});
