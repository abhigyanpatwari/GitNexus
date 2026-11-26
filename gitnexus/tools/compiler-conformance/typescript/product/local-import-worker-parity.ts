import { registerCases } from '../support/cases.mjs';
import { before as beforeAll, describe, it } from 'node:test';
import { expect } from 'expect';
import {
  assertPlainFacts,
  assertWorkerDispatch,
  loaderSource,
  runWorkerParity,
} from '../../../../test/helpers/worker-parity.js';
const fixtures = {
  'typescript.ts': `${loaderSource}\nfunction typed(value: Child): Parent { return value; }`,
  'typescript.tsx': `${loaderSource}\nconst element = <Child />;`,
  'vue-ts.vue': `<template>\n<div />\n</template>\n<script setup lang="ts">\n${loaderSource}\nfunction typed(value: Child): Parent { return value; }\n</script>`,
};

describe('TypeScript local imports across the real parse worker', () => {
  let run: Awaited<ReturnType<typeof runWorkerParity>>;
  let workerFiles: typeof run.workerFiles;
  let directFiles: typeof run.directFiles;
  beforeAll(
    async () => {
      run = await runWorkerParity(fixtures);
      ({ workerFiles, directFiles } = run);
    },
    { timeout: 120_000 },
  );

  it('witnesses actual worker dispatch and returned ParsedFiles without a fallback', () => {
    assertWorkerDispatch(run, fixtures);
  });

  registerCases(
    it,
    Object.keys(fixtures),
    'preserves complete direct provider facts for %s',
    (filePath) => {
      const direct = directFiles.get(filePath)!;
      const transported = workerFiles.get(filePath)!;
      expect(direct.scopes.some((scope) => (scope.nameClaims?.length ?? 0) > 0)).toBe(true);
      expect(transported).toEqual(direct);
      assertPlainFacts(transported);
    },
  );

  it('transports Vue TypeScript declarations with original graph positions', () => {
    expect(
      workerFiles.get('vue-ts.vue')!.localDefs.some((def) => def.graphPosition !== undefined),
    ).toBe(true);
  });
});
