/**
 * What `group_sync` and `group_contracts` PUT ON THE WIRE.
 *
 * Both tools document fields an agent is expected to branch on, and both build
 * their payload by hand — a literal per field, each one a line that can be
 * deleted without breaking a type or a build. Nothing asserted either payload,
 * so dropping `unreadableRepos` or `registryOutcome` from the sync response, or
 * the truncation triple from the contract listing, was a silent change: the
 * caller simply stopped being told, and every existing test stayed green.
 *
 * Hence exact-shape assertions throughout. `toMatchObject` — which is what the
 * one existing `groupSync` assertion uses, in
 * `test/integration/group/group-service-sync-lazy-import.test.ts` — passes
 * happily on a payload that has lost a key, which is precisely the regression
 * this file exists to catch.
 *
 * The tri-state these cases pin, established by the sibling commits in this PR:
 *
 *  - an ABSENT `unreadableRepos` means the sync never recorded which repos it
 *    could read, so any answer derived from the artifact is a floor;
 *  - an EMPTY list is a measurement — this sync accounted for every repo;
 *  - a POPULATED list names the repos whose contracts are not in there.
 *
 * `groupContracts` therefore OMITS the key in the absent case rather than
 * inventing `[]`, and pairs it with `truncated: true` +
 * `truncationReason: 'incomplete-sync'` + `riskEpistemic: 'lower-bound'`. An
 * exact-shape assertion is the only kind that can see the difference between
 * omitting a key and normalizing it to empty.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { SyncResult } from '../../../src/core/group/sync.js';
import type { GroupToolPort, GroupRepoHandle } from '../../../src/core/group/service.js';
import type { CrossLink } from '../../../src/core/group/types.js';
import { makeContract } from './fixtures.js';

/**
 * `GroupService.groupSync` reaches `syncGroup` through a dynamic
 * `await import('./sync.js')`; vitest resolves that to the same module id as
 * the specifier below, so this factory serves it. Mocked because the two
 * forwarded fields are what is under test and a real sync cannot be steered to
 * an arbitrary `registryOutcome` without an indexed repo — the real import is
 * pinned separately, and deliberately unmocked, in
 * `test/integration/group/group-service-sync-lazy-import.test.ts`.
 */
const syncGroupMock = vi.fn<() => Promise<SyncResult>>();

vi.mock('../../../src/core/group/sync.js', () => ({
  syncGroup: (...args: unknown[]) => syncGroupMock(...(args as [])),
}));

const { GroupService } = await import('../../../src/core/group/service.js');

const port: GroupToolPort = {
  resolveRepo: vi.fn(
    async (name?: string): Promise<GroupRepoHandle> => ({
      id: name ?? 'repo',
      name: name ?? 'repo',
      repoPath: '/tmp/repo',
      storagePath: '/tmp/repo/.gitnexus',
    }),
  ),
  impact: vi.fn(async () => ({ symbols: [] })),
  query: vi.fn(async () => ({ processes: [] })),
  impactByUid: vi.fn(async () => null),
  context: vi.fn(async () => ({
    status: 'found' as const,
    symbol: { filePath: 'src/routes.ts', uid: 'uid-1', name: 'getUsers' },
  })),
};

const GROUP = 'payload';

/** Every field of a `SyncResult`, overridable one at a time. */
const syncResult = (overrides: Partial<SyncResult> = {}): SyncResult => ({
  contracts: [],
  crossLinks: [],
  unmatched: [],
  missingRepos: [],
  unreadableRepos: [],
  repoSnapshots: {},
  suppressedMatchStages: [],
  registryOutcome: 'written',
  ...overrides,
});

const CONTRACT = makeContract({ repo: 'app/backend' });
const CROSS_LINK: CrossLink = {
  contractId: CONTRACT.contractId,
  type: 'http',
  matchType: 'exact',
  confidence: 1,
  from: {
    repo: 'app/frontend',
    symbolUid: 'uid-2',
    symbolRef: { filePath: 'src/client.ts', name: 'callUsers' },
  },
  to: {
    repo: 'app/backend',
    symbolUid: 'uid-1',
    symbolRef: { filePath: 'src/routes.ts', name: 'getUsers' },
  },
};

let home: string;
let groupDir: string;

beforeEach(() => {
  syncGroupMock.mockReset();
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'gitnexus-group-payload-'));
  groupDir = path.join(home, 'groups', GROUP);
  fs.mkdirSync(groupDir, { recursive: true });
  fs.writeFileSync(
    path.join(groupDir, 'group.yaml'),
    `version: 1
name: ${GROUP}
description: ""
repos:
  app/backend: payload-backend
  app/frontend: payload-frontend
`,
    'utf8',
  );
  vi.stubEnv('GITNEXUS_HOME', home);
});

afterEach(() => {
  vi.unstubAllEnvs();
  fs.rmSync(home, { recursive: true, force: true });
});

