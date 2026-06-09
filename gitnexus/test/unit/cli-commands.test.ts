import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect, vi } from 'vitest';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

async function readRepoJson<T>(relativePath: string): Promise<T> {
  return JSON.parse(await fs.readFile(path.join(REPO_ROOT, relativePath), 'utf8')) as T;
}

// Mock all the heavy imports before importing index
vi.mock('../../src/cli/analyze.js', () => ({
  analyzeCommand: vi.fn(),
}));
vi.mock('../../src/cli/mcp.js', () => ({
  mcpCommand: vi.fn(),
}));
vi.mock('../../src/cli/setup.js', () => ({
  setupCommand: vi.fn(),
}));
vi.mock('../../src/cli/publish.js', () => ({
  publishCommand: vi.fn(),
}));

describe('CLI commands', () => {
  describe('version', () => {
    it('package.json has a valid version string', async () => {
      const pkg = await import('../../package.json', { with: { type: 'json' } });
      expect(pkg.default.version).toMatch(/^\d+\.\d+\.\d+/);
    });

    it('keeps Claude plugin manifests aligned with the gitnexus release version', async () => {
      const pkg = await import('../../package.json', { with: { type: 'json' } });
      const pluginManifest = await readRepoJson<{ version: string }>(
        'gitnexus-claude-plugin/.claude-plugin/plugin.json',
      );
      const marketplaceManifest = await readRepoJson<{
        plugins?: Array<{ name: string; version: string }>;
      }>('.claude-plugin/marketplace.json');

      expect(Array.isArray(marketplaceManifest.plugins)).toBe(true);

      const gitnexusEntries = (marketplaceManifest.plugins ?? []).filter(
        (plugin) => plugin.name === 'gitnexus',
      );

      expect(gitnexusEntries).toHaveLength(1);
      expect(pluginManifest.version).toBe(pkg.default.version);
      expect(gitnexusEntries[0]?.version).toBe(pkg.default.version);
    });
  });

  describe('package.json scripts', () => {
    it('has test scripts configured', async () => {
      const pkg = await import('../../package.json', { with: { type: 'json' } });
      expect(pkg.default.scripts.test).toBeDefined();
      expect(pkg.default.scripts['test:integration']).toBeDefined();
      expect(pkg.default.scripts['test:unit']).toBeDefined();
    });

    it('has build script', async () => {
      const pkg = await import('../../package.json', { with: { type: 'json' } });
      expect(pkg.default.scripts.build).toBeDefined();
    });
  });

  describe('package.json bin entry', () => {
    it('exposes gitnexus binary', async () => {
      const pkg = await import('../../package.json', { with: { type: 'json' } });
      expect(pkg.default.bin).toBeDefined();
      expect(pkg.default.bin.gitnexus || pkg.default.bin).toBeDefined();
    });
  });

  describe('optional parser dependencies', () => {
    it('materializes vendored grammars at postinstall instead of file: optionalDependencies (#1728)', async () => {
      const pkg = await import('../../package.json', { with: { type: 'json' } });
      const optional = pkg.default.optionalDependencies ?? {};
      expect(optional['tree-sitter-dart']).toBeUndefined();
      expect(optional['tree-sitter-proto']).toBeUndefined();
      expect(optional['tree-sitter-swift']).toBeUndefined();
      expect(pkg.default.scripts.postinstall).toContain('materialize-vendor-grammars.cjs');
      expect(pkg.default.files).toContain('vendor');
    });

    it('keeps vendored Swift runtime with prebuilds and hoisted activation script', async () => {
      const pkg = await import('../../package.json', { with: { type: 'json' } });
      const swiftPkg = await import('../../vendor/tree-sitter-swift/package.json', {
        with: { type: 'json' },
      });
      // Exact pin (no caret) — #1922 holds the runtime at 0.21.1 so the ABI
      // gate's assumptions (setTimeoutMicros semantics, ABI 13–14 grammar
      // range) can't drift under a minor bump.
      expect(pkg.default.dependencies['tree-sitter']).toBe('0.21.1');
      expect(pkg.default.scripts.postinstall).toContain('build-tree-sitter-swift.cjs');
      expect(swiftPkg.default.version).toBe('0.7.1');
      expect(swiftPkg.default.scripts?.install).toBeUndefined();
      expect(swiftPkg.default.dependencies).toBeUndefined();
      expect(swiftPkg.default.peerDependencies['tree-sitter']).toContain('^0.21.1');
    });

    it('declares tree-sitter-kotlin as an optionalDependency probed at postinstall (#2107)', async () => {
      const pkg = await import('../../package.json', { with: { type: 'json' } });
      const optional = pkg.default.optionalDependencies ?? {};
      // Kotlin is a third-party npm optionalDependency (not vendored), so npm
      // skips it when its source-only native build soft-fails — the gitnexus
      // install still succeeds.
      expect(optional['tree-sitter-kotlin']).toBeDefined();
      expect(pkg.default.scripts.postinstall).toContain('build-tree-sitter-kotlin.cjs');
    });
  });

  describe('analyzeCommand', () => {
    it('is a function', async () => {
      const { analyzeCommand } = await import('../../src/cli/analyze.js');
      expect(typeof analyzeCommand).toBe('function');
    });
  });

  describe('mcpCommand', () => {
    it('is a function', async () => {
      const { mcpCommand } = await import('../../src/cli/mcp.js');
      expect(typeof mcpCommand).toBe('function');
    });
  });

  describe('setupCommand', () => {
    it('is a function', async () => {
      const { setupCommand } = await import('../../src/cli/setup.js');
      expect(typeof setupCommand).toBe('function');
    });
  });

  describe('publishCommand', () => {
    it('is a function', async () => {
      const { publishCommand } = await import('../../src/cli/publish.js');
      expect(typeof publishCommand).toBe('function');
    });
  });
});
