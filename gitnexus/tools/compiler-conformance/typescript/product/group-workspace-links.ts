import { it } from 'node:test';
import { expect } from 'expect';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { syncGroup } from '../../../../src/core/group/sync.js';
import type { GroupConfig } from '../../../../src/core/group/types.js';
import type { RegistryEntry } from '../../../../src/storage/repo-manager.js';
import { createTestEnvironment } from '../support/environment.js';
it('discovers Node workspace links through syncGroup orchestrator', async (t) => {
  const environment = createTestEnvironment();
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gitnexus-sync-ws-node-'));

  t.after(() => {
    environment.restore();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });
  function makeWsConfig(repos: Record<string, string>, workspaceDeps: boolean): GroupConfig {
    return {
      version: 1,
      name: 'test',
      description: '',
      repos,
      links: [],
      packages: {},
      detect: {
        http: false,
        grpc: false,
        thrift: false,
        topics: false,
        includes: false,
        workspace_deps: workspaceDeps,
      },
      matching: {},
    };
  }

  function writeFileSync(relPath: string, content: string) {
    const absPath = path.join(tmpDir, relPath);
    fs.mkdirSync(path.dirname(absPath), { recursive: true });
    fs.writeFileSync(absPath, content, 'utf-8');
  }

  writeFileSync('shared/package.json', '{"name": "@myorg/shared", "version": "1.0.0"}');
  writeFileSync('shared/src/index.ts', 'export class Config {}\n');

  writeFileSync(
    'app/package.json',
    '{"name": "@myorg/app", "version": "1.0.0", "dependencies": {"@myorg/shared": "workspace:*"}}',
  );
  writeFileSync('app/src/index.ts', "import { Config } from '@myorg/shared';\n");

  const mockEntries: RegistryEntry[] = [
    {
      name: 'shared',
      path: path.join(tmpDir, 'shared'),
      storagePath: path.join(tmpDir, 'shared', '.gitnexus'),
      indexedAt: '',
      lastCommit: '',
    },
    {
      name: 'app',
      path: path.join(tmpDir, 'app'),
      storagePath: path.join(tmpDir, 'app', '.gitnexus'),
      indexedAt: '',
      lastCommit: '',
    },
  ];

  environment.set('GITNEXUS_HOME', tmpDir);
  fs.writeFileSync(path.join(tmpDir, 'registry.json'), JSON.stringify(mockEntries));

  const config = makeWsConfig({ 'pkg/shared': 'shared', 'pkg/app': 'app' }, true);

  const result = await syncGroup(config, {
    extractorOverride: async () => [],
    skipWrite: true,
  });

  const manifestLinks = result.crossLinks.filter((cl) => cl.matchType === 'manifest');
  expect(manifestLinks).toHaveLength(1);
  const nodeLink = manifestLinks.find((cl) => cl.contractId === 'custom::@myorg/shared::Config');
  expect(nodeLink).toBeDefined();
});
