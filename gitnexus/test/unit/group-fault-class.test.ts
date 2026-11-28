import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  clientError,
  createFaultScope,
  faultOf,
  type FaultClass,
} from '../../src/core/fault-class.js';
import { GroupService, type GroupToolPort } from '../../src/core/group/service.js';
import { GroupNotFoundError } from '../../src/core/group/config-parser.js';
import { GroupSyncLockError } from '../../src/core/group/group-lock.js';
import { validateGroupName } from '../../src/core/group/storage.js';
import { ensureBridgeReady } from '../../src/core/group/cross-impact.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js';
import { createMCPServer, MCP_FAULT_META_KEY } from '../../src/mcp/server.js';

// Fails the next read of a group.yaml with an injected error code, so each code
// is checked where it is born whatever this platform's filesystem would report.
// `windowsPaths` reports ENOENT where a path runs through a file, as Windows does.
const { groupYamlFailure } = vi.hoisted(() => ({
  groupYamlFailure: {
    code: undefined as string | undefined,
    windowsPaths: false,
    stat: undefined as { path: string; code: string } | undefined,
  },
}));
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  const asOnWindows = (err: NodeJS.ErrnoException) => {
    if (groupYamlFailure.windowsPaths && err.code === 'ENOTDIR') err.code = 'ENOENT';
    throw err;
  };
  const readFile = ((file: unknown, ...rest: unknown[]) => {
    const code = groupYamlFailure.code;
    if (code && String(file).endsWith('group.yaml')) {
      groupYamlFailure.code = undefined;
      return Promise.reject(
        Object.assign(new Error(`${code}: injected, open '${file}'`), { code }),
      );
    }
    return (actual.readFile as (...args: unknown[]) => Promise<unknown>)(file, ...rest).catch(
      asOnWindows,
    );
  }) as typeof actual.readFile;
  const stat = ((...args: Parameters<typeof actual.stat>) => {
    const failure = groupYamlFailure.stat;
    if (failure && String(args[0]) === failure.path) {
      return Promise.reject(
        Object.assign(new Error(`${failure.code}: injected, stat '${failure.path}'`), {
          code: failure.code,
        }),
      );
    }
    return actual.stat(...args).catch(asOnWindows);
  }) as typeof actual.stat;
  const defaultExport = (actual as unknown as { default: object }).default;
  return { ...actual, readFile, stat, default: { ...defaultExport, readFile, stat } };
});

describe('group-mode fault classes', () => {
  let dir: string | undefined;
  afterEach(async () => {
    if (dir) await fs.rm(dir, { recursive: true, force: true });
    dir = undefined;
  });

  it('an unknown group and an invalid group name are client faults', () => {
    expect(faultOf(new GroupNotFoundError('missing'))).toBe('client');
    let error: unknown;
    try {
      validateGroupName('../escape');
    } catch (e) {
      error = e;
    }
    expect((error as Error).message).toMatch(/^Invalid group name "\.\.\/escape"\./);
    expect(faultOf(error)).toBe('client');
  });

  it('a sync lock held by another sync is a client fault; a broken lock is a server fault', () => {
    expect(faultOf(new GroupSyncLockError('timeout', '/g', 'busy'))).toBe('client');
    expect(faultOf(new GroupSyncLockError('unavailable', '/g', 'no lock'))).toBe('server');
  });

  it('a group without a bridge reports a client fault', async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'gitnexus-group-fault-'));
    const scope = createFaultScope();
    const result = await scope.run(() => ensureBridgeReady(dir!));
    expect(result).toMatchObject({ error: expect.stringMatching(/^No bridge\.lbug/) });
    expect(scope.fault()).toBe('client');
  });

  it('every caller sharing one failed bridge open reports a server fault', async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'gitnexus-group-fault-'));
    await fs.writeFile(path.join(dir, 'bridge.lbug'), 'not a database');
    const scopes = [createFaultScope(), createFaultScope()];
    const results = await Promise.all(
      scopes.map((scope) => scope.run(() => ensureBridgeReady(dir!))),
    );
    for (const result of results) {
      expect(result).toMatchObject({
        error: expect.stringMatching(/^Could not open bridge\.lbug/),
      });
    }
    expect(scopes.map((scope) => scope.fault())).toEqual(['server', 'server']);
  });
});

