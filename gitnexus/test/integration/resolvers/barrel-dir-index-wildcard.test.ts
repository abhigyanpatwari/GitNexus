/**
 * C2 — the grafana `Button` shape: a workspace barrel `export *`s a components
 * index, which re-exports NAMED bindings (with inline `type` modifiers) from a
 * DIRECTORY index, which `export *`s the real file, whose `Button` is a
 * `React.forwardRef` const. Measured on grafana@871af0720: `Button` resolved 8
 * of 475 ledger entries while siblings through plain hops resolved at scale.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import path from 'path';
import fs from 'node:fs';
import os from 'node:os';
import {
  getRelationships,
  getResolutionOutcomes,
  runPipelineFromRepo,
  writeFixtureRepo,
  type PipelineResult,
} from './helpers.js';

describe('named re-export through a directory index that wildcards (grafana Button shape)', () => {
  let result: PipelineResult;
  let repoDir: string | undefined;

  beforeAll(async () => {
    repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gn-c2-dir-index-'));
    writeFixtureRepo(repoDir, {
      'package.json': '{ "name": "root", "private": true, "workspaces": ["packages/*"] }\n',
      'packages/ui/package.json':
        '{ "name": "@x/ui", "version": "1.0.0", "main": "src/index.ts" }\n',
      'packages/ui/src/index.ts': `export * from './components';\nexport * from './themes';\n`,
      // Inline `type` modifiers on the same statement as value re-exports.
      'packages/ui/src/components/index.ts': `export { Stack } from './Layout/Stack';
export { Button, LinkButton, type ButtonVariant, ButtonGroup, type ButtonProps, clearButtonStyles } from './Button';
`,
      // Directory index: wildcard + one named re-export.
      'packages/ui/src/components/Button/index.ts': `export * from './Button';\nexport { ButtonGroup } from './ButtonGroup';\n`,
      'packages/ui/src/components/Button/Button.tsx': `import React from 'react';
export type ButtonVariant = 'primary' | 'secondary';
export interface ButtonProps { variant?: ButtonVariant; label: string }
export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>((props, ref) => {
  return null;
});
export const LinkButton = React.forwardRef<HTMLAnchorElement, ButtonProps>((props, ref) => {
  return null;
});
export const clearButtonStyles = (theme: string) => {
  return theme;
};
`,
      'packages/ui/src/components/Button/ButtonGroup.tsx': `export function ButtonGroup(children: string) {
  return children;
}
`,
      'packages/ui/src/components/Layout/Stack.tsx': `export function Stack(children: string) {
  return children;
}
`,
      'packages/ui/src/themes/index.ts': `export * from './hooks';\n`,
      'packages/ui/src/themes/hooks/index.ts': `export * from './useStyles2';\n`,
      'packages/ui/src/themes/hooks/useStyles2.ts': `export function useStyles2(fn: (t: string) => string) {
  return fn('theme');
}
`,
      'packages/app/package.json':
        '{ "name": "@x/app", "version": "1.0.0", "main": "src/main.tsx", "dependencies": { "@x/ui": "1.0.0" } }\n',
      'packages/app/tsconfig.json': `{ "compilerOptions": { "jsx": "react-jsx" } }\n`,
      'packages/app/src/main.tsx': `import { Button, LinkButton, ButtonGroup, clearButtonStyles, Stack, useStyles2 } from '@x/ui';

export function render() {
  const styles = useStyles2((t) => t);
  clearButtonStyles(styles);
  ButtonGroup('x');
  Stack('y');
  const a = <Button label="a" />;
  const b = <LinkButton label="b" />;
  return [a, b];
}
`,
    });
    result = await runPipelineFromRepo(repoDir, () => {});
  }, 120_000);

  afterAll(() => {
    if (repoDir !== undefined)
      fs.rmSync(repoDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  const callsFromMain = () =>
    getRelationships(result, 'CALLS').filter((e) =>
      e.sourceFilePath.includes('packages/app/src/main.tsx'),
    );

  it('resolves the plain named hop (Stack) and the deep wildcard chain (useStyles2)', () => {
    const targets = callsFromMain().map((e) => e.target);
    expect(targets.some((t) => t.includes('Stack'))).toBe(true);
    expect(targets.some((t) => t.includes('useStyles2'))).toBe(true);
  });

  it('resolves value names on a statement that also carries inline `type` modifiers', () => {
    const targets = callsFromMain().map((e) => e.target);
    expect(targets.some((t) => t.includes('clearButtonStyles'))).toBe(true);
    expect(targets.some((t) => t.includes('ButtonGroup'))).toBe(true);
  });

  it('resolves a forwardRef const component used as JSX through the dir-index wildcard', () => {
    const targets = callsFromMain().map((e) => e.target);
    // Exact name — `/Button$/` also matched `LinkButton`, which made the
    // assertion below imply this one and would have let zero `Button` edges pass.
    expect(targets).toContain('Button');
    expect(targets.some((t) => t.includes('LinkButton'))).toBe(true);
  });

  it('refuses nothing on this shape (no ambiguity, no fallback)', () => {
    const outcomes = getResolutionOutcomes(result);
    expect(outcomes.filter((o) => o.kind === 'reexport-ambiguous')).toEqual([]);
    expect(outcomes.filter((o) => o.kind === 'fallback-guessed')).toEqual([]);
  });

  // The bug this fixture regresses against wasn't "no edge" — it was an edge
  // to the WRONG node. `export const Button = React.forwardRef(...)` emits a
  // `Variable` def for the lexical declaration alongside the `Function` def
  // for the arrow; before the wildcard fan-out used the same
  // callable-preferred index the named-reexport path already used, whichever
  // def `localDefs` happened to iterate first could win the closure slot. An
  // edge landing on `Variable` would still show up in a `target` name match
  // (both defs share the simple name) while pointing at the wrong graph node
  // — so the label, not just the name, is the assertion that actually catches
  // a regression here.
  it('every arrow-const winner through the wildcard chain is the Function def, not the Variable shadow', () => {
    const calls = callsFromMain();
    for (const name of ['Button', 'LinkButton', 'clearButtonStyles']) {
      const labels = calls.filter((edge) => edge.target === name).map((edge) => edge.targetLabel);
      expect(labels, name).toEqual(['Function']);
    }
  });
});
