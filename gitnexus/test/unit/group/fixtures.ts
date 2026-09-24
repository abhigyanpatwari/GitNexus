/**
 * Shared test fixtures for `test/unit/group/*` test files. Keep this small
 * and purpose-built — it's NOT a general-purpose factory. If a builder here
 * grows complex enough to need its own module, move it next to the code
 * under test (e.g. `bridge-db.fixtures.ts`) instead of ballooning this file.
 */

import fsp from 'node:fs/promises';
import path from 'node:path';
import { vi } from 'vitest';
import type { GroupToolPort } from '../../../src/core/group/service.js';
import type { StoredContract } from '../../../src/core/group/types.js';

/**
 * Canonical baseline contract used by bridge-db and related tests. Every
 * field is populated so callers get a valid `StoredContract` with zero args,
 * and any field can be overridden via the partial — e.g.
 * `makeContract({ role: 'consumer', repo: 'frontend' })`.
 *
 * Prefer passing a `Partial<StoredContract>` override for the specific
 * field you care about rather than mutating the returned object in place.
 */
export function makeContract(overrides: Partial<StoredContract> = {}): StoredContract {
  return {
    contractId: 'http::GET::/api/users',
    type: 'http',
    role: 'provider',
    symbolUid: 'uid-1',
    symbolRef: { filePath: 'src/routes.ts', name: 'getUsers' },
    symbolName: 'getUsers',
    confidence: 0.85,
    meta: {},
    repo: 'backend',
    ...overrides,
  };
}

/**
 * The one contract shape `runWildcardMatch` fires on: a thrift service-wildcard
 * consumer and a matching method-level provider. `runExactMatch` skips wildcard
 * consumers, so this pair links through the wildcard stage or through no stage
 * at all — which is what makes it the fixture for anything testing that stage
 * being run or skipped.
 *
 * Shared because two suites need exactly this pair; if the predicate in
 * `isServiceWildcard` ever changes, it changes here once.
 */
export function makeWildcardPair(): { provider: StoredContract; consumer: StoredContract } {
  return {
    provider: makeContract({
      contractId: 'thrift::billing.v1.OrderService/PlaceOrder',
      type: 'thrift',
      role: 'provider',
      symbolUid: 'uid-provider-place-order',
      symbolRef: { filePath: 'src/provider.ts', name: 'OrderService.PlaceOrder' },
      symbolName: 'OrderService.PlaceOrder',
      confidence: 0.9,
      repo: 'app/provider',
    }),
    consumer: makeContract({
      contractId: 'thrift::OrderService/*',
      type: 'thrift',
      role: 'consumer',
      symbolUid: 'uid-consumer-order-service',
      symbolRef: { filePath: 'src/consumer.ts', name: 'callOrderService' },
      symbolName: 'callOrderService',
      confidence: 0.9,
      repo: 'app/consumer',
    }),
  };
}

/**
 * Write the `waveful` group's `group.yaml` into `groupDir` (creating it), with
 * every detector disabled so a suite's own bridge rows are the only thing that
 * can produce a crossing.
 *
 * Each entry of `repos` is a member name; its registry entry is
 * `<name>-registry`, which is the name `resolveRepo` is called with — several
 * suites assert on exactly that string.
 */
export async function writeGroupYaml(groupDir: string, repos: string[]): Promise<void> {
  await fsp.mkdir(groupDir, { recursive: true });
  const repoLines = repos.map((name) => `  ${name}: ${name}-registry`).join('\n');
  await fsp.writeFile(
    path.join(groupDir, 'group.yaml'),
    `version: 1
name: waveful
description: ""
repos:
${repoLines}
links: []
packages: {}
detect:
  http: false
  grpc: false
  thrift: false
  topics: false
  shared_libs: false
  embedding_fallback: false
matching:
  bm25_threshold: 0.7
  embedding_threshold: 0.65
  max_candidates_per_step: 3
`,
    'utf8',
  );
}

/**
 * A `GroupToolPort` whose legs are all benign stubs: every repo resolves under
 * `home`, the local impact walk reports one direct dependent, and a fanned-out
 * neighbour comes back with nothing.
 *
 * Pass `overrides` for the ONE leg a test is about — making it throw, hang, or
 * return a shaped result — so the difference under test is the only difference
 * in the port. Note that `vi.mock` factories cannot move here: vitest hoists
 * them per test module, so each suite keeps its own `bridge-db` mock.
 */
export function makeGroupToolPort(
  home: string,
  overrides: Partial<GroupToolPort> = {},
): GroupToolPort {
  return {
    resolveRepo: vi.fn(async (name: string) => ({
      id: name,
      name,
      repoPath: name,
      storagePath: path.join(home, name),
    })),
    impact: vi.fn(async () => ({
      target: { id: 'Function:src/api.ts:publish', filePath: 'src/api.ts' },
      byDepth: {},
      summary: { direct: 1, processes_affected: 0, modules_affected: 0 },
      risk: 'LOW',
    })),
    impactByUid: vi.fn(async () => ({
      byDepth: {},
      summary: { direct: 0, processes_affected: 0, modules_affected: 0 },
      risk: 'LOW',
    })),
    query: vi.fn(),
    context: vi.fn(),
    ...overrides,
  } as GroupToolPort;
}
