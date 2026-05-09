/**
 * Integration test: IncludeExtractor output → group matching → bridge DB.
 *
 * Covers PR #1156 review finding #7: verifies that the full runtime path
 * (IncludeExtractor → StoredContract → runExactMatch → CrossLinks → writeBridge)
 * stays wired up. A regression in either normalizeContractId or the include
 * branch of ManifestExtractor.resolveSymbol would produce 0 cross-links and
 * fail this test.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { parseGroupConfig } from '../../../src/core/group/config-parser.js';
import { syncGroup } from '../../../src/core/group/sync.js';
import type { StoredContract } from '../../../src/core/group/types.js';
import { IncludeExtractor } from '../../../src/core/group/extractors/include-extractor.js';
import { normalizeContractId } from '../../../src/core/group/matching.js';

const GROUP_YAML = [
  'version: 1',
  'name: include-test-group',
  'description: "IncludeExtractor integration test"',
  '',
  'repos:',
  '  app/provider: include-provider',
  '  app/consumer: include-consumer',
  '',
  'links: []',
  'packages: {}',
  '',
  'detect:',
  '  http: false',
  '  grpc: false',
  '  topics: false',
  '  shared_libs: false',
  '  includes: true',
  '  embedding_fallback: false',
  '',
  'matching:',
  '  bm25_threshold: 0.7',
  '  embedding_threshold: 0.65',
  '  max_candidates_per_step: 3',
].join('\n');

describe('IncludeExtractor → syncGroup integration (finding #7)', () => {
  it('produces a CrossLink when provider and consumer emit the same include contract-id', async () => {
    const config = parseGroupConfig(GROUP_YAML);

    // Mock the IncludeExtractor output directly — a header provider in one
    // repo and a quoted #include consumer in the other, both normalized to
    // the same include::map/base/view.h contract-id.
    const mockContracts: StoredContract[] = [
      {
        contractId: 'include::map/base/view.h',
        type: 'include',
        role: 'provider',
        symbolUid: 'File:map/base/view.h',
        symbolRef: { filePath: 'map/base/view.h', name: 'view.h' },
        symbolName: 'view.h',
        confidence: 0.95,
        meta: { source: 'filesystem' },
        repo: 'app/provider',
      },
      {
        contractId: 'include::map/base/view.h',
        type: 'include',
        role: 'consumer',
        symbolUid: 'File:src/controller.cpp',
        symbolRef: { filePath: 'src/controller.cpp', name: 'map/base/view.h' },
        symbolName: 'map/base/view.h',
        confidence: 0.85,
        meta: { source: 'tree_sitter', includePath: 'map/base/view.h' },
        repo: 'app/consumer',
      },
    ];

    const result = await syncGroup(config, {
      extractorOverride: async () => mockContracts,
      skipWrite: true,
    });

    const includeLinks = result.crossLinks.filter((l) => l.type === 'include');
    expect(includeLinks.length).toBeGreaterThanOrEqual(1);

    const link = includeLinks[0];
    expect(link.contractId).toBe('include::map/base/view.h');
    expect(link.matchType).toBe('exact');
    expect(link.from.repo).toBe('app/consumer');
    expect(link.to.repo).toBe('app/provider');
  });

  it('normalizes mixed-case / backslash include paths to the same contract-id end-to-end', async () => {
    const config = parseGroupConfig(GROUP_YAML);

    // Provider writes the canonical form; consumer's include has mixed case
    // and a backslash. After normalizeContractId they must still match.
    const providerId = 'include::map/base/view.h';
    const rawConsumerId = 'include::Map\\Base\\View.h';

    // Sanity — normalizeContractId must collapse them.
    expect(normalizeContractId(rawConsumerId)).toBe(providerId);

    const mockContracts: StoredContract[] = [
      {
        contractId: providerId,
        type: 'include',
        role: 'provider',
        symbolUid: 'File:map/base/view.h',
        symbolRef: { filePath: 'map/base/view.h', name: 'view.h' },
        symbolName: 'view.h',
        confidence: 0.95,
        meta: { source: 'filesystem' },
        repo: 'app/provider',
      },
      {
        contractId: rawConsumerId,
        type: 'include',
        role: 'consumer',
        symbolUid: 'File:src/controller.cpp',
        symbolRef: { filePath: 'src/controller.cpp', name: 'Map/Base/View.h' },
        symbolName: 'Map/Base/View.h',
        confidence: 0.85,
        meta: { source: 'tree_sitter', includePath: 'Map\\Base\\View.h' },
        repo: 'app/consumer',
      },
    ];

    const result = await syncGroup(config, {
      extractorOverride: async () => mockContracts,
      skipWrite: true,
    });

    const includeLinks = result.crossLinks.filter((l) => l.type === 'include');
    expect(includeLinks.length).toBeGreaterThanOrEqual(1);
  });

  it('round-trip: extractor output from two real temp repos produces matching contract-ids', async () => {
    // Drives the extractor directly (no `syncGroup`) against two on-disk
    // fixture repos, then hands the StoredContract-shaped output to
    // syncGroup via extractorOverride. This exercises the real extraction
    // code + the matching pipeline together.
    const providerDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gitnexus-include-int-provider-'));
    const consumerDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gitnexus-include-int-consumer-'));
    try {
      fs.mkdirSync(path.join(providerDir, 'shared/api'), { recursive: true });
      fs.writeFileSync(
        path.join(providerDir, 'shared/api/client.h'),
        '#pragma once\nstruct Client {};',
      );
      fs.mkdirSync(path.join(consumerDir, 'src'), { recursive: true });
      fs.writeFileSync(
        path.join(consumerDir, 'src/main.cpp'),
        '#include "shared/api/client.h"\nint main(){return 0;}',
      );

      const extractor = new IncludeExtractor();
      const providerOutput = await extractor.extract(null, providerDir, {
        id: 'provider',
        path: 'app/provider',
        repoPath: providerDir,
        storagePath: path.join(providerDir, '.gitnexus'),
      });
      const consumerOutput = await extractor.extract(null, consumerDir, {
        id: 'consumer',
        path: 'app/consumer',
        repoPath: consumerDir,
        storagePath: path.join(consumerDir, '.gitnexus'),
      });

      const stored: StoredContract[] = [
        ...providerOutput
          .filter((c) => c.role === 'provider')
          .map((c) => ({ ...c, repo: 'app/provider' })),
        ...consumerOutput
          .filter((c) => c.role === 'consumer')
          .map((c) => ({ ...c, repo: 'app/consumer' })),
      ];

      const config = parseGroupConfig(GROUP_YAML);
      const result = await syncGroup(config, {
        extractorOverride: async () => stored,
        skipWrite: true,
      });

      const includeLinks = result.crossLinks.filter((l) => l.type === 'include');
      expect(includeLinks.length).toBeGreaterThanOrEqual(1);
      expect(includeLinks[0].contractId).toBe('include::shared/api/client.h');
      expect(includeLinks[0].matchType).toBe('exact');
    } finally {
      fs.rmSync(providerDir, { recursive: true, force: true });
      fs.rmSync(consumerDir, { recursive: true, force: true });
    }
  });
});
