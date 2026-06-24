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

    expect(calls.filter((edge) => edge.sourceFilePath.endsWith('pages/local.ts'))).toHaveLength(0);
    expect(calls.filter((edge) => edge.sourceFilePath.endsWith('pages/noise.ts'))).toHaveLength(0);
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