const seedRegistry = (registry: Record<string, unknown>): void =>
  fs.writeFileSync(path.join(groupDir, 'contracts.json'), JSON.stringify(registry), 'utf8');

const BASE_REGISTRY = {
  version: 1,
  generatedAt: '2026-01-01T00:00:00.000Z',
  repoSnapshots: {},
  missingRepos: [],
  contracts: [CONTRACT],
  crossLinks: [CROSS_LINK],
};

describe('group_sync forwards what the sync learned about the repos and the file', () => {
  it('carries the unreadable list and the registry outcome, by exact shape', async () => {
    // The headline case: a sync that could read nothing and therefore kept the
    // previous registry. An agent that calls `group_sync` and then
    // `group_contracts` a moment later otherwise sees contract counts that
    // disagree with this payload, with nothing here explaining why the write
    // was skipped — and no way to tell "the group has no contracts" from "this
    // run could not read the repos that hold them".
    syncGroupMock.mockResolvedValue(
      syncResult({
        contracts: [CONTRACT],
        crossLinks: [CROSS_LINK],
        unmatched: [CONTRACT],
        missingRepos: ['app/frontend'],
        unreadableRepos: ['app/backend'],
        registryOutcome: 'preserved',
      }),
    );

    const payload = await new GroupService(port).groupSync({ name: GROUP });

    // `toEqual`, not `toMatchObject`: deleting either forwarded line from the
    // return literal leaves a payload that a partial match still accepts.
    expect(payload).toEqual({
      contracts: 1,
      crossLinks: 1,
      unmatched: 1,
      missingRepos: ['app/frontend'],
      unreadableRepos: ['app/backend'],
      suppressedMatchStages: [],
      registryOutcome: 'preserved',
    });
  });

  it('reports an empty unreadable list as the measurement it is', async () => {
    // `[]` here is "this sync accounted for every repo", and it has to arrive
    // as `[]` rather than as an absent key: on the response boundary the two
    // are the difference between a clean result and an unmeasured one.
    syncGroupMock.mockResolvedValue(syncResult({ registryOutcome: 'written' }));

    const payload = await new GroupService(port).groupSync({ name: GROUP });

    expect(payload).toEqual({
      contracts: 0,
      crossLinks: 0,
      unmatched: 0,
      missingRepos: [],
      unreadableRepos: [],
      suppressedMatchStages: [],
      registryOutcome: 'written',
    });
  });

  it('names each write outcome the sync can reach', async () => {
    // `registryOutcome` is a union of four, and the CLI's outcome chain has no
    // fallback branch — a value that never reached the wire would fall through
    // it silently. Forwarding is verbatim, so this pins that too.
    const outcomes: SyncResult['registryOutcome'][] = [
      'written',
      'preserved',
      'no-prior-registry',
      'not-attempted',
    ];
    const seen: unknown[] = [];

    for (const registryOutcome of outcomes) {
      syncGroupMock.mockResolvedValue(syncResult({ registryOutcome }));
      const payload = (await new GroupService(port).groupSync({ name: GROUP })) as Record<
        string,
        unknown
      >;
      seen.push(payload.registryOutcome);
    }

    expect(seen).toEqual(outcomes);
  });
});

describe('group_contracts forwards its structured incompleteness', () => {
  it('omits the unreadable list, and calls the listing a floor, when the sync never recorded one', async () => {
    // Provenance unknown. The registry predates the field (or held something
    // that was not a list of repo paths), so this listing cannot say which
    // repos the sync failed to read — and therefore cannot claim to be
    // complete. Inventing `[]` here would report an unmeasured state as a clean
    // one, which is the conflation the whole tri-state removes.
    seedRegistry(BASE_REGISTRY);

    const payload = await new GroupService(port).groupContracts({ name: GROUP });

    expect(payload).toEqual({
      contracts: [CONTRACT],
      crossLinks: [CROSS_LINK],
      missingRepos: [],
      truncated: true,
      truncationReason: 'incomplete-sync',
      riskEpistemic: 'lower-bound',
    });
    // The same claim stated directly, because it is an ABSENCE and absence is
    // the one thing a reader of the assertion above has to infer.
    expect(payload).not.toHaveProperty('unreadableRepos');
  });

  it('returns the measured empty list, and calls the listing complete', async () => {
    // The middle state, and the only one that may answer `truncated: false`.
    seedRegistry({ ...BASE_REGISTRY, unreadableRepos: [] });

    const payload = await new GroupService(port).groupContracts({ name: GROUP });

    expect(payload).toEqual({
      contracts: [CONTRACT],
      crossLinks: [CROSS_LINK],
      missingRepos: [],
      unreadableRepos: [],
      truncated: false,
    });
    // `truncationReason` and `riskEpistemic` ride `truncated: true` and must not
    // appear beside a complete answer — an agent that branches on either one
    // being present would read this listing as a floor.
    expect(payload).not.toHaveProperty('truncationReason');
    expect(payload).not.toHaveProperty('riskEpistemic');
  });

  it('names the repos, and marks the listing a floor, when the sync recorded some', async () => {
    // The populated state. `truncated` alone says the answer was cut short;
    // `unreadableRepos` is what says WHERE, and it is the field that turns "this
    // listing is incomplete" into something an operator can act on.
    seedRegistry({ ...BASE_REGISTRY, unreadableRepos: ['app/backend'] });

    const payload = await new GroupService(port).groupContracts({ name: GROUP });

    expect(payload).toEqual({
      contracts: [CONTRACT],
      crossLinks: [CROSS_LINK],
      missingRepos: [],
      unreadableRepos: ['app/backend'],
      truncated: true,
      truncationReason: 'incomplete-sync',
      riskEpistemic: 'lower-bound',
    });
  });

  it('marks the listing a floor for a repo the registry recorded as missing too', async () => {
    // The two lists are independent diagnostics with one consequence — none of
    // those repos' contracts are in the artifact — so the completeness fold
    // reads both. A `truncated` derived from `unreadableRepos` alone would call
    // this listing complete while a whole member is unaccounted for.
    seedRegistry({ ...BASE_REGISTRY, missingRepos: ['app/frontend'], unreadableRepos: [] });

    const payload = await new GroupService(port).groupContracts({ name: GROUP });

    expect(payload).toEqual({
      contracts: [CONTRACT],
      crossLinks: [CROSS_LINK],
      missingRepos: ['app/frontend'],
      unreadableRepos: [],
      truncated: true,
      truncationReason: 'incomplete-sync',
      riskEpistemic: 'lower-bound',
    });
  });
});

