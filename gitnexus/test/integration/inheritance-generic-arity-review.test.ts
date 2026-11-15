import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getRelationships, runPipelineFromRepo, writeFixtureRepo } from './resolvers/helpers.js';

describe.each([
  {
    language: 'Kotlin',
    extension: 'kt',
    directory: 'kotlin',
    basePrefix: 'open class',
    child: 'class Child : Base<String>()',
  },
  {
    language: 'Java',
    extension: 'java',
    directory: 'java',
    basePrefix: 'class',
    child: 'class Child extends Base<String> {}',
  },
])('$language inherited generic arity', ({ language, extension, directory, basePrefix, child }) => {
  const source = (body: string) => 'package p' + (extension === 'java' ? ';\n' : '\n') + body;

  it.each([
    { label: 'a nearer two-parameter base', near: '<T, U>', far: '<T>', hasTarget: true },
    { label: 'a nearer non-generic base', near: '', far: '<T>', hasTarget: true },
    { label: 'only incompatible bases', near: '<T, U>', far: '<T, U, V>', hasTarget: false },
  ])(
    'filters $label before source proximity',
    async ({ near, far, hasTarget }) => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gn-jvm-base-arity-'));
      try {
        const suffix = extension === 'java' ? ' {}' : '';
        writeFixtureRepo(root, {
          ['near/src/main/' + directory + '/p/Child.' + extension]: source(child),
          ['near/nested-module/src/main/' + directory + '/p/Base.' + extension]: source(
            basePrefix + ' Base' + near + suffix,
          ),
          ['far/src/main/' + directory + '/p/Base.' + extension]: source(
            basePrefix + ' Base' + far + suffix,
          ),
          ['other/src/main/' + directory + '/q/Base.' + extension]:
            'package q' + (extension === 'java' ? ';\nclass Base<T> {}' : '\nclass Base<T>'),
        });
        const result = await runPipelineFromRepo(root, () => {}, {});
        expect(
          getRelationships(result, 'EXTENDS')
            .filter((e) => e.source === 'Child')
            .map((e) => e.targetFilePath),
        ).toEqual(hasTarget ? ['far/src/main/' + directory + '/p/Base.' + extension] : []);
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    },
    120000,
  );

  it('retains omitted generic arguments where the language permits them', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gn-jvm-base-inference-'));
    try {
      const kotlin = language === 'Kotlin';
      writeFixtureRepo(root, {
        ['app/src/main/' + directory + '/p/Child.' + extension]: source(
          kotlin ? 'class Child : Base("value")' : 'class Child extends Base {}',
        ),
        ['model/src/main/' + directory + '/p/Base.' + extension]: source(
          kotlin ? 'open class Base<T>(val value: T)' : 'class Base<T> {}',
        ),
        ['other/src/main/' + directory + '/q/Base.' + extension]:
          'package q' + (kotlin ? '\nclass Base<T>' : ';\nclass Base<T> {}'),
      });
      const result = await runPipelineFromRepo(root, () => {}, {});
      expect(
        getRelationships(result, 'EXTENDS')
          .filter((e) => e.source === 'Child')
          .map((e) => e.targetFilePath),
      ).toEqual(['model/src/main/' + directory + '/p/Base.' + extension]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }, 120000);
});
