import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Command } from 'commander';

const mockGroupService = {
  groupDiscover: vi.fn(),
  groupStatus: vi.fn(),
  groupGraph: vi.fn(),
  groupQuery: vi.fn(),
  groupContracts: vi.fn(),
};

const mockBackend = {
  init: vi.fn(async () => {}),
  dispose: vi.fn(async () => {}),
  getGroupService: vi.fn(() => mockGroupService),
};

const mockCreateGroupDir = vi.fn();
const mockGetGroupDir = vi.fn();
const mockGetDefaultGitnexusDir = vi.fn();
const mockListGroups = vi.fn();
const mockReadContractRegistry = vi.fn();
const mockLoadGroupConfig = vi.fn();
const mockSyncGroup = vi.fn();
const mockFsWriteFile = vi.fn();

vi.mock('../../src/mcp/local/local-backend.js', () => ({
  LocalBackend: class {
    init = mockBackend.init;
    dispose = mockBackend.dispose;
    getGroupService = mockBackend.getGroupService;
  },
}));

vi.mock('../../src/core/group/storage.js', () => ({
  createGroupDir: mockCreateGroupDir,
  getGroupDir: mockGetGroupDir,
  getDefaultGitnexusDir: mockGetDefaultGitnexusDir,
  listGroups: mockListGroups,
  readContractRegistry: mockReadContractRegistry,
}));

vi.mock('../../src/core/group/config-parser.js', () => ({
  loadGroupConfig: mockLoadGroupConfig,
}));

vi.mock('../../src/core/group/sync.js', () => ({
  syncGroup: mockSyncGroup,
}));

vi.mock('node:fs/promises', () => ({
  writeFile: mockFsWriteFile,
  default: { writeFile: mockFsWriteFile },
}));

async function runCommand(args: string[]): Promise<void> {
  const { registerGroupCommands } = await import('../../src/cli/group.js');
  const program = new Command();
  program.exitOverride();
  registerGroupCommands(program);
  await program.parseAsync(['node', 'gitnexus', ...args]);
}

