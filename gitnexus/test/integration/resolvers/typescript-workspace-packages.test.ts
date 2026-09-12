/**
 * TypeScript bare-specifier resolution in a pnpm workspace monorepo (#2953).
 *
 * Two failures with one cause — the resolver knew nothing about `package.json`:
 *   1. `@acme/telemetry/nest` (a registry dependency) basename-matched the
 *      repo's only `**\/nest/index.ts` and emitted an `IMPORTS` edge for it.
 *   2. `@repo/utils` (a workspace package, named only in its manifest) resolved
 *      to nothing, so no cross-package `IMPORTS`/`CALLS` edges existed.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import path from 'path';
import { FIXTURES, getRelationships, runPipelineFromRepo, type PipelineResult } from './helpers.js';

describe('TypeScript workspace-package imports (#2953)', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(
      path.join(FIXTURES, 'typescript-pnpm-workspace-imports'),
      () => {},
    );
  }, 60000);

  it('does not resolve the external @acme/telemetry/nest to packages/inner/src/nest/index.ts', () => {
    const imports = getRelationships(result, 'IMPORTS');
    const falseEdge = imports.find(
      (e) =>
        e.sourceFilePath === 'apps/web/src/main.ts' &&
        e.targetFilePath === 'packages/inner/src/nest/index.ts',
    );
    expect(falseEdge).toBeUndefined();
  });

  it('emits no in-repo IMPORTS edge at all from the file whose only import is external', () => {
    const imports = getRelationships(result, 'IMPORTS');
    const fromMain = imports.filter((e) => e.sourceFilePath === 'apps/web/src/main.ts');
    expect(fromMain).toEqual([]);
  });

  it('resolves the workspace package @repo/utils to its entry point', () => {
    const imports = getRelationships(result, 'IMPORTS');
    const workspaceEdge = imports.find(
      (e) =>
        e.sourceFilePath === 'apps/web/src/use.ts' &&
        e.targetFilePath === 'packages/utils/src/index.ts',
    );
    expect(workspaceEdge).toBeDefined();
  });

  it('emits a cross-package CALLS edge into the workspace package', () => {
    const calls = getRelationships(result, 'CALLS');
    const crossPackage = calls.filter(
      (e) =>
        e.sourceFilePath.startsWith('apps/') &&
        e.targetFilePath.startsWith('packages/utils/') &&
        e.target === 'doThing',
    );
    expect(crossPackage.length).toBeGreaterThan(0);
  });

  it('resolves a baseUrl-relative specifier through the package tsconfig', () => {
    // `apps/web/tsconfig.json` declares `baseUrl: "src"`, which is what makes
    // `import 'utils/format'` legal. The old resolver reached the same file by
    // suffix-matching and would have reached it just as happily with no
    // tsconfig at all; this one resolves it because the project says so.
    const imports = getRelationships(result, 'IMPORTS');
    const edge = imports.find(
      (e) =>
        e.sourceFilePath === 'apps/web/src/baseurl.ts' &&
        e.targetFilePath === 'apps/web/src/utils/format.ts',
    );
    expect(edge).toBeDefined();
  });

  it('resolves a tsconfig paths alias', () => {
    const imports = getRelationships(result, 'IMPORTS');
    const edge = imports.find(
      (e) =>
        e.sourceFilePath === 'apps/web/src/alias.ts' &&
        e.targetFilePath === 'apps/web/src/components/Button.ts',
    );
    expect(edge).toBeDefined();
  });

  it('resolves nothing for a package outside the declared workspace globs', () => {
    // `examples/excluded/package.json` declares `@repo/excluded`, but
    // `pnpm-workspace.yaml` admits only `apps/*` and `packages/*`. A manifest
    // the workspace never admitted is not a workspace package — treating every
    // `package.json` found on disk as one recreates the false-positive half of
    // #2953 from a different source, since an excluded fixture or example that
    // happens to reuse a registry name would capture that name's imports.
    const imports = getRelationships(result, 'IMPORTS');
    const edge = imports.find((e) => e.sourceFilePath === 'apps/web/src/outside.ts');
    expect(edge).toBeUndefined();
  });

  it('resolves nothing for a specifier no config declares', () => {
    // `shared/helper` is not relative, not a package, and not reachable through
    // this project's `baseUrl` (`apps/web/src/shared/helper` does not exist).
    // The old resolver answered `packages/inner/src/shared/helper.ts` anyway,
    // by dropping leading segments until a path suffix matched. Nothing
    // declares that edge, so there is no edge.
    const imports = getRelationships(result, 'IMPORTS');
    const guessed = imports.filter((e) => e.sourceFilePath === 'apps/web/src/guess.ts');
    expect(guessed).toEqual([]);
  });
});