const FIXTURE_GROUP_YAML = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../fixtures/group/group.yaml',
);

/** Run `fn` against a GroupService whose home holds `test-group`, inside a fault scope. */
async function faultOfGroupCall(
  setup: (groupDir: string) => Promise<void>,
  fn: (svc: GroupService) => Promise<unknown>,
  port: Partial<GroupToolPort> = {},
): Promise<{ result: unknown; fault: FaultClass | undefined }> {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'gitnexus-group-fault-home-'));
  try {
    const groupDir = path.join(home, 'groups', 'test-group');
    await fs.mkdir(groupDir, { recursive: true });
    await fs.copyFile(FIXTURE_GROUP_YAML, path.join(groupDir, 'group.yaml'));
    await setup(groupDir);
    vi.stubEnv('GITNEXUS_HOME', home);
    const svc = new GroupService({
      resolveRepo: vi.fn(),
      impact: vi.fn(),
      query: vi.fn(),
      impactByUid: vi.fn(),
      context: vi.fn(),
      ...port,
    } as GroupToolPort);
    const scope = createFaultScope();
    const result = await scope.run(() => fn(svc));
    return { result, fault: scope.fault() };
  } finally {
    vi.unstubAllEnvs();
    await fs.rm(home, { recursive: true, force: true });
  }
}

