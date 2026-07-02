import { describe, it, expect, beforeAll } from 'vitest';
import path from 'path';
import { FIXTURES, getRelationships, runPipelineFromRepo, type PipelineResult } from './helpers.js';

describe('Nuxt/Nitro auto-import scope resolution', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(path.join(FIXTURES, 'nuxt-auto-imports'), () => {}, {
      skipGraphPhases: true,
    });
  }, 60000);

  function nuxtCalls() {
    return getRelationships(result, 'CALLS').filter(
      (edge) => edge.rel.reason === 'nuxt-auto-import',
    );
  }

  it('prefers server/utils over client composables for same-named server calls', () => {
    const calls = nuxtCalls();
    const serverValidate = calls.find(
      (edge) =>
        edge.sourceFilePath.endsWith('server/api/route.ts') &&
        edge.target === 'validate' &&
        edge.targetFilePath.endsWith('server/utils/serverValidate.ts'),
    );
    const wrongClientValidate = calls.find(
      (edge) =>
        edge.sourceFilePath.endsWith('server/api/route.ts') &&
        edge.target === 'validate' &&
        edge.targetFilePath.endsWith('composables/clientValidate.ts'),
    );

    expect(serverValidate).toBeDefined();
    expect(wrongClientValidate).toBeUndefined();
  });

  it('keeps server/utils out of client files while allowing client auto-imports', () => {
    const calls = nuxtCalls();
    expect(
      calls.find(
        (edge) =>
          edge.sourceFilePath.endsWith('app.ts') &&
          edge.target === 'validate' &&
          edge.targetFilePath.endsWith('composables/clientValidate.ts'),
      ),
    ).toBeDefined();
    expect(
      calls.find(
        (edge) =>
          edge.sourceFilePath.endsWith('app.ts') &&
          edge.targetFilePath.endsWith('server/utils/serverOnly.ts'),
      ),
    ).toBeUndefined();
  });

  it('resolves extensionless barrel directories to index files', () => {
    const calls = nuxtCalls();
    const imports = getRelationships(result, 'IMPORTS').filter(
      (edge) => edge.rel.reason === 'nuxt-auto-import-file',
    );

    expect(
      calls.find(
        (edge) =>
          edge.sourceFilePath.endsWith('app.ts') &&
          edge.target === 'useBarrel' &&
          edge.targetFilePath.endsWith('composables/group/index.ts'),
      ),
    ).toBeDefined();
    expect(
      imports.find(
        (edge) =>
          edge.sourceFilePath.endsWith('app.ts') &&
          edge.targetFilePath.endsWith('composables/group/index.ts'),
      ),
    ).toBeDefined();
  });

  it('does not resolve client composables from Nitro server callers (no client fallback)', () => {
    const calls = nuxtCalls();
    // server/api/route.ts calls validate() (a real server/util), useAuto() and
    // useBarrel() (client-only composables). Only the server/util resolves;
    // Nitro does not auto-import composables/ server-side, so no edge is emitted
    // to either composable.
    const composableEdges = calls.filter(
      (edge) =>
        edge.sourceFilePath.endsWith('server/api/route.ts') &&
        edge.targetFilePath.includes('/composables/'),
    );
    expect(composableEdges).toHaveLength(0);
    // The legitimate server/util edge still resolves.
    expect(
      calls.find(
        (edge) =>
          edge.sourceFilePath.endsWith('server/api/route.ts') &&
          edge.target === 'validate' &&
          edge.targetFilePath.endsWith('server/utils/serverValidate.ts'),
      ),
    ).toBeDefined();
  });

  it('does not emit auto-import edges for local shadowing or lexical noise', () => {
    const calls = nuxtCalls();
    // Guard against a vacuous pass: the feature must have emitted edges elsewhere.
    expect(calls.length).toBeGreaterThan(0);

    expect(calls.filter((edge) => edge.sourceFilePath.endsWith('pages/local.ts'))).toHaveLength(0);
    expect(calls.filter((edge) => edge.sourceFilePath.endsWith('pages/noise.ts'))).toHaveLength(0);
  });

  it('does not emit an auto-import edge when a typed parameter shadows the name', () => {
    const calls = nuxtCalls();
    expect(calls.length).toBeGreaterThan(0);
    // pages/param-typed.ts has `function renderTyped(validate: ValidateFn)` and
    // calls validate() — the type-annotated parameter (in scope.typeBindings)
    // shadows the composable, so no nuxt edge is emitted.
    expect(
      calls.filter((edge) => edge.sourceFilePath.endsWith('pages/param-typed.ts')),
    ).toHaveLength(0);
  });

  it('allows type-only local declarations to coexist with value auto-import calls', () => {
    const calls = nuxtCalls();

    expect(
      calls.find(
        (edge) =>
          edge.sourceFilePath.endsWith('pages/type-only.ts') &&
          edge.target === 'useAuto' &&
          edge.targetFilePath.endsWith('composables/useAuto.ts'),
      ),
    ).toBeDefined();
  });

  it('suppresses an auto-import shadowed by an explicit unresolved external import', () => {
    const calls = nuxtCalls();
    // Guard against a vacuous pass: the feature must have emitted edges elsewhere.
    expect(calls.length).toBeGreaterThan(0);
    // pages/external-import.ts does `import { useAuto } from '@vueuse/core'` (an
    // unresolved external) then calls useAuto(). The explicit import shadows the
    // Nuxt auto-import, so no nuxt edge is emitted from that file.
    expect(
      calls.filter((edge) => edge.sourceFilePath.endsWith('pages/external-import.ts')),
    ).toHaveLength(0);
  });

  it('suppresses only explicitly imported local names, not every symbol from the same source', () => {
    const calls = nuxtCalls();

    expect(
      calls.find(
        (edge) => edge.sourceFilePath.endsWith('pages/explicit.ts') && edge.target === 'useAuto',
      ),
    ).toBeDefined();
    expect(
      calls.find(
        (edge) =>
          edge.sourceFilePath.endsWith('pages/explicit-auto.ts') && edge.target === 'useAuto',
      ),
    ).toBeUndefined();
  });
});
