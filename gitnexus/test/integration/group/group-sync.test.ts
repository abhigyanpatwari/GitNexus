/**
 * Group sync integration — uses `extractorOverride` / parsed YAML only (no LadybugDB).
 * Full pipeline with indexed fixture repos is a follow-up (needs `.gitnexus/lbug`).
 */
import { describe, it, expect } from 'vitest';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseGroupConfig } from '../../../src/core/group/config-parser.js';
import { syncGroup } from '../../../src/core/group/sync.js';
import type { StoredContract } from '../../../src/core/group/types.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = path.resolve(__dirname, '../../fixtures/group');

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
});