describe('group service fault classes', () => {
  const contracts = (svc: GroupService) => svc.groupContracts({ name: 'test-group' });

  it.each([
    ['no contracts.json (never synced)', 'client', async () => {}],
    [
      'unparseable contracts.json',
      'server',
      (dir: string) => fs.writeFile(path.join(dir, 'contracts.json'), '{"contracts": ['),
    ],
    [
      'contracts.json with an invalid root',
      'server',
      (dir: string) => fs.writeFile(path.join(dir, 'contracts.json'), '[]'),
    ],
  ] as const)('group_contracts: %s is a %s fault', async (_label, expected, setup) => {
    const { result, fault } = await faultOfGroupCall(setup, contracts);
    expect(result).toMatchObject({ error: expect.any(String) });
    expect(fault).toBe(expected);
  });

  it('an unknown group is a client fault', async () => {
    const { result, fault } = await faultOfGroupCall(
      async () => {},
      (svc) => svc.groupContext({ name: 'no-such-group', target: 'x' }),
    );
    expect(result).toMatchObject({ error: expect.stringMatching(/not found/) });
    expect(fault).toBe('client');
  });

  it.each([
    ['an unclassified server failure', () => new Error('No indexed repositories'), 'server'],
    ['a client rejection', () => clientError('Repository "x" not found.'), 'client'],
  ] as const)(
    'group trace with no resolvable member keeps the class of %s',
    async (_label, failure, expected) => {
      const { result, fault } = await faultOfGroupCall(
        async () => {},
        (svc) => svc.groupTrace({ name: 'test-group', from: 'a', to: 'b' }),
        {
          resolveRepo: vi.fn(async () => Promise.reject(failure())),
          trace: vi.fn(),
          resolveSymbol: vi.fn(),
        },
      );
      expect(result).toMatchObject({ error: 'No resolvable repos in this group.' });
      expect(fault).toBe(expected);
    },
  );

  // test-backend and test-frontend are the two members of the fixture group.
  const failAfter = (ms: number, err: Error) =>
    new Promise<never>((_resolve, reject) => setTimeout(() => reject(err), ms));

  it.each([
    ['the client failure first', 1, 20],
    ['the server failure first', 20, 1],
  ] as const)(
    'group trace with mixed member failures is a server fault, %s',
    async (_label, clientDelay, serverDelay) => {
      const { result, fault } = await faultOfGroupCall(
        async () => {},
        (svc) => svc.groupTrace({ name: 'test-group', from: 'a', to: 'b' }),
        {
          resolveRepo: vi.fn(async (registryName: string) =>
            registryName === 'test-backend'
              ? failAfter(clientDelay, clientError('Repository "test-backend" not found.'))
              : failAfter(serverDelay, new Error('registry read failed')),
          ),
          trace: vi.fn(),
          resolveSymbol: vi.fn(),
        },
      );
      expect(result).toMatchObject({ error: 'No resolvable repos in this group.' });
      expect(fault).toBe('server');
    },
  );

  /** Group trace through tools/call: its result and the fault class the response carries. */
  const traceThroughServer = (
    setup: (groupDir: string) => Promise<void>,
    port: Partial<GroupToolPort>,
  ) =>
    faultOfGroupCall(
      setup,
      async (svc) => {
        const backend = {
          callTool: vi.fn(() => svc.groupTrace({ name: 'test-group', from: 'a', to: 'b' })),
          listRepos: vi.fn().mockResolvedValue([]),
          countRepos: vi.fn().mockResolvedValue(0),
          cachedRepoCount: vi.fn().mockReturnValue(0),
          getContext: vi.fn().mockReturnValue(null),
          disconnect: vi.fn().mockResolvedValue(undefined),
        };
        const server = createMCPServer(backend as never);
        const client = new Client({ name: 'group-fault-client', version: '0.0.0' });
        const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
        try {
          await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
          const response = CallToolResultSchema.parse(
            await client.callTool({
              name: 'trace',
              arguments: { from: 'a', to: 'b', repo: '@test-group' },
            }),
          );
          return {
            result: JSON.parse(
              response.content[0].type === 'text'
                ? response.content[0].text.split('\n\n---')[0]
                : '',
            ),
            meta: response._meta,
          };
        } finally {
          await client.close();
          await server.close();
        }
      },
      port,
    ).then(
      ({ result }) => result as { result: Record<string, unknown>; meta?: Record<string, unknown> },
    );

  const unreachableBackend = async (registryName?: string) => {
    if (registryName === 'test-backend') throw new Error('registry read failed');
    return {
      id: registryName,
      name: registryName,
      repoPath: `/${registryName}`,
      storagePath: `/${registryName}/.gitnexus`,
    };
  };
  const symbolIn = (id: string) => ({
    kind: 'ok' as const,
    symbol: { id, name: id, type: 'Function', filePath: 'src/x.ts', startLine: 1, endLine: 2 },
  });

  it.each([
    ['not_found', async () => ({ kind: 'not_found' as const })],
    ['ok', async (_handle: unknown, query: { name?: string }) => symbolIn(query.name ?? '')],
  ] as const)(
    'one unreachable member leaves a %s result without an error unclassified',
    async (status, resolveSymbol) => {
      const { result, meta } = await traceThroughServer(async () => {}, {
        resolveRepo: unreachableBackend,
        trace: vi.fn(async () => ({ status: 'ok', hops: [], edges: [] })),
        resolveSymbol: vi.fn(resolveSymbol),
      });
      expect(result).toMatchObject({ status });
      expect(result).not.toHaveProperty('error');
      expect(meta).toBeUndefined();
    },
  );

  it('one unreachable member makes a later error result a server fault', async () => {
    // A third member resolves too, so the trace reaches the bridge, which was
    // never synced: alone, that error is the caller's.
    const { result, meta } = await traceThroughServer(
      async (dir) => {
        const file = path.join(dir, 'group.yaml');
        const yaml = await fs.readFile(file, 'utf8');
        await fs.writeFile(
          file,
          yaml.replace(
            '  app/frontend: test-frontend\n',
            '  app/frontend: test-frontend\n  app/worker: test-worker\n',
          ),
        );
      },
      {
        resolveRepo: unreachableBackend,
        trace: vi.fn(),
        resolveSymbol: vi.fn(async (handle: { id: string }, query: { name?: string }) =>
          (handle.id === 'test-frontend' && query.name === 'a') ||
          (handle.id === 'test-worker' && query.name === 'b')
            ? symbolIn(`${handle.id}:${query.name}`)
            : { kind: 'not_found' as const },
        ),
      },
    );
    expect(result).toMatchObject({
      status: 'error',
      error: expect.stringMatching(/^No bridge\.lbug/),
    });
    expect(meta?.[MCP_FAULT_META_KEY]).toBe('server');
  });

  /**
   * The error group_list throws for `name`, after `setup` breaks the groups
   * directory, and the fault class its scope recorded.
   */
  const thrownByGroupList = async (
    setup: (groupDir: string) => Promise<void>,
    name = 'test-group',
  ) => {
    let error: unknown;
    const { result, fault } = await faultOfGroupCall(setup, async (svc) =>
      svc.groupList({ name }).catch((err: unknown) => {
        error = err;
        return undefined;
      }),
    );
    return { result, error: error as NodeJS.ErrnoException | undefined, fault };
  };

  const dirBecomesFile = async (dir: string) => {
    await fs.rm(dir, { recursive: true });
    await fs.writeFile(dir, 'x');
  };

  it.each([
    ['ENOTDIR', 'an existing group directory', async () => {}],
    ['EISDIR', 'an existing group directory', async () => {}],
    ['EACCES', 'an existing group directory', async () => {}],
    ['EIO', 'an existing group directory', async () => {}],
    ['ENAMETOOLONG', 'an ordinary group name', async () => {}],
    // Windows reports ENOENT where POSIX reports ENOTDIR for a directory that is a file.
    ['ENOENT', 'a group directory that is a file', dirBecomesFile],
  ] as const)(
    'a group.yaml read failing with %s for %s is a server fault',
    async (code, _label, setup) => {
      groupYamlFailure.code = code;
      const { error, fault } = await thrownByGroupList(setup);
      expect(error?.code).toBe(code);
      expect(faultOf(error)).toBeUndefined();
      expect(fault).toBe('server');
    },
  );

  it('a group.yaml read failing with ENAMETOOLONG for a name over the file-name limit is a client fault', async () => {
    groupYamlFailure.code = 'ENAMETOOLONG';
    const { error, fault } = await thrownByGroupList(async () => {}, 'a'.repeat(300));
    expect(error?.code).toBe('ENAMETOOLONG');
    expect(faultOf(error)).toBe('client');
    expect(fault).toBe('client');
  });

  it('a group.yaml read failing with ENOENT for an existing group directory is a client fault', async () => {
    groupYamlFailure.code = 'ENOENT';
    const { result, error, fault } = await thrownByGroupList(async () => {});
    expect(error).toBeUndefined();
    expect(result).toMatchObject({ error: expect.stringMatching(/^Group "test-group" not found/) });
    expect(fault).toBe('client');
  });

  // The rest use the real filesystem. Windows reports ENOENT for a path through
  // a file and for an over-long name, where POSIX systems report ENOTDIR and
  // ENAMETOOLONG; the class must not depend on which.
  const onWindows = (posixCode: string) => (process.platform === 'win32' ? 'ENOENT' : posixCode);

  it.each([
    [
      'group.yaml is a directory',
      'EISDIR',
      async (dir: string) => {
        await fs.rm(path.join(dir, 'group.yaml'));
        await fs.mkdir(path.join(dir, 'group.yaml'));
      },
    ],
    ['the group directory is a file', onWindows('ENOTDIR'), dirBecomesFile],
    [
      'the groups root is a file',
      onWindows('ENOTDIR'),
      (dir: string) => dirBecomesFile(path.dirname(dir)),
    ],
  ] as const)('reading group.yaml when %s is a server fault', async (_label, code, setup) => {
    const { error, fault } = await thrownByGroupList(setup);
    expect(error?.code).toBe(code);
    expect(faultOf(error)).toBeUndefined();
    expect(fault).toBe('server');
  });

  it.for([
    ['the group directory', (dir: string) => dir],
    ['the groups root', (dir: string) => path.dirname(dir)],
  ] as const)('%s as a broken link is a server fault', async ([, level], ctx) => {
    const { error, fault } = await thrownByGroupList(async (dir) => {
      const link = level(dir);
      await fs.rm(link, { recursive: true });
      try {
        await fs.symlink(path.join(path.dirname(link), 'missing-target'), link, 'dir');
      } catch (err) {
        if (['EPERM', 'EACCES'].includes((err as NodeJS.ErrnoException).code ?? '')) ctx.skip();
        throw err;
      }
    });
    expect(error?.code).toBe('ENOENT');
    expect(fault).toBe('server');
  });

  // What Windows reports for each case: ENOENT whether the group is missing or
  // a level of its path is a file. Only the second is broken storage.
  describe('with Windows path errors', () => {
    afterEach(() => {
      groupYamlFailure.windowsPaths = false;
      groupYamlFailure.stat = undefined;
    });

    // The levels below the failing one are missing, so the walk reaches it.
    const groupDirOf = (dir: string) => dir;
    const groupsRootOf = (dir: string) => path.dirname(dir);
    const homeOf = (dir: string) => path.dirname(path.dirname(dir));
    it.each([
      ['EIO', 'the group directory', groupDirOf, groupDirOf],
      ['EACCES', 'the groups root', groupDirOf, groupsRootOf],
      ['EPERM', 'the GitNexus home', groupsRootOf, homeOf],
    ])(
      'ENOENT when %s on %s hides the path is a server fault',
      async (code, _label, removed, failing) => {
        groupYamlFailure.code = 'ENOENT';
        const { error, fault } = await thrownByGroupList(async (dir) => {
          await fs.rm(removed(dir), { recursive: true });
          groupYamlFailure.stat = { path: failing(dir), code };
        });
        expect(error?.code).toBe('ENOENT');
        expect(fault).toBe('server');
      },
    );

    it.each([
      ['the group directory', (dir: string) => dir],
      ['the groups root', (dir: string) => path.dirname(dir)],
      ['the GitNexus home', (dir: string) => path.dirname(path.dirname(dir))],
    ])('ENOENT because %s is a file is a server fault', async (_label, level) => {
      groupYamlFailure.windowsPaths = true;
      const { error, fault } = await thrownByGroupList((dir) => dirBecomesFile(level(dir)));
      expect(error?.code).toBe('ENOENT');
      expect(fault).toBe('server');
    });

    it.each([
      ['the group directory', (dir: string) => dir],
      ['the groups root', (dir: string) => path.dirname(dir)],
      ['the GitNexus home', (dir: string) => path.dirname(path.dirname(dir))],
    ])('ENOENT because %s is missing is a client fault', async (_label, level) => {
      groupYamlFailure.windowsPaths = true;
      const { result, error, fault } = await thrownByGroupList((dir) =>
        fs.rm(level(dir), { recursive: true }),
      );
      expect(error).toBeUndefined();
      expect(result).toMatchObject({
        error: expect.stringMatching(/^Group "test-group" not found/),
      });
      expect(fault).toBe('client');
    });
  });

  it.skipIf(process.getuid?.() === 0 || process.platform === 'win32')(
    'an unreadable group.yaml is a server fault',
    async () => {
      const { error, fault } = await thrownByGroupList((dir) =>
        fs.chmod(path.join(dir, 'group.yaml'), 0o000),
      );
      expect(error?.code).toBe('EACCES');
      expect(faultOf(error)).toBeUndefined();
      expect(fault).toBe('server');
    },
  );

  it('a group name too long for the filesystem is a client fault', async () => {
    const name = 'a'.repeat(300);
    expect(() => validateGroupName(name)).not.toThrow();
    const { result, error, fault } = await thrownByGroupList(async () => {}, name);
    if (process.platform === 'win32') {
      // ENOENT: the group cannot exist under that name.
      expect(error).toBeUndefined();
      expect(result).toMatchObject({ error: expect.stringMatching(/ not found\./) });
    } else {
      expect(error?.code).toBe('ENAMETOOLONG');
      expect(faultOf(error)).toBe('client');
    }
    expect(fault).toBe('client');
  });

  // Windows reports ENOENT for this path too, which reads as a group that does
  // not exist: the injected ENAMETOOLONG case above covers the class there.
  it.skipIf(process.platform === 'win32')(
    'an over-long groups root with an ordinary name is a server fault',
    async () => {
      const { loadGroupConfig } = await import('../../src/core/group/config-parser.js');
      // Each component fits the file-name limit; together they exceed the path limit.
      const root = path.join(os.tmpdir(), ...Array.from({ length: 24 }, () => 'r'.repeat(200)));
      const error = await loadGroupConfig(path.join(root, 'groups', 'test-group')).then(
        () => undefined,
        (err: NodeJS.ErrnoException) => err,
      );
      expect(error?.code).toBe('ENAMETOOLONG');
      expect(faultOf(error)).toBeUndefined();
    },
  );
});
