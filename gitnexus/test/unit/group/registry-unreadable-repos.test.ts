/**
 * `ContractRegistry.unreadableRepos` is optional, and its absence means "the
 * last sync did not record this", not "the last sync found none unreadable".
 * Every registry written before the field existed is in that state.
 *
 * The failure this file pins: both the registry loader and `groupStatus`
 * normalized a missing field to `[]`, so a group whose contracts.json predates
 * the diagnostic reported a clean, measured zero — an unmeasured state rendered
 * as a good result. `[]` and `undefined` are different answers here, and the
 * CLI's `group status` prints them differently for exactly that reason.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { GroupService } from '../../../src/core/group/service.js';
import { makeGroupToolPort, writeGroupYaml } from './fixtures.js';

/** The fields every case shares; only `unreadableRepos` is under test. */
const REGISTRY_BASE = {
  version: 1,
  generatedAt: '2026-01-01T00:00:00.000Z',
  repoSnapshots: {},
  missingRepos: [],
  contracts: [],
  crossLinks: [],
};

/** One valid row, so "the registry still loads" is observable in the payload. */
const GOOD_CONTRACT = {
  contractId: 'http::GET::/api/users',
  type: 'http',
  repo: 'backend',
  role: 'provider',
  symbolUid: 'u',
  symbolRef: { filePath: 'src/routes.ts', name: 'getUsers' },
  symbolName: 'getUsers',
  confidence: 1,
  meta: {},
};

type StatusPayload = { group: string; unreadableRepos?: unknown; missingRepos?: unknown };
type ContractsPayload = { contracts?: unknown[]; skippedCorrupt?: number; error?: string };

describe('unreadableRepos survives a round trip through contracts.json', () => {
  let home: string;
  let groupDir: string;

  beforeEach(async () => {
    home = await fsp.mkdtemp(path.join(os.tmpdir(), 'gitnexus-registry-unreadable-'));
    groupDir = path.join(home, 'groups', 'waveful');
    await writeGroupYaml(groupDir, ['backend', 'svc/users']);
    vi.stubEnv('GITNEXUS_HOME', home);
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await fsp.rm(home, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  /**
   * Written as raw JSON, not through `writeContractRegistry`: the point of
   * several cases is a file shape the current `ContractRegistry` type cannot
   * express — a legacy file with the key missing, or a corrupted one.
   */
  const writeRegistryJson = (extra: Record<string, unknown>): Promise<void> =>
    fsp.writeFile(
      path.join(groupDir, 'contracts.json'),
      JSON.stringify({ ...REGISTRY_BASE, ...extra }, null, 2),
      'utf8',
    );

  const status = async (): Promise<StatusPayload> => {
    const svc = new GroupService(makeGroupToolPort(home));
    return (await svc.groupStatus({ name: 'waveful' })) as StatusPayload;
  };

  const contracts = async (): Promise<ContractsPayload> => {
    const svc = new GroupService(makeGroupToolPort(home));
    return (await svc.groupContracts({ name: 'waveful' })) as ContractsPayload;
  };

  it('reports a registry that never recorded the field as not recorded', async () => {
    // The whole point: a contracts.json written before this diagnostic existed
    // has no opinion about which indexes opened. Reporting `[]` here tells the
    // caller the last sync measured zero unreadable repos, which never happened.
    await writeRegistryJson({});

    const result = await status();

    expect(result.unreadableRepos).toBeUndefined();
    expect(result.unreadableRepos).not.toEqual([]);
  });

  it('reports a measured zero as a measured zero', async () => {
    // The companion that gives the case above its meaning. A sync that read
    // every index DID record an answer, and that answer is an empty list.
    await writeRegistryJson({ unreadableRepos: [] });

    const result = await status();

    expect(result.unreadableRepos).toEqual([]);
  });

  it('passes a recorded list through intact', async () => {
    await writeRegistryJson({ unreadableRepos: ['app/backend'] });

    const result = await status();

    expect(result.unreadableRepos).toEqual(['app/backend']);
  });

  const corruptValues: Array<{ label: string; value: unknown }> = [
    { label: 'null', value: null },
    { label: 'a bare string', value: 'app/backend' },
    { label: 'an object', value: { 'app/backend': true } },
  ];

  it.each(corruptValues)(
    'does not launder $label in the unreadableRepos slot into a clean empty list',
    async ({ value }) => {
      // A hand-edited or half-written registry must not be able to produce the
      // one value that means "measured, and everything was fine".
      //
      // `groupStatus` reads the file through `readContractRegistry`, which is a
      // bare `JSON.parse(...) as ContractRegistry` — the validation in
      // `loadContractRegistryResilient` never runs on this path — so the shape
      // gate lives in `getStatus` itself. It has to: a non-array here used to
      // reach `cli/group.ts` and die in `.join(', ')`, which is the command
      // whose entire job is explaining an unreadable thing crashing on one.
      //
      // A value we cannot read is "not recorded", the same as absent.
      await writeRegistryJson({ unreadableRepos: value });

      const result = await status();

      expect(result.group).toBe('waveful');
      expect(result.unreadableRepos).toBeUndefined();
      expect(result.unreadableRepos).not.toEqual([]);
    },
  );

  it.each(corruptValues)(
    'does not hand $label in the missingRepos slot to the CLI either',
    async ({ value }) => {
      // Same gate, same reason: `cli/group.ts` calls `.join(', ')` on this one
      // too. `[]` is the right answer here rather than `undefined` — unlike
      // `unreadableRepos`, `missingRepos` has always been required, so there is
      // no "not recorded" state to preserve.
      await writeRegistryJson({ missingRepos: value });

      const result = await status();

      expect(result.group).toBe('waveful');
      expect(result.missingRepos).toEqual([]);
    },
  );

  it('loads a registry that predates the field without inventing a value for it', async () => {
    // `loadContractRegistryResilient` had zero test references when this
    // back-compat promise was made, so the legacy shape was resting on a type
    // annotation alone. This is the read path an agent hits right after a sync.
    await writeRegistryJson({ contracts: [GOOD_CONTRACT] });

    const result = await contracts();

    expect(result.error).toBeUndefined();
    expect(result.contracts).toHaveLength(1);
    expect(result.skippedCorrupt).toBeUndefined();
  });

  it('still salvages good contract rows when the unreadableRepos slot is corrupt', async () => {
    // The resilient loader's job is to hand back everything it can parse. A
    // junk value in one diagnostic field must not cost the caller the rows
    // next to it, and must not throw out of a read-only tool call.
    await writeRegistryJson({
      unreadableRepos: 'app/backend',
      contracts: [{ not: 'a-contract' }, GOOD_CONTRACT],
    });

    const result = await contracts();

    expect(result.error).toBeUndefined();
    expect(result.contracts).toHaveLength(1);
    expect(result.skippedCorrupt).toBe(1);
  });
});
