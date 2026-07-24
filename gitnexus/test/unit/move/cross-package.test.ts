import path from 'node:path';
import { describe, it, expect } from 'vitest';
import { runPipelineFromRepo } from '../../../src/core/ingestion/pipeline.js';
import type { MoveFactsMap } from '../../../src/core/move/compiler-facts.js';
import type { MoveFlowClient } from '../../../src/core/move/mcp-client.js';
import { createMoveIngestPhase } from '../../../src/core/move/move-ingest.js';

const friendGraphFixture = path.resolve(process.cwd(), 'test/fixtures/move/friend_graph');

const factsByPackage: Record<string, MoveFactsMap> = {
  pkg_x: {
    '0xa::m_x': {
      file: path.join(friendGraphFixture, 'pkg_x/sources/x.move'),
      span: [1, 11],
      friends: [{ module: '0xb::m_y' }],
      attributes: [],
      functions: [],
      structs: [],
      constants: [],
    },
  },
  pkg_y: {
    '0xb::m_y': {
      file: path.join(friendGraphFixture, 'pkg_y/sources/y.move'),
      span: [1, 7],
      friends: [{ module: '0xa::m_x' }],
      attributes: [],
      functions: [],
      structs: [],
      constants: [],
    },
  },
};

const client: MoveFlowClient = {
  async facts(packagePath: string): Promise<MoveFactsMap> {
    return packagePath.endsWith('pkg_x') ? factsByPackage.pkg_x : factsByPackage.pkg_y;
  },
  async callGraph() {
    return {};
  },
  async functionUsage() {
    return { called: [], used: [] };
  },
  async packageStatus() {
    return { ok: true, diagnostics: '' };
  },
  async capabilities() {
    return { hasFactsQuery: true, hasFunctionUsageQuery: false, hasStatusTool: false };
  },
  async shutdown() {},
};

describe('move ingest - cross-package edges', () => {
  it('emits cross-package FRIEND_OF edges after the global pass', async () => {
    const result = await runPipelineFromRepo(friendGraphFixture, () => {}, {
      standaloneIngestPhase: createMoveIngestPhase(client),
      skipGraphPhases: true,
    });
    const edges = [...result.graph.iterRelationships()];
    const crossPkgFriend = edges.find(
      (e) => e.type === 'FRIEND_OF' && e.sourceId.includes('m_x') && e.targetId.includes('m_y'),
    );
    expect(crossPkgFriend).toBeDefined();
  });
});
