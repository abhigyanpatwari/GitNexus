/**
 * `GroupService.groupSync` reaches `syncGroup` through a DYNAMIC
 * `await import('./sync.js')`. A static import would drag the six contract
 * extractors — and, through them, the native tree-sitter binding — onto MCP
 * server startup, which never syncs; `groupSync` is the module's only consumer.
 *
 * That import is the one control-flow line the change added, and EVERY
 * production `group_sync` call runs it. Mocking `./sync.js` out would prove
 * nothing about it: the claims worth pinning are that the specifier still
 * RESOLVES and that the destructured `syncGroup` is the real function. So the
 * happy path here mocks nothing and drives the real module — mutating the
 * specifier (`'./sync-nope.js'`) or the destructured name turns it RED.
 *
 * Reaching a real `syncGroup` with no indexed repo is what the group.yaml below
 * is for: `GITNEXUS_HOME` points at an empty temp home, so the registry is
 * empty and every member repo lands in `missingRepos`, while a declared
 * manifest link still yields synthetic-UID contracts (the same shape
 * `manifest-synthetic-impact.test.ts` covers downstream). Every detector is off,
 * so nothing opens a repo graph.
 *
 * The negative direction is covered too: `sync.js` is replaced with a module
 * whose load THROWS, pinning that the failure surfaces as a rejected
 * `groupSync()` the MCP dispatch layer can convert into a scoped tool error,
 * and that the two guards ahead of the import still answer without ever
 * resolving it.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { createTempDirPool } from '../../helpers/temp-dir-pool.js';
import { makeGroupToolPort } from '../../unit/group/fixtures.js';
import { GroupService } from '../../../src/core/group/service.js';
import { readContractRegistry } from '../../../src/core/group/storage.js';

const tempDirs = createTempDirPool('gn-group-lazy-sync-');

const GROUP_NAME = 'lazy-sync';
const CONTRACT_ID = 'custom::rotateSigningKey';
const LOAD_FAILURE = 'simulated ./sync.js load failure';

/**
 * A group whose two members are absent from the registry (so `syncGroup`
 * reports them missing instead of opening a graph) but which declares one
 * manifest link, the one input a full `syncGroup` turns into contracts without
 * an indexed repo. `app/frontend` is the link's `from` with `role: consumer`,
 * so `app/backend` is the provider.
 */
async function seedGroup(home: string): Promise<string> {
  const groupDir = path.join(home, 'groups', GROUP_NAME);
  await fsp.mkdir(groupDir, { recursive: true });
  await fsp.writeFile(
    path.join(groupDir, 'group.yaml'),
    `version: 1
name: ${GROUP_NAME}
description: ""
repos:
  app/backend: lazy-sync-backend
  app/frontend: lazy-sync-frontend
links:
  - from: app/frontend
    to: app/backend
    type: custom
    contract: rotateSigningKey
    role: consumer
packages: {}
detect:
  http: false
  grpc: false
  thrift: false
  topics: false
  shared_libs: false
  embedding_fallback: false
  includes: false
  workspace_deps: false
matching:
  bm25_threshold: 0.7
  embedding_threshold: 0.65
  max_candidates_per_step: 3
`,
    'utf8',
  );
  return groupDir;
}

/**
 * Every message in an error's `cause` chain. The module runner reports a failed
 * module load through its own error with the original attached as `cause`, and
 * exactly where it puts it is a runner detail — flattening the chain keeps the
 * assertion about the failure that happened, not about how vitest wraps it.
 */
function errorChainText(err: unknown): string {
  const messages: string[] = [];
  const seen = new Set<unknown>();
  let current: unknown = err;
  while (current instanceof Error && !seen.has(current)) {
    seen.add(current);
    messages.push(current.message);
    current = current.cause;
  }
  return messages.join(' | ');
}

/**
 * A `GroupService` from a freshly re-evaluated module graph in which
 * `./sync.js` cannot be loaded at all. The re-import is what makes this a
 * statement about the LAZY import: a static one would have thrown here, at
 * `service.js` load, rather than at the `groupSync` call below.
 */
async function serviceWithUnloadableSync(home: string): Promise<GroupService> {
  vi.resetModules();
  vi.doMock('../../../src/core/group/sync.js', () => {
    throw new Error(LOAD_FAILURE);
  });
  const { GroupService: FreshGroupService } = await import('../../../src/core/group/service.js');
  return new FreshGroupService(makeGroupToolPort(home));
}

describe('GroupService.groupSync — lazy ./sync.js import', () => {
  afterEach(() => {
    vi.doUnmock('../../../src/core/group/sync.js');
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it('resolves the real ./sync.js and returns the real syncGroup result', async () => {
    const home = tempDirs.dir();
    vi.stubEnv('GITNEXUS_HOME', home);
    const groupDir = await seedGroup(home);

    const result = await new GroupService(makeGroupToolPort(home)).groupSync({
      name: GROUP_NAME,
    });

    // Only the REAL syncGroup produces this: two synthetic manifest contracts
    // (provider + consumer) and their cross-link, with both members reported
    // missing because the temp registry is empty.
    expect(result).toMatchObject({
      contracts: 2,
      crossLinks: 1,
      missingRepos: ['app/backend', 'app/frontend'],
    });

    // `groupDir` reached syncGroup's options too: the registry it wrote there
    // carries the contracts the returned counts summarize.
    await expect(readContractRegistry(groupDir)).resolves.toMatchObject({
      version: 1,
      missingRepos: ['app/backend', 'app/frontend'],
      contracts: [
        {
          contractId: CONTRACT_ID,
          role: 'provider',
          repo: 'app/backend',
          symbolUid: `manifest::app/backend::${CONTRACT_ID}`,
          meta: { source: 'manifest' },
        },
        {
          contractId: CONTRACT_ID,
          role: 'consumer',
          repo: 'app/frontend',
          symbolUid: `manifest::app/frontend::${CONTRACT_ID}`,
          meta: { source: 'manifest' },
        },
      ],
      crossLinks: [
        {
          contractId: CONTRACT_ID,
          matchType: 'manifest',
          from: { repo: 'app/frontend' },
          to: { repo: 'app/backend' },
        },
      ],
    });
  });

  it('surfaces a ./sync.js load failure as a rejected groupSync call', async () => {
    const home = tempDirs.dir();
    vi.stubEnv('GITNEXUS_HOME', home);
    await seedGroup(home);
    const service = await serviceWithUnloadableSync(home);

    // Awaited inside `groupSync`, so the caller (LocalBackend → MCP dispatch)
    // gets a catchable rejection rather than a floating unhandled one. A
    // `groupSync` that instead RESOLVED — swallowing the failed import into a
    // fake success — reports the sentinel and fails this assertion.
    const outcome = await service.groupSync({ name: GROUP_NAME }).then(
      () => 'resolved: the failed ./sync.js import did not propagate',
      (err: unknown) => errorChainText(err),
    );
    expect(outcome).toContain(LOAD_FAILURE);
  });

  it('answers both pre-import guards without resolving ./sync.js', async () => {
    const home = tempDirs.dir();
    vi.stubEnv('GITNEXUS_HOME', home);
    const service = await serviceWithUnloadableSync(home);

    await expect(service.groupSync({ name: '  ' })).resolves.toEqual({
      error: 'name is required',
    });
    await expect(service.groupSync({ name: 'never-configured' })).resolves.toEqual({
      error: 'Group "never-configured" not found. Run group_list to see configured groups.',
    });
  });
});
