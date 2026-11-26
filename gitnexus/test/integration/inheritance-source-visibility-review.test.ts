import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  getRelationships,
  runPipelineFromRepo,
  writeFixtureRepo,
  type PipelineResult,
} from '../integration/resolvers/helpers.js';

describe('review probes for candidate visibility', () => {
  let root: string;
  let result: PipelineResult;
  beforeAll(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'gn-source-visibility-'));
    writeFixtureRepo(root, {});
    writeFixtureRepo(root, {
      'alias/p/B.kt': 'package aliasp\nopen class B',
      'alias/p/C.kt': 'package aliasp\nimport aliasq.B\nclass AliasChild : B()',
      'alias/q/Types.kt': 'package aliasq\nopen class Real\ntypealias B = Real',

      'alpha/src/main/kotlin/ktparents/Base.kt': 'package ktparents\nopen class Base',
      'beta/src/test/kotlin/ktparents/Base.kt': 'package ktparents\nopen class Base',
      'beta/src/main/kotlin/ktparents/Child.kt': 'package ktparents\nclass Child : Base()',
    });
    result = await runPipelineFromRepo(root, () => {}, {});
  }, 120000);
  afterAll(() => {
    if (root) fs.rmSync(root, { recursive: true, force: true });
  });

  it('does not override a resolved Kotlin typealias import with a package sibling', () => {
    const edges = getRelationships(result, 'EXTENDS').filter((e) => e.source === 'AliasChild');
    expect(edges).not.toContainEqual(expect.objectContaining({ targetFilePath: 'alias/p/B.kt' }));
  });

  it('excludes test-only Kotlin bases from production inheritance', () => {
    const edges = getRelationships(result, 'EXTENDS').filter(
      (e) => e.source === 'Child' && e.sourceFilePath.endsWith('.kt'),
    );
    expect(edges.map((e) => e.targetFilePath)).toEqual(['alpha/src/main/kotlin/ktparents/Base.kt']);
  });
});
