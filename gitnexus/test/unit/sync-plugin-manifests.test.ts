import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { syncPluginManifests } from '../../scripts/sync-plugin-manifests.mjs';

const SURFACES = [
  'gitnexus-claude-plugin/.claude-plugin/plugin.json',
  '.claude-plugin/marketplace.json',
  'gitnexus-claude-plugin/.codex-plugin/plugin.json',
  '.agents/plugins/marketplace.json',
] as const;

const tempRoots: string[] = [];

afterEach(() => {
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function writeJson(root: string, file: string, value: unknown): void {
  const filePath = path.join(root, file);
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function makeRoot(packageVersion: string, manifestVersion: string): string {
  const root = mkdtempSync(path.join(os.tmpdir(), 'gitnexus-manifest-sync-'));
  tempRoots.push(root);
  writeJson(root, 'gitnexus/package.json', { name: 'gitnexus', version: packageVersion });
  writeJson(root, SURFACES[0], { name: 'gitnexus', version: manifestVersion });
  writeJson(root, SURFACES[1], {
    name: 'gitnexus-marketplace',
    plugins: [{ name: 'gitnexus', version: manifestVersion, source: './gitnexus-claude-plugin' }],
  });
  writeJson(root, SURFACES[2], { name: 'gitnexus', version: manifestVersion });
  writeJson(root, SURFACES[3], {
    name: 'gitnexus-marketplace',
    plugins: [{ name: 'gitnexus', version: manifestVersion, category: 'Developer Tools' }],
  });
  return root;
}

function readVersions(root: string): string[] {
  return SURFACES.map((file) => {
    const manifest = JSON.parse(readFileSync(path.join(root, file), 'utf8')) as {
      version?: string;
      plugins?: Array<{ name: string; version: string }>;
    };
    return (
      manifest.version ??
      manifest.plugins?.find((plugin) => plugin.name === 'gitnexus')?.version ??
      ''
    );
  });
}

describe('syncPluginManifests (#2445)', () => {
  it('rewrites all four surfaces to the package version and reports them', () => {
    const root = makeRoot('1.6.10-rc.29', '1.6.9');

    const result = syncPluginManifests(root);

    expect(result.version).toBe('1.6.10-rc.29');
    expect(result.synced).toHaveLength(4);
    expect(result.stale.map(({ from }) => from)).toEqual(['1.6.9', '1.6.9', '1.6.9', '1.6.9']);
    expect(readVersions(root)).toEqual(Array(4).fill('1.6.10-rc.29'));
  });

  it('is idempotent once everything matches', () => {
    const root = makeRoot('1.6.10-rc.29', '1.6.9');
    syncPluginManifests(root);

    const second = syncPluginManifests(root);

    expect(second.synced).toHaveLength(0);
    expect(second.stale).toHaveLength(0);
  });

  it('check mode reports drift without writing anything', () => {
    const root = makeRoot('1.6.10-rc.29', '1.6.9');

    const result = syncPluginManifests(root, { check: true });

    expect(result.stale).toHaveLength(4);
    expect(result.synced).toHaveLength(0);
    expect(readVersions(root)).toEqual(Array(4).fill('1.6.9'));
  });

  it('changes only the version text and preserves the surrounding formatting', () => {
    const root = makeRoot('1.6.10-rc.29', '1.6.9');
    const inlineFormatted = `{
  "name": "gitnexus",
  "version": "1.6.9",
  "keywords": ["code-intelligence", "knowledge-graph", "mcp"]
}
`;
    writeFileSync(path.join(root, SURFACES[0]), inlineFormatted);

    syncPluginManifests(root);

    expect(readFileSync(path.join(root, SURFACES[0]), 'utf8')).toBe(
      inlineFormatted.replace('"version": "1.6.9"', '"version": "1.6.10-rc.29"'),
    );
  });

  it('fails closed when the current version text is ambiguous in the file', () => {
    const root = makeRoot('1.6.10-rc.29', '1.6.9');
    writeFileSync(
      path.join(root, SURFACES[0]),
      `{
  "name": "gitnexus",
  "version": "1.6.9",
  "previous": { "version": "1.6.9" }
}
`,
    );

    expect(() => syncPluginManifests(root)).toThrow(/expected exactly one/);
  });

  it('fails closed when a marketplace has no gitnexus entry', () => {
    const root = makeRoot('1.6.10-rc.29', '1.6.9');
    writeJson(root, SURFACES[1], { name: 'gitnexus-marketplace', plugins: [] });

    expect(() => syncPluginManifests(root)).toThrow(/exactly one "gitnexus" plugin entry/);
  });

  it('fails closed when a surface file is missing', () => {
    const root = makeRoot('1.6.10-rc.29', '1.6.9');
    rmSync(path.join(root, SURFACES[2]));

    expect(() => syncPluginManifests(root)).toThrow(/Cannot read manifest surface/);
  });

  it('fails closed on unparseable JSON', () => {
    const root = makeRoot('1.6.10-rc.29', '1.6.9');
    writeFileSync(path.join(root, SURFACES[0]), '{ not json');

    expect(() => syncPluginManifests(root)).toThrow(/not valid JSON/);
  });

  it('matches the real repository layout and passes the check on a synced tree', () => {
    const repoRoot = path.resolve(__dirname, '..', '..', '..');

    const result = syncPluginManifests(repoRoot, { check: true });

    expect(result.stale).toEqual([]);
  });

  it('is wired into the npm version lifecycle so every bump syncs the manifests', async () => {
    const pkg = await import('../../package.json', { with: { type: 'json' } });

    expect(pkg.default.scripts.version).toBe('node scripts/sync-plugin-manifests.mjs');
  });
});
