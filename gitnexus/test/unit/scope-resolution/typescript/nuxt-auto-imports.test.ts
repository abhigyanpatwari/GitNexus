import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  getNuxtAutoImportEntry,
  isNitroServerRuntimeFile,
  loadNuxtAutoImports,
} from '../../../../src/core/ingestion/languages/typescript/nuxt-auto-imports.js';

const tempRoots: string[] = [];

function makeRepo(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gitnexus-nuxt-auto-imports-'));
  tempRoots.push(root);
  return root;
}

function writeFile(root: string, relPath: string, content: string): void {
  const fullPath = path.join(root, relPath);
  fs.mkdirSync(path.dirname(fullPath), { recursive: true });
  fs.writeFileSync(fullPath, content, 'utf8');
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe('loadNuxtAutoImports', () => {
  it('returns null for non-Nuxt repos without .nuxt/imports.d.ts', async () => {
    const root = makeRepo();
    writeFile(root, 'server/utils/helpers.ts', 'export function serverOnly() {}');

    await expect(loadNuxtAutoImports(root)).resolves.toBeNull();
  });

  it('keeps client and server entries separate and selects by caller scope', async () => {
    const root = makeRepo();
    writeFile(
      root,
      '.nuxt/imports.d.ts',
      "export { validate, useThing as useAlias } from '../composables/clientValidate'\n",
    );
    writeFile(root, 'composables/clientValidate.ts', 'export function validate() {}');
    writeFile(root, 'server/utils/serverValidate.ts', 'export function validate() {}');

    const config = await loadNuxtAutoImports(root);

    expect(config).not.toBeNull();
    expect(config!.clientByLocalName.get('validate')).toMatchObject({
      sourceFile: 'composables/clientValidate.ts',
      scope: 'client',
    });
    expect(config!.clientByLocalName.get('useAlias')).toMatchObject({
      exportName: 'useThing',
      sourceFile: 'composables/clientValidate.ts',
      scope: 'client',
    });
    expect(config!.serverByLocalName.get('validate')).toMatchObject({
      sourceFile: 'server/utils/serverValidate.ts',
      scope: 'server',
    });
    expect(getNuxtAutoImportEntry(config!, 'validate', 'server/api/users.ts')).toMatchObject({
      sourceFile: 'server/utils/serverValidate.ts',
    });
    expect(getNuxtAutoImportEntry(config!, 'validate', 'app.vue')).toMatchObject({
      sourceFile: 'composables/clientValidate.ts',
    });
    // A Nitro server caller does NOT fall back to a client-only composable.
    expect(getNuxtAutoImportEntry(config!, 'useAlias', 'server/api/users.ts')).toBeUndefined();
  });

  it('resolves extensionless directory imports to index files', async () => {
    const root = makeRepo();
    writeFile(root, '.nuxt/imports.d.ts', "export { useGroup } from '../composables/group'\n");
    writeFile(root, 'composables/group/index.ts', 'export function useGroup() {}');

    const config = await loadNuxtAutoImports(root);

    expect(config!.clientByLocalName.get('useGroup')).toMatchObject({
      sourceFile: 'composables/group/index.ts',
    });
  });

  it('indexes common server/utils export forms and skips generated dirs', async () => {
    const root = makeRepo();
    writeFile(root, '.nuxt/imports.d.ts', '');
    writeFile(
      root,
      'server/utils/helpers.ts',
      [
        'export function fn() {}',
        'export async function asyncFn() {}',
        'export class ServerThing {}',
        'export default function defaultTool() {}',
        'export const alpha = () => {}, beta = () => {};',
        'export let gamma = () => {};',
        'export var delta = () => {};',
      ].join('\n'),
    );
    writeFile(root, 'server/utils/jsHelper.js', 'export function jsServerTool() {}');
    writeFile(root, 'server/utils/dist/generated.ts', 'export function generatedUtility() {}');

    const config = await loadNuxtAutoImports(root);

    expect([...config!.serverByLocalName.keys()].sort()).toEqual([
      'ServerThing',
      'alpha',
      'asyncFn',
      'beta',
      'defaultTool',
      'delta',
      'fn',
      'gamma',
      'jsServerTool',
    ]);
    expect(config!.serverByLocalName.get('jsServerTool')).toMatchObject({
      sourceFile: 'server/utils/jsHelper.js',
    });
  });

  it('captures only LHS binding names from server/utils const exports', async () => {
    const root = makeRepo();
    writeFile(root, '.nuxt/imports.d.ts', '');
    writeFile(
      root,
      'server/utils/forms.ts',
      [
        'export const createUser = async (event: H3Event) => {};',
        'export const config = { onError: () => {} };',
        'export const eq = a === b;',
        'export const helper: Record<string, unknown> = {};',
        'export const first = 1, second = 2;',
      ].join('\n'),
    );

    const config = await loadNuxtAutoImports(root);

    // Only declared binding names — never RHS arrow params (`event`), object
    // keys (`onError`), operands (`a`/`b`), nor a generic-typed name dropped at
    // the comma inside `Record<string, unknown>`.
    expect([...config!.serverByLocalName.keys()].sort()).toEqual([
      'config',
      'createUser',
      'eq',
      'first',
      'helper',
      'second',
    ]);
  });

  it('ignores imports.d.ts sources that resolve outside the repo root', async () => {
    const root = makeRepo();
    // A real file in its own temp dir OUTSIDE the repo, reachable from .nuxt only
    // by directory traversal. Its own mkdtemp dir is tracked for cleanup.
    const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gitnexus-nuxt-escape-'));
    tempRoots.push(outsideDir);
    const outside = path.join(outsideDir, 'escape.ts');
    fs.writeFileSync(outside, 'export function escape() {}', 'utf8');

    // Relative traversal from root/.nuxt to the out-of-repo file (extensionless).
    const traversal = path
      .relative(path.join(root, '.nuxt'), outside)
      .replace(/\\/g, '/')
      .replace(/\.ts$/, '');
    writeFile(
      root,
      '.nuxt/imports.d.ts',
      [
        `export { escape } from '${traversal}'`,
        "export { useGood } from '../composables/good'",
      ].join('\n'),
    );
    writeFile(root, 'composables/good.ts', 'export function useGood() {}');

    const config = await loadNuxtAutoImports(root);

    // The traversal source is skipped (no entry, no throw); the in-repo one resolves.
    expect(config!.clientByLocalName.has('escape')).toBe(false);
    expect(config!.clientByLocalName.get('useGood')).toMatchObject({
      sourceFile: 'composables/good.ts',
    });
  });
});

describe('isNitroServerRuntimeFile', () => {
  it('matches only Nitro runtime entry directories', () => {
    expect(isNitroServerRuntimeFile('server/api/users.ts')).toBe(true);
    expect(isNitroServerRuntimeFile('server/routes/feed.ts')).toBe(true);
    expect(isNitroServerRuntimeFile('server/middleware/auth.ts')).toBe(true);
    expect(isNitroServerRuntimeFile('server/plugins/init.ts')).toBe(true);
    expect(isNitroServerRuntimeFile('server/tasks/cleanup.ts')).toBe(true);
    expect(isNitroServerRuntimeFile('server/utils/auth.ts')).toBe(false);
    expect(isNitroServerRuntimeFile('pages/index.ts')).toBe(false);
  });
});
