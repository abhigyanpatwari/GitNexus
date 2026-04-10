/**
 * Group sync integration — keeps a cheap mocked orchestration check and adds
 * a real indexed-fixture path for bridge generation.
 */
import { describe, it, expect } from 'vitest';
import * as path from 'node:path';
import * as fs from 'node:fs';
import * as os from 'node:os';
import { fileURLToPath } from 'node:url';
import { parseGroupConfig } from '../../../src/core/group/config-parser.js';
import { syncGroup } from '../../../src/core/group/sync.js';
import { runFullAnalysis } from '../../../src/core/run-analyze.js';
import { bridgeExists } from '../../../src/core/group/bridge-db.js';
import type { RepoHandle, StoredContract } from '../../../src/core/group/types.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = path.resolve(__dirname, '../../fixtures/group');
const CROSS_REPO_FIXTURE = path.join(FIXTURES_DIR, 'group-cross-repo.yaml');
const FIXTURE_REPOS = [
  'test-monorepo/services/auth',
  'test-monorepo/services/orders',
  'test-monorepo/services/gateway',
] as const;

const ANALYZE_CALLBACKS = {
  onProgress: () => {},
  onLog: () => {},
};

function withIsolatedHomes<T>(run: (tempRoot: string) => Promise<T>): Promise<T> {
  const previous = {
    GITNEXUS_HOME: process.env.GITNEXUS_HOME,
    USERPROFILE: process.env.USERPROFILE,
    HOME: process.env.HOME,
  };
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gitnexus-group-sync-'));
  process.env.GITNEXUS_HOME = path.join(tempRoot, '.gitnexus-home');
  process.env.USERPROFILE = tempRoot;
  process.env.HOME = tempRoot;

  return run(tempRoot).finally(async () => {
    if (previous.GITNEXUS_HOME === undefined) delete process.env.GITNEXUS_HOME;
    else process.env.GITNEXUS_HOME = previous.GITNEXUS_HOME;
    if (previous.USERPROFILE === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = previous.USERPROFILE;
    if (previous.HOME === undefined) delete process.env.HOME;
    else process.env.HOME = previous.HOME;
    await removeTree(tempRoot);
  });
}

function stageFixtureRepos(tempRoot: string): string {
  const fixtureRoot = path.join(tempRoot, 'fixture-root');
  for (const relPath of FIXTURE_REPOS) {
    const sourcePath = path.join(FIXTURES_DIR, relPath);
    const targetPath = path.join(fixtureRoot, relPath);
    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    fs.cpSync(sourcePath, targetPath, { recursive: true });
    fs.rmSync(path.join(targetPath, '.gitnexus'), { recursive: true, force: true });
  }
  return fixtureRoot;
}

async function analyzeFixtureRepos(fixtureRoot: string): Promise<void> {
  for (const relPath of FIXTURE_REPOS) {
    const repoPath = path.join(fixtureRoot, relPath);
    await runFullAnalysis(
      repoPath,
      {
        force: true,
        embeddings: false,
        skipAgentsMd: true,
      },
      ANALYZE_CALLBACKS,
    );
  }
}

async function removeTree(targetPath: string): Promise<void> {
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      fs.rmSync(targetPath, { recursive: true, force: true });
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 50 * (attempt + 1)));
    }
  }
}

function resolveFixtureRepoHandle(registryName: string, groupPath: string): RepoHandle {
  const repoPath = path.join(FIXTURES_DIR, registryName);
  return {
    id: groupPath.replace(/[^a-z0-9]+/gi, '-').toLowerCase(),
    path: groupPath,
    repoPath,
    storagePath: path.join(repoPath, '.gitnexus'),
  };
}

describe('Group sync integration', () => {
  it('parses fixture group.yaml', () => {
    const yamlContent = fs.readFileSync(path.join(FIXTURES_DIR, 'group.yaml'), 'utf-8');
    const config = parseGroupConfig(yamlContent);
    expect(config.name).toBe('test-group');
    expect(config.repos['app/backend']).toBe('test-backend');
    expect(config.repos['app/frontend']).toBe('test-frontend');
  });

  it('builds cross-links from fixture-shaped contracts via syncGroup', async () => {
    const yamlContent = fs.readFileSync(path.join(FIXTURES_DIR, 'group.yaml'), 'utf-8');
    const config = parseGroupConfig(yamlContent);

    const mockContracts: StoredContract[] = [
      {
        contractId: 'http::GET::/api/users',
        type: 'http',
        role: 'provider',
        symbolUid: 'uid-p1',
        symbolRef: { filePath: 'src/routes/users.ts', name: 'list' },
        symbolName: 'list',
        confidence: 0.9,
        meta: { method: 'GET', path: '/api/users' },
        repo: 'app/backend',
      },
      {
        contractId: 'http::GET::/api/users',
        type: 'http',
        role: 'consumer',
        symbolUid: 'uid-c1',
        symbolRef: { filePath: 'src/api/users.ts', name: 'fetchUsers' },
        symbolName: 'fetchUsers',
        confidence: 0.85,
        meta: { method: 'GET', path: '/api/users' },
        repo: 'app/frontend',
      },
      {
        contractId: 'http::GET::/api/health',
        type: 'http',
        role: 'provider',
        symbolUid: 'uid-h1',
        symbolRef: { filePath: 'src/routes/health.ts', name: 'health' },
        symbolName: 'health',
        confidence: 0.9,
        meta: { method: 'GET', path: '/api/health' },
        repo: 'app/backend',
      },
    ];

    const result = await syncGroup(config, {
      extractorOverride: async () => mockContracts,
      skipWrite: true,
    });

    expect(result.crossLinks.length).toBeGreaterThanOrEqual(1);
    const usersLink = result.crossLinks.find((l) => l.contractId.includes('/api/users'));
    expect(usersLink).toBeDefined();
    expect(usersLink!.matchType).toBe('exact');
    expect(usersLink!.confidence).toBe(1.0);

    const healthUnmatched = result.unmatched.some((c) => c.contractId.includes('/api/health'));
    expect(healthUnmatched).toBe(true);
  });

  it('builds bridge.lbug from real per-repo indexes for cross-repo fixture', async () => {
    await withIsolatedHomes(async (tempRoot) => {
      const config = parseGroupConfig(fs.readFileSync(CROSS_REPO_FIXTURE, 'utf-8'));
      const groupDir = path.join(tempRoot, 'group-output');
      const fixtureRoot = stageFixtureRepos(tempRoot);
      fs.mkdirSync(groupDir, { recursive: true });

      await analyzeFixtureRepos(fixtureRoot);

      const result = await syncGroup(config, {
        groupDir,
        resolveRepoHandle: async (registryName, groupPath) => ({
          ...resolveFixtureRepoHandle(registryName, groupPath),
          repoPath: path.join(fixtureRoot, registryName),
          storagePath: path.join(fixtureRoot, registryName, '.gitnexus'),
        }),
      });

      const grpcLink = result.crossLinks.find(
        (link) =>
          link.type === 'grpc' &&
          link.matchType === 'wildcard' &&
          link.from.repo === 'platform/orders' &&
          link.to.repo === 'platform/auth',
      );
      expect(grpcLink).toBeDefined();

      const httpLink = result.crossLinks.find(
        (link) =>
          link.type === 'http' &&
          link.matchType === 'exact' &&
          link.contractId === 'http::POST::/api/orders' &&
          link.from.repo === 'platform/gateway' &&
          link.to.repo === 'platform/orders',
      );
      expect(httpLink).toBeDefined();
      expect(await bridgeExists(groupDir)).toBe(true);
    });
  }, 120000);
});
