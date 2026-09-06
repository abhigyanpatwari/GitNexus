/**
 * Review finding on #3182 (magyargergo, node-workspace-packages.ts:730): the
 * vite `lib.entry` regex took its FIRST match, which could sit inside a comment
 * (`// old lib: { entry: 'src/wrong.ts' }`) ahead of the live config. Comments
 * are stripped first, and every live `lib.entry` is a candidate so two
 * disagreeing ones are refused as ambiguous rather than first-wins.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  loadNodeWorkspacePackages,
  stripJsComments,
} from '../../src/core/ingestion/import-resolvers/node-workspace-packages.js';

describe('stripJsComments', () => {
  it('drops line and block comments and keeps string contents intact', () => {
    expect(stripJsComments("a; // lib: { entry: 'x' }\nb /* lib: {\n entry: 'y' } */ c")).toBe(
      'a; \nb  c',
    );
    expect(stripJsComments("const u = 'http://x/*y'; // c")).toBe("const u = 'http://x/*y'; ");
    expect(stripJsComments('const s = "a\\"//b"; x')).toBe('const s = "a\\"//b"; x');
  });
});

describe('vite lib.entry discovery ignores comments and refuses disagreeing entries', () => {
  let dir: string;
  const w = (p: string, s: string) => {
    fs.mkdirSync(path.dirname(path.join(dir, p)), { recursive: true });
    fs.writeFileSync(path.join(dir, p), s);
  };
  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gn-vite-comment-'));
    w('package.json', JSON.stringify({ name: 'root', private: true, workspaces: ['packages/*'] }));
    // A commented-out stale entry BEFORE the live one; both files exist.
    w(
      'packages/commented/package.json',
      JSON.stringify({ name: '@acme/commented', exports: { '.': './dist/bundle.js' } }),
    );
    w(
      'packages/commented/vite.config.ts',
      `// old lib: { entry: "src/wrong.ts" }\n/* also once: lib: { entry: 'src/wrong.ts' } */\nexport default defineConfig({ build: { lib: { entry: "src/right.ts" } } });\n`,
    );
    w('packages/commented/src/wrong.ts', 'export const wrong = 1;\n');
    w('packages/commented/src/right.ts', 'export const right = 1;\n');
    // Two LIVE lib objects that disagree: ambiguous, refuse.
    w(
      'packages/twolive/package.json',
      JSON.stringify({ name: '@acme/twolive', main: 'dist/index.js' }),
    );
    w(
      'packages/twolive/vite.config.ts',
      `const a = { lib: { entry: 'src/a.ts' } };\nexport default process.env.X ? a : { build: { lib: { entry: 'src/b.ts' } } };\n`,
    );
    w('packages/twolive/src/a.ts', 'export const a = 1;\n');
    w('packages/twolive/src/b.ts', 'export const b = 1;\n');
  });
  afterAll(() => {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  it('picks the live entry, never the commented one', async () => {
    const pkgs = await loadNodeWorkspacePackages(dir);
    const entries = pkgs!.byName.get('@acme/commented')!.entries;
    expect(entries).toContain('packages/commented/src/right');
    expect(entries).not.toContain('packages/commented/src/wrong');
  });

  it('refuses when two live lib entries name different existing files', async () => {
    const pkgs = await loadNodeWorkspacePackages(dir);
    const entries = pkgs!.byName.get('@acme/twolive')!.entries;
    expect(entries).not.toContain('packages/twolive/src/a');
    expect(entries).not.toContain('packages/twolive/src/b');
  });
});
