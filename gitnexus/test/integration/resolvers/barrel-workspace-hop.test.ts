/**
 * The workspace-package barrel hop.
 *
 * A call imported from a workspace package (`@x/ui`) resolves through the
 * package's `main`, through three re-export forms, and through a barrel chain
 * three levels deep; a call imported through a tsconfig `paths` alias resolves
 * too. Those resolutions are pinned here against regression, together with the
 * one shape the resolver must REFUSE: two `export *` sources publishing the
 * same name (a star-vs-star collision) is recorded as `reexport-ambiguous`
 * naming both candidates, and the name appears in the run's census.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import path from 'path';
import fs from 'node:fs';
import os from 'node:os';
import {
  getRelationships,
  runPipelineFromRepo,
  writeFixtureRepo,
  type PipelineResult,
} from './helpers.js';
import { summarizeNameFallback } from '../../../src/core/ingestion/scope-resolution/name-fallback-summary.js';

describe('workspace-package barrel hop', () => {
  let result: PipelineResult;
  let repoDir: string | undefined;

  beforeAll(async () => {
    repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gn-ws1c-barrel-'));
    writeFixtureRepo(repoDir, {
      'package.json': '{ "name": "root", "private": true, "workspaces": ["packages/*"] }\n',
      'packages/ui/package.json':
        '{ "name": "@x/ui", "version": "1.0.0", "main": "src/index.ts" }\n',
      // Three re-export forms in one barrel, plus a nested barrel chain.
      'packages/ui/src/index.ts': `export { Button } from './components/Button/Button';
export * from './components/Stack';
export type { ButtonProps } from './components/Button/Button';
export * from './themes';
`,
      'packages/ui/src/components/Button/Button.tsx': `export interface ButtonProps { label: string }
export function Button(props: ButtonProps) {
  return props.label;
}
`,
      'packages/ui/src/components/Stack/index.ts': `export * from './Stack';\n`,
      'packages/ui/src/components/Stack/Stack.tsx': `export function Stack(children: string) {
  return children;
}
`,
      // themes -> hooks -> useStyles2: three barrels deep.
      'packages/ui/src/themes/index.ts': `export * from './hooks';\n`,
      'packages/ui/src/themes/hooks/index.ts': `export * from './useStyles2';\n`,
      'packages/ui/src/themes/hooks/useStyles2.ts': `export function useStyles2(fn: (t: string) => string) {
  return fn('theme');
}
`,
      'packages/app/package.json':
        '{ "name": "@x/app", "version": "1.0.0", "main": "src/main.tsx", "dependencies": { "@x/ui": "1.0.0" } }\n',
      'packages/app/tsconfig.json': `{
  "compilerOptions": {
    "jsx": "react-jsx",
    "baseUrl": "src",
    "paths": { "app/core/*": ["core/*"] }
  }
}
`,
      'packages/app/src/core/utils/format.ts': `export function formatTitle(raw: string) {
  return raw.trim();
}
`,
      // Calls AND JSX through the same imported names.
      'packages/app/src/features/Panel.tsx': `import { Button, Stack, useStyles2 } from '@x/ui';
import { formatTitle } from 'app/core/utils/format';

export function Panel() {
  const styles = useStyles2((t) => t);
  const title = formatTitle('  hi  ');
  const label = Button({ label: title });
  const stacked = Stack(label);
  return <Stack><Button label={styles + stacked} /></Stack>;
}
`,
    });
    result = await runPipelineFromRepo(repoDir, () => {});
  }, 180000);

  afterAll(() => {
    if (repoDir !== undefined) {
      fs.rmSync(repoDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });

  it('resolves a call through the package barrel to its real definition file', () => {
    const edge = getRelationships(result, 'CALLS').find(
      (c) => c.source === 'Panel' && c.target === 'Button',
    );
    expect(edge?.targetFilePath).toBe('packages/ui/src/components/Button/Button.tsx');
  });

  it('resolves through an `export *` re-export', () => {
    const edge = getRelationships(result, 'CALLS').find(
      (c) => c.source === 'Panel' && c.target === 'Stack',
    );
    expect(edge?.targetFilePath).toBe('packages/ui/src/components/Stack/Stack.tsx');
  });

  it('resolves through a barrel chain three levels deep', () => {
    const edge = getRelationships(result, 'CALLS').find(
      (c) => c.source === 'Panel' && c.target === 'useStyles2',
    );
    expect(edge?.targetFilePath).toBe('packages/ui/src/themes/hooks/useStyles2.ts');
  });

  it('resolves through a tsconfig `paths` alias', () => {
    const edge = getRelationships(result, 'CALLS').find(
      (c) => c.source === 'Panel' && c.target === 'formatTitle',
    );
    expect(edge?.targetFilePath).toBe('packages/app/src/core/utils/format.ts');
  });
});

/**
 * `export * from './a'; export * from './b'` where both files declare `collide`
 * is ambiguous: the language names no winner (ECMAScript excludes the name from
 * the module's exports). The resolver used to pick the first-listed source and
 * publish the edge as `import-resolved` at 0.85 — a definite target for a call
 * that has none, the "incorrect context is worse than missing context" failure
 * in its purest form.
 *
 * Fixed in the shared finalize pass (`collectAmbiguousWildcards`): the name is
 * refused in BOTH places it used to win — the barrel's re-export closure and
 * the barrel's own wildcard-expanded module scope — and reported through
 * `FinalizeStats.ambiguousWildcardExports`, which the pipeline records as a
 * `reexport-ambiguous` resolution outcome. The importer stays unresolved —
 * a missing edge, never a wrong one.
 */
