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
import { GroupService, type GroupToolPort } from '../../../src/core/group/service.js';
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

/**
 * One row of the per-repo status table. Every field is `unknown` so a wrong
 * TYPE fails the assertion rather than being coerced past it — `undefined` and
 * `false` are different answers about which failure a row means.
 */
type RepoStatusRow = { missing?: unknown; unresolvable?: unknown; unresolvableReason?: unknown };
type RepoStatusPayload = { repos: Record<string, RepoStatusRow> };
/** One valid cross-link, so the control can assert that half of the payload too. */
const GOOD_CROSS_LINK = {
  from: { repo: 'frontend', symbolUid: 'f' },
  to: { repo: 'backend', symbolUid: 'u' },
  contractId: 'http::GET::/api/users',
  type: 'http',
  matchType: 'exact',
  confidence: 1,
};

type ContractsPayload = {
  contracts?: unknown[];
  crossLinks?: unknown[];
  skippedCorrupt?: number;
  error?: string;
  /** The registry's own diagnostics, echoed onto the listing. */
  missingRepos?: unknown;
  unreadableRepos?: unknown;
  /** The shared incompleteness triple (KTD10) — `unknown` so a wrong TYPE fails. */
  truncated?: unknown;
  truncationReason?: unknown;
  riskEpistemic?: unknown;
};

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
    // An array of the wrong element type is the shape `Array.isArray` alone
    // waves through, and it is the one that reaches `.join(', ')` and renders
    // as `[object Object]` — a measurement the operator can read but not act on.
    { label: 'an array of objects', value: [{ repo: 'app/backend' }] },
    { label: 'an array of numbers', value: [1, 2] },
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

  /**
   * `group_contracts` is the third surface that can hand back a partial
   * cross-repo answer (KTD10). `group_status` already reports the registry's
   * two repo lists; the listing itself reported nothing at all, so an agent
   * reading a contract set assembled from a sync that could not open half the
   * group could not tell it apart from a complete one.
   *
   * The answer here is the SAME structured triple `GroupImpactResult` carries —
   * `truncated` / `truncationReason` / `riskEpistemic` — computed by the SAME
   * helper (`crossRepoCompleteness`), so the three surfaces cannot drift into
   * three vocabularies.
   */
  describe('group_contracts reports its completeness in the shared vocabulary', () => {
    it('names the unreadable repos and marks the listing a floor', async () => {
      await writeRegistryJson({ unreadableRepos: ['app/backend'], contracts: [GOOD_CONTRACT] });

      const result = await contracts();

      expect(result.unreadableRepos).toEqual(['app/backend']);
      expect(result.truncated).toBe(true);
      // Not 'partial'/'timeout': nothing was cut short by a runtime limit here.
      // The remedy is `gitnexus group sync`, not a narrower query.
      expect(result.truncationReason).toBe('incomplete-sync');
      expect(result.riskEpistemic).toBe('lower-bound');
      // The rows the sync DID read are still returned — a floor, not an error.
      expect(result.contracts).toHaveLength(1);
    });

    it('reports a measured-clean registry as complete', async () => {
      // The companion that gives the case above its meaning: a sync that read
      // every index recorded an answer, and that answer is an empty list.
      await writeRegistryJson({ unreadableRepos: [], contracts: [GOOD_CONTRACT] });

      const result = await contracts();

      expect(result.unreadableRepos).toEqual([]);
      expect(result.truncated).toBe(false);
      // The two companions are set WITH `truncated`, never without it.
      expect(result.truncationReason).toBeUndefined();
      expect(result.riskEpistemic).toBeUndefined();
    });

    it('omits the key for a registry that predates the field, and reports a floor', async () => {
      // Absence is "not recorded", not "none". Inventing `[]` here would tell
      // the agent the last sync measured zero unreadable repos — it never ran
      // the measurement — and the same conflation would then say "complete".
      await writeRegistryJson({ contracts: [GOOD_CONTRACT] });

      const result = await contracts();

      expect(Object.keys(result)).not.toContain('unreadableRepos');
      expect(result.unreadableRepos).toBeUndefined();
      expect(result.truncated).toBe(true);
      expect(result.truncationReason).toBe('incomplete-sync');
      expect(result.riskEpistemic).toBe('lower-bound');
    });

    it('counts a missing repo as incompleteness even when every index opened', async () => {
      // The two lists are independent diagnostics with one consequence: none of
      // those repos' contracts are in the artifact. A recorded-clean
      // `unreadableRepos` must not launder a missing member into a complete set.
      await writeRegistryJson({
        unreadableRepos: [],
        missingRepos: ['svc/users'],
        contracts: [GOOD_CONTRACT],
      });

      const result = await contracts();

      expect(result.missingRepos).toEqual(['svc/users']);
      expect(result.unreadableRepos).toEqual([]);
      expect(result.truncated).toBe(true);
      expect(result.truncationReason).toBe('incomplete-sync');
      expect(result.riskEpistemic).toBe('lower-bound');
    });

    it.each(corruptValues)(
      'does not read $label in the unreadableRepos slot as a measured zero',
      async ({ value }) => {
        // Same gate as `group_status`, on the same registry field: a value we
        // could not read is unrecorded, so the listing omits the key and says
        // it is a floor rather than reporting a clean measured empty list.
        await writeRegistryJson({ unreadableRepos: value, contracts: [GOOD_CONTRACT] });

        const result = await contracts();

        expect(Object.keys(result)).not.toContain('unreadableRepos');
        expect(result.truncated).toBe(true);
        expect(result.truncationReason).toBe('incomplete-sync');
      },
    );

    it.each(corruptValues)(
      'degrades $label in the missingRepos slot to an empty list',
      async ({ value }) => {
        // `missingRepos` has always been required, so there is no "not
        // recorded" state to preserve — but an unreadable value must not reach
        // the caller (or the completeness fold) as if it were a repo list. An
        // array of objects is the shape `Array.isArray` alone waves through.
        await writeRegistryJson({
          missingRepos: value,
          unreadableRepos: [],
          contracts: [GOOD_CONTRACT],
        });

        const result = await contracts();

        expect(result.missingRepos).toEqual([]);
        expect(result.truncated).toBe(false);
      },
    );

    it('keeps the contract and cross-link payload it has always returned', async () => {
      // Control. The completeness fields are an ADDITION to this payload; if
      // this case moves, the fold broke the surface it was meant to annotate.
      await writeRegistryJson({
        unreadableRepos: [],
        contracts: [GOOD_CONTRACT],
        crossLinks: [GOOD_CROSS_LINK],
      });

      const result = await contracts();

      expect(result.error).toBeUndefined();
      expect(result.contracts).toEqual([GOOD_CONTRACT]);
      expect(result.crossLinks).toEqual([GOOD_CROSS_LINK]);
      expect(result.skippedCorrupt).toBeUndefined();
    });
  });

  /**
   * The per-repo table had ONE failure label — `missing`, printed as "no entry
   * in the registry" — and every cause collapsed into it, including a global
   * registry that could not be read at all. For that cause "no entry" is a
   * statement about a file nothing could be read from, and it points at the
   * wrong repair: index the repo, when the fix is to repair the registry.
   *
   * `getStatus` therefore reads the global registry through the STRICT mode.
   * The lenient read's `catch { return [] }` turns an unreadable registry into
   * an empty one, which is indistinguishable from a genuine absence — it can
   * only ever produce the `missing` answer, so it cannot express these cases.
   */
  describe('group status tells a missing repo apart from an unresolvable one', () => {
    /** A registry row carrying every field the strict read demands of one. */
    const registryRow = (name: string): Record<string, unknown> => ({
      name,
      path: path.join(home, name),
      storagePath: path.join(home, name, '.gitnexus'),
      indexedAt: '2026-01-01T00:00:00.000Z',
      lastCommit: 'abc123',
    });

    /**
     * Written verbatim rather than through the registry writer: half these
     * cases need a file shape `RegistryEntry[]` cannot express — a JSON
     * object, a truncated write, a row that names nothing.
     */
    const writeGlobalRegistry = (body: string): Promise<void> =>
      fsp.writeFile(path.join(home, 'registry.json'), body, 'utf8');

    const notFound = (name: string): never => {
      throw new Error(`Repository "${name}" not found. Available: `);
    };

    /**
     * Stands in for `LocalBackend.resolveRepo`: a handle for the names given,
     * and its own not-found error for the rest. The fixture only means
     * anything while it agrees with the registry file the case wrote —
     * `getStatus` reads that file itself, and the two answers are what these
     * cases are about.
     */
    const portResolving = (resolvable: string[]): GroupToolPort => {
      const handles = new Map(
        resolvable.map((name) => [
          name,
          {
            id: name,
            name,
            repoPath: path.join(home, name),
            storagePath: path.join(home, name, '.gitnexus'),
          },
        ]),
      );
      return makeGroupToolPort(home, {
        resolveRepo: vi.fn(async (registryName?: string) => {
          const wanted = String(registryName);
          return handles.get(wanted) ?? notFound(wanted);
        }),
      });
    };

    const statusWith = async (port: GroupToolPort): Promise<RepoStatusPayload> =>
      (await new GroupService(port).groupStatus({ name: 'waveful' })) as RepoStatusPayload;

    it('renders a repo the readable registry simply lacks as missing', async () => {
      // The guard on the other side of the split: the new label must not
      // swallow the old one. This repo has no row, that is exactly why
      // resolution failed, and "no entry in the registry" is a true statement.
      await writeGlobalRegistry(JSON.stringify([registryRow('backend-registry')]));

      const result = await statusWith(portResolving(['backend-registry']));

      expect(result.repos['svc/users'].missing).toBe(true);
      expect(result.repos['svc/users'].unresolvable).toBeFalsy();
      expect(result.repos['svc/users'].unresolvableReason).toBeUndefined();
    });

    it('renders a repo the registry does hold but cannot resolve as unresolvable', async () => {
      // The same port failure as the case above, in the same group, with one
      // difference: the registry HAS the row. "No entry in the registry" would
      // be a false statement about the file the command just read.
      await writeGlobalRegistry(
        JSON.stringify([registryRow('backend-registry'), registryRow('svc/users-registry')]),
      );

      const result = await statusWith(portResolving(['backend-registry']));

      expect(result.repos['svc/users'].unresolvable).toBe(true);
      expect(result.repos['svc/users'].unresolvableReason).toContain('svc/users-registry');
      // The pre-split flag keeps its meaning, so a consumer written before the
      // split still sees an unusable repo flagged rather than a clean row.
      expect(result.repos['svc/users'].missing).toBe(true);
    });

    it('carries both states in one payload, distinguishably', async () => {
      // What an agent reads. Nothing resolves; the registry knows one of the
      // two repos and not the other. Two failures, two different answers.
      await writeGlobalRegistry(JSON.stringify([registryRow('backend-registry')]));

      const result = await statusWith(portResolving([]));

      expect(result.repos['backend'].unresolvable).toBe(true);
      expect(result.repos['svc/users'].unresolvable).toBe(false);
      expect(result.repos['backend'].missing).toBe(true);
      expect(result.repos['svc/users'].missing).toBe(true);
    });

    const unreadableRegistries: Array<{ label: string; body: string }> = [
      { label: 'a JSON object', body: '{"repos": []}' },
      { label: 'a truncated write', body: '[{"name":"backend-registry",' },
      { label: 'not JSON at all', body: 'nope' },
    ];

    it.each(unreadableRegistries)(
      'renders every configured repo as unresolvable when the registry is $label',
      async ({ body }) => {
        // The answer the lenient read cannot give: it collapses this file into
        // `[]`, and every repo then reports "no entry in the registry" — a
        // measurement of a file nothing could be measured from.
        await writeGlobalRegistry(body);

        const result = await statusWith(portResolving([]));

        expect(result.repos['backend'].unresolvable).toBe(true);
        expect(result.repos['svc/users'].unresolvable).toBe(true);
        expect(result.repos['backend'].unresolvableReason).toContain('registry');
      },
    );

    it('reports every repo as unresolvable when one row cannot identify a repo', async () => {
      // The accepted consequence of the strict read: it rejects the WHOLE
      // registry on one unidentifiable row, so `backend` is reported
      // unresolvable even though its own row is intact and it still resolves.
      // Deliberate — a registry the resolver cannot trust row-wise cannot be
      // trusted about any row — and the answer is an unresolved state, never
      // the clean `missing: false` row this used to print.
      await writeGlobalRegistry(
        JSON.stringify([
          registryRow('backend-registry'),
          { ...registryRow('svc/users-registry'), name: '   ' },
        ]),
      );

      const result = await statusWith(portResolving(['backend-registry', 'svc/users-registry']));

      expect(result.repos['backend'].unresolvable).toBe(true);
      expect(result.repos['backend'].missing).toBe(true);
      expect(result.repos['svc/users'].unresolvable).toBe(true);
    });

    it('renders neither state for a group whose repos all resolve', async () => {
      // Control. Both labels are for failures; a healthy group must show
      // neither, or the split is just a new way to raise a false alarm.
      await writeGlobalRegistry(
        JSON.stringify([registryRow('backend-registry'), registryRow('svc/users-registry')]),
      );

      const result = await statusWith(portResolving(['backend-registry', 'svc/users-registry']));

      expect(result.repos['backend'].missing).toBe(false);
      expect(result.repos['backend'].unresolvable).toBeFalsy();
      expect(result.repos['svc/users'].missing).toBe(false);
      expect(result.repos['svc/users'].unresolvable).toBeFalsy();
    });
  });
});
