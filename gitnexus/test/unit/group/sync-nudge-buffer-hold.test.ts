/**
 * A group sync holds the tree releasers' nudge buffer while it extracts and
 * ends that hold however extraction ends, so a long-lived MCP or serve
 * process drops the buffer after its last sync.
 */
import { describe, expect, it, vi } from 'vitest';

const holds = vi.hoisted(() => ({ opened: 0, ended: 0 }));
vi.mock('../../../src/core/tree-sitter/native-tree-release.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../../src/core/tree-sitter/native-tree-release.js')>();
  return {
    ...actual,
    holdNudgeBuffer: () => {
      holds.opened += 1;
      const end = actual.holdNudgeBuffer();
      return () => {
        holds.ended += 1;
        end();
      };
    },
  };
});

import { syncGroup } from '../../../src/core/group/sync.js';
import type { GroupConfig } from '../../../src/core/group/types.js';

const config: GroupConfig = {
  version: 1,
  name: 'test',
  description: '',
  repos: {},
  links: [],
  packages: {},
  detect: {
    http: true,
    grpc: false,
    thrift: false,
    topics: false,
    includes: false,
    workspace_deps: false,
  },
  matching: {},
};

describe('syncGroup nudge buffer hold', () => {
  it.each([
    ['extraction succeeds', async () => []],
    [
      'extraction throws',
      async () => {
        throw new Error('extraction failed (test)');
      },
    ],
  ])('ends its hold when %s', async (_label, extractorOverride) => {
    holds.opened = 0;
    holds.ended = 0;
    await syncGroup(config, { extractorOverride, skipWrite: true }).catch(() => undefined);
    expect(holds).toEqual({ opened: 1, ended: 1 });
  });
});
