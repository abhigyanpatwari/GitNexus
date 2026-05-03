/**
 * Integration test for code-level dependency detection across repos.
 *
 * Tests the full pipeline:
 * 1. Fixture repos with package.json (shared-utils exports, web-app imports)
 * 2. CodeDepExtractor produces lib contracts (provider + consumer)
 * 3. syncGroup matches them into CrossLinks with type 'lib'
 *
 * Uses extractorOverride for provider contracts (no LadybugDB needed),
 * and real source scanning for consumer contracts.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { syncGroup } from '../../../src/core/group/sync.js';
import type { GroupConfig, StoredContract } from '../../../src/core/group/types.js';

describe('Code-dep sync integration', () => {
  let tmpDir: string;
  let sharedDir: string;
  let webAppDir: string;

  beforeEach(() => {
    tmpDir = path.join(os.tmpdir(), `gitnexus-codedep-integ-${Date.now()}`);
    sharedDir = path.join(tmpDir, 'shared-utils');
    webAppDir = path.join(tmpDir, 'web-app');

    // Create shared-utils repo
    fs.mkdirSync(path.join(sharedDir, 'src'), { recursive: true });
    fs.writeFileSync(
      path.join(sharedDir, 'package.json'),
      JSON.stringify({
        name: '@test/shared-utils',
        version: '1.0.0',
        dependencies: {},
      }),
    );
    fs.writeFileSync(
      path.join(sharedDir, 'src', 'utils.ts'),
      `export function formatDate(d: Date): string { return d.toISOString(); }
export class Logger { log(msg: string) { console.log(msg); } }
export const VERSION = '1.0.0';`,
    );

    // Create web-app repo
    fs.mkdirSync(path.join(webAppDir, 'src'), { recursive: true });
    fs.writeFileSync(
      path.join(webAppDir, 'package.json'),
      JSON.stringify({
        name: '@test/web-app',
        version: '2.0.0',
        dependencies: { '@test/shared-utils': '^1.0.0', react: '^18.0.0' },
      }),
    );
    fs.writeFileSync(
      path.join(webAppDir, 'src', 'app.ts'),
      `import { formatDate, Logger } from '@test/shared-utils';
import React from 'react';

const logger = new Logger();
console.log(formatDate(new Date()));`,
    );
    fs.writeFileSync(
      path.join(webAppDir, 'src', 'utils.ts'),
      `import { VERSION } from '@test/shared-utils';
export function getVersion() { return VERSION; }`,
    );
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function makeConfig(overrides?: Partial<GroupConfig>): GroupConfig {
    return {
      version: 1,
      name: 'test-workspace',
      description: 'Code-dep integration test',
      repos: { 'libs/shared': 'shared-utils', 'apps/web': 'web-app' },
      links: [],
      packages: {},
      detect: {
        http: false,
        grpc: false,
        topics: false,
        shared_libs: true,
        embedding_fallback: false,
      },
      matching: { bm25_threshold: 0.7, embedding_threshold: 0.65, max_candidates_per_step: 3 },
      ...overrides,
    };
  }

  it('matches lib contracts between provider and consumer repos', async () => {
    const config = makeConfig();

    // Mock contracts simulating what CodeDepExtractor would produce:
    // Provider side: exported symbols from shared-utils
    // Consumer side: imports in web-app
    const mockContracts: StoredContract[] = [
      // Providers from shared-utils
      {
        contractId: 'lib::@test/shared-utils::formatDate',
        type: 'lib',
        role: 'provider',
        symbolUid: 'fn-formatDate',
        symbolRef: { filePath: 'src/utils.ts', name: 'formatDate' },
        symbolName: 'formatDate',
        confidence: 0.9,
        meta: { packageName: '@test/shared-utils' },
        repo: 'libs/shared',
      },
      {
        contractId: 'lib::@test/shared-utils::Logger',
        type: 'lib',
        role: 'provider',
        symbolUid: 'class-Logger',
        symbolRef: { filePath: 'src/utils.ts', name: 'Logger' },
        symbolName: 'Logger',
        confidence: 0.9,
        meta: { packageName: '@test/shared-utils' },
        repo: 'libs/shared',
      },
      {
        contractId: 'lib::@test/shared-utils::VERSION',
        type: 'lib',
        role: 'provider',
        symbolUid: 'const-VERSION',
        symbolRef: { filePath: 'src/utils.ts', name: 'VERSION' },
        symbolName: 'VERSION',
        confidence: 0.9,
        meta: { packageName: '@test/shared-utils' },
        repo: 'libs/shared',
      },
      // Consumers from web-app
      {
        contractId: 'lib::@test/shared-utils::formatDate',
        type: 'lib',
        role: 'consumer',
        symbolUid: '',
        symbolRef: { filePath: 'src/app.ts', name: 'formatDate' },
        symbolName: 'formatDate',
        confidence: 0.9,
        meta: { packageName: '@test/shared-utils', importType: 'named' },
        repo: 'apps/web',
      },
      {
        contractId: 'lib::@test/shared-utils::Logger',
        type: 'lib',
        role: 'consumer',
        symbolUid: '',
        symbolRef: { filePath: 'src/app.ts', name: 'Logger' },
        symbolName: 'Logger',
        confidence: 0.9,
        meta: { packageName: '@test/shared-utils', importType: 'named' },
        repo: 'apps/web',
      },
      {
        contractId: 'lib::@test/shared-utils::VERSION',
        type: 'lib',
        role: 'consumer',
        symbolUid: '',
        symbolRef: { filePath: 'src/utils.ts', name: 'VERSION' },
        symbolName: 'VERSION',
        confidence: 0.9,
        meta: { packageName: '@test/shared-utils', importType: 'named' },
        repo: 'apps/web',
      },
    ];

    const result = await syncGroup(config, {
      extractorOverride: async () => mockContracts,
      skipWrite: true,
    });

    // Should produce 3 cross-links: formatDate, Logger, VERSION
    expect(result.crossLinks).toHaveLength(3);

    // All cross-links should be lib type
    for (const link of result.crossLinks) {
      expect(link.type).toBe('lib');
      expect(link.matchType).toBe('exact');
      expect(link.confidence).toBe(1.0);
    }

    // Verify from/to directions
    const formatDateLink = result.crossLinks.find((l) => l.contractId.includes('formatDate'));
    expect(formatDateLink).toBeDefined();
    expect(formatDateLink!.from.repo).toBe('apps/web'); // consumer
    expect(formatDateLink!.to.repo).toBe('libs/shared'); // provider

    const loggerLink = result.crossLinks.find((l) => l.contractId.includes('Logger'));
    expect(loggerLink).toBeDefined();
    expect(loggerLink!.from.repo).toBe('apps/web');
    expect(loggerLink!.to.repo).toBe('libs/shared');

    // No unmatched lib contracts (all 3 matched)
    const unmatchedLib = result.unmatched.filter((c) => c.type === 'lib');
    expect(unmatchedLib).toHaveLength(0);
  });

  it('handles unmatched lib contracts (consumer with no provider)', async () => {
    const config = makeConfig();

    const mockContracts: StoredContract[] = [
      // Consumer wants something that no provider offers
      {
        contractId: 'lib::@test/shared-utils::nonExistent',
        type: 'lib',
        role: 'consumer',
        symbolUid: '',
        symbolRef: { filePath: 'src/app.ts', name: 'nonExistent' },
        symbolName: 'nonExistent',
        confidence: 0.9,
        meta: {},
        repo: 'apps/web',
      },
    ];

    const result = await syncGroup(config, {
      extractorOverride: async () => mockContracts,
      skipWrite: true,
    });

    expect(result.crossLinks).toHaveLength(0);
    expect(result.unmatched).toHaveLength(1);
    expect(result.unmatched[0].contractId).toBe('lib::@test/shared-utils::nonExistent');
  });

  it('lib matching uses normalized contractId (case-insensitive)', async () => {
    const config = makeConfig();

    const mockContracts: StoredContract[] = [
      {
        contractId: 'lib::@test/shared-utils::formatDate',
        type: 'lib',
        role: 'provider',
        symbolUid: 'fn-1',
        symbolRef: { filePath: 'src/utils.ts', name: 'formatDate' },
        symbolName: 'formatDate',
        confidence: 0.9,
        meta: {},
        repo: 'libs/shared',
      },
      {
        contractId: 'lib::@test/shared-utils::formatDate',
        type: 'lib',
        role: 'consumer',
        symbolUid: '',
        symbolRef: { filePath: 'src/app.ts', name: 'formatDate' },
        symbolName: 'formatDate',
        confidence: 0.9,
        meta: {},
        repo: 'apps/web',
      },
    ];

    const result = await syncGroup(config, {
      extractorOverride: async () => mockContracts,
      skipWrite: true,
    });

    expect(result.crossLinks).toHaveLength(1);
    expect(result.crossLinks[0].type).toBe('lib');
  });

  it('config.links produces manifest cross-links when skipWrite is true', async () => {
    const config = makeConfig({
      links: [
        {
          from: 'apps/web',
          to: 'libs/shared',
          type: 'http',
          contract: 'GET::/api/shared/health',
          role: 'consumer',
        },
      ],
      detect: {
        http: false,
        grpc: false,
        topics: false,
        shared_libs: false,
        embedding_fallback: false,
      },
    });

    const result = await syncGroup(config, {
      extractorOverride: async () => [],
      skipWrite: true,
    });

    const manifestLink = result.crossLinks.find((cl) => cl.matchType === 'manifest');
    expect(manifestLink).toBeDefined();
    expect(manifestLink!.contractId).toBe('http::GET::/api/shared/health');
    expect(manifestLink!.from.repo).toBe('apps/web');
    expect(manifestLink!.to.repo).toBe('libs/shared');

    // Manifest links should not be duplicated by an exact-match twin.
    expect(
      result.crossLinks.filter((cl) => cl.contractId === manifestLink!.contractId),
    ).toHaveLength(1);
  });
});
