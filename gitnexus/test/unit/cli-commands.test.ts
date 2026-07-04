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

    it('keeps Codex plugin manifests aligned with the gitnexus release version', async () => {
      const pkg = await import('../../package.json', { with: { type: 'json' } });
      const pluginManifest = await readRepoJson<{ version: string }>(
        'gitnexus-claude-plugin/.codex-plugin/plugin.json',
      );
      const marketplaceManifest = await readRepoJson<{
        plugins?: Array<{ name: string; version: string }>;
      }>('.agents/plugins/marketplace.json');

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
    it('loads vendored grammars from vendor/ — never file: optionalDependencies (#1728) nor a node_modules copy (#2111)', async () => {
      const pkg = await import('../../package.json', { with: { type: 'json' } });
      const optional = pkg.default.optionalDependencies ?? {};
      expect(optional['tree-sitter-dart']).toBeUndefined();
      expect(optional['tree-sitter-proto']).toBeUndefined();
      expect(optional['tree-sitter-swift']).toBeUndefined();
      // #2111: the grammars MUST NOT be copied into node_modules at install — an
      // undeclared node_modules package is "extraneous" to every subsequent
      // npm/npx reify, which prunes/relocates it (Windows EPERM symlink + silent
      // deletion on the 2nd run). They are loaded from vendor/ by absolute path
      // (vendored-grammars.ts), so postinstall no longer materializes anything.
      expect(pkg.default.scripts.postinstall).not.toContain('materialize-vendor-grammars.cjs');
      expect(pkg.default.scripts.postinstall).toContain('build-tree-sitter-grammars.cjs');
      expect(pkg.default.files).toContain('vendor');
    });

    it('declares node-gyp-build/node-addon-api as regular dependencies (runtime-load contract)', async () => {
      // Every vendored grammar's index.js does `require("node-gyp-build")` at
      // runtime to load even a prebuilt .node, so node-gyp-build must always be
      // present. They were optionalDependencies (surviving --omit=optional only
      // via tree-sitter's transitive edge); promote them so the contract is
      // explicit and robust to a future tree-sitter change.
      const pkg = await import('../../package.json', { with: { type: 'json' } });
      const deps = pkg.default.dependencies ?? {};
      const optional = (pkg.default as { optionalDependencies?: Record<string, string> })
        .optionalDependencies;
      expect(deps['node-gyp-build']).toBeDefined();
      expect(deps['node-addon-api']).toBeDefined();
      // No grammar/native-build entries linger in optionalDependencies.
      expect(optional?.['node-gyp-build']).toBeUndefined();
      expect(optional?.['node-addon-api']).toBeUndefined();
    });

    it('keeps vendored Swift runtime with vendored source + GitNexus-built prebuilds and hoisted activation script', async () => {
      const pkg = await import('../../package.json', { with: { type: 'json' } });
      const swiftPkg = await import('../../vendor/tree-sitter-swift/package.json', {
        with: { type: 'json' },
      });
      // Exact pin (no caret) — #1922 holds the runtime at 0.21.1 so the ABI
      // gate's assumptions (setTimeoutMicros semantics, ABI 13–14 grammar
      // range) can't drift under a minor bump.
      expect(pkg.default.dependencies['tree-sitter']).toBe('0.21.1');
      expect(pkg.default.scripts.postinstall).toContain('build-tree-sitter-grammars.cjs');
      expect(swiftPkg.default.version).toBe('0.7.1');
      // No scripts.install / dependencies inside vendor/ (#836 / #1728 hygiene).
      expect(swiftPkg.default.scripts?.install).toBeUndefined();
      expect(swiftPkg.default.dependencies).toBeUndefined();
      expect(swiftPkg.default.peerDependencies['tree-sitter']).toContain('^0.21.1');
      // Swift is now unified with Dart/Proto/Kotlin/C: the grammar SOURCE is
      // vendored so build-tree-sitter-grammars.cjs can source-build the binding
      // when no committed prebuild matches (e.g. CI before prebuilds land).
      const bindingGyp = await fs.readFile(
        path.join(REPO_ROOT, 'gitnexus/vendor/tree-sitter-swift/binding.gyp'),
        'utf8',
      );
      expect(bindingGyp).toContain('tree_sitter_swift_binding');
      expect(bindingGyp).toContain('src/parser.c');
      await expect(
        fs.stat(path.join(REPO_ROOT, 'gitnexus/vendor/tree-sitter-swift/src/parser.c')),
      ).resolves.toBeDefined();
    });

    it('keeps vendored Kotlin runtime with GitNexus-built prebuilds and hoisted activation script (#2107)', async () => {
      const pkg = await import('../../package.json', { with: { type: 'json' } });
      const kotlinPkg = await import('../../vendor/tree-sitter-kotlin/package.json', {
        with: { type: 'json' },
      });
      const optional = pkg.default.optionalDependencies ?? {};
      // Kotlin is now VENDORED (like Swift/Dart/Proto), not a third-party npm
      // optionalDependency. Its prebuilds are GitNexus-cross-built (upstream
      // ships source only) and loaded from vendor/ by absolute path (#2111).
      expect(optional['tree-sitter-kotlin']).toBeUndefined();
      expect(pkg.default.scripts.postinstall).toContain('build-tree-sitter-grammars.cjs');
      expect(kotlinPkg.default.version).toBe('0.4.0');
      // No scripts.install / dependencies inside vendor/ (#836 / #1728 hygiene).
      expect(kotlinPkg.default.scripts?.install).toBeUndefined();
      expect(kotlinPkg.default.dependencies).toBeUndefined();
      expect(kotlinPkg.default.peerDependencies['tree-sitter']).toContain('^0.21');
    });

    it('vendors tree-sitter-c prebuild-only at the 0.21.4 ABI pin instead of an npm dependency (#2116/#1242)', async () => {
      const pkg = await import('../../package.json', { with: { type: 'json' } });
      const cPkg = await import('../../vendor/tree-sitter-c/package.json', {
        with: { type: 'json' },
      });
      // c is a REQUIRED grammar that hard-fails install on toolchain-less ARM
      // (upstream ships 4/6). Vendored with GitNexus-built prebuilds for all 6,
      // held at 0.21.4 for ABI safety (#1242) — so it is NOT an npm dependency.
      expect(pkg.default.dependencies['tree-sitter-c']).toBeUndefined();
      expect(pkg.default.scripts.postinstall).toContain('build-tree-sitter-grammars.cjs');
      expect(cPkg.default.version).toBe('0.21.4');
      expect(cPkg.default.scripts?.install).toBeUndefined();
      expect(cPkg.default.dependencies).toBeUndefined();
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