/**
 * What `group_sync` REFUSES to run on.
 *
 * The MCP SDK does not enforce a tool's advertised `inputSchema` and
 * `callTool` is reachable directly, so this service method is the real
 * validation boundary. Two consequences this block pins:
 *
 * - `exactOnly` now gates a matching stage, so `Boolean(params.exactOnly)`
 *   turned the string `"false"` — a common shape for an LLM caller emitting
 *   JSON — into `true` and persisted a registry with the wildcard stage
 *   suppressed. The opposite of what the caller asked for, written to disk.
 * - `skipEmbeddings` and `allowStale` were retired. The CLI rejects them
 *   outright; the MCP path accepted and silently dropped them, so an agent
 *   working from a cached schema was told nothing.
 *
 * Every case asserts `syncGroupMock` was NOT called: a rejection that still
 * runs the sync is the failure mode, and an error string alone cannot tell
 * the two apart.
 */
describe('group_sync rejects malformed and retired parameters', () => {
  it.each([['false'], ['true'], [0], [1], [null], [{}], [[]]])(
    'rejects a non-boolean exactOnly (%j) and runs no sync',
    async (bad) => {
      const payload = await new GroupService(port).groupSync({ name: GROUP, exactOnly: bad });

      expect(payload).toEqual({
        error: `Invalid "exactOnly": expected true or false, got ${JSON.stringify(bad)}.`,
      });
      expect(syncGroupMock).not.toHaveBeenCalled();
    },
  );

  it.each([['skipEmbeddings'], ['allowStale']])(
    'rejects the retired %s parameter by name and runs no sync',
    async (retired) => {
      const payload = await new GroupService(port).groupSync({ name: GROUP, [retired]: true });

      expect(payload).toEqual({
        error: `"${retired}" was removed and is no longer accepted. Drop it from the call.`,
      });
      expect(syncGroupMock).not.toHaveBeenCalled();
    },
  );

  it.each([[true], [false]])(
    'passes a real boolean exactOnly (%j) through unchanged',
    async (ok) => {
      syncGroupMock.mockResolvedValue(syncResult());

      await new GroupService(port).groupSync({ name: GROUP, exactOnly: ok });

      expect(syncGroupMock).toHaveBeenCalledTimes(1);
      expect(syncGroupMock.mock.calls[0][1]).toMatchObject({ exactOnly: ok });
    },
  );

  it('treats an omitted exactOnly as false', async () => {
    syncGroupMock.mockResolvedValue(syncResult());

    await new GroupService(port).groupSync({ name: GROUP });

    expect(syncGroupMock.mock.calls[0][1]).toMatchObject({ exactOnly: false });
  });

  // control: the guards above reject specific shapes, not every call. Without
  // this, deleting the whole method body and returning an error would pass.
  it('control: a valid call with only a name still syncs', async () => {
    syncGroupMock.mockResolvedValue(syncResult({ registryOutcome: 'written' }));

    const payload = (await new GroupService(port).groupSync({ name: GROUP })) as Record<
      string,
      unknown
    >;

    expect(payload.error).toBeUndefined();
    expect(payload.registryOutcome).toBe('written');
    expect(syncGroupMock).toHaveBeenCalledTimes(1);
  });
});