describe('ambiguous `export *` collision is refused, not guessed', () => {
  let result: PipelineResult;
  let repoDir: string | undefined;

  beforeAll(async () => {
    repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gn-ws1c-ambig-'));
    writeFixtureRepo(repoDir, {
      'package.json': '{ "name": "root", "private": true, "workspaces": ["packages/*"] }\n',
      'packages/ui/package.json':
        '{ "name": "@x/ui", "version": "1.0.0", "main": "src/index.ts" }\n',
      'packages/ui/src/index.ts': `export * from './a';\nexport * from './b';\nexport * from './c';\n`,
      'packages/ui/src/a.ts': `export function collide() { return 'a'; }\nexport function onlyA() { return 1; }\n`,
      'packages/ui/src/b.ts': `export function collide() { return 'b'; }\n`,
      'packages/ui/src/c.ts': `export function onlyC() { return 3; }\n`,
      'packages/app/package.json':
        '{ "name": "@x/app", "version": "1.0.0", "main": "src/m.ts", "dependencies": { "@x/ui": "1.0.0" } }\n',
      'packages/app/src/m.ts': `import { collide, onlyA, onlyC } from '@x/ui';
export function useIt() { onlyA(); onlyC(); return collide(); }
`,
    });
    result = await runPipelineFromRepo(repoDir, () => {});
  }, 180000);

  afterAll(() => {
    if (repoDir !== undefined) {
      fs.rmSync(repoDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });

  it('emits NO CALLS edge for the colliding name', () => {
    const edges = getRelationships(result, 'CALLS').filter(
      (c) => c.source === 'useIt' && c.target === 'collide',
    );
    expect(edges).toEqual([]);
  });

  it('still resolves the names that do NOT collide through the same barrel', () => {
    const targets = getRelationships(result, 'CALLS')
      .filter((c) => c.source === 'useIt')
      .map((c) => c.target)
      .sort();
    expect(targets).toEqual(['onlyA', 'onlyC']);
  });

  it('records the refusal as a `reexport-ambiguous` outcome naming both candidates', () => {
    const refused = result.resolutionOutcomes.filter(
      (o) => o.kind === 'reexport-ambiguous' && o.name === 'collide',
    );
    expect(refused).toHaveLength(1);
    const [outcome] = refused;
    expect(outcome!.kind === 'reexport-ambiguous' && outcome!.filePath).toBe(
      'packages/ui/src/index.ts',
    );
    expect(outcome!.kind === 'reexport-ambiguous' ? outcome!.candidateIds.length : 0).toBe(2);
  });

  // The census persists the refused barrel name itself, not just a count. This
  // is the real star-vs-star collision the pipeline produced (not a hand-built
  // `ResolutionOutcome`), closing the loop from the `reexport-ambiguous`
  // outcome through to the persisted name list.
  it('the barrel census names the refused collision in `ambiguousReexportNames`', () => {
    const summary = summarizeNameFallback(result.resolutionOutcomes);
    expect(summary?.totalAmbiguousReexports).toBe(1);
    expect(summary?.ambiguousReexportNames).toEqual(['packages/ui/src/index.ts:collide']);
  });
});
