import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  getRelationships,
  runPipelineFromRepo,
  writeFixtureRepo,
} from '../integration/resolvers/helpers.js';

describe('Kotlin inherited generic arity', () => {
  const source = (body: string) => 'package p\n' + body;
  it.each([
    { label: 'a nearer two-parameter base', near: '<T, U>', far: '<T>', hasTarget: true },
    { label: 'a nearer non-generic base', near: '', far: '<T>', hasTarget: true },
    { label: 'only incompatible bases', near: '<T, U>', far: '<T, U, V>', hasTarget: false },
  ])(
    'filters $label before source proximity',
    async ({ near, far, hasTarget }) => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gn-jvm-base-arity-'));
      try {
        writeFixtureRepo(root, {
          ['near/src/main/kotlin/p/Child.kt']: source('class Child : Base<String>()'),
          ['near/nested-module/src/main/kotlin/p/Base.kt']: source('open class Base' + near),
          ['far/src/main/kotlin/p/Base.kt']: source('open class Base' + far),
          ['other/src/main/kotlin/q/Base.kt']: 'package q\nclass Base<T>',
        });
        const result = await runPipelineFromRepo(root, () => {}, {});
        expect(
          getRelationships(result, 'EXTENDS')
            .filter((e) => e.source === 'Child')
            .map((e) => e.targetFilePath),
        ).toEqual(hasTarget ? ['far/src/main/kotlin/p/Base.kt'] : []);
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    },
    120000,
  );

  it('retains omitted generic arguments where the language permits them', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gn-jvm-base-inference-'));
    try {
      writeFixtureRepo(root, {
        ['app/src/main/kotlin/p/Child.kt']: source('class Child : Base("value")'),
        ['model/src/main/kotlin/p/Base.kt']: source('open class Base<T>(val value: T)'),
        ['other/src/main/kotlin/q/Base.kt']: 'package q\nclass Base<T>',
      });
      const result = await runPipelineFromRepo(root, () => {}, {});
      expect(
        getRelationships(result, 'EXTENDS')
          .filter((e) => e.source === 'Child')
          .map((e) => e.targetFilePath),
      ).toEqual(['model/src/main/kotlin/p/Base.kt']);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }, 120000);
});