describe('group CLI', () => {
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    process.exitCode = undefined;
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    mockGetDefaultGitnexusDir.mockReturnValue('/home/.gitnexus');
    mockGetGroupDir.mockImplementation((home: string, name: string) => `${home}/groups/${name}`);
  });

  describe('create', () => {
    it('creates a group dir and prints next-step instructions', async () => {
      mockCreateGroupDir.mockResolvedValueOnce('/home/.gitnexus/groups/team-a');

      await runCommand(['group', 'create', 'team-a']);

      expect(mockCreateGroupDir).toHaveBeenCalledWith('/home/.gitnexus', 'team-a', undefined);
      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('Created group "team-a"'));
    });

    it('forwards --force to createGroupDir', async () => {
      mockCreateGroupDir.mockResolvedValueOnce('/home/.gitnexus/groups/team-a');

      await runCommand(['group', 'create', 'team-a', '--force']);

      expect(mockCreateGroupDir).toHaveBeenCalledWith('/home/.gitnexus', 'team-a', true);
    });
  });

  describe('auto-discover', () => {
    it('calls groupDiscover with resolved directory and prints repos + package mappings', async () => {
      mockGroupService.groupDiscover.mockResolvedValueOnce({
        group: 'workspace',
        groupDir: '/home/.gitnexus/groups/workspace',
        repoCount: 2,
        repos: [
          { name: 'shared-utils', packageName: '@test/shared' },
          { name: 'web-app', packageName: null },
        ],
        packageMappings: { '@test/shared': 'libs/shared' },
        synced: true,
        contracts: 5,
        crossLinks: 3,
      });

      await runCommand(['group', 'auto-discover', '/repos']);

      expect(mockGroupService.groupDiscover).toHaveBeenCalledWith(
        expect.objectContaining({
          directory: expect.stringContaining('repos'),
          name: 'workspace',
          force: false,
          skipSync: false,
        }),
      );
      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('Discovering indexed repos'));
      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('Repos (2)'));
      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('shared-utils (@test/shared)'));
      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('5 contracts, 3 cross-links'));
      expect(mockBackend.dispose).toHaveBeenCalled();
    });

    it('prints JSON when --json is set', async () => {
      const payload = {
        group: 'workspace',
        groupDir: '/g',
        repoCount: 0,
        repos: [],
        packageMappings: {},
      };
      mockGroupService.groupDiscover.mockResolvedValueOnce(payload);

      await runCommand(['group', 'auto-discover', '/repos', '--json']);

      const jsonCall = logSpy.mock.calls.find(
        (c) => typeof c[0] === 'string' && c[0].trim().startsWith('{'),
      );
      expect(jsonCall).toBeDefined();
      expect(JSON.parse(jsonCall![0] as string)).toEqual(payload);
    });

    it('prints error and sets exitCode=1 on service error', async () => {
      mockGroupService.groupDiscover.mockResolvedValueOnce({ error: 'boom' });

      await runCommand(['group', 'auto-discover', '/repos']);

      expect(errSpy).toHaveBeenCalledWith('boom');
      expect(process.exitCode).toBe(1);
    });
  });

  describe('repos', () => {
    it('resolves each repo path and calls groupDiscover with repoPaths', async () => {
      mockGroupService.groupDiscover.mockResolvedValueOnce({
        group: 'workspace',
        groupDir: '/g',
        repoCount: 2,
        repos: [],
        packageMappings: {},
      });

      await runCommand(['group', 'repos', '/a', '/b', '--name', 'custom']);

      expect(mockGroupService.groupDiscover).toHaveBeenCalledTimes(1);
      const callArg = mockGroupService.groupDiscover.mock.calls[0][0] as {
        repoPaths: string[];
        name: string;
        force: boolean;
        skipSync: boolean;
      };
      const normalizedPaths = callArg.repoPaths.map((p) => p.replace(/\\/g, '/'));
      expect(normalizedPaths).toEqual(
        expect.arrayContaining([expect.stringContaining('/a'), expect.stringContaining('/b')]),
      );
      expect(callArg).toMatchObject({ name: 'custom', force: false, skipSync: false });
    });
  });

  describe('add', () => {
    it('adds a repo to the group yaml and prints sync reminder', async () => {
      mockLoadGroupConfig.mockResolvedValueOnce({
        version: 1,
        name: 'team-a',
        description: '',
        repos: {},
        links: [],
        packages: {},
        detect: {
          http: false,
          grpc: false,
          topics: false,
          shared_libs: false,
          embedding_fallback: false,
        },
        matching: { bm25_threshold: 0.7, embedding_threshold: 0.65, max_candidates_per_step: 3 },
      });

      await runCommand(['group', 'add', 'team-a', 'apps/web', 'web-app']);

      expect(mockFsWriteFile).toHaveBeenCalled();
      const writtenArg = mockFsWriteFile.mock.calls[0][1] as string;
      expect(writtenArg).toContain('apps/web');
      expect(writtenArg).toContain('web-app');
      expect(logSpy).toHaveBeenCalledWith(
        expect.stringContaining('Added web-app as "apps/web" to group "team-a"'),
      );
    });
  });

  describe('remove', () => {
    it('removes a repo path from the group yaml', async () => {
      mockLoadGroupConfig.mockResolvedValueOnce({
        version: 1,
        name: 'team-a',
        description: '',
        repos: { 'apps/web': 'web-app', 'libs/shared': 'shared-utils' },
        links: [],
        packages: {},
        detect: {
          http: false,
          grpc: false,
          topics: false,
          shared_libs: false,
          embedding_fallback: false,
        },
        matching: { bm25_threshold: 0.7, embedding_threshold: 0.65, max_candidates_per_step: 3 },
      });

      await runCommand(['group', 'remove', 'team-a', 'apps/web']);

      expect(mockFsWriteFile).toHaveBeenCalled();
      const written = mockFsWriteFile.mock.calls[0][1] as string;
      expect(written).not.toContain('apps/web');
      expect(written).toContain('libs/shared');
    });

    it('errors when the repo path is not present', async () => {
      mockLoadGroupConfig.mockResolvedValueOnce({
        version: 1,
        name: 'team-a',
        description: '',
        repos: { 'libs/shared': 'shared-utils' },
        links: [],
        packages: {},
        detect: {
          http: false,
          grpc: false,
          topics: false,
          shared_libs: false,
          embedding_fallback: false,
        },
        matching: { bm25_threshold: 0.7, embedding_threshold: 0.65, max_candidates_per_step: 3 },
      });

      await runCommand(['group', 'remove', 'team-a', 'apps/web']);

      expect(errSpy).toHaveBeenCalledWith(expect.stringContaining('not found in group "team-a"'));
      expect(process.exitCode).toBe(1);
      expect(mockFsWriteFile).not.toHaveBeenCalled();
    });
  });

  describe('list', () => {
    it('without name: prints all groups', async () => {
      mockListGroups.mockResolvedValueOnce(['team-a', 'team-b']);

      await runCommand(['group', 'list']);

      expect(logSpy).toHaveBeenCalledWith('Groups:');
      expect(logSpy).toHaveBeenCalledWith('  team-a');
      expect(logSpy).toHaveBeenCalledWith('  team-b');
    });

    it('without name, empty: prints create instruction', async () => {
      mockListGroups.mockResolvedValueOnce([]);

      await runCommand(['group', 'list']);

      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('No groups configured'));
    });

    it('with name: prints repos and manifest links', async () => {
      mockLoadGroupConfig.mockResolvedValueOnce({
        version: 1,
        name: 'team-a',
        description: 'A team group',
        repos: { 'apps/web': 'web-app' },
        links: [
          {
            from: 'apps/web',
            to: 'services/api',
            type: 'http',
            contract: 'GET::/x',
            role: 'consumer',
          },
        ],
        packages: {},
        detect: {
          http: false,
          grpc: false,
          topics: false,
          shared_libs: false,
          embedding_fallback: false,
        },
        matching: { bm25_threshold: 0.7, embedding_threshold: 0.65, max_candidates_per_step: 3 },
      });

      await runCommand(['group', 'list', 'team-a']);

      expect(logSpy).toHaveBeenCalledWith('Group: team-a');
      expect(logSpy).toHaveBeenCalledWith('Description: A team group');
      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('apps/web -> web-app'));
      expect(logSpy).toHaveBeenCalledWith(
        expect.stringContaining('apps/web -> services/api [http: GET::/x]'),
      );
    });
  });

  describe('status', () => {
    it('prints OK/STALE/MISSING rows and last-sync timestamp', async () => {
      mockReadContractRegistry.mockResolvedValueOnce({
        version: 1,
        generatedAt: '2026-04-01T00:00:00Z',
        repoSnapshots: {},
        missingRepos: ['legacy/old'],
        contracts: [],
        crossLinks: [],
      });
      mockGroupService.groupStatus.mockResolvedValueOnce({
        repos: {
          'apps/web': {
            indexStale: false,
            contractsStale: false,
            missing: false,
            commitsBehind: 0,
          },
          'libs/shared': {
            indexStale: true,
            contractsStale: true,
            missing: false,
            commitsBehind: 3,
          },
          'legacy/old': { indexStale: false, contractsStale: false, missing: true },
        },
        missingRepos: ['legacy/old'],
      });

      await runCommand(['group', 'status', 'team-a']);

      expect(logSpy).toHaveBeenCalledWith(
        expect.stringContaining('last sync: 2026-04-01T00:00:00Z'),
      );
      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('MISSING'));
      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('STALE'));
      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('3 commits behind'));
      expect(logSpy).toHaveBeenCalledWith(
        expect.stringContaining('Last sync missing repos: legacy/old'),
      );
    });

    it('shows "never synced" when no registry exists', async () => {
      mockReadContractRegistry.mockResolvedValueOnce(null);
      mockGroupService.groupStatus.mockResolvedValueOnce({ repos: {}, missingRepos: [] });

      await runCommand(['group', 'status', 'team-a']);

      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('never synced'));
    });
  });

  describe('sync', () => {
    it('calls syncGroup and prints cascade summary', async () => {
      mockLoadGroupConfig.mockResolvedValueOnce({
        version: 1,
        name: 'team-a',
        description: '',
        repos: { 'apps/web': 'web-app' },
        links: [],
        packages: {},
        detect: {
          http: false,
          grpc: false,
          topics: false,
          shared_libs: false,
          embedding_fallback: false,
        },
        matching: { bm25_threshold: 0.7, embedding_threshold: 0.65, max_candidates_per_step: 3 },
      });
      mockSyncGroup.mockResolvedValueOnce({
        contracts: [{ id: 1 }, { id: 2 }],
        crossLinks: [{ matchType: 'exact' }, { matchType: 'exact' }, { matchType: 'manifest' }],
        unmatched: [{ id: 3 }],
        missingRepos: [],
        repoSnapshots: {},
      });

      await runCommand(['group', 'sync', 'team-a', '--allow-stale', '--verbose']);

      expect(mockSyncGroup).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ allowStale: true, verbose: true }),
      );
      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('exact:     2 cross-links'));
      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('unmatched: 1 contracts'));
      expect(logSpy).toHaveBeenCalledWith(
        expect.stringContaining('Wrote contracts.json (2 contracts, 3 cross-links)'),
      );
    });

    it('prints JSON when --json is set', async () => {
      mockLoadGroupConfig.mockResolvedValueOnce({
        version: 1,
        name: 'team-a',
        description: '',
        repos: {},
        links: [],
        packages: {},
        detect: {
          http: false,
          grpc: false,
          topics: false,
          shared_libs: false,
          embedding_fallback: false,
        },
        matching: { bm25_threshold: 0.7, embedding_threshold: 0.65, max_candidates_per_step: 3 },
      });
      const result = {
        contracts: [],
        crossLinks: [],
        unmatched: [],
        missingRepos: [],
        repoSnapshots: {},
      };
      mockSyncGroup.mockResolvedValueOnce(result);

      await runCommand(['group', 'sync', 'team-a', '--json']);

      const jsonCall = logSpy.mock.calls.find(
        (c) => typeof c[0] === 'string' && c[0].trim().startsWith('{'),
      );
      expect(jsonCall).toBeDefined();
    });
  });

  describe('graph', () => {
    it('parses --depth and --direction, prints cross connections', async () => {
      mockGroupService.groupGraph.mockResolvedValueOnce({
        sourceRepo: 'web-app',
        localContext: {},
        crossConnections: [
          {
            direction: 'outgoing',
            remoteRepo: 'libs/shared',
            contractId: 'lib::x',
            contractType: 'lib',
            confidence: 1.0,
          },
          {
            direction: 'incoming',
            remoteRepo: 'apps/other',
            contractId: 'http::GET::/y',
            contractType: 'http',
            confidence: 0.8,
          },
        ],
        totalCrossLinks: 2,
      });

      await runCommand([
        'group',
        'graph',
        'team-a',
        'mySymbol',
        '--repo',
        'web-app',
        '--depth',
        '2',
        '--direction',
        'both',
      ]);

      expect(mockGroupService.groupGraph).toHaveBeenCalledWith({
        name: 'team-a',
        symbol: 'mySymbol',
        repo: 'web-app',
        depth: 2,
        direction: 'both',
      });
      expect(logSpy).toHaveBeenCalledWith('Source repo: web-app');
      expect(logSpy).toHaveBeenCalledWith('Cross-repo connections: 2\n');
      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('→ libs/shared [lib] lib::x'));
      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('← apps/other [http]'));
    });

    it('prints "No cross-repo connections" when empty', async () => {
      mockGroupService.groupGraph.mockResolvedValueOnce({
        sourceRepo: 'web-app',
        localContext: {},
        crossConnections: [],
        totalCrossLinks: 0,
      });

      await runCommand(['group', 'graph', 'team-a', 'mySymbol']);

      expect(logSpy).toHaveBeenCalledWith(
        expect.stringContaining('No cross-repo connections found'),
      );
    });

    it('sets exitCode=1 on error', async () => {
      mockGroupService.groupGraph.mockResolvedValueOnce({ error: 'not found' });

      await runCommand(['group', 'graph', 'team-a', 'mySymbol']);

      expect(errSpy).toHaveBeenCalledWith('not found');
      expect(process.exitCode).toBe(1);
    });

    it('defaults depth to 1 when --depth is invalid', async () => {
      mockGroupService.groupGraph.mockResolvedValueOnce({
        sourceRepo: 'r',
        localContext: {},
        crossConnections: [],
        totalCrossLinks: 0,
      });

      await runCommand(['group', 'graph', 'team-a', 'x', '--depth', 'not-a-number']);

      expect(mockGroupService.groupGraph).toHaveBeenCalledWith(
        expect.objectContaining({ depth: 1 }),
      );
    });
  });

  describe('query', () => {
    it('prints merged results with RRF scores', async () => {
      mockGroupService.groupQuery.mockResolvedValueOnce({
        results: [
          { summary: 'flow A', _repo: 'apps/web', _rrf_score: 0.0164 },
          { name: 'flow B', _repo: 'libs/shared', _rrf_score: 0.0161 },
        ],
        per_repo: [
          { repo: 'apps/web', count: 1 },
          { repo: 'libs/shared', count: 1 },
        ],
      });

      await runCommand(['group', 'query', 'team-a', 'auth', '--limit', '10', '--subgroup', 'apps']);

      expect(mockGroupService.groupQuery).toHaveBeenCalledWith({
        name: 'team-a',
        query: 'auth',
        limit: 10,
        subgroup: 'apps',
      });
      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('Results (top 2)'));
      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('[apps/web] flow A'));
    });

    it('prints empty-result message when no flows match', async () => {
      mockGroupService.groupQuery.mockResolvedValueOnce({ results: [], per_repo: [] });

      await runCommand(['group', 'query', 'team-a', 'nothing']);

      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('No matching execution flows'));
    });
  });

  describe('contracts', () => {
    it('prints contracts and cross-links', async () => {
      mockGroupService.groupContracts.mockResolvedValueOnce({
        contracts: [
          { role: 'provider', contractId: 'lib::x', repo: 'libs/shared', symbolRef: { name: 'x' } },
          { role: 'consumer', contractId: 'lib::x', repo: 'apps/web', symbolRef: { name: 'x' } },
        ],
        crossLinks: [
          {
            from: { repo: 'apps/web' },
            to: { repo: 'libs/shared' },
            matchType: 'exact',
            confidence: 1.0,
            contractId: 'lib::x',
          },
        ],
      });

      await runCommand(['group', 'contracts', 'team-a', '--type', 'lib']);

      expect(mockGroupService.groupContracts).toHaveBeenCalledWith({
        name: 'team-a',
        type: 'lib',
        repo: undefined,
        unmatchedOnly: false,
      });
      expect(logSpy).toHaveBeenCalledWith('Contracts (2):');
      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('[provider] lib::x'));
      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('apps/web -> libs/shared'));
    });

    it('errors and exits 1 when service returns an error', async () => {
      mockGroupService.groupContracts.mockResolvedValueOnce({ error: 'bad' });

      await runCommand(['group', 'contracts', 'team-a']);

      expect(errSpy).toHaveBeenCalledWith('bad');
      expect(process.exitCode).toBe(1);
    });

    it('forwards --unmatched and --repo filters', async () => {
      mockGroupService.groupContracts.mockResolvedValueOnce({ contracts: [], crossLinks: [] });

      await runCommand([
        'group',
        'contracts',
        'team-a',
        '--unmatched',
        '--repo',
        'apps/web',
        '--json',
      ]);

      expect(mockGroupService.groupContracts).toHaveBeenCalledWith(
        expect.objectContaining({
          unmatchedOnly: true,
          repo: 'apps/web',
        }),
      );
    });
  });
});
